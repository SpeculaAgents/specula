import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { accessToken, Specula, SpeculaError, verifyAnswer, type Answer, type PaymentRequiredBody } from "../../packages/sdk/src/index.ts";
import { backtest, parseStrategy, step, type State, type Strategy, type Tick } from "../src/lab.ts";
import { startEngine, type Engine } from "../src/main.ts";
import { bountiesAbi, checkUrl } from "../src/market.ts";
import { HttpError, nowSec } from "../src/util.ts";
import { ANVIL_KEYS, ENGINE_KEY, localChain, readJson, replayFetch, replayTransport, testCtx, type FetchTape, type LocalChain, type Tape } from "./helpers.ts";

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const seller = privateKeyToAccount(ANVIL_KEYS.agent2);
const buyer = privateKeyToAccount(ANVIL_KEYS.agent);
const friend = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");
const treasury = privateKeyToAccount(ANVIL_KEYS.treasury).address;
let chain: LocalChain;
let e: Engine;
let shop: Server;
let shopUrl = "";
let mode: "ok" | "down" | "text" | "big" = "ok";
const docs = readJson<FetchTape>("docs.json");
const replay = replayFetch(docs);
const call = async (path: string, who: typeof seller | null, method = "GET", body?: unknown) => {
  const r = await fetch(`${e.url}${path}`, { method, headers: { ...(who ? { Authorization: `Specula ${await accessToken(who)}` } : {}), "content-type": "application/json", "x-forwarded-for": "10.1.1.1" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: (await r.json()) as J };
};
const sdk = (who: typeof seller) => new Specula({ baseUrl: e.url, account: who, maxPricePerCall: "5" });
const listing = (over: J = {}) => ({ slug: "weather", title: "City weather now", summary: "Temperature and wind for a city, read from a station network.", price: "0.25", url: `${shopUrl}/weather`, params: [{ name: "city", required: true, doc: "City name." }], ...over });

before(async () => {
  shop = createServer((req, res) => {
    const u = new URL(req.url!, "http://x");
    if (mode === "down") return void res.writeHead(500).end("no");
    if (mode === "text") return void res.writeHead(200).end("hello, not json");
    if (mode === "big") return void res.writeHead(200).end(JSON.stringify({ blob: "x".repeat(300_000) }));
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ city: u.searchParams.get("city"), tempC: 7.5, windMs: 3 }));
  });
  await new Promise<void>((r) => shop.listen(0, "127.0.0.1", r));
  shopUrl = `http://127.0.0.1:${(shop.address() as { port: number }).port}`;
  chain = await localChain(4147, privateKeyToAccount(ENGINE_KEY).address);
  await chain.mint(buyer.address, 50_000_000n);
  await chain.mint(friend.address, 5_000_000n);
  // The seller's shop is a local server; everything else (the SEC, the statistics) still comes from the recorded tape.
  const net: typeof fetch = ((u: string | URL | Request, i?: RequestInit) => (String(u).startsWith(shopUrl) ? fetch(u, i) : replay(u, i))) as typeof fetch;
  e = await startEngine(
    { port: 0, dbPath: ":memory:", engineKey: ENGINE_KEY, payments: true, payRpcUrl: chain.url, payChainId: 31337, payAsset: chain.usdg, payTo: treasury, relayerKey: ANVIL_KEYS.relayer, bounties: chain.bounties, marketAllowLocal: true, freeDaily: 1, freeDailyAnon: 1, secMinGapMs: 0, archiveEverySec: 300 },
    { jobs: false, env: {}, transport: replayTransport(readJson<{ tape: Tape }>("chain.json").tape), fetch: net },
  );
});
after(async () => {
  await e?.stop();
  chain?.stop();
  shop?.close();
});

// ---------- marketplace

