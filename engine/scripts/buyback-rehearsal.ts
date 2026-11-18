// Local rehearsal of the buyback against an anvil fork: node --import tsx scripts/buyback-rehearsal.ts
// Needs RPC (the anvil URL), SPLITTER, SWAP and the buyback key in SPECULA_BUYBACK_KEY. Sends only to that RPC.
import { createPublicClient, defineChain, formatEther, http, parseAbi } from "viem";
import { openDb } from "../src/db.ts";
import { buybackConfig, buybackRun, buybackTotals, initBuyback } from "../src/buyback.ts";
import type { Ctx } from "../src/ctx.ts";

const rpc = process.env.RPC!;
if (!/^http:\/\/(127\.0\.0\.1|localhost)/.test(rpc)) throw new Error("rehearsal runs against a local fork only");
const chain = defineChain({ id: 4663, name: "fork", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const pub = createPublicClient({ chain, transport: http(rpc) });
const ctx = { pub, db: openDb(":memory:"), cfg: { rpcUrls: [rpc] }, mem: new Map() } as unknown as Ctx;
const cfg = buybackConfig({ ...process.env, SPECULA_BUYBACK: "on" });
initBuyback(ctx, cfg);
const T = parseAbi(["function totalSupply() view returns (uint256)", "function balanceOf(address) view returns (uint256)"]);
const token = await pub.readContract({ address: cfg.splitter!, abi: parseAbi(["function token() view returns (address)"]), functionName: "token" });
const wallet = (await import("viem/accounts")).privateKeyToAccount(cfg.key!).address;
const own = await pub.readContract({ address: token, abi: T, functionName: "balanceOf", args: [wallet] });
const s0 = await pub.readContract({ address: token, abi: T, functionName: "totalSupply" });
const b0 = await pub.getBalance({ address: wallet });
for (let i = 0; i < 2; i++) console.log(`run ${i + 1}:`, await buybackRun(ctx, cfg));
const s1 = await pub.readContract({ address: token, abi: T, functionName: "totalSupply" });
const own1 = await pub.readContract({ address: token, abi: T, functionName: "balanceOf", args: [wallet] });
const b1 = await pub.getBalance({ address: wallet });
const tot = buybackTotals(ctx);
console.log({ runs: tot.runs, ethSpentOnBuys: formatEther(tot.ethIn), burned: formatEther(tot.burned), supplyFell: formatEther(s0 - s1), walletTokensBefore: formatEther(own), walletTokensAfter: formatEther(own1), walletEthBefore: formatEther(b0), walletEthAfter: formatEther(b1) });
console.log(ctx.db.prepare("SELECT * FROM buybacks").all());
