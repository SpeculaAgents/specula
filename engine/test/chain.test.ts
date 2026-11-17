import assert from "node:assert/strict";
import { test } from "node:test";
import { custom } from "viem";
import { FEEDS } from "../src/catalog.ts";
import { collect, normalizeParams } from "../src/collect.ts";
import { getLogs } from "../src/chain/client.ts";
import { ADDR, evSwap } from "../src/chain/abi.ts";
import { cleanName, indexRange, poolIdOf } from "../src/chain/indexer.ts";
import { PRICE_FEEDS, priceFeed, type PricePoint } from "../src/chain/prices.ts";
import { indexStats, priceOf, usdOf } from "../src/chain/views.ts";
import { HttpError, ZERO } from "../src/util.ts";
import { chainScenario, readJson, replayTransport, testCtx, type Tape } from "./helpers.ts";

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const fix = readJson<{ meta: { from: string; to: string; token: string | null; busy: string; wallet: string; counts: J }; tape: Tape }>("chain.json");
const feed = (id: string) => FEEDS.find((f) => f.id === id)!;
const ask = async (ctx: ReturnType<typeof testCtx>, id: string, p: Record<string, string>) => (await collect(ctx, feed(id), normalizeParams(feed(id), p), 0)).data as J;

async function indexed() {
  const ctx = testCtx({}, { transport: replayTransport(fix.tape) });
  const out = await chainScenario(ctx, BigInt(fix.meta.from), BigInt(fix.meta.to));
  return { ctx, ...out };
}

test("the price feed registry is complete and consistent", () => {
  assert.ok(PRICE_FEEDS.length >= 60);
  assert.equal(new Set(PRICE_FEEDS.map((f) => f.symbol)).size, PRICE_FEEDS.length);
  for (const f of PRICE_FEEDS) assert.ok(/^0x[0-9a-fA-F]{40}$/.test(f.proxy) && (f.decimals === 8 || f.decimals === 18));
  assert.equal(priceFeed("nvda").symbol, "NVDA");
  assert.throws(() => priceFeed("NOPE"), (e: HttpError) => e.status === 404);
});

test("the price board decodes real on-chain rounds into exact decimal prices", async () => {
  const { board } = await indexed();
  const pts = (board.data as { prices: PricePoint[] }).prices;
  assert.ok(pts.length >= 55, `only ${pts.length} feeds answered`);
  const by = new Map(pts.map((p) => [p.symbol, p]));
  const eth = by.get("ETH")!;
  assert.ok(Number(eth.price) > 100 && Number(eth.price) < 100_000);
  assert.equal(BigInt(eth.raw), BigInt(eth.price.replace(".", "").padEnd(eth.price.split(".")[0].length + 8, "0")), "the decimal string is the raw integer with the point moved");
  const usdg = by.get("USDG")!;
  assert.ok(Math.abs(Number(usdg.price) - 1) < 0.05, "the dollar token reads about one dollar");
  for (const p of pts) {
    assert.ok(BigInt(p.raw) > 0n && p.updatedAtSec > 1_700_000_000);
    assert.equal(p.resting, p.ageSeconds > p.heartbeat);
  }
  assert.equal(board.source, "chainlink");
});

test("one symbol can be asked for alone and unknown symbols are refused", async () => {
  const { ctx } = await indexed();
  await assert.rejects(ask(ctx, "chain.price", { symbol: "NOPE" }), (e: HttpError) => e.code === "unknown_symbol");
});

test("the indexer reads launches, trades, pools and liquidity from recorded blocks", async () => {
  const { ctx, res } = await indexed();
  assert.equal(res.launches, fix.meta.counts.launches);
  assert.equal(res.trades, fix.meta.counts.trades);
  assert.equal(res.liquidity, fix.meta.counts.liquidity);
  assert.ok(res.trades > 20 && res.liquidity > 5);
  const s = indexStats(ctx);
  assert.equal(s.trades, res.trades);
  assert.equal(s.launches, res.launches);
  assert.equal(s.block, Number(fix.meta.to));
  assert.equal(s.behindBlocks, 0);
});

test("indexing the same range again changes nothing", async () => {
  const { ctx, res } = await indexed();
  const before = JSON.stringify([ctx.db.prepare("SELECT COUNT(*) n FROM trades").get(), ctx.db.prepare("SELECT token, holder, balance FROM holders ORDER BY token, holder").all()]);
  const again = await indexRange(ctx, BigInt(fix.meta.from), BigInt(fix.meta.to));
  assert.equal(again.trades, 0, "no trade is written twice");
  assert.equal(again.launches, res.launches);
  // Holders were already read up to the end of the range, so the transfers are not applied twice.
  assert.equal(JSON.stringify([ctx.db.prepare("SELECT COUNT(*) n FROM trades").get(), ctx.db.prepare("SELECT token, holder, balance FROM holders ORDER BY token, holder").all()]), before);
});