test("a seller's endpoint must be a public https address", async () => {
  const ctx = testCtx();
  for (const bad of ["http://example.com/x", "https://localhost/x", "https://127.0.0.1/x", "https://10.0.0.8/x", "https://192.168.1.1/x", "https://169.254.169.254/latest", "https://[::1]/x", "https://user:pw@example.com/", "https://db.internal/x", "ftp://example.com", "not a url"])
    await assert.rejects(checkUrl(ctx, bad), (err: HttpError) => err.status === 400 && err.code === "bad_url", bad);
  assert.equal((await checkUrl(ctx, "https://1.1.1.1/data")).hostname, "1.1.1.1");
});

test("anyone with a wallet can list a feed; a listing is checked and belongs to its seller", async () => {
  assert.equal((await call("/v1/market/feeds", null, "POST", listing())).status, 401);
  for (const [over, why] of [[{ slug: "X" }, "slug"], [{ summary: "too short" }, "summary"], [{ price: "0" }, "price"], [{ price: "1000" }, "price"], [{ url: "nope" }, "url"], [{ params: [{ name: "bad name" }] }, "param"], [{ allow: ["0x12"] }, "allow"]] as const)
    assert.equal((await call("/v1/market/feeds", seller, "POST", listing(over))).status, 400, why);
  const made = await call("/v1/market/feeds", seller, "POST", listing());
  assert.equal(made.status, 201);
  assert.equal(made.body.id, "market.weather");
  assert.equal(made.body.private, false);
  assert.equal((await call("/v1/market/feeds", buyer, "POST", listing({ title: "Mine now" }))).status, 409, "another wallet cannot take the name");
  assert.equal((await call("/v1/market/feeds", seller, "POST", listing({ price: "0.3" }))).status, 200, "the seller can change it");
  const m = (await call("/v1/market", null)).body;
  assert.deepEqual([m.count, m.sellers, m.feeds[0].id, m.feeds[0].price, m.feeds[0].paid30d], [1, 1, "market.weather", "0.3", "0"]);
  const cat = (await call("/v1/catalog", null)).body.feeds.find((f: J) => f.id === "market.weather");
  assert.equal(cat.groupTitle, "Marketplace");
  assert.match(cat.seller, /^0x[0-9a-f]{4}…[0-9a-f]{4}$/);
});

test("a buyer pays the seller directly: the exact price lands in the seller's wallet and the engine holds nothing", async () => {
  const first = await fetch(`${e.url}/v1/feeds/market.weather?city=Oslo`);
  assert.equal(first.status, 402, "a seller's feed has no free allowance");
  const need = (await first.json()) as PaymentRequiredBody;
  assert.equal(need.accepts[0].payTo.toLowerCase(), seller.address.toLowerCase());
  assert.equal(need.accepts[0].maxAmountRequired, "300000");
  const [s0, t0, b0] = [await chain.balance(seller.address), await chain.balance(treasury), await chain.balance(buyer.address)];
  const a = (await sdk(buyer).get("market.weather", { city: "Oslo" })) as Answer<J>;
  assert.deepEqual(a.data, { city: "Oslo", tempC: 7.5, windMs: 3 });
  assert.match(a.source, /^seller:0x[0-9a-f]{4}…[0-9a-f]{4}$/);
  assert.equal(a.meta.paidBy, "x402");
  assert.ok(await verifyAnswer(a, privateKeyToAccount(ENGINE_KEY).address));
  assert.equal((await chain.balance(seller.address)) - s0, 300_000n);
  assert.equal((await chain.balance(buyer.address)) - b0, -300_000n);
  assert.equal(await chain.balance(treasury), t0);
  await assert.rejects(sdk(buyer).get("market.weather", {}), (err: SpeculaError) => err.status === 400, "the listing's own parameters are enforced");
  const mine = (await call("/v1/market/mine", seller)).body;
  assert.deepEqual([mine.earned30d, mine.feeds[0].paidCalls30d, mine.feeds[0].buyers30d, mine.feeds[0].url], ["0.3", 1, 1, `${shopUrl}/weather`]);
  assert.equal((await call("/v1/market", null)).body.feeds[0].paid30d, "0.3");
  // Prepaid credits are the engine's money, so they are never used for a seller's feed.
  await sdk(buyer).topUp("1");
  const b1 = await chain.balance(seller.address);
  const again = await sdk(buyer).get("market.weather", { city: "Bergen" });
  assert.equal(again.meta.paidBy, "x402");
  assert.equal((await chain.balance(seller.address)) - b1, 300_000n);
});

