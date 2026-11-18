// The buyback: the team's buyback wallet buys $SPECULA with the fees the splitter sent it, and burns exactly what it
// bought. Every SPECULA_BUYBACK_EVERY_MIN minutes (30 by default):
//
//   1. sweep: the splitter releases the curve's fees, claims them from Pons' escrow and pays the two wallets
//   2. owed:  everything the splitter has paid this wallet (totalToBuyback, on chain) minus everything already spent
//             on buybacks, gas included. Only that is ever spent, so the wallet's own ETH and its own $SPECULA are
//             never touched, and a buffer of SPECULA_BUYBACK_BUFFER_ETH (0.005) always stays for gas.
//   3. buy:   on the bonding curve straight from the wallet, or after graduation through SpeculaSwap in the pool;
//             at most 1% of the curve's depth per run, the rest waits for the next run
//   4. burn:  token.burn() of exactly the tokens this buy delivered (read from the receipt), and the supply must fall
//
// Off unless SPECULA_BUYBACK=on. The wallet's key is SPECULA_BUYBACK_KEY. Every run is recorded and shown on the token
// page with both transactions, and with the time of the next run for the countdown.
import { createWalletClient, http, parseAbi, parseEther, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Ctx } from "./ctx.ts";

const SPLITTER = parseAbi([
  "function sweep() returns (uint256)",
  "function token() view returns (address)",
  "function buyback() view returns (address)",
  "function totalToBuyback() view returns (uint256)",
  "function totalSplit() view returns (uint256)",
]);
const FACTORY = parseAbi([
  "struct LaunchedToken { address token; address curve; address deployer; address creatorFeeRecipient; address pairToken; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; uint16 creatorTaxBps; bool buybackEnabled; uint8 phase; uint256 sweptQuote; uint256 sweptTokens; uint256 sweptAt; bool exists; }",
  "function getLaunchedToken(address) view returns (LaunchedToken)",
]);
const CURVE = parseAbi([
  "function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256)",
  "function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)",
  "function readyToGraduate() view returns (bool)",
]);
const SWAP = parseAbi(["function buy(address token, uint256 minOut, address recipient) payable returns (uint256 ethIn, uint256 tokensOut)"]);
const TOKEN = parseAbi([
  "function burn(uint256 value)",
  "function totalSupply() view returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export const PONS_FACTORY: Address = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";

export interface BuybackConfig {
  on: boolean;
  key: Hex | null;
  splitter: Address | null;
  swap: Address | null;
  everyMs: number;
  bufferWei: bigint;
  minWei: bigint;
}

export function buybackConfig(env: NodeJS.ProcessEnv): BuybackConfig {
  return {
    on: env.SPECULA_BUYBACK === "on",
    key: (env.SPECULA_BUYBACK_KEY as Hex | undefined) ?? null,
    splitter: (env.SPECULA_SPLITTER as Address | undefined) ?? null,
    swap: (env.SPECULA_SWAP as Address | undefined) ?? null,
    everyMs: Number(env.SPECULA_BUYBACK_EVERY_MIN ?? 30) * 60_000,
    bufferWei: parseEther(env.SPECULA_BUYBACK_BUFFER_ETH ?? "0.005"),
    minWei: parseEther(env.SPECULA_BUYBACK_MIN_ETH ?? "0.0002"),
  };
}

export function ensureBuybackTables(ctx: Ctx): void {
  ctx.db.exec(`CREATE TABLE IF NOT EXISTS buybacks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, eth_in TEXT NOT NULL, gas TEXT NOT NULL,
    bought TEXT NOT NULL, buy_tx TEXT NOT NULL, burn_tx TEXT, via TEXT NOT NULL)`);
  ctx.db.exec(`CREATE TABLE IF NOT EXISTS buyback_gas (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, tx TEXT NOT NULL, gas TEXT NOT NULL, kind TEXT NOT NULL)`);
}

function spentSoFar(ctx: Ctx): bigint {
  let s = 0n;
  for (const r of ctx.db.prepare("SELECT eth_in, gas FROM buybacks").all() as { eth_in: string; gas: string }[]) s += BigInt(r.eth_in) + BigInt(r.gas);
  for (const r of ctx.db.prepare("SELECT gas FROM buyback_gas").all() as { gas: string }[]) s += BigInt(r.gas);
  return s;
}

const feeOf = (r: { gasUsed: bigint; effectiveGasPrice: bigint }) => r.gasUsed * r.effectiveGasPrice;

export interface BuybackState {
  on: boolean;
  wallet: Address | null;
  splitter: Address | null;
  everyMin: number;
  lastAt: number | null;
  nextAt: number | null;
  lastNote: string | null;
}

export function buybackState(ctx: Ctx): BuybackState {
  const b = ctx.mem.get("buyback") as { cfg: BuybackConfig; wallet: Address | null; lastAt: number | null; lastNote: string | null } | undefined;
  if (!b) return { on: false, wallet: null, splitter: null, everyMin: 30, lastAt: null, nextAt: null, lastNote: null };
  return {
    on: b.cfg.on,
    wallet: b.wallet,
    splitter: b.cfg.splitter,
    everyMin: Math.round(b.cfg.everyMs / 60_000),
    lastAt: b.lastAt,
    nextAt: b.lastAt ? b.lastAt + b.cfg.everyMs : null,
    lastNote: b.lastNote,
  };
}

export function buybackRuns(ctx: Ctx, limit = 100) {
  return (ctx.db.prepare("SELECT at, eth_in, bought, buy_tx, burn_tx, via FROM buybacks ORDER BY id DESC LIMIT ?").all(limit) as {
    at: number; eth_in: string; bought: string; buy_tx: string; burn_tx: string | null; via: string;
  }[]);
}

export function buybackTotals(ctx: Ctx): { runs: number; ethIn: bigint; burned: bigint } {
  let ethIn = 0n, burned = 0n, runs = 0;
  for (const r of ctx.db.prepare("SELECT eth_in, bought, burn_tx FROM buybacks").all() as { eth_in: string; bought: string; burn_tx: string | null }[]) {
    runs++;
    ethIn += BigInt(r.eth_in);
    if (r.burn_tx) burned += BigInt(r.bought);
  }
  return { runs, ethIn, burned };
}

/** Sets up the state the token page reads, even while the buyback is off. */
export function initBuyback(ctx: Ctx, cfg: BuybackConfig): void {
  ensureBuybackTables(ctx);
  const wallet = cfg.key ? privateKeyToAccount(cfg.key).address : null;
  const last = ctx.db.prepare("SELECT MAX(at) AS at FROM buybacks").get() as { at: number | null };
  const lastTried = Number((ctx.db.prepare("SELECT value FROM kv WHERE key = 'buyback_last_at'").get() as { value: string } | undefined)?.value ?? 0) || null;
  ctx.mem.set("buyback", { cfg, wallet, lastAt: lastTried ?? (last.at ? last.at * 1000 : null), lastNote: null });
}

/** One run. Returns a short note of what happened, for the log and the page. */
export async function buybackRun(ctx: Ctx, cfg: BuybackConfig, wc?: WalletClient, now = Date.now()): Promise<string> {
  const state = ctx.mem.get("buyback") as { lastAt: number | null; lastNote: string | null } | undefined;
  const done = (note: string) => {
    if (state) { state.lastAt = now; state.lastNote = note; }
    ctx.db.prepare("INSERT INTO kv (key, value) VALUES ('buyback_last_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(now));
    return note;
  };
  if (!cfg.on || !cfg.key || !cfg.splitter) return "off";
  const pub = ctx.pub as PublicClient;
  const account = privateKeyToAccount(cfg.key);
  const w = wc ?? createWalletClient({ account, chain: pub.chain, transport: http(ctx.cfg.rpcUrls[0]) });
  const wallet = account.address;

  const [token, payee] = await Promise.all([
    pub.readContract({ address: cfg.splitter, abi: SPLITTER, functionName: "token" }),
    pub.readContract({ address: cfg.splitter, abi: SPLITTER, functionName: "buyback" }),
  ]);
  if (token === "0x0000000000000000000000000000000000000000") return done("waiting for the token");
  if (payee.toLowerCase() !== wallet.toLowerCase()) return done("this key is not the splitter's buyback wallet");

  // 0. a buy whose burn did not go through last time is burned first
  for (const u of ctx.db.prepare("SELECT id, bought FROM buybacks WHERE burn_tx IS NULL AND bought != '0'").all() as { id: number; bought: string }[]) {
    const tx = await w.writeContract({ address: token, abi: TOKEN, functionName: "burn", args: [BigInt(u.bought)], account, chain: pub.chain });
    const r = await pub.waitForTransactionReceipt({ hash: tx });
    if (r.status !== "success") throw new Error(`burn ${tx} failed`);
    ctx.db.prepare("UPDATE buybacks SET burn_tx = ? WHERE id = ?").run(tx, u.id);
    ctx.db.prepare("INSERT INTO buyback_gas (at, tx, gas, kind) VALUES (?, ?, ?, 'burn')").run(Math.floor(now / 1000), tx, feeOf(r).toString());
  }

  // 1. sweep, only when it would move something
  try {
    const sim = await pub.simulateContract({ address: cfg.splitter, abi: SPLITTER, functionName: "sweep", account });
    if (sim.result > 0n) {
      const tx = await w.writeContract({ ...sim.request, account, chain: pub.chain });
      const r = await pub.waitForTransactionReceipt({ hash: tx });
      ctx.db.prepare("INSERT INTO buyback_gas (at, tx, gas, kind) VALUES (?, ?, ?, 'sweep')").run(Math.floor(now / 1000), tx, feeOf(r).toString());
    }
  } catch { /* nothing to sweep, or the node hiccuped: the owed amount below still counts */ }

  // 2. owed
  const paid = await pub.readContract({ address: cfg.splitter, abi: SPLITTER, functionName: "totalToBuyback" });
  const owed = paid - spentSoFar(ctx);
  const bal = await pub.getBalance({ address: wallet });
  let spend = owed;
  if (bal - cfg.bufferWei < spend) spend = bal - cfg.bufferWei;
  const info = await pub.readContract({ address: PONS_FACTORY, abi: FACTORY, functionName: "getLaunchedToken", args: [token] });
  const viaCurve = info.phase === 0;
  if (viaCurve) {
    if (await pub.readContract({ address: info.curve, abi: CURVE, functionName: "readyToGraduate" })) return done("the curve is graduating, waiting for the pool");
    const [quoteReserve] = await pub.readContract({ address: info.curve, abi: CURVE, functionName: "getReserves" });
    const cap = quoteReserve / 100n;
    if (spend > cap) spend = cap;
  } else if (info.phase !== 2 || !cfg.swap) {
    return done("no market to buy in right now");
  }
  if (spend < cfg.minWei) return done(owed > 0n ? "fees are still small, waiting for more" : "no new fees yet");

  // 3. buy
  const supplyBefore = await pub.readContract({ address: token, abi: TOKEN, functionName: "totalSupply" });
  const buyTx = viaCurve
    ? await w.writeContract({ address: info.curve, abi: CURVE, functionName: "buy", args: [spend, 0n, wallet], value: spend, account, chain: pub.chain })
    : await w.writeContract({ address: cfg.swap!, abi: SWAP, functionName: "buy", args: [token, 1n, wallet], value: spend, account, chain: pub.chain });
  const br = await pub.waitForTransactionReceipt({ hash: buyTx });
  if (br.status !== "success") throw new Error(`buy ${buyTx} failed`);
  let bought = 0n;
  for (const l of br.logs) {
    if (l.address.toLowerCase() === token.toLowerCase() && l.topics[0] === TRANSFER_TOPIC && l.topics[2] && `0x${l.topics[2].slice(26)}`.toLowerCase() === wallet.toLowerCase()) bought += BigInt(l.data);
  }
  // what really left for the buy: the curve refunds what it could not fill, the swap returns what it did not swap
  const before = await pub.getBalance({ address: wallet, blockNumber: br.blockNumber - 1n });
  const after = await pub.getBalance({ address: wallet, blockNumber: br.blockNumber });
  const buyGas = feeOf(br);
  const ethIn = before - after - buyGas > 0n ? before - after - buyGas : spend;
  const row = ctx.db.prepare("INSERT INTO buybacks (at, eth_in, gas, bought, buy_tx, burn_tx, via) VALUES (?, ?, ?, ?, ?, NULL, ?)")
    .run(Math.floor(now / 1000), ethIn.toString(), buyGas.toString(), bought.toString(), buyTx, viaCurve ? "curve" : "pool");
  if (bought === 0n) return done("the buy delivered nothing");

  // 4. burn exactly that
  const burnTx = await w.writeContract({ address: token, abi: TOKEN, functionName: "burn", args: [bought], account, chain: pub.chain });
  const rr = await pub.waitForTransactionReceipt({ hash: burnTx });
  if (rr.status !== "success") throw new Error(`burn ${burnTx} failed`);
  const supplyAfter = await pub.readContract({ address: token, abi: TOKEN, functionName: "totalSupply" });
  ctx.db.prepare("UPDATE buybacks SET burn_tx = ?, gas = ? WHERE id = ?").run(burnTx, (buyGas + feeOf(rr)).toString(), row.lastInsertRowid);
  if (supplyBefore - supplyAfter < bought) return done("burned, but the supply fell by less than expected");
  return done(`bought and burned ${bought} with ${ethIn} wei`);
}