test("trades come out decoded: side, exact amounts, a positive price, a dollar value", async () => {
  const { ctx } = await indexed();
  const d = await ask(ctx, "chain.trades", { limit: "500" });
  assert.equal(d.count, fix.meta.counts.trades);
  let curve = 0;
  let pool = 0;
  for (const t of d.trades as J[]) {
    assert.ok(t.side === "buy" || t.side === "sell");
    assert.ok(/^0x[0-9a-f]{40}$/.test(t.trader) && /^0x[0-9a-f]{64}$/.test(t.tx));
    assert.ok(Number(t.amount) > 0 && Number(t.quote.amount) > 0 && Number(t.price) > 0);
    if (t.venue === "curve") curve++;
    else pool++;
    if (t.quote.asset === "ETH") assert.ok(t.valueUsd !== null && Number(t.valueUsd) >= 0);
  }
  assert.ok(curve > 0, "curve trades are indexed");
  assert.equal(curve + pool, d.count);
  const times = (d.trades as J[]).map((t) => Date.parse(t.time));
  assert.deepEqual(times, [...times].sort((a, b) => b - a), "newest first");
  // Every curve trade's fee and tax are part of what was paid, never more than it.
  for (const r of ctx.db.prepare("SELECT quote, fee, tax FROM trades WHERE venue = 'curve'").all() as { quote: string; fee: string; tax: string }[]) assert.ok(BigInt(r.fee) + BigInt(r.tax) <= BigInt(r.quote));
  const one = await ask(ctx, "chain.trades", { token: fix.meta.busy, limit: "5" });
  assert.ok(one.count > 0 && (one.trades as J[]).every((t) => t.token === fix.meta.busy));
});

test("a launch carries its name, its deployer and its first buyers in order", async () => {
  const { ctx } = await indexed();
  const d = await ask(ctx, "chain.launches", { limit: "10", buyers: "5" });
  assert.equal(d.count, fix.meta.counts.launches);
  if (!d.count) return;
  const l = d.launches[0];
  assert.equal(l.token, fix.meta.token);
  assert.ok(typeof l.symbol === "string" && l.launchedAt && /^0x[0-9a-f]{40}$/.test(l.deployer));
  assert.equal(l.phase, "curve");
  const secs = (l.firstBuyers as J[]).map((b) => b.secondsAfterLaunch);
  assert.deepEqual(secs, [...secs].sort((a, b) => a - b));
});

test("holders are rebuilt from transfers: balances add up to the supply and shares are in basis points", async () => {
  const { ctx } = await indexed();
  if (!fix.meta.token) return;
  const d = await ask(ctx, "chain.holders", { token: fix.meta.token, limit: "50" });
  const rows = ctx.db.prepare("SELECT balance FROM holders WHERE token = ?").all(fix.meta.token) as { balance: string }[];
  const sum = rows.reduce((n, r) => n + BigInt(r.balance), 0n);
  const supply = BigInt((ctx.db.prepare("SELECT supply FROM tokens WHERE address = ?").get(fix.meta.token) as { supply: string }).supply);
  const burned = BigInt((ctx.db.prepare("SELECT burned FROM holder_progress WHERE token = ?").get(fix.meta.token) as { burned: string }).burned);
  assert.equal(sum + burned, supply, "every unit of supply is held by someone or was burned");
  assert.ok(rows.every((r) => BigInt(r.balance) > 0n), "empty balances are removed, never negative");
  assert.equal(d.holders, (d.top as J[]).length <= 50 ? d.holders : 50);
  const c = d.concentration;
  assert.ok(c.top1Bps <= c.top10Bps && c.top10Bps <= c.top50Bps && c.top50Bps <= 10000);
  assert.ok((d.inVenues as J[]).some((v) => v.venue === "curve"), "the curve's own balance is shown apart from wallets");
  const shares = (d.top as J[]).map((h) => h.shareBps);
  assert.deepEqual(shares, [...shares].sort((a, b) => b - a));
});

test("a token outside the window is not guessed at: the caller is told it is being read and is not charged", async () => {
  const { ctx } = await indexed();
  const other = (ctx.db.prepare("SELECT address FROM tokens WHERE launch_seen = 0 LIMIT 1").get() as { address: string } | undefined)?.address;
  if (!other) return;
  ctx.db.prepare("UPDATE kv SET value = ? WHERE key = 'index_block'").run(String(BigInt(fix.meta.to) + 1_000_000n));
  await assert.rejects(ask(ctx, "chain.holders", { token: other }), (e: HttpError) => e.status === 409 && e.code === "indexing" && e.extra.retryAfter === 60);
});