test("when a seller's endpoint fails, answers junk or answers too much, the buyer is not charged", async () => {
  const before = await chain.balance(buyer.address);
  for (const [m, why] of [["down", /answered 500/], ["text", /not JSON/], ["big", /larger than 256 KB/]] as const) {
    mode = m;
    await assert.rejects(sdk(buyer).get("market.weather", { city: `x${m}` }), (err: SpeculaError) => err.status === 502 && err.body.charged === false && why.test(JSON.stringify(err.body.tried)), m);
  }
  mode = "ok";
  assert.equal(await chain.balance(buyer.address), before);
  assert.ok((await call("/v1/market", null)).body.feeds[0].uptime24h < 1, "the listing's uptime shows the failures");
});

test("a private feed exists only for the wallets on its list", async () => {
  const made = await call("/v1/market/feeds", seller, "POST", listing({ slug: "desk", title: "Private desk notes", allow: [friend.address] }));
  assert.equal(made.status, 201);
  assert.deepEqual([made.body.private, made.body.allow], [true, [friend.address.toLowerCase()]]);
  assert.ok(!(await call("/v1/catalog", null)).body.feeds.some((f: J) => f.id === "market.desk"), "not in the public catalog");
  assert.equal((await call("/v1/market", null)).body.count, 1, "not in the public market");
  assert.equal((await call("/v1/market", null)).body.privateFeeds, 1);
  assert.equal((await call("/v1/catalog/market.desk", null)).status, 404);
  assert.equal((await fetch(`${e.url}/v1/feeds/market.desk?city=A`)).status, 404, "a stranger is told the feed does not exist");
  await assert.rejects(sdk(buyer).get("market.desk", { city: "A" }), (err: SpeculaError) => err.status === 404);
  const a = await sdk(friend).get("market.desk", { city: "A" });
  assert.equal(a.meta.paidBy, "x402");
  assert.deepEqual((await call("/v1/market/mine", friend)).body.visibleToMe.map((f: J) => f.id), ["market.desk"]);
  assert.equal((await call("/v1/archive", null)).body.feeds.some((f: J) => f.feed === "market.desk"), false, "private answers are not listed in the public archive");
  await assert.rejects(sdk(buyer).get("archive.at", { feed: "market.desk", params: "city=A" }), (err: SpeculaError) => err.status === 404);
});

test("a seller can take a listing down", async () => {
  assert.equal((await call("/v1/market/feeds/desk", buyer, "DELETE")).status, 404);
  assert.deepEqual((await call("/v1/market/feeds/desk", seller, "DELETE")).body, { removed: true });
  await assert.rejects(sdk(friend).get("market.desk", { city: "A" }), (err: SpeculaError) => err.status === 404);
});

// ---------- bounties

