import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import { count, type Ctx } from "../ctx.ts";
import { kvGet, kvSet } from "../db.ts";
import { DEAD, lower, nowSec, sameAddress, ZERO } from "../util.ts";
import { ADDR, curveAbi, erc20Abi, evBuy, evGraduated, evInit, evLaunched, evLiq, evSell, evSwap, evTransfer, factoryAbi } from "./abi.ts";
import { blockClock, getLogs } from "./client.ts";

const CHUNK = 50_000n;
const QUOTES: string[] = [lower(ADDR.usdg), ZERO, lower(ADDR.weth)];

/** Names come from strangers. Keep printable characters only, cap the length. */
export const cleanName = (s: unknown, max = 48) =>
  String(s ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

export const poolIdOf = (c0: Address, c1: Address, fee: number, tickSpacing: number, hooks: Address): Hex =>
  keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }], [c0, c1, fee, tickSpacing, hooks]));

interface NewToken {
  token: Address;
  curve: Address;
  deployer: Address;
  block: bigint;
  seen: boolean;
}

type Launched = { token: Address; curve: Address; deployer: Address; pairToken: Address; poolFee: number; tickSpacing: number; creatorTaxBps: number; phase: number; exists: boolean };

async function ensureAssets(ctx: Ctx, addrs: string[]) {
  const fresh = [...new Set(addrs.map(lower))].filter((a) => a !== ZERO && !ctx.db.prepare("SELECT 1 FROM assets WHERE address = ?").get(a));
  ctx.db.prepare("INSERT OR IGNORE INTO assets (address, symbol, name, decimals) VALUES (?, 'ETH', 'Ether', 18)").run(ZERO);
  if (!fresh.length) return;
  const res = await ctx.pub.multicall({
    contracts: fresh.flatMap((a) => [
      { address: a as Address, abi: erc20Abi, functionName: "symbol" as const },
      { address: a as Address, abi: erc20Abi, functionName: "name" as const },
      { address: a as Address, abi: erc20Abi, functionName: "decimals" as const },
    ]),
    allowFailure: true,
  });
  const ins = ctx.db.prepare("INSERT OR IGNORE INTO assets (address, symbol, name, decimals) VALUES (?, ?, ?, ?)");
  fresh.forEach((a, i) => {
    const [s, n, d] = [res[i * 3], res[i * 3 + 1], res[i * 3 + 2]];
    ins.run(a, s.status === "success" ? cleanName(s.result, 16) : null, n.status === "success" ? cleanName(n.result) : null, d.status === "success" ? Number(d.result) : 18);
  });
}