test("a wallet profile, a token overview and project fees are built from the same index", async () => {
  const { ctx } = await indexed();
  const w = await ask(ctx, "chain.wallet", { address: fix.meta.wallet.toUpperCase().replace("0X", "0x") });
  assert.equal(w.address, fix.meta.wallet, "the address is matched whatever its case");
  assert.ok(w.trades > 0 && w.tokensTraded > 0 && w.balances.eth !== null);
  const net = Number(w.ethReceived) - Number(w.ethSpent);
  assert.ok(Math.abs(Number(w.netEth) - net) < 1e-9);
  const t = await ask(ctx, "chain.token", { token: fix.meta.busy });
  assert.ok(t.price && t.day.buys + t.day.sells > 0 && t.day.traders > 0);
  assert.ok(["curve", "graduating", "pool", "rescued"].includes(t.phase));
  const f = await ask(ctx, "chain.fees", { token: fix.meta.token ?? fix.meta.busy });
  assert.ok(f.curve.trades >= 0 && /^\d+(\.\d+)?$/.test(f.curve.tradingFeesEth) && f.pool.measured === false);
  await assert.rejects(ask(ctx, "chain.token", { token: "0x00000000000000000000000000000000000000aa" }), /./);
});

test("liquidity events name the pool, the direction and the range", async () => {
  const { ctx } = await indexed();
  const d = await ask(ctx, "chain.liquidity", { limit: "100" });
  assert.equal(d.count, Math.min(100, fix.meta.counts.liquidity));
  for (const e of d.events as J[]) {
    assert.ok(e.kind === "add" || e.kind === "remove");
    assert.equal(e.kind === "add", BigInt(e.liquidityDelta) >= 0n);
    assert.ok(e.tickLower < e.tickUpper);
  }
});

test("a query the node refuses as too large is split in half until it fits, and a refusal is not an error", async () => {
  const asked: [number, number][] = [];
  const transport = custom({
    async request({ method, params }) {
      if (method !== "eth_getLogs") throw new Error("unexpected");
      const q = (params as { fromBlock: string; toBlock: string }[])[0];
      const [from, to] = [Number(q.fromBlock), Number(q.toBlock)];
      asked.push([from, to]);
      if (to - from + 1 > 250) throw Object.assign(new Error("RPC"), { details: "logs matched by query exceeds limit of 10000" });
      return [];
    },
  });
  const ctx = testCtx({}, { transport });
  const logs = await getLogs(ctx, { address: ADDR.poolManager, event: evSwap, fromBlock: 1000n, toBlock: 1999n });
  assert.equal(logs.length, 0);
  const leaves = asked.filter(([a, b]) => b - a + 1 <= 250).sort((x, y) => x[0] - y[0]);
  assert.equal(leaves[0][0], 1000);
  assert.equal(leaves[leaves.length - 1][1], 1999);
  for (let i = 1; i < leaves.length; i++) assert.equal(leaves[i][0], leaves[i - 1][1] + 1, "the pieces cover the range with no gap and no overlap");
});

test("an unfiltered query never spans more blocks than the node allows", async () => {
  const spans: number[] = [];
  const transport = custom({ request: async ({ params }) => (spans.push(Number((params as { toBlock: string }[])[0].toBlock) - Number((params as { fromBlock: string }[])[0].fromBlock) + 1), []) });
  const ctx = testCtx({}, { transport });
  await getLogs(ctx, { event: evSwap, fromBlock: 0n, toBlock: 99_999n });
  assert.ok(Math.max(...spans) <= 30_000 && spans.reduce((a, b) => a + b, 0) === 100_000);
});

test("price and dollar arithmetic is exact", () => {
  assert.equal(priceOf(10n ** 18n, 4n * 10n ** 18n, 18, 18), "0.25");
  assert.equal(priceOf(1_500_000n, 3n * 10n ** 18n, 18, 6), "0.5");
  assert.equal(priceOf(1n, 0n, 18, 18), null);
  const ctx = testCtx();
  assert.equal(usdOf(ctx, ZERO, 10n ** 18n), null, "no dollar value without a price reading");
  ctx.mem.set("ethusd", 3_000_12345678n);
  assert.equal(usdOf(ctx, ZERO, 10n ** 18n), "3000.12");
  assert.equal(usdOf(ctx, ZERO, 5n * 10n ** 17n), "1500.06");
  assert.equal(usdOf(ctx, ADDR.usdg.toLowerCase(), 2_500_000n), "2.5");
  assert.equal(usdOf(ctx, "0x00000000000000000000000000000000000000aa", 1n), null);
});

test("names from strangers are cleaned and pool ids are derived the standard way", () => {
  assert.equal(cleanName("  Good\u0000 Coin‮\n  "), "Good Coin");
  assert.equal(cleanName("x".repeat(200)).length, 48);
  assert.equal(cleanName(undefined), "");
  const id = poolIdOf(ZERO, "0x00000000000000000000000000000000000000aa", 0, 200, ADDR.ponsHook);
  assert.ok(/^0x[0-9a-f]{64}$/.test(id));
  assert.notEqual(id, poolIdOf(ZERO, "0x00000000000000000000000000000000000000aa", 0, 60, ADDR.ponsHook));
});