test("a bounty is a pledge until the escrow contract holds the money, then funded, then awarded", async () => {
  assert.equal((await call("/v1/bounties", buyer, "POST", { title: "short", detail: "x", amount: "5" })).status, 400);
  const made = await call("/v1/bounties", buyer, "POST", { title: "Hourly port congestion", detail: "Ships waiting at the ten largest container ports, updated every hour.", amount: "5", days: 7 });
  assert.equal(made.status, 201);
  const b = made.body;
  assert.deepEqual([b.status, b.amount, b.fund.contract.toLowerCase()], ["pledged", "5", chain.bounties.toLowerCase()]);
  assert.equal((await call("/v1/bounties", null)).body.open, 0, "a pledge is not counted as open money");
  const pub = createPublicClient({ chain: foundry, transport: http(chain.url), pollingInterval: 50 });
  const w = createWalletClient({ account: buyer, chain: foundry, transport: http(chain.url) });
  const erc = parseAbi(["function approve(address spender, uint256 value) returns (bool)"]);
  const mined = (hash: `0x${string}`) => pub.waitForTransactionReceipt({ hash });
  await mined(await w.writeContract({ address: chain.usdg, abi: erc, functionName: "approve", args: [chain.bounties, 10n ** 12n] }));
  await mined(await w.writeContract({ address: chain.bounties, abi: bountiesAbi, functionName: "open", args: [b.fund.args[0], BigInt(b.fund.args[1]), BigInt(b.fund.args[2])] }));
  const funded = (await call(`/v1/bounties/${b.id}`, null)).body;
  assert.equal(funded.status, "funded");
  const board = (await call("/v1/bounties", null)).body;
  assert.deepEqual([board.open, board.openAmount], [1, "5"]);
  // A seller offers the feed they listed; someone else's feed, or a built-in one, is not an offer.
  assert.equal((await call(`/v1/bounties/${b.id}/offers`, buyer, "POST", { feed: "market.weather" })).status, 400);
  assert.equal((await call(`/v1/bounties/${b.id}/offers`, seller, "POST", { feed: "chain.price" })).status, 400);
  const offered = await call(`/v1/bounties/${b.id}/offers`, seller, "POST", { feed: "market.weather" });
  assert.equal(offered.status, 201);
  assert.deepEqual(offered.body.offers.map((o: J) => [o.feed, o.listed]), [["market.weather", true]]);
  const s0 = await chain.balance(seller.address);
  await mined(await w.writeContract({ address: chain.bounties, abi: bountiesAbi, functionName: "award", args: [b.fund.args[0], seller.address] }));
  assert.equal((await chain.balance(seller.address)) - s0, 5_000_000n);
  const done = (await call(`/v1/bounties/${b.id}`, null)).body;
  assert.equal(done.status, "awarded");
  assert.match(done.winner, /^0x[0-9a-f]{4}…/);
  assert.equal((await call(`/v1/bounties/${b.id}/offers`, seller, "POST", { feed: "market.weather" })).status, 409);
});

// ---------- teams

test("a team shares one daily budget across its wallets and reports who spent what", async () => {
  const made = await call("/v1/teams", buyer, "POST", { name: "Desk one" });
  assert.equal(made.status, 201);
  const tid = made.body.id;
  assert.equal((await call(`/v1/teams/${tid}/members`, friend, "POST", { wallet: seller.address })).status, 404, "only the owner changes the team");
  assert.equal((await call(`/v1/teams/${tid}/members`, buyer, "POST", { wallet: friend.address })).status, 201);
  assert.equal((await call(`/v1/teams/${tid}/members`, buyer, "POST", { wallet: friend.address })).status, 409);
  // The invited wallet joins with its own signature.
  assert.equal((await call(`/v1/teams/${tid}/members`, friend, "POST", { wallet: friend.address })).status, 201);
  assert.equal((await call("/v1/teams", friend, "POST", { name: "Second" })).status, 409, "a wallet is in one team");
  // Each wallet's free call first, then paid calls of 0.005 from both wallets against the shared 0.012.
  // Free calls are also held to the caller's address, so each wallet calls from its own.
  for (const [i, who] of [buyer, friend].entries()) await fetch(`${e.url}/v1/feeds/chain.prices?kind=all`, { headers: { Authorization: `Specula ${await accessToken(who)}`, "x-forwarded-for": `10.1.2.${i + 1}` } });
  // The budget counts everything the team's wallets spent today, so set it to what is spent already plus 0.012.
  const spentSoFar = (await call("/v1/teams/mine", friend)).body.members.reduce((n: number, m: J) => n + Math.round(Number(m.spentToday) * 1e6), 0);
  const set = await call(`/v1/teams/${tid}/budget`, buyer, "POST", { daily: ((spentSoFar + 12000) / 1e6).toFixed(6) });
  const before = set.body.budget.spentToday;
  await new Specula({ baseUrl: e.url, account: buyer }).get("chain.prices", { kind: "all" });
  await sdk(friend).get("chain.prices", { kind: "all" });
  const bal = await chain.balance(friend.address);
  await assert.rejects(sdk(friend).get("chain.prices", { kind: "all" }), (err: SpeculaError) => err.status === 403 && err.code === "team_budget_reached" && (err.body.team as J).name === "Desk one");
  assert.equal(await chain.balance(friend.address), bal, "the refused call was not charged");
  const rep = (await call("/v1/teams/mine", friend)).body;
  assert.equal(rep.members.length, 2);
  assert.equal(Math.round((Number(rep.budget.spentToday) - Number(before)) * 1e6), 10000);
  assert.equal(rep.members.find((m: J) => m.wallet === friend.address.toLowerCase()).mostUsedFeed, "chain.prices");
  assert.equal((await call(`/v1/teams/${tid}/budget`, buyer, "POST", { daily: null })).body.budget, null);
  await sdk(friend).get("chain.prices", { kind: "all" });
  assert.equal((await call(`/v1/teams/${tid}/members/${friend.address}`, buyer, "DELETE")).body.members.length, 1);
  assert.equal((await call("/v1/teams/mine", friend)).status, 404);
});