async function ensureTokens(ctx: Ctx, entries: NewToken[], clock: (b: bigint) => number) {
  const seen = new Set<string>();
  const fresh = entries.filter((e) => {
    const k = lower(e.token);
    if (seen.has(k)) return false;
    seen.add(k);
    const row = ctx.db.prepare("SELECT launch_seen FROM tokens WHERE address = ?").get(k) as { launch_seen: number } | undefined;
    if (row && e.seen && !row.launch_seen) ctx.db.prepare("UPDATE tokens SET launch_seen = 1, launch_block = ?, launch_time = ? WHERE address = ?").run(Number(e.block), clock(e.block), k);
    return !row;
  });
  if (!fresh.length) return;
  const res = await ctx.pub.multicall({
    contracts: fresh.flatMap((e) => [
      { address: e.token, abi: erc20Abi, functionName: "name" as const },
      { address: e.token, abi: erc20Abi, functionName: "symbol" as const },
      { address: e.token, abi: erc20Abi, functionName: "totalSupply" as const },
      { address: ADDR.ponsFactory, abi: factoryAbi, functionName: "getLaunchedToken" as const, args: [e.token] as const },
    ]),
    allowFailure: true,
  });
  const ins = ctx.db.prepare(
    "INSERT OR IGNORE INTO tokens (address, curve, name, symbol, deployer, launch_block, launch_time, launch_seen, tax_bps, phase, supply) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const asset = ctx.db.prepare("INSERT OR IGNORE INTO assets (address, symbol, name, decimals) VALUES (?, ?, ?, 18)");
  ctx.db.transaction(() => {
    fresh.forEach((e, i) => {
      const [n, s, sup, info] = [res[i * 4], res[i * 4 + 1], res[i * 4 + 2], res[i * 4 + 3]];
      const name = n.status === "success" ? cleanName(n.result) : "";
      const symbol = s.status === "success" ? cleanName(s.result, 16) : "";
      const li = info.status === "success" ? (info.result as unknown as Launched) : null;
      ins.run(lower(e.token), lower(e.curve), name, symbol, lower(e.deployer), Number(e.block), clock(e.block), e.seen ? 1 : 0, li?.creatorTaxBps ?? null, li?.phase ?? 0, sup.status === "success" ? String(sup.result) : null);
      asset.run(lower(e.token), symbol, name);
      if (e.seen) ctx.db.prepare("INSERT OR IGNORE INTO holder_progress (token, from_block, last_block) VALUES (?, ?, ?)").run(lower(e.token), Number(e.block), Number(e.block) - 1);
    });
  })();
}

async function discoverCurves(ctx: Ctx, curves: Address[], block: bigint, clock: (b: bigint) => number) {
  if (!curves.length) return;
  const toks = await ctx.pub.multicall({ contracts: curves.map((a) => ({ address: a, abi: curveAbi, functionName: "token" as const })), allowFailure: true });
  const pairs = curves.map((curve, i) => (toks[i].status === "success" ? { curve, token: toks[i].result as Address } : null)).filter((x): x is { curve: Address; token: Address } => !!x);
  if (!pairs.length) return;
  const infos = await ctx.pub.multicall({ contracts: pairs.map((p) => ({ address: ADDR.ponsFactory, abi: factoryAbi, functionName: "getLaunchedToken" as const, args: [p.token] as const })), allowFailure: true });
  const entries: NewToken[] = [];
  pairs.forEach((p, i) => {
    const info = infos[i];
    if (info.status !== "success") return;
    const li = info.result as unknown as Launched;
    // Only curves the factory itself vouches for: anyone can emit a look-alike event.
    if (!li.exists || !sameAddress(li.curve, p.curve)) return;
    entries.push({ token: p.token, curve: p.curve, deployer: li.deployer, block, seen: false });
  });
  await ensureTokens(ctx, entries, clock);
}

export interface TradeRow {
  token: string;
  block: number;
  log_index: number;
  tx: string;
  time: number;
  side: "buy" | "sell";
  trader: string;
  quote: string;
  amount: string;
  fee: string;
  tax: string;
  venue: "curve" | "pool";
  quote_asset: string;
}

const abs = (n: bigint) => (n < 0n ? -n : n);

/** Index one range of blocks. Safe to run again over the same range: every row is keyed by block and log index. */
export async function indexRange(ctx: Ctx, from: bigint, to: bigint) {
  const clock = await blockClock(ctx);
  const launched = await getLogs(ctx, { address: ADDR.ponsFactory, event: evLaunched, fromBlock: from, toBlock: to });
  const graduated = await getLogs(ctx, { address: ADDR.ponsFactory, event: evGraduated, fromBlock: from, toBlock: to });
  const buys = await getLogs(ctx, { event: evBuy, fromBlock: from, toBlock: to });
  const sells = await getLogs(ctx, { event: evSell, fromBlock: from, toBlock: to });
  const inits = await getLogs(ctx, { address: ADDR.poolManager, event: evInit, fromBlock: from, toBlock: to });
  const swaps = await getLogs(ctx, { address: ADDR.poolManager, event: evSwap, fromBlock: from, toBlock: to });
  const liqs = await getLogs(ctx, { address: ADDR.poolManager, event: evLiq, fromBlock: from, toBlock: to });

  await ensureTokens(ctx, launched.map((l) => ({ token: l.args.token, curve: l.args.curve, deployer: l.args.deployer, block: l.blockNumber, seen: true })), clock);

  const curveMap = () => new Map((ctx.db.prepare("SELECT address, curve FROM tokens WHERE curve IS NOT NULL").all() as { address: string; curve: string }[]).map((r) => [r.curve, r.address]));
  let curves = curveMap();
  const unknown = [...new Set([...buys, ...sells].map((l) => lower(l.address)))].filter((a) => !curves.has(a));
  if (unknown.length) {
    for (let i = 0; i < unknown.length; i += 100) await discoverCurves(ctx, unknown.slice(i, i + 100) as Address[], from, clock);
    curves = curveMap();
  }

  const trades: TradeRow[] = [];
  for (const l of buys) {
    const token = curves.get(lower(l.address));
    if (!token || l.args.tokensOut === 0n) continue;
    trades.push({ token, block: Number(l.blockNumber), log_index: l.logIndex, tx: l.transactionHash, time: clock(l.blockNumber), side: "buy", trader: lower(l.args.recipient), quote: String(l.args.quoteIn), amount: String(l.args.tokensOut), fee: String(l.args.fee), tax: String(l.args.tax), venue: "curve", quote_asset: ZERO });
  }
  for (const l of sells) {
    const token = curves.get(lower(l.address));
    if (!token || l.args.tokensIn === 0n) continue;
    trades.push({ token, block: Number(l.blockNumber), log_index: l.logIndex, tx: l.transactionHash, time: clock(l.blockNumber), side: "sell", trader: lower(l.args.seller), quote: String(l.args.quoteOut), amount: String(l.args.tokensIn), fee: String(l.args.fee), tax: String(l.args.tax), venue: "curve", quote_asset: ZERO });
  }

  // New pools: every pool opened in this range, and the pool of each token that graduated in it.
  const insPool = ctx.db.prepare("INSERT OR IGNORE INTO pools (id, currency0, currency1, fee, tick_spacing, hooks, block, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  await ensureAssets(ctx, inits.flatMap((l) => [l.args.currency0, l.args.currency1]));
  for (const l of inits) insPool.run(lower(l.args.id), lower(l.args.currency0), lower(l.args.currency1), l.args.fee, l.args.tickSpacing, lower(l.args.hooks), Number(l.blockNumber), sameAddress(l.args.hooks, ADDR.ponsHook) ? "pons" : "v4");
  if (graduated.length) {
    const infos = await ctx.pub.multicall({ contracts: graduated.map((g) => ({ address: ADDR.ponsFactory, abi: factoryAbi, functionName: "getLaunchedToken" as const, args: [g.args.token] as const })), allowFailure: true });
    await ensureTokens(ctx, graduated.flatMap((g, i) => (infos[i].status === "success" ? [{ token: g.args.token, curve: (infos[i].result as unknown as Launched).curve, deployer: (infos[i].result as unknown as Launched).deployer, block: g.blockNumber, seen: false }] : [])), clock);
    graduated.forEach((g, i) => {
      const info = infos[i];
      if (info.status !== "success") return;
      const li = info.result as unknown as Launched;
      const [c0, c1] = BigInt(li.pairToken) < BigInt(g.args.token) ? [li.pairToken, g.args.token] : [g.args.token, li.pairToken];
      const pid = lower(poolIdOf(c0, c1, li.poolFee, li.tickSpacing, ADDR.ponsHook));
      insPool.run(pid, lower(c0), lower(c1), li.poolFee, li.tickSpacing, lower(ADDR.ponsHook), Number(g.blockNumber), "pons");
      ctx.db.prepare("UPDATE tokens SET phase = 2, pool_id = ?, graduated_at = ? WHERE address = ?").run(pid, clock(g.blockNumber), lower(g.args.token));
      ctx.bus.emit("graduation", { token: lower(g.args.token), time: clock(g.blockNumber), tx: g.transactionHash });
    });
  }

  // Swaps in pools we can name. Amounts are the swapper's deltas: the side that goes negative is what was paid.
  const pools = new Map((ctx.db.prepare("SELECT id, currency0, currency1 FROM pools").all() as { id: string; currency0: string; currency1: string }[]).map((p) => [p.id, p]));
  const known = swaps.filter((s) => pools.has(lower(s.args.id)) && s.args.amount0 !== 0n && s.args.amount1 !== 0n);
  // The swap event names the router, not the person. Look the sender up, newest first, within a budget per range.
  const lookups = new Map<string, Promise<{ from: Address } | null>>();
  for (const s of [...known].reverse()) {
    if (lookups.size >= 300) break;
    if (!lookups.has(s.transactionHash)) lookups.set(s.transactionHash, ctx.pub.getTransaction({ hash: s.transactionHash }).catch(() => null));
  }
  const txs = await Promise.all(known.map((s) => lookups.get(s.transactionHash) ?? null));
  known.forEach((s, i) => {
    const p = pools.get(lower(s.args.id))!;
    const q0 = QUOTES.indexOf(p.currency0);
    const q1 = QUOTES.indexOf(p.currency1);
    const quoteIs0 = q1 === -1 || (q0 !== -1 && q0 <= q1);
    const [quoteDelta, baseDelta] = quoteIs0 ? [s.args.amount0, s.args.amount1] : [s.args.amount1, s.args.amount0];
    trades.push({
      token: quoteIs0 ? p.currency1 : p.currency0,
      block: Number(s.blockNumber),
      log_index: s.logIndex,
      tx: s.transactionHash,
      time: clock(s.blockNumber),
      side: quoteDelta < 0n ? "buy" : "sell",
      trader: lower(txs[i]?.from ?? s.args.sender),
      quote: String(abs(quoteDelta)),
      amount: String(abs(baseDelta)),
      fee: "0",
      tax: "0",
      venue: "pool",
      quote_asset: quoteIs0 ? p.currency0 : p.currency1,
    });
  });
  count(ctx, "swaps_unnamed", swaps.length - known.length);

  const insTrade = ctx.db.prepare("INSERT OR IGNORE INTO trades (token, block, log_index, tx, time, side, trader, quote, amount, fee, tax, venue, quote_asset) VALUES (@token, @block, @log_index, @tx, @time, @side, @trader, @quote, @amount, @fee, @tax, @venue, @quote_asset)");
  const insLiq = ctx.db.prepare("INSERT OR IGNORE INTO liquidity (pool_id, block, log_index, tx, time, sender, tick_lower, tick_upper, delta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  trades.sort((a, b) => a.block - b.block || a.log_index - b.log_index);
  const fresh: TradeRow[] = [];
  ctx.db.transaction(() => {
    for (const t of trades) if (insTrade.run(t).changes) fresh.push(t);
    for (const l of liqs) insLiq.run(lower(l.args.id), Number(l.blockNumber), l.logIndex, l.transactionHash, clock(l.blockNumber), lower(l.args.sender), l.args.tickLower, l.args.tickUpper, String(l.args.liquidityDelta));
  })();

  await syncHolders(ctx, from, to, clock);

  for (const l of launched) ctx.bus.emit("launch", { token: lower(l.args.token), time: clock(l.blockNumber), tx: l.transactionHash });
  for (const t of fresh.slice(-200)) ctx.bus.emit("trade", t);
  return { from, to, launches: launched.length, trades: fresh.length, graduations: graduated.length, pools: inits.length, liquidity: liqs.length };
}

/** Apply Transfer logs to the holder table. Balances are exact base units, kept as text. */
function applyTransfers(ctx: Ctx, logs: { address: string; blockNumber: bigint; logIndex: number; transactionHash: string; args: { from: Address; to: Address; value: bigint } }[], clock: (b: bigint) => number) {
  const bal = new Map<string, bigint>();
  const get = ctx.db.prepare("SELECT balance FROM holders WHERE token = ? AND holder = ?");
  const read = (token: string, holder: string) => {
    const k = `${token}|${holder}`;
    let v = bal.get(k);
    if (v === undefined) {
      v = BigInt((get.get(token, holder) as { balance: string } | undefined)?.balance ?? "0");
      bal.set(k, v);
    }
    return v;
  };
  const burn = ctx.db.prepare("INSERT OR IGNORE INTO burns (token, block, log_index, tx, time, sender, amount) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const move = ctx.db.prepare("INSERT OR IGNORE INTO transfers (token, block, log_index, tx, time, sender, recipient, amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const perToken = new Map<string, { n: number; burned: bigint }>();
  ctx.db.transaction(() => {
    for (const l of logs) {
      const token = lower(l.address);
      const from = lower(l.args.from);
      const to = lower(l.args.to);
      const v = l.args.value;
      const st = perToken.get(token) ?? { n: 0, burned: 0n };
      st.n++;
      if (from !== ZERO) bal.set(`${token}|${from}`, read(token, from) - v);
      if (to === ZERO || to === DEAD) {
        if (from !== ZERO && burn.run(token, Number(l.blockNumber), l.logIndex, l.transactionHash, clock(l.blockNumber), from, String(v)).changes) st.burned += v;
      } else {
        bal.set(`${token}|${to}`, read(token, to) + v);
        if (from !== ZERO && v > 0n) move.run(token, Number(l.blockNumber), l.logIndex, l.transactionHash, clock(l.blockNumber), from, to, String(v));
      }
      perToken.set(token, st);
    }
    const up = ctx.db.prepare("INSERT INTO holders (token, holder, balance) VALUES (?, ?, ?) ON CONFLICT(token, holder) DO UPDATE SET balance = excluded.balance");
    const del = ctx.db.prepare("DELETE FROM holders WHERE token = ? AND holder = ?");
    for (const [k, v] of bal) {
      const [token, holder] = k.split("|");
      if (v <= 0n) del.run(token, holder);
      else up.run(token, holder, v.toString());
    }
    const prog = ctx.db.prepare("UPDATE holder_progress SET transfers = transfers + ?, burned = ? WHERE token = ?");
    for (const [token, st] of perToken) {
      const cur = BigInt((ctx.db.prepare("SELECT burned FROM holder_progress WHERE token = ?").get(token) as { burned: string } | undefined)?.burned ?? "0");
      prog.run(st.n, (cur + st.burned).toString(), token);
    }
  })();
}

/** Holders for the tokens that are in step with the index (launched inside the window). */
async function syncHolders(ctx: Ctx, from: bigint, to: bigint, clock: (b: bigint) => number) {
  const inStep = (ctx.db.prepare("SELECT token FROM holder_progress WHERE last_block >= ? AND last_block < ? ORDER BY from_block DESC LIMIT 400").all(Number(from) - 1, Number(to)) as { token: string }[]).map((r) => r.token);
  for (let i = 0; i < inStep.length; i += 80) {
    const part = inStep.slice(i, i + 80);
    const logs = await getLogs(ctx, { address: part as Address[], event: evTransfer, fromBlock: from, toBlock: to });
    const lastOf = new Map((ctx.db.prepare(`SELECT token, last_block FROM holder_progress WHERE token IN (${part.map(() => "?").join(",")})`).all(...part) as { token: string; last_block: number }[]).map((r) => [r.token, r.last_block]));
    applyTransfers(ctx, logs.filter((l) => Number(l.blockNumber) > (lastOf.get(lower(l.address)) ?? 0)) as never, clock);
    ctx.db.prepare(`UPDATE holder_progress SET last_block = ? WHERE token IN (${part.map(() => "?").join(",")})`).run(Number(to), ...part);
  }
}

/** Bring one token's holders up to the index head. Used when a token outside the window is asked for. */
export async function catchUpHolders(ctx: Ctx, token: string, head: bigint) {
  const clock = await blockClock(ctx);
  for (;;) {
    const p = ctx.db.prepare("SELECT last_block FROM holder_progress WHERE token = ?").get(token) as { last_block: number } | undefined;
    if (!p || BigInt(p.last_block) >= head) return;
    const from = BigInt(p.last_block) + 1n;
    const to = from + CHUNK - 1n > head ? head : from + CHUNK - 1n;
    const logs = await getLogs(ctx, { address: token as Address, event: evTransfer, fromBlock: from, toBlock: to });
    applyTransfers(ctx, logs as never, clock);
    ctx.db.prepare("UPDATE holder_progress SET last_block = ? WHERE token = ?").run(Number(to), token);
  }
}

/** Find the block a token launched in by its indexed topic, newest first. Selective, so wide ranges are fine. */
export async function findLaunch(ctx: Ctx, token: Address, head: bigint): Promise<bigint | null> {
  const SPAN = 1_000_000n;
  for (let to = head; to > 0n; to -= SPAN) {
    const from = to > SPAN ? to - SPAN + 1n : 0n;
    const logs = await getLogs(ctx, { address: ADDR.ponsFactory, event: evLaunched, args: { token }, fromBlock: from, toBlock: to });
    if (logs.length) return logs[0].blockNumber;
    if (from === 0n) break;
  }
  return null;
}

export const indexHead = (ctx: Ctx): bigint | null => {
  const v = kvGet(ctx.db, "index_block");
  return v ? BigInt(v) : null;
};

/** One step of the index: from the last block read up to the chain head, at most one chunk. */
export async function indexTick(ctx: Ctx): Promise<{ from: bigint; to: bigint; head: bigint; behind: bigint } | null> {
  const head = await ctx.pub.getBlockNumber();
  const last = indexHead(ctx);
  const from = last === null ? (head > BigInt(ctx.cfg.backfillBlocks) ? head - BigInt(ctx.cfg.backfillBlocks) : 0n) : last + 1n;
  if (last === null) kvSet(ctx.db, "index_start", from.toString());
  if (from > head) return null;
  const to = from + CHUNK - 1n > head ? head : from + CHUNK - 1n;
  await indexRange(ctx, from, to);
  kvSet(ctx.db, "index_block", to.toString());
  kvSet(ctx.db, "index_head", head.toString());
  kvSet(ctx.db, "index_at", String(nowSec()));
  return { from, to, head, behind: head - to };
}

export function prune(ctx: Ctx) {
  const t = nowSec();
  ctx.db.prepare("DELETE FROM liquidity WHERE time < ?").run(t - 7 * 86400);
  ctx.db.prepare("DELETE FROM trades WHERE time < ?").run(t - 30 * 86400);
  ctx.db.prepare("DELETE FROM transfers WHERE time < ?").run(t - 30 * 86400);
  ctx.db.prepare("DELETE FROM requests WHERE at < ?").run(t - 90 * 86400);
  ctx.db.prepare("DELETE FROM health_hour WHERE hour < ?").run(Math.floor(t / 3600) - 24 * 30);
}
