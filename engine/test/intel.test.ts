// The token price oracle, answers that agree across sources, and chain intelligence.
import assert from "node:assert/strict";
import { test } from "node:test";
import { recoverMessageAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { reconcile, type History } from "../src/agree.ts";
import { FEEDS } from "../src/catalog.ts";
import { collect, feedUptime, normalizeParams, peek, type Feed, type Source } from "../src/collect.ts";
import { priceAgreeAll, priceAgreeOne, PRICE_TOLERANCE_BPS, type PricePoint } from "../src/chain/prices.ts";
import { twap, twapRule, twapUpdate, twapUpdateHash } from "../src/chain/twap.ts";
import { verifyValue } from "../src/sign.ts";
import { HttpError, ZERO } from "../src/util.ts";
import { chainScenario, ENGINE_KEY, readJson, replayTransport, testCtx, type Tape } from "./helpers.ts";

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Ctx = ReturnType<typeof testCtx>;
const fix = readJson<{ meta: { from: string; to: string; token: string; busy: string; wallet: string; counts: J }; tape: Tape }>("chain.json");
const feed = (id: string) => FEEDS.find((f) => f.id === id)!;
const ask = async (ctx: Ctx, id: string, p: Record<string, string>) => (await collect(ctx, feed(id), normalizeParams(feed(id), p), 0)).data as J;
async function indexed() {
  const ctx = testCtx({}, { transport: replayTransport(fix.tape) });
  await chainScenario(ctx, BigInt(fix.meta.from), BigInt(fix.meta.to));
  return ctx;
}
const refused = async (run: Promise<unknown>, code: string): Promise<HttpError> => {
  try {
    await run;
  } catch (e) {
    assert.ok(e instanceof HttpError && e.code === code, `expected ${code}, got ${String((e as Error).message)}`);
    return e;
  }
  throw new Error(`expected ${code}, but it answered`);
};

// ---------- answers that agree across sources ----------

const T0 = 1_800_000_000;
const point = (price: string, updatedAtSec = T0, over: Partial<PricePoint> = {}): PricePoint => ({ symbol: "NVDA", name: "NVDA / USD", kind: "equity", session: "24/5", quote: "USD", price, raw: price.replace(".", ""), decimals: 2, roundId: String(updatedAtSec), updatedAt: new Date(updatedAtSec * 1000).toISOString(), updatedAtSec, ageSeconds: 0, heartbeat: 3600, resting: false, feed: ZERO, ...over });
/** A source whose next answer the test sets by hand, so it can be made to lie. */
const src = (id: string, first: PricePoint | (() => PricePoint)) => {
  const s = { id, next: first as PricePoint | (() => PricePoint) | Error, calls: 0, run: async () => {
    s.calls++;
    if (s.next instanceof Error) throw s.next;
    return { data: typeof s.next === "function" ? s.next() : s.next };
  } };
  return s as Source & { next: PricePoint | (() => PricePoint) | Error; calls: number };
};
const priceFeedOf = (sources: Source[], id = "t.price"): Feed => ({ id, group: "chain", title: "T", summary: "", params: [{ name: "symbol", type: "symbol", required: true, doc: "" }], price: "0.001", ttl: 15, sources, agree: priceAgreeOne, example: {} });
// maxAge -1: never from the hot cache, so every call asks the sources again
const one = async (ctx: Ctx, f: Feed) => (await collect(ctx, f, { symbol: "NVDA" }, -1)).data as PricePoint & { agreement: J };

test("the price feeds ask two independent sources and are set to compare them", () => {
  for (const id of ["chain.price", "chain.prices"]) {
    const f = feed(id);
    assert.deepEqual(f.sources.map((s) => s.id), ["chainlink", "chainlink-secondary"]);
    assert.ok(f.agree && f.agree.toleranceBps === PRICE_TOLERANCE_BPS);
  }
});

test("two sources that agree: the answer says how many agreed and how far apart they were, and both were asked", async () => {
  const ctx = testCtx();
  const a = src("a", point("100.00"));
  const b = src("b", point("100.40"));
  const d = await collect(ctx, priceFeedOf([a, b]), { symbol: "NVDA" }, 0);
  const p = d.data as PricePoint & { agreement: J };
  assert.equal(a.calls + b.calls, 2, "both sources are asked every time, not just the first");
  assert.equal(p.price, "100.00");
  assert.deepEqual([p.agreement.sources, p.agreement.agreed, p.agreement.checked], [2, 2, true]);
  assert.deepEqual(p.agreement.agreedSources, ["a", "b"]);
  assert.equal(p.agreement.spreadBps, 40);
  assert.equal(p.agreement.toleranceBps, PRICE_TOLERANCE_BPS);
  assert.deepEqual(p.agreement.dropped, []);
  assert.equal(d.source, "a");
  assert.ok(await verifyValue({ feed: d.feed, params: d.params, data: d.data, source: d.source, collectedAt: d.collectedAt }, d.signature, ctx.signer.address), "what is signed includes the agreement");
});

test("a source that lies about the price: with two sources there is no answer, and the caller is told why", async () => {
  const ctx = testCtx();
  const f = priceFeedOf([src("a", point("100.00")), src("liar", point("131.00"))]);
  const e = await refused(collect(ctx, f, { symbol: "NVDA" }, 0), "sources_disagree");
  assert.equal(e.status, 503);
  assert.match(e.message, /basis points apart/);
  assert.match(e.message, /not charged/);
  const ag = e.extra.agreement as J;
  assert.deepEqual([ag.sources, ag.agreed, ag.checked], [2, 0, false]);
  assert.ok(ag.spreadBps > PRICE_TOLERANCE_BPS);
  assert.equal(peek(ctx, f, { symbol: "NVDA" }), null, "nothing was signed or cached");
  assert.equal(feedUptime(ctx, f.id).uptime, 0, "and the feed's uptime shows the failed collection");
});

test("a source that lies about the price: with three sources the liar is dropped and named, and the other two answer", async () => {
  const ctx = testCtx();
  const p = await one(ctx, priceFeedOf([src("a", point("100.00")), src("liar", point("131.00")), src("c", point("100.20"))]));
  assert.equal(p.price, "100.00");
  assert.deepEqual([p.agreement.sources, p.agreement.agreed, p.agreement.checked], [3, 2, true]);
  assert.deepEqual(p.agreement.agreedSources, ["a", "c"]);
  assert.equal(p.agreement.dropped.length, 1);
  assert.deepEqual([p.agreement.dropped[0].source, p.agreement.dropped[0].reason, p.agreement.dropped[0].value], ["liar", "disagrees", 131]);
  assert.ok(p.agreement.dropped[0].offBps > 2000);
  // even when the liar is listed first, it is not the one the answer is taken from
  const q = await one(testCtx(), priceFeedOf([src("liar", point("131.00")), src("a", point("100.00")), src("c", point("100.20"))]));
  assert.equal(q.price, "100.00");
});

test("a source with a stale time is dropped as stale, even when its price looks right", async () => {
  // b last updated two hours ago, past its one-hour heartbeat, while a and c updated just now
  const stale = point("100.00", T0 - 7200);
  const p = await one(testCtx(), priceFeedOf([src("a", point("100.10")), src("b", stale), src("c", point("100.20"))]));
  assert.deepEqual([p.agreement.agreed, p.agreement.dropped[0].source, p.agreement.dropped[0].reason], [2, "b", "stale"]);
  assert.equal(p.agreement.dropped[0].at, T0 - 7200);
  // with only two sources, the fresh one alone is not agreement: no answer
  const e = await refused(collect(testCtx(), priceFeedOf([src("a", point("100.10")), src("b", stale)]), { symbol: "NVDA" }, 0), "sources_disagree");
  assert.match(e.message, /dropped as stale/);
  assert.equal((e.extra.agreement as J).dropped[0].reason, "stale");
  // two sources that are both resting (a weekend) are not stale against each other
  const rest = await one(testCtx(), priceFeedOf([src("a", point("100.10", T0 - 90000)), src("b", point("100.00", T0 - 90010))]));
  assert.deepEqual([rest.agreement.agreed, rest.agreement.dropped.length], [2, 0]);
});

test("a source frozen on one value while its clock keeps moving is caught, though each reading is within tolerance", async () => {
  const ctx = testCtx();
  let i = 0;
  // a and c move a little every round; b reports a new time every round and the same value every time
  const a = src("a", () => point((100 + i * 0.1).toFixed(2), T0 + i * 60));
  const c = src("c", () => point((100.05 + i * 0.1).toFixed(2), T0 + i * 60));
  const b = src("frozen", () => point("100.00", T0 + i * 60));
  const f = priceFeedOf([a, b, c]);
  const seen: J[] = [];
  for (i = 0; i < 5; i++) seen.push((await one(ctx, f)).agreement);
  assert.deepEqual(seen[0].dropped, [], "one identical reading proves nothing");
  assert.equal(seen[2].agreed, 3, "nor do three");
  const last = seen[4];
  assert.deepEqual([last.agreed, last.dropped.length, last.dropped[0].source, last.dropped[0].reason], [2, 1, "frozen", "frozen"]);
  assert.ok(last.spreadBps <= PRICE_TOLERANCE_BPS);
  // a calm market is not a frozen source: when nobody moves, nobody is dropped
  const calm = testCtx();
  const g = priceFeedOf([src("a", () => point("100.00", T0 + i * 60)), src("b", () => point("100.00", T0 + i * 60))]);
  for (i = 0; i < 6; i++) assert.deepEqual((await one(calm, g)).agreement.dropped, []);
});

test("when one source cannot be reached the other still answers, and the answer says it was not checked", async () => {
  const ctx = testCtx();
  const down = src("b", point("1"));
  down.next = new Error("node unreachable");
  const p = await one(ctx, priceFeedOf([src("a", point("100.00")), down]));
  assert.deepEqual([p.agreement.sources, p.agreement.agreed, p.agreement.checked, p.agreement.spreadBps], [1, 1, false, null]);
  assert.deepEqual(p.agreement.unreachable, ["b"]);
  // and when neither can be reached, it is the usual clear error
  const both = priceFeedOf([down, down]);
  await refused(collect(testCtx(), both, { symbol: "NVDA" }, 0), "all_sources_failed");
});

test("on the board every symbol is compared on its own: a symbol that does not agree is withheld, the rest are given", async () => {
  const ctx = testCtx();
  const board = (pts: PricePoint[]): Source => ({ id: "", run: async () => ({ data: { count: pts.length, prices: pts } }) });
  const A = [point("100.00", T0, { symbol: "NVDA" }), point("50.00", T0, { symbol: "AAPL" }), point("9.00", T0, { symbol: "ETH" })];
  const B = [point("100.30", T0, { symbol: "NVDA" }), point("80.00", T0, { symbol: "AAPL" })]; // AAPL is far off; ETH has one source only
  const f: Feed = { id: "t.board", group: "chain", title: "T", summary: "", params: [], price: "0.005", ttl: 15, sources: [{ ...board(A), id: "a" }, { ...board(B), id: "b" }], agree: priceAgreeAll, example: {} };
  const d = (await collect(ctx, f, {}, 0)).data as J;
  assert.deepEqual(d.prices.map((p: J) => [p.symbol, p.agreed, p.spreadBps]), [["ETH", 1, null], ["NVDA", 2, 30]]);
  assert.equal(d.count, 2);
  assert.deepEqual([d.agreement.checked, d.agreement.single, d.agreement.withheld.length], [1, 1, 1]);
  assert.equal(d.agreement.withheld[0].symbol, "AAPL");
  assert.match(d.agreement.withheld[0].why, /no telling which one is wrong/);
});

test("the comparison itself: tolerance is measured from the middle, and a reading is never dropped without a second opinion", () => {
  const rule = { toleranceBps: 100, maxLagSec: 3600, frozenAfter: 3 };
  const r = (value: number, at = T0) => [{ key: "X", value, at, heartbeat: 3600 }];
  const v = (answers: [string, number, number?][], hist: History = new Map()) => reconcile(answers.map(([source, value, at]) => ({ source, readings: r(value, at) })), rule, hist).get("X")!;
  assert.deepEqual([v([["a", 100], ["b", 101]]).ok, v([["a", 100], ["b", 101]]).spreadBps], [true, 100]);
  assert.equal(v([["a", 100], ["b", 101.1]]).ok, false);
  assert.deepEqual([v([["a", 100]]).ok, v([["a", 100]]).agreed, v([["a", 100]]).dropped.length], [true, 1, 0], "a lone source is given out as it is, and marked as unchecked by its count");
  assert.equal(v([["a", 100, T0 - 999999]]).dropped.length, 0, "an old reading with nothing to compare it to is not called stale");
  const four = v([["a", 100], ["b", 100.2], ["c", 99.9], ["d", 250]]);
  assert.deepEqual([four.agreed, four.dropped.map((d) => d.source)], [3, ["d"]]);
});

// ---------- the time-weighted token price ----------

const TOKEN = "0x00000000000000000000000000000000000000aa";
const NOW = 1_800_100_000;
/** A market with one trade every `step` seconds at a price in ETH per token, from many wallets. */
function market(ctx: Ctx, opts: { n?: number; step?: number; price?: (i: number) => number; venue?: "curve" | "pool"; wallets?: number; size?: number; endsAt?: number } = {}) {
  const { n = 40, step = 30, price = () => 0.000002, venue = "pool", wallets = 8, size = 0.05, endsAt = NOW - 10 } = opts;
  ctx.mem.set("ethusd", 2000n * 10n ** 8n);
  ctx.db.prepare("INSERT OR REPLACE INTO tokens (address, curve, name, symbol, deployer, launch_block, launch_time, launch_seen, phase, pool_id, supply) VALUES (?, ?, 'T', 'TKN', ?, 1, ?, 1, ?, ?, ?)").run(TOKEN, "0x00000000000000000000000000000000000000cc", "0x00000000000000000000000000000000000000dd", NOW - 86400, venue === "pool" ? 2 : 0, venue === "pool" ? "0xpool" : null, (10n ** 27n).toString());
  for (let i = 0; i < n; i++) trade(ctx, { block: 1000 + i, time: endsAt - (n - 1 - i) * step, price: price(i), eth: size, trader: `0x${String(i % wallets).padStart(40, "0")}`, venue });
}
let logIndex = 0;
function trade(ctx: Ctx, t: { block: number; time: number; price: number; eth: number; trader?: string; venue?: "curve" | "pool"; side?: "buy" | "sell"; token?: string }) {
  const quote = BigInt(Math.round(t.eth * 1e9)) * 10n ** 9n;
  const amount = (quote * 10n ** 18n) / BigInt(Math.round(t.price * 1e18));
  ctx.db.prepare("INSERT INTO trades (token, block, log_index, tx, time, side, trader, quote, amount, venue, quote_asset) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(t.token ?? TOKEN, t.block, logIndex++, `0xtx${t.block}_${logIndex}`, t.time, t.side ?? "buy", t.trader ?? "0x00000000000000000000000000000000000000ee", quote.toString(), amount.toString(), t.venue ?? "pool", ZERO);
}
const rule = twapRule(1800);
const near = (got: string | null, want: number, tolerance = 0.01) => got !== null && Math.abs(Number(got) / want - 1) <= tolerance;

test("a steady market gives the price it traded at, with the evidence it was built from", () => {
  const ctx = testCtx();
  market(ctx);
  const t = twap(ctx, TOKEN, rule, NOW);
  assert.equal(t.thin, false, t.reasons.join("; "));
  assert.ok(near(t.price, 0.000002, 0.0001), `price ${t.price}`);
  assert.ok(near(t.priceUsd, 0.004, 0.0001), `usd ${t.priceUsd}`);
  assert.equal(BigInt(t.priceX18!) > 0n, true);
  assert.deepEqual([t.stats.trades, t.stats.blocks, t.stats.blocksTrimmed, t.stats.traders], [40, 40, 0, 8]);
  assert.deepEqual([t.evidence.firstBlock, t.evidence.lastBlock], [1000, 1039]);
  assert.equal(t.atSec, NOW - 10);
  assert.equal(t.venue, "pool");
});

test("attack: one block at ten times the price is trimmed and does not move the average", () => {
  const ctx = testCtx();
  market(ctx, { price: (i) => (i === 25 ? 0.00002 : 0.000002) });
  const t = twap(ctx, TOKEN, rule, NOW);
  assert.equal(t.thin, false);
  assert.ok(near(t.price, 0.000002, 0.0001), `price ${t.price}`);
  assert.equal(t.stats.blocksTrimmed, 1);
  assert.deepEqual([t.evidence.trimmed[0].block, t.evidence.trimmed[0].offBps], [1025, 90000]);
});

test("attack: stuffing one block with many large trades counts as one block, not as many", () => {
  const ctx = testCtx();
  market(ctx, { price: () => 0.000002 });
  // 60 trades in a single block, each ten times the usual size, at a price 8% up (inside the trimming band on purpose)
  for (let k = 0; k < 60; k++) trade(ctx, { block: 1020, time: NOW - 10 - 19 * 30, price: 0.00000216, eth: 0.5 });
  const t = twap(ctx, TOKEN, rule, NOW);
  assert.equal(t.stats.trades, 100);
  assert.equal(t.stats.blocks, 40);
  // by volume the stuffed block is over 90% of the window; by time it is one block of forty
  assert.ok(near(t.price, 0.000002, 0.003), `price ${t.price} moved more than a block's worth`);
});

test("attack: a price pushed in the last seconds of the window barely counts, because it has barely stood", () => {
  const ctx = testCtx();
  market(ctx, { n: 40, step: 40, endsAt: NOW - 30 });
  trade(ctx, { block: 2000, time: NOW - 1, price: 0.0000021, eth: 5 }); // 5% up, one second before the reading
  const t = twap(ctx, TOKEN, rule, NOW);
  assert.ok(near(t.price, 0.000002, 0.0005), `price ${t.price}`);
  // and a long quiet stretch cannot make one price stand for the whole window: its weight is capped at a quarter
  const quiet = testCtx();
  market(quiet, { n: 12, step: 1, endsAt: NOW - 1700, price: (i) => (i === 11 ? 0.0000021 : 0.000002) });
  market(quiet, { n: 0 });
  for (let i = 0; i < 12; i++) trade(quiet, { block: 3000 + i, time: NOW - 200 + i * 10, price: 0.000002, eth: 0.05, trader: `0x${String(i % 8).padStart(40, "0")}` });
  const q = twap(quiet, TOKEN, rule, NOW);
  // uncapped, the 5% higher price would stand for 1500 of 1711 seconds and lift the average by 4.4%; capped it lifts it by 3.4%
  assert.ok(Number(q.price) > 0.000002 && Number(q.price) < 0.00000207, `one price held ${q.price} of the average`);
});

test("too little trading is a thin market: no price at all, and the reasons are spelled out", () => {
  const few = testCtx();
  market(few, { n: 5 });
  const a = twap(few, TOKEN, rule, NOW);
  assert.deepEqual([a.thin, a.price, a.priceX18, a.priceUsd], [true, null, null, null]);
  assert.ok(a.reasons.some((r) => /5 trades in the window, fewer than 12/.test(r)));
  assert.ok(a.reasons.some((r) => /blocks after trimming/.test(r)));

  const oneWallet = testCtx();
  market(oneWallet, { wallets: 1 });
  assert.ok(twap(oneWallet, TOKEN, rule, NOW).reasons.some((r) => /1 wallets traded, fewer than 4/.test(r)), "one wallet trading with itself is not a market");

  const dust = testCtx();
  market(dust, { size: 0.0001 });
  assert.ok(twap(dust, TOKEN, rule, NOW).reasons.some((r) => /traded in the window, less than \$500/.test(r)));

  const old = testCtx();
  market(old, { endsAt: NOW - 1200 });
  assert.ok(twap(old, TOKEN, rule, NOW).reasons.some((r) => /last trade was 1200 seconds ago/.test(r)));

  const none = testCtx();
  market(none, { n: 0 });
  assert.deepEqual(twap(none, TOKEN, rule, NOW).reasons, ["no trade in the window"]);

  const scattered = testCtx();
  market(scattered, { price: (i) => (i % 2 ? 0.000002 : 0.00002) });
  const s = twap(scattered, TOKEN, rule, NOW);
  assert.equal(s.thin, true);
  assert.ok(s.reasons.some((r) => /too scattered/.test(r)), s.reasons.join("; "));
  assert.equal(s.price, null);
});

test("too little liquidity is a thin market: a nearly empty curve, or a pool whose liquidity was taken out", () => {
  const curve = testCtx();
  market(curve, { venue: "curve", size: 0.02 }); // 40 buys of 0.02 ETH
  for (let i = 0; i < 38; i++) trade(curve, { block: 5000 + i, time: NOW - 9, price: 0.000002, eth: 0.02, side: "sell", venue: "curve", trader: `0x${String(i % 8).padStart(40, "0")}` });
  const c = twap(curve, TOKEN, rule, NOW);
  assert.equal(c.stats.curveReserveUsd, "80");
  assert.ok(c.thin && c.reasons.some((r) => /the curve holds \$80, less than \$250/.test(r)), c.reasons.join("; "));

  const pool = testCtx();
  market(pool);
  const liq = pool.db.prepare("INSERT INTO liquidity (pool_id, block, log_index, tx, time, sender, tick_lower, tick_upper, delta) VALUES ('0xpool', ?, ?, '0xl', ?, '0x', 0, 0, ?)");
  liq.run(900, 1, NOW - 5000, "1000000");
  assert.equal(twap(pool, TOKEN, rule, NOW).thin, false);
  liq.run(1039, 99, NOW - 11, "-1000000");
  const p = twap(pool, TOKEN, rule, NOW);
  assert.ok(p.thin && p.reasons.includes("the liquidity added to the pool has been taken out again"));
});

test("the engine signs an update the oracle contract accepts: same bytes, the engine's key, and thin carries no price", async () => {
  const oracle = "0x00000000000000000000000000000000000ac1e5";
  const ctx = testCtx({ tokenOracle: oracle as `0x${string}`, payChainId: 31337 });
  market(ctx);
  const t = twap(ctx, TOKEN, rule, NOW);
  const u = await twapUpdate(ctx, t, NOW);
  assert.deepEqual([u.price, u.timestamp, u.window, u.thin, u.decimals, u.chainId, u.oracle], [t.priceX18, NOW - 10, 1800, false, 18, 31337, oracle]);
  assert.equal(u.hash, twapUpdateHash(31337n, oracle, TOKEN, BigInt(t.priceX18!), NOW - 10, 1800, false));
  const engine = privateKeyToAccount(ENGINE_KEY).address;
  assert.equal(await recoverMessageAddress({ message: { raw: u.hash }, signature: u.signature }), engine);
  // the same vector the contract's own test checks (contracts/test/TwapOracle.t.sol)
  assert.equal(twapUpdateHash(31337n, oracle, "0x1111111111111111111111111111111111111111", 123456789012345678n, 1_800_000_000, 1800, false), "0xd143c26b984f8853ddb4e50faccba1c8000b1bd0174484572b059e5b87c914f6");
  // a thin market is signed too, with no price, dated when it was read
  const thinCtx = testCtx({ tokenOracle: oracle as `0x${string}`, payChainId: 31337 });
  market(thinCtx, { n: 3 });
  const tu = await twapUpdate(thinCtx, twap(thinCtx, TOKEN, rule, NOW), NOW);
  assert.deepEqual([tu.price, tu.thin, tu.timestamp], ["0", true, NOW]);
  assert.ok(tu.reasons.length > 0);
  assert.equal(await recoverMessageAddress({ message: { raw: tu.hash }, signature: tu.signature }), engine);
  // a different chain or contract gives different bytes, so an update cannot be carried elsewhere
  assert.notEqual(twapUpdateHash(1n, oracle, TOKEN, 1n, 1, 1800, false), twapUpdateHash(31337n, oracle, TOKEN, 1n, 1, 1800, false));
});

test("on recorded blocks the price feed answers from the index and is signed like any other answer", async () => {
  const ctx = await indexed();
  const f = feed("chain.twap");
  const d = await collect(ctx, f, normalizeParams(f, { token: fix.meta.token }), 0);
  const t = d.data as J;
  // the recording is old, so there is no trade in the last half hour: a thin market, said plainly
  assert.deepEqual([t.thin, t.price, t.reasons], [true, null, ["no trade in the window"]]);
  assert.ok(await verifyValue({ feed: d.feed, params: d.params, data: d.data, source: d.source, collectedAt: d.collectedAt }, d.signature, ctx.signer.address));
  // read as of the last recorded trade, the same token has a real window of trades behind it
  const last = (ctx.db.prepare("SELECT MAX(time) t FROM trades WHERE token = ?").get(fix.meta.token) as { t: number }).t;
  const then = twap(ctx, fix.meta.token, twapRule(1800), last + 1);
  assert.ok(then.stats.trades > 0 && then.evidence.firstTx && then.evidence.lastTx);
  const rows = ctx.db.prepare("SELECT tx FROM trades WHERE token = ?").all(fix.meta.token) as { tx: string }[];
  assert.ok(rows.some((r) => r.tx === then.evidence.lastTx), "the evidence is a real transaction from the tape");
  if (!then.thin) assert.ok(Number(then.price) > 0);
  else assert.ok(then.reasons.length > 0);
});

// ---------- chain intelligence ----------

test("who sniped a launch, on recorded blocks: every wallet bought inside the window and names its transactions", async () => {
  const ctx = await indexed();
  const tok = ctx.db.prepare("SELECT launch_block, launch_time, deployer, supply FROM tokens WHERE address = ?").get(fix.meta.token) as { launch_block: number; launch_time: number; deployer: string; supply: string };
  const d = await ask(ctx, "chain.snipers", { token: fix.meta.token, blocks: "3" });
  assert.equal(d.token, fix.meta.token);
  assert.deepEqual([d.launch.block, d.launch.deployer], [tok.launch_block, tok.deployer]);
  assert.deepEqual(d.window, { blocks: 3, fromBlock: tok.launch_block, toBlock: tok.launch_block + 3 });
  const inWindow = ctx.db.prepare("SELECT DISTINCT trader FROM trades WHERE token = ? AND side = 'buy' AND block <= ?").all(fix.meta.token, tok.launch_block + 3) as { trader: string }[];
  assert.equal(d.wallets, inWindow.length);
  assert.deepEqual((d.snipers as J[]).map((s) => s.wallet).sort(), inWindow.map((r) => r.trader).sort());
  const has = ctx.db.prepare("SELECT 1 FROM trades WHERE tx = ? AND block = ? AND trader = ? AND side = 'buy'");
  let share = 0;
  for (const s of d.snipers as J[]) {
    assert.ok(s.firstBuy.blocksAfterLaunch >= 0 && s.firstBuy.blocksAfterLaunch <= 3);
    assert.ok(s.evidence.length >= 1);
    for (const e of s.evidence as J[]) assert.ok(has.get(e.tx, e.block, s.wallet), "each piece of evidence is a buy by that wallet on the tape");
    assert.ok(Number(s.tokensBought) > 0 && Number(s.spent) > 0);
    share += s.shareOfSupplyBps;
  }
  assert.ok(Math.abs(share - d.shareOfSupplyBps) <= d.wallets, "the shares add up to the total");
  // a wider window can only add wallets
  const wide = await ask(ctx, "chain.snipers", { token: fix.meta.token, blocks: "20" });
  assert.ok(wide.wallets >= d.wallets);
  // a token whose launch the index did not see is not guessed at
  const e = await refused(collect(ctx, feed("chain.snipers"), normalizeParams(feed("chain.snipers"), { token: "0x00000000000000000000000000000000000000ab" }), 0), "launch_not_indexed");
  assert.equal(e.status, 404);
});

test("a deployer's history, on recorded blocks: what was launched and what became of it, in facts", async () => {
  const ctx = await indexed();
  const dep = (ctx.db.prepare("SELECT deployer FROM tokens WHERE address = ?").get(fix.meta.token) as { deployer: string }).deployer;
  const d = await ask(ctx, "chain.deployer", { address: dep });
  const n = (ctx.db.prepare("SELECT COUNT(*) n FROM tokens WHERE deployer = ?").get(dep) as { n: number }).n;
  assert.deepEqual([d.deployer, d.tokensLaunched, d.listed], [dep, n, n]);
  const t = (d.tokens as J[]).find((x) => x.token === fix.meta.token)!;
  assert.equal(t.phase, "curve");
  assert.ok(t.whatHappened.includes("still on its launch curve"));
  assert.equal(t.trades, (ctx.db.prepare("SELECT COUNT(*) n FROM trades WHERE token = ?").get(fix.meta.token) as { n: number }).n);
  assert.ok(["trading", "quiet", "liquidity removed", "no trades seen"].includes(t.ended));
  const s = d.summary;
  assert.equal(s.trading + s.quiet + s.liquidityRemoved + s.noTradesSeen, d.listed);
  // a wallet that never launched anything has an empty, honest history
  const none = await ask(ctx, "chain.deployer", { address: "0x00000000000000000000000000000000000000ab" });
  assert.deepEqual([none.tokensLaunched, none.tokens], [0, []]);
});

test("a deployer whose pool was emptied and who sold: the answer says exactly that, with the transactions", async () => {
  const ctx = testCtx();
  const dep = "0x00000000000000000000000000000000000000dd";
  market(ctx);
  ctx.db.prepare("INSERT INTO liquidity (pool_id, block, log_index, tx, time, sender, tick_lower, tick_upper, delta) VALUES ('0xpool', 900, 1, '0xadd', ?, '0x', 0, 0, '500')").run(NOW - 5000);
  ctx.db.prepare("INSERT INTO liquidity (pool_id, block, log_index, tx, time, sender, tick_lower, tick_upper, delta) VALUES ('0xpool', 1040, 1, '0xpull', ?, '0x', 0, 0, '-500')").run(NOW - 5);
  trade(ctx, { block: 1041, time: NOW - 4, price: 0.000002, eth: 1, side: "sell", trader: dep });
  kv(ctx);
  const d = await ask(ctx, "chain.deployer", { address: dep });
  const t = d.tokens[0];
  assert.equal(t.ended, "liquidity removed");
  assert.deepEqual(t.liquidity.lastRemoval.tx, "0xpull");
  assert.equal(t.liquidity.allRemoved, true);
  assert.deepEqual([t.deployerTrades.sells, t.deployerTrades.received, t.deployerTrades.firstSell.block], [1, "1", 1041]);
  assert.ok(t.whatHappened.some((w: string) => /all liquidity the index saw added to its pool was removed again, last at block 1040/.test(w)));
  assert.ok(t.whatHappened.includes("the deployer sold it 1 time"));
  assert.equal(d.summary.liquidityRemoved, 1);
});

/** The index head, so the feeds know the index is up. */
const kv = (ctx: Ctx) => ctx.db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('index_head', '99999'), ('index_block', '99999'), ('index_start', '1')").run();
const w = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

test("holder clusters: wallets are linked by token transfers and by buying together twice, never by one shared block", async () => {
  const ctx = testCtx();
  market(ctx, { n: 0 });
  kv(ctx);
  const send = ctx.db.prepare("INSERT INTO transfers (token, block, log_index, tx, time, sender, recipient, amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  let li = 0;
  // wallet 1 sends the token to 2 and 3: one sender, two recipients
  send.run(TOKEN, 10, li++, "0xs12", NOW, w(1), w(2), (10n ** 24n).toString());
  send.run(TOKEN, 11, li++, "0xs13", NOW, w(1), w(3), (10n ** 24n).toString());
  // 4 and 5 buy in the same block twice; 6 and 7 share a block only once
  for (const [block, a, b] of [[20, 4, 5], [21, 4, 5], [22, 6, 7]] as const) for (const x of [a, b]) trade(ctx, { block, time: NOW, price: 0.000002, eth: 0.1, trader: w(x) });
  // the curve sends to forty wallets: a venue, which links nobody
  for (let i = 0; i < 40; i++) send.run(TOKEN, 30, li++, "0xv", NOW, "0x00000000000000000000000000000000000000cc", w(100 + i), "1");
  // a busy wallet with thirty recipients is treated the same way
  for (let i = 0; i < 30; i++) send.run(TOKEN, 31, li++, "0xh", NOW, w(9), w(200 + i), "1");
  ctx.db.prepare("INSERT INTO holder_progress (token, from_block, last_block) VALUES (?, 1, 99999)").run(TOKEN);
  const hold = ctx.db.prepare("INSERT INTO holders (token, holder, balance) VALUES (?, ?, ?)");
  hold.run(TOKEN, w(2), (3n * 10n ** 25n).toString());
  hold.run(TOKEN, w(3), (2n * 10n ** 25n).toString());
  const d = await ask(ctx, "chain.clusters", { token: TOKEN });
  assert.equal(d.clusters, 2);
  const [big, pair] = d.list as J[];
  assert.deepEqual(big.members.map((m: J) => m.wallet).sort(), [w(1), w(2), w(3)]);
  assert.deepEqual(big.linkedBy.sort(), ["same sender", "sent tokens"]);
  assert.equal(big.shareBps, 500, "the cluster holds 5% of the supply between its wallets");
  assert.ok(big.evidence.some((e: J) => e.tx === "0xs12" && e.kind === "sent tokens") && big.evidence.some((e: J) => e.kind === "same sender" && /both received the token from/.test(e.detail)));
  assert.deepEqual(pair.members.map((m: J) => m.wallet).sort(), [w(4), w(5)]);
  assert.deepEqual(pair.linkedBy, ["bought together"]);
  assert.match(pair.evidence[0].detail, /bought in the same block 2 times \(blocks 20, 21\)/);
  const all = JSON.stringify(d);
  for (const lone of [w(6), w(7), w(100), w(200), w(9)]) assert.ok(!all.includes(lone), `${lone} is in no cluster`);
  assert.match(d.limits, /Plain ETH sent between wallets is not in the index/);
});

test("holder clusters on recorded blocks: every link points at a transaction on the tape", async () => {
  const ctx = await indexed();
  const d = await ask(ctx, "chain.clusters", { token: fix.meta.token });
  assert.equal(d.token, fix.meta.token);
  assert.ok((ctx.db.prepare("SELECT COUNT(*) n FROM transfers WHERE token = ?").get(fix.meta.token) as { n: number }).n === d.coverage.transfers);
  const curve = (ctx.db.prepare("SELECT curve FROM tokens WHERE address = ?").get(fix.meta.token) as { curve: string }).curve;
  for (const c of d.list as J[]) {
    assert.ok(c.wallets >= 2 && c.members.length >= 2);
    assert.ok(!c.members.some((m: J) => m.wallet === curve), "the curve is a venue, not a member");
    for (const e of c.evidence as J[]) assert.ok(ctx.db.prepare("SELECT 1 FROM transfers WHERE tx = ? UNION SELECT 1 FROM trades WHERE tx = ?").get(e.tx, e.tx), "the evidence is on the tape");
  }
  await refused(collect(ctx, feed("chain.clusters"), normalizeParams(feed("chain.clusters"), { token: "0x00000000000000000000000000000000000000ab" }), 0), "unknown_token");
});

test("wallets early in tokens that rose: counted from entries and later prices, a wallet's own launches left out", async () => {
  const ctx = testCtx();
  ctx.mem.set("ethusd", 2000n * 10n ** 8n);
  kv(ctx);
  const tokens = [1, 2, 3, 4].map((i) => `0x${"0".repeat(38)}a${i}`);
  const insTok = ctx.db.prepare("INSERT INTO tokens (address, name, symbol, deployer, launch_block, launch_time, launch_seen, phase, supply) VALUES (?, 'T', ?, ?, ?, ?, 1, ?, ?)");
  // tokens 1 and 2 rise fivefold, token 3 falls, token 4 was launched by the wallet itself and rises
  const later = [5, 5, 0.5, 5];
  tokens.forEach((token, i) => {
    const launch = NOW - 50000 + i * 1000;
    insTok.run(token, `T${i + 1}`, i === 3 ? w(1) : w(99), 100 + i * 100, launch, i === 0 ? 2 : 0, (10n ** 27n).toString());
    trade(ctx, { token, block: 100 + i * 100, time: launch + 5, price: 0.000001, eth: 0.1, trader: w(1) }); // wallet 1: early everywhere
    if (i < 2) trade(ctx, { token, block: 101 + i * 100, time: launch + 400, price: 0.000001, eth: 0.1, trader: w(2) }); // wallet 2: late
    if (i === 2) trade(ctx, { token, block: 101 + i * 100, time: launch + 8, price: 0.000001, eth: 0.1, trader: w(3) }); // wallet 3: early once
    for (let k = 0; k < 25; k++) trade(ctx, { token, block: 110 + i * 100 + k, time: launch + 1000 + k, price: 0.000001 * later[i], eth: 0.05, trader: w(50 + (k % 5)) });
  });
  const d = await ask(ctx, "chain.smartmoney", { entries: "3" });
  assert.equal(d.count, 1);
  const s = d.wallets[0];
  assert.deepEqual([s.wallet, s.earlyEntries, s.rose, s.roseShareBps, s.graduated], [w(1), 3, 2, 6667, 1]);
  assert.equal(s.evidence.length, 3, "its own launch is not counted for it");
  const e = s.evidence[0];
  assert.deepEqual([e.rose, e.entry.secondsAfterLaunch, e.entry.price, e.later.timesEntry], [true, 5, "0.000001", 5]);
  assert.ok(ctx.db.prepare("SELECT 1 FROM trades WHERE tx = ? AND trader = ?").get(e.entry.tx, w(1)));
  assert.equal(s.evidence[2].rose, false);
  // asking for fewer entries lets nobody in who has no token that rose
  const loose = await ask(ctx, "chain.smartmoney", { entries: "2" });
  assert.deepEqual(loose.wallets.map((x: J) => x.wallet), [w(1)]);
  assert.match(d.limits, /does not say why a wallet was early/);
});

test("wallets early in tokens that rose, on recorded blocks: one launch is not a record, so nobody is listed", async () => {
  const ctx = await indexed();
  const d = await ask(ctx, "chain.smartmoney", {});
  assert.deepEqual([d.count, d.wallets], [0, []]);
  assert.match(d.method, /at least 3 tokens within 60 seconds/);
});

test("the intelligence feeds are in the catalog with a price, and none of them passes judgement on anyone", async () => {
  const ids = ["chain.twap", "chain.snipers", "chain.deployer", "chain.clusters", "chain.smartmoney"];
  for (const id of ids) {
    const f = feed(id);
    assert.ok(f && Number(f.price) > 0 && f.group === "chain" && f.summary.length > 40, id);
    normalizeParams(f, f.example);
  }
  const ctx = await indexed();
  const dep = (ctx.db.prepare("SELECT deployer FROM tokens WHERE address = ?").get(fix.meta.token) as { deployer: string }).deployer;
  const answers = [await ask(ctx, "chain.snipers", { token: fix.meta.token }), await ask(ctx, "chain.deployer", { address: dep }), await ask(ctx, "chain.clusters", { token: fix.meta.token }), await ask(ctx, "chain.smartmoney", {})];
  const text = JSON.stringify([answers, ids.map((id) => [feed(id).title, feed(id).summary])]);
  assert.ok(!/scam|rug|fraud|criminal|thief|stole|malicious/i.test(text), "the answers describe what happened and call nobody names");
  assert.ok(!/[—–]/.test(text), "no long dashes");
});