// ---------- archive

test("the archive keeps answers as they were, with their signatures, and reads them back by time", async () => {
  const live = await sdk(buyer).get("macro.series", { series: "cpi" });
  const key = `macro.series?{"limit":"13","series":"cpi"}`;
  const n = () => (e.ctx.db.prepare("SELECT COUNT(*) n FROM archive WHERE key = ?").get(key) as { n: number }).n;
  assert.equal(n(), 1);
  e.ctx.mem.delete(key);
  e.ctx.db.prepare("UPDATE cache SET collected_at = collected_at - 100000 WHERE key = ?").run(key);
  await sdk(buyer).get("macro.series", { series: "cpi" });
  assert.equal(n(), 1, "a second answer inside the interval is not archived again");
  // An older point, as if the engine had been running yesterday.
  e.ctx.db.prepare("INSERT INTO archive (feed, key, at, params, data, source, digest, signature) SELECT feed, key, at - 90000, params, '{\"old\":true}', source, digest, signature FROM archive WHERE key = ?").run(key);
  const latest = (await sdk(buyer).get("archive.at", { feed: "macro.series", params: "series=cpi" })).data as J;
  assert.equal(latest.answer.proof.digest, live.proof.digest);
  assert.ok(await verifyAnswer(latest.answer as Answer, privateKeyToAccount(ENGINE_KEY).address), "an archived answer checks out like a live one");
  const then = (await sdk(buyer).get("archive.at", { feed: "macro.series", params: "series=cpi", at: String(nowSec() - 3600) })).data as J;
  assert.deepEqual(then.answer.data, { old: true });
  assert.ok(then.ageAtThatTime > 80000);
  const range = (await sdk(buyer).get("archive.range", { feed: "macro.series", params: "series=cpi", from: String(nowSec() - 200000) })).data as J;
  assert.equal(range.count, 2);
  assert.ok(range.answers[0].collectedAt < range.answers[1].collectedAt);
  await assert.rejects(sdk(buyer).get("archive.at", { feed: "macro.series", params: "series=cpi", at: "2001-01-01T00:00:00Z" }), (err: SpeculaError) => err.code === "not_archived");
  await assert.rejects(sdk(buyer).get("archive.at", { feed: "nope.feed" }), (err: SpeculaError) => err.status === 404);
  await assert.rejects(sdk(buyer).get("archive.at", { feed: "macro.series", params: "series=cpi", at: "whenever" }), (err: SpeculaError) => err.status === 400);
  const cover = (await call("/v1/archive", null)).body;
  assert.ok(cover.answers >= 2 && cover.feeds.some((f: J) => f.feed === "macro.series" && f.answers === 2));
});

// ---------- strategy lab

const S = (over: Partial<Strategy> = {}): Strategy => ({ symbol: "ETH", direction: "down", bps: 100, windowMin: 60, side: "long", sizeUsd: 1000, holdMin: 120, takeBps: null, stopBps: null, ...over });
const series = (...pts: [number, number][]): Tick[] => pts.map(([min, px]) => ({ t: 1_800_000_000 + min * 60, p: BigInt(Math.round(px * 1e8)) }));

test("a backtest enters on the move, exits on time, take or stop, and counts dollars exactly", () => {
  // Falls 2% in an hour (entry at 98), then sits at 100.94 two hours later: +3% on $1,000 is $30.00.
  const timed = backtest(S(), series([0, 100], [60, 98], [120, 99], [180, 100.94]));
  assert.deepEqual([timed.trades, timed.wins, timed.pnlUsd, timed.lastTrades[0].why, timed.lastTrades[0].entry, timed.lastTrades[0].exit], [1, 1, "30.00", "time", "98.00", "100.94"]);
  assert.equal(timed.reads, "Buy $1,000 of ETH when it falls 1.00% within 60 min; close after 120 min.");
  const take = backtest(S({ takeBps: 100 }), series([0, 100], [60, 98], [70, 99.5], [180, 90]));
  assert.deepEqual([take.lastTrades[0].why, take.lastTrades[0].exit, take.pnlUsd], ["take", "99.50", "15.30"]);
  const stop = backtest(S({ stopBps: 200 }), series([0, 100], [60, 98], [70, 95], [180, 120]));
  assert.deepEqual([stop.lastTrades[0].why, stop.pnlUsd, stop.winShare, stop.maxDrawdownUsd], ["stop", "-30.61", 0, "30.61"]);
  const short = backtest(S({ direction: "up", side: "short" }), series([0, 100], [60, 102], [180, 96.9]));
  assert.deepEqual([short.trades, short.pnlUsd], [1, "50.00"]);
  const none = backtest(S({ bps: 500 }), series([0, 100], [60, 98], [180, 100]));
  assert.deepEqual([none.trades, none.pnlUsd, none.winShare], [0, "0.00", null]);
  // A gap in the prices (a market that rested) is not a move.
  assert.equal(backtest(S(), series([0, 100], [600, 90], [700, 95])).trades, 0);
  const open = backtest(S(), series([0, 100], [60, 98]));
  assert.deepEqual([open.trades, open.open?.entry], [0, "98.00"]);
});

test("stepping is pure, and a strategy is checked field by field", () => {
  const st: State = { position: null, trades: [], window: [] };
  const a = step(S(), st, series([0, 100])[0]);
  assert.deepEqual(st, { position: null, trades: [], window: [] }, "the state passed in is never changed");
  assert.equal(a.window.length, 1);
  assert.deepEqual(parseStrategy({ symbol: "eth", bps: "50" }), S({ bps: 50, direction: "up", holdMin: 60 }));
  assert.throws(() => parseStrategy({ symbol: "NOPE", bps: "50" }), (err: HttpError) => err.status === 404);
  assert.throws(() => parseStrategy({ symbol: "ETH" }), (err: HttpError) => err.code === "missing_param");
  assert.throws(() => parseStrategy({ symbol: "ETH", bps: "0" }), (err: HttpError) => err.code === "bad_param");
  assert.throws(() => parseStrategy({ symbol: "ETH", bps: "50", sizeUsd: "1.5" }), (err: HttpError) => err.code === "bad_param");
});

test("the backtest feed runs over the prices the engine recorded, and a paper run follows live prices", async () => {
  await assert.rejects(sdk(buyer).get("lab.backtest", { symbol: "GME", bps: 50 }), (err: SpeculaError) => err.status === 409 && err.code === "no_history");
  const t = nowSec();
  const ins = e.ctx.db.prepare("INSERT OR REPLACE INTO price_ticks (symbol, time, answer, updated_at) VALUES ('GME', ?, ?, ?)");
  for (const [ago, px] of [[14400, 100], [10800, 98], [7200, 99], [3600, 100.94]] as const) ins.run(t - ago, String(Math.round(px * 1e8)), t - ago);
  const r = (await sdk(buyer).get("lab.backtest", { symbol: "GME", direction: "down", bps: 100, holdMin: 120 })).data as J;
  assert.deepEqual([r.pricesRead, r.trades, r.pnlUsd], [4, 1, "30.00"]);
  assert.match(r.note, /not advice/);
  // Paper: the same rule on live prices. Nothing is bought; the position is pretend.
  assert.equal((await call("/v1/lab/paper", null, "POST", {})).status, 401);
  const run = await call("/v1/lab/paper", buyer, "POST", { symbol: "NVDA", direction: "up", bps: 100, windowMin: 1, holdMin: 1, takeBps: 50 });
  assert.equal(run.status, 201);
  const tick = (raw: bigint) => e.ctx.bus.emit("prices", [{ symbol: "NVDA", raw: raw.toString(), price: "0", decimals: 8, roundId: String(raw), resting: false }]);
  e.ctx.db.prepare("UPDATE paper_runs SET state = ? WHERE id = ?").run(JSON.stringify({ position: null, trades: [], window: [[t - 90, "10000000000"]], ticks: 1 }), run.body.id);
  tick(102_00000000n);
  let mine = (await call("/v1/lab/paper", buyer)).body.runs[0];
  assert.equal(mine.open.entry, "102.00");
  tick(103_02000000n);
  mine = (await call("/v1/lab/paper", buyer)).body.runs[0];
  assert.deepEqual([mine.open, mine.trades, mine.pnlUsd, mine.lastTrades[0].why], [null, 1, "10.00", "take"]);
  assert.equal((await call("/v1/lab/paper", friend)).body.runs.length, 0, "paper runs belong to their wallet");
  assert.deepEqual((await call(`/v1/lab/paper/${run.body.id}`, buyer, "DELETE")).body, { stopped: true });
  assert.ok((await call("/v1/lab", null)).body.pricesRecorded >= 4);
});

// ---------- the public data index

test("the demand index ranks the data agents actually asked for, and leaves private feeds out", async () => {
  const d = (await call("/v1/demand", null)).body;
  assert.ok(d.calls > 5 && d.feedsAsked >= 4);
  const ranks = d.feeds.map((f: J) => f.calls7d);
  assert.deepEqual(ranks, [...ranks].sort((a: number, b: number) => b - a));
  assert.equal(d.feeds[0].rank, 1);
  assert.equal(d.feeds.reduce((n: number, f: J) => n + f.shareBps, 0) > 9900, true);
  assert.ok(d.feeds.some((f: J) => f.feed === "market.weather" && f.paidCalls7d >= 2));
  assert.ok(!d.feeds.some((f: J) => f.feed === "market.desk"));
});

// Last, because it moves the local chain's clock forward.
test("a bounty funded with less than it promised stays a pledge, and a refund after the deadline shows as refunded", async () => {
  const b = (await call("/v1/bounties", buyer, "POST", { title: "Daily rainfall totals", detail: "Rainfall in millimetres for one hundred weather stations, once a day.", amount: "4", days: 1 })).body;
  const pub = createPublicClient({ chain: foundry, transport: http(chain.url), pollingInterval: 50 });
  const w = createWalletClient({ account: buyer, chain: foundry, transport: http(chain.url) });
  const mined = (hash: `0x${string}`) => pub.waitForTransactionReceipt({ hash });
  const deadline = BigInt((await pub.getBlock()).timestamp) + 3600n;
  await mined(await w.writeContract({ address: chain.bounties, abi: bountiesAbi, functionName: "open", args: [b.escrowId, 1_000_000n, deadline] }));
  assert.equal((await call(`/v1/bounties/${b.id}`, null)).body.status, "pledged", "one dollar locked is not the four that were promised");
  const c = (await call("/v1/bounties", buyer, "POST", { title: "Weekly fuel prices", detail: "Average pump prices for petrol and diesel in thirty countries, weekly.", amount: "2", days: 1 })).body;
  await mined(await w.writeContract({ address: chain.bounties, abi: bountiesAbi, functionName: "open", args: [c.escrowId, 2_000_000n, deadline] }));
  assert.equal((await call(`/v1/bounties/${c.id}`, null)).body.status, "funded");
  await chain.warp(3700);
  await mined(await w.writeContract({ address: chain.bounties, abi: bountiesAbi, functionName: "refund", args: [c.escrowId] }));
  const r = (await call(`/v1/bounties/${c.id}`, null)).body;
  assert.deepEqual([r.status, r.winner], ["refunded", null]);
});

