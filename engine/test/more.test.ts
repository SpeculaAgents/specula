import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { Specula, SpeculaError, verifyInclusion, type Answer } from "../../packages/sdk/src/index.ts";
import { standin } from "../src/ai.ts";
import { factsOf } from "../src/ask.ts";
import { FEEDS } from "../src/catalog.ts";
import { collect, normalizeParams, type Datum } from "../src/collect.ts";
import { INDEXES, oracleAbi, oracleId, stepIndexes } from "../src/indexes.ts";
import { startEngine, type Engine } from "../src/main.ts";
import { anchorAbi, merkle, sealHours } from "../src/merkle.ts";
import { qualityOf } from "../src/quality.ts";
import { BUILTIN, describe, pollSignals, settleOutcomes, trackRecord, validRule } from "../src/signals.ts";
import { nowSec, ZERO } from "../src/util.ts";
import { ANVIL_KEYS, ENGINE_KEY, localChain, readJson, replayFetch, replayTransport, type FetchTape, type LocalChain, type Tape } from "./helpers.ts";

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const chainFix = readJson<{ meta: J; tape: Tape }>("chain.json");
const docs = readJson<FetchTape>("docs.json");
const agent = privateKeyToAccount(ANVIL_KEYS.agent);
const feed = (id: string) => FEEDS.find((f) => f.id === id)!;
let chain: LocalChain;
let e: Engine;
let s: Specula;
const json = async (path: string, init?: RequestInit) => (await fetch(`${e.url}${path}`, init)).json() as Promise<J>;
const tick = (symbol: string, raw: bigint, agoSec: number) => e.ctx.db.prepare("INSERT OR REPLACE INTO price_ticks (symbol, time, answer, updated_at) VALUES (?, ?, ?, ?)").run(symbol, nowSec() - agoSec, raw.toString(), nowSec() - agoSec);
const pt = (symbol: string, raw: bigint, extra: J = {}) => ({ symbol, raw: raw.toString(), price: (Number(raw) / 1e8).toString(), decimals: 8, roundId: String(raw), resting: false, ...extra });
const fires = (rule: string) => e.ctx.db.prepare("SELECT * FROM signal_fires WHERE rule_id = ? ORDER BY rowid").all(rule) as J[];

before(async () => {
  chain = await localChain(4146, privateKeyToAccount(ENGINE_KEY).address);
  e = await startEngine(
    { port: 0, dbPath: ":memory:", engineKey: ENGINE_KEY, payments: false, payRpcUrl: chain.url, payChainId: 31337, payAsset: chain.usdg, relayerKey: ANVIL_KEYS.relayer, anchor: chain.anchor, oracle: chain.oracle, secMinGapMs: 0 },
    { jobs: false, env: {}, transport: replayTransport(chainFix.tape), fetch: replayFetch(docs) },
  );
  s = new Specula({ baseUrl: e.url, account: agent });
});
after(async () => {
  await e?.stop();
  chain?.stop();
});

// ---------- the API surface

test("the engine describes itself, its catalog and its health", async () => {
  const root = await json("/v1");
  assert.equal(root.name, "Specula");
  assert.equal(root.engine, privateKeyToAccount(ENGINE_KEY).address.toLowerCase());
  assert.deepEqual(root.payments, { on: false });
  const cat = await json("/v1/catalog");
  assert.equal(cat.count, FEEDS.length);
  const f = (cat.feeds as J[]).find((x) => x.id === "chain.price")!;
  assert.deepEqual(f.price, { live: { amount: "0.001", label: "Live" }, recent: { amount: "0.0005", label: "Up to 5 minutes old" }, delayed: { amount: "0.0002", label: "Up to 1 hour old" } });
  assert.deepEqual(f.sources, ["chainlink", "chainlink-secondary"]);
  assert.equal(f.path, "/v1/feeds/chain.price?symbol=NVDA");
  assert.equal(f.uptime24h, null, "no uptime is shown before anything was measured");
  const res = await fetch(`${e.url}/v1/nope`);
  assert.equal(res.status, 404);
  assert.equal((await fetch(`${e.url}/v1/feeds/nope.feed`)).status, 404);
  assert.equal((await fetch(`${e.url}/v1/feeds/chain.price`)).status, 400);
  assert.equal((await fetch(`${e.url}/v1/catalog`, { headers: { origin: "https://example.org" } })).headers.get("access-control-allow-origin"), "*");
  assert.equal(await (await fetch(`${e.url}/healthz`)).text(), "ok");
});

test("with payments off every answer is free and still signed; the catalog then shows a real example and measured uptime", async () => {
  const a = await s.prices("all");
  assert.equal(a.meta.paidBy, "free");
  assert.equal(a.meta.allowance.limit, null);
  const b = (await json("/v1/feeds/macro.series", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ series: "cpi", limit: 2 }) })) as Answer;
  assert.equal((b.data as J).observations.length, 2);
  await collect(e.ctx, feed("chain.prices"), normalizeParams(feed("chain.prices"), feed("chain.prices").example), 9999).catch(() => null);
  const one = await json("/v1/catalog/macro.series");
  assert.equal(one.uptime24h, 1);
  assert.ok(one.avgMs >= 0 && one.health[0].source === "publisher");
  assert.equal(one.exampleAnswer, null, "the example parameters were not collected yet, so no answer is invented");
  await e.run("warm");
  const st = await json("/v1/status");
  assert.ok(st.ok && st.model === "standin" && st.jobs.some((j: J) => j.name === "warm" && j.runs === 1));
  assert.ok(st.feeds.find((f: J) => f.id === "macro.series").collections >= 1);
  assert.match(await (await fetch(`${e.url}/v1/metrics`)).text(), /specula_collected \d+/);
});

test("the site's live stream carries each request as it is served", async () => {
  const ac = new AbortController();
  const res = await fetch(`${e.url}/v1/events`, { signal: ac.signal });
  const reader = res.body!.getReader();
  let buf = "";
  const until = async (re: RegExp) => {
    while (!re.test(buf)) buf += new TextDecoder().decode((await reader.read()).value);
  };
  await until(/event: hello/);
  await s.economy();
  await until(/event: request\ndata: (.+)\n/);
  const row = JSON.parse(buf.match(/event: request\ndata: (.+)\n/)![1]) as J;
  assert.equal(row.feed, "macro.snapshot");
  assert.equal(row.via, "sdk");
  assert.match(row.buyer, /^0x[0-9a-f]{4}…[0-9a-f]{4}$/);
  ac.abort();
});

// ---------- signals

test("thirty built-in signals exist and every one reads as a plain sentence", async () => {
  assert.equal(BUILTIN.length, 30);
  const list = await json("/v1/signals");
  assert.equal(list.rules.length, 30);
  for (const r of list.rules as J[]) {
    assert.ok(r.name.length > 10 && !/undefined|NaN/.test(r.name));
    assert.deepEqual(validRule(r.rule), r.rule);
    assert.deepEqual(r.record, { fires: 0, measured: 0, pending: 0, after1h: null });
  }
  assert.equal(describe({ kind: "price_move", symbol: "NVDA", direction: "down", bps: 250, windowMin: 120 }), "NVDA falls 2.50% or more within 2 h");
  assert.equal(validRule({ kind: "price_move", symbol: "NOPE", bps: 100, windowMin: 60 }), null);
  assert.equal(validRule({ kind: "whale_trade", minUsd: -5 }), null);
  assert.equal(validRule({ kind: "burn", token: "0x12" }), null);
  assert.equal(validRule({ kind: "drop_tables" }), null);
});

test("a price move fires once per window, never on a resting market, and is measured an hour later", async () => {
  tick("NVDA", 100_00000000n, 3700);
  tick("NVDA", 103_00000000n, 0);
  e.ctx.bus.emit("prices", [pt("NVDA", 103_00000000n)]);
  e.ctx.bus.emit("prices", [pt("NVDA", 103_50000000n)]);
  const f = fires("move-nvda");
  assert.equal(f.length, 1, "one fire per window, not one per tick");
  const d = JSON.parse(f[0].detail) as J;
  assert.equal(d.moveBps, 300);
  assert.equal(d.from, "100.00");
  assert.equal(f[0].ref_value, "10300000000");
  tick("TSLA", 100_00000000n, 3700);
  tick("TSLA", 110_00000000n, 0);
  e.ctx.bus.emit("prices", [pt("TSLA", 110_00000000n, { resting: true })]);
  assert.equal(fires("move-tsla").length, 0);
  tick("AAPL", 100_00000000n, 3 * 86400);
  tick("AAPL", 110_00000000n, 0);
  e.ctx.bus.emit("prices", [pt("AAPL", 110_00000000n)]);
  assert.equal(fires("move-aapl").length, 0, "a market reopening after days is not a one-hour move");
  // An hour passes; the price went on up. The record shows it followed through.
  e.ctx.db.prepare("UPDATE signal_fires SET check_at = ? WHERE id = ?").run(nowSec() - 1, f[0].id);
  e.ctx.db.prepare("INSERT OR REPLACE INTO price_ticks (symbol, time, answer, updated_at) VALUES ('NVDA', ?, '10403000000', ?)").run(nowSec() + 1, nowSec() + 1);
  assert.equal(settleOutcomes(e.ctx), 1);
  assert.deepEqual(trackRecord(e.ctx, "move-nvda"), { fires: 1, measured: 1, pending: 0, after1h: { averageMoveBps: 100, medianMoveBps: 100, upShare: 1, followedThroughShare: 1 } });
  const live = await s.signals({ limit: 5 });
  const top = (live.data as J).fires[0];
  assert.equal(top.rule, "move-nvda");
  assert.deepEqual(top.after1h, { outcome: "up", moveBps: 100 });
  assert.ok(!("track" in top.detail));
});

test("large trades, launches and graduations fire from the index's own events", async () => {
  e.ctx.mem.set("ethusd", 3000_00000000n);
  const tok = "0x00000000000000000000000000000000000000aa";
  const trade = (quoteEth: bigint, side: string, li: number) => ({ token: tok, block: 5, log_index: li, tx: `0x${"1".repeat(64)}`, time: nowSec(), side, trader: agent.address.toLowerCase(), quote: (quoteEth * 10n ** 18n).toString(), amount: (10n ** 24n).toString(), fee: "0", tax: "0", venue: "curve", quote_asset: ZERO });
  e.ctx.bus.emit("trade", trade(1n, "buy", 1)); // $3,000: below every rule
  assert.equal(fires("whale-5k").length, 0);
  e.ctx.bus.emit("trade", trade(2n, "sell", 2)); // $6,000 sell
  e.ctx.bus.emit("trade", trade(10n, "buy", 3)); // $30,000 buy
  e.ctx.bus.emit("trade", trade(10n, "buy", 3)); // the same log again
  assert.equal(fires("whale-5k").length, 2);
  assert.equal(fires("whale-buy-25k").length, 1);
  assert.equal((JSON.parse(fires("whale-buy-25k")[0].detail) as J).valueUsd, "30000");
  e.ctx.bus.emit("launch", { token: tok, tx: "0x2" });
  e.ctx.bus.emit("launch", { token: tok, tx: "0x2" });
  e.ctx.bus.emit("graduation", { token: tok, tx: "0x3" });
  assert.equal(fires("launch").length, 1);
  assert.equal(fires("graduation").length, 1);
});

test("a new filing fires its signal, and the first look only takes note", async () => {
  await pollSignals(e.ctx, "filings");
  assert.equal(fires("8k-nvda").length, 0, "the first look records where the list stands");
  const second = (await collect(e.ctx, feed("sec.filings"), { ticker: "NVDA", form: "8-K", limit: "5" }, 9999)).data as J;
  e.ctx.db.prepare("UPDATE kv SET value = ? WHERE key = 'sig:8k-nvda'").run(second.filings[2].accession);
  await pollSignals(e.ctx, "filings");
  const f = fires("8k-nvda");
  assert.equal(f.length, 2, "the two filings newer than the last one seen");
  assert.equal((JSON.parse(f[0].detail) as J).accession, second.filings[0].accession);
  await pollSignals(e.ctx, "filings");
  assert.equal(fires("8k-nvda").length, 2);
});

test("an agent keeps its own rules in plain words; nonsense is refused; rules belong to their wallet", async () => {
  const tryIt = await s.parseSignal("tell me when NVDA falls 3% in an hour");
  assert.deepEqual(tryIt, { text: "tell me when NVDA falls 3% in an hour", understood: true, rule: { kind: "price_move", symbol: "NVDA", direction: "down", bps: 300, windowMin: 60 }, reads: "NVDA falls 3% or more within 1 h", model: "standin" } as never);
  assert.equal((await s.parseSignal("make me rich quickly")).understood, false);
  const made = await s.addSignal("when bitcoin goes above $70,000");
  assert.deepEqual(made.rule, { kind: "price_cross", symbol: "BTC", direction: "above", level: "70000" });
  await assert.rejects(s.addSignal("make me rich quickly"), (err: SpeculaError) => err.status === 422);
  assert.equal((await fetch(`${e.url}/v1/signals`, { method: "POST", body: "{}" })).status, 401);
  tick("BTC", 69_900_00000000n, 30);
  tick("BTC", 70_100_00000000n, 0);
  e.ctx.bus.emit("prices", [pt("BTC", 70_100_00000000n)]);
  assert.equal(fires(made.id).length, 1);
  assert.equal((await s.mySignals()).rules.length, 1);
  const other = new Specula({ baseUrl: e.url, account: privateKeyToAccount(ANVIL_KEYS.agent2) });
  await assert.rejects(other.removeSignal(made.id), (err: SpeculaError) => err.status === 404);
  assert.deepEqual(await s.removeSignal(made.id), { deleted: true });
  assert.equal((await s.mySignals()).rules.length, 0);
  assert.equal((await json("/v1/signals")).rules.length, 30, "custom rules are not listed publicly");
});

// ---------- ask the data

test("a question is answered only from collected facts, and every citation is a signed answer", async () => {
  const a = await s.ask("What did NVDA file with the SEC lately, and how is inflation?");
  const d = a.data;
  assert.equal(d.answered, true);
  assert.ok(d.citations.length >= 2);
  for (const c of d.citations) {
    assert.ok(d.answer.includes(`[${c.id}]`), "each listed citation is used in the answer");
    assert.match(c.digest, /^0x[0-9a-f]{64}$/);
    assert.ok(["sec.filings", "macro.snapshot"].includes(c.feed));
    assert.ok(e.ctx.db.prepare("SELECT 1 FROM leaves WHERE digest = ?").get(c.digest), "the cited answer is one the engine signed");
  }
  assert.ok(/NVIDIA/i.test(d.answer) && /Consumer price index/i.test(d.answer));
  const none = await s.ask("what is the meaning of life");
  assert.equal(none.data.answered, false);
  assert.equal(none.data.citations.length, 0);
});

test("a model that cites facts that do not exist has those citations removed", async () => {
  const real = e.ctx.ai;
  e.ctx.ai = { ...standin, id: "liar", answer: async () => ({ text: "Real thing [f1]. Invented thing [f99].", cites: ["f1", "f99", "zzz"] }) };
  try {
    const d = (await collect(e.ctx, feed("answers.ask"), { q: "How is inflation?" }, 0)).data as J;
    assert.equal(d.answer, "Real thing [f1]. Invented thing .");
    assert.deepEqual((d.citations as J[]).map((c) => c.id), ["f1"]);
    e.ctx.ai = { ...standin, id: "liar2", answer: async () => ({ text: "All invented [f77].", cites: ["f77"] }) };
    const none = (await collect(e.ctx, feed("answers.ask"), { q: "How is the unemployment rate?" }, 0)).data as J;
    assert.equal(none.answered, false);
  } finally {
    e.ctx.ai = real;
  }
});

test("facts are plain sentences for every kind of answer", () => {
  const d = (feedId: string, data: unknown) => ({ feed: feedId, data }) as Datum;
  assert.deepEqual(factsOf(d("chain.price", { symbol: "NVDA", price: "156.46253943", quote: "USD", updatedAt: "2026-11-16T21:03:13.000Z", resting: false })), ["NVDA is 156.4625 USD on the on-chain price feed, last updated 2026-11-16 21:03 UTC."]);
  assert.deepEqual(factsOf(d("chain.holders", { symbol: "ABC", holders: 12, concentration: { top1Bps: 1250, top10Bps: 6000 } })), ["ABC has 12 holding wallets; the largest holds 12.5% and the top 10 hold 60.0% of supply."]);
  assert.deepEqual(factsOf(d("unknown.feed", {})), []);
});

test("the daily briefing is built from what the engine holds, each line with its source", async () => {
  tick("ETH", 3000_00000000n, 90000);
  const b = (await s.briefing()).data as J;
  assert.equal(b.day, new Date().toISOString().slice(0, 10));
  const titles = (b.sections as J[]).map((x) => x.title);
  assert.ok(titles.includes("Signals") && titles.includes("The economy"), titles.join());
  for (const sec of b.sections as J[]) for (const l of sec.lines as J[]) assert.ok(l.text.length > 10 && FEEDS.some((f) => f.id === l.feed) && !/[—–]/.test(l.text));
  await assert.rejects(s.briefing("2001-01-01"), (err: SpeculaError) => err.status === 404);
});

// ---------- verified data

test("a Merkle proof exists for every leaf of trees of every small size, and fails for anything else", () => {
  for (let n = 1; n <= 9; n++) {
    const leaves = Array.from({ length: n }, (_, i) => `0x${(i + 1).toString(16).padStart(64, "0")}` as Hex);
    const t = merkle(leaves);
    for (const l of leaves) assert.ok(verifyInclusion(l, t.proof(l)!, t.root), `size ${n}`);
    assert.equal(t.proof(`0x${"f".repeat(64)}`), null);
    assert.ok(!verifyInclusion(`0x${"f".repeat(64)}`, t.proof(leaves[0])!, t.root));
  }
  assert.equal(merkle([`0x${"a".repeat(64)}`, `0x${"A".repeat(64)}`] as Hex[]).root, `0x${"a".repeat(64)}`, "the same leaf twice is one leaf");
});

test("each finished hour is sealed into one signed root, posted to the anchor contract, and provable on chain", async () => {
  const a = await s.series("unemployment");
  const open = await s.verify(a, { inclusion: true });
  assert.deepEqual(open, { signature: true, inclusion: null, root: null, anchored: null });
  const pending = await json(`/v1/proof/${a.proof.digest}`);
  assert.equal(pending.sealed, false);
  // Move this hour's answers into the hour before, as if the clock had turned.
  const hour = Math.floor(nowSec() / 3600) - 1;
  await chain.warp(10);
  e.ctx.db.prepare("UPDATE leaves SET hour = ?").run(hour);
  const count = (e.ctx.db.prepare("SELECT COUNT(*) n FROM leaves").get() as { n: number }).n;
  assert.equal(await sealHours(e.ctx), 1);
  assert.equal(await sealHours(e.ctx), 0, "an hour is sealed once");
  const roots = await json("/v1/roots");
  assert.equal(roots.sealed, 1);
  assert.equal(roots.roots[0].answers, count);
  assert.match(roots.roots[0].anchored.transaction, /^0x[0-9a-f]{64}$/);
  const v = await s.verify(a, { inclusion: true });
  assert.equal(v.signature, true);
  assert.equal(v.inclusion, true);
  assert.equal(v.root, roots.roots[0].root);
  // The contract agrees, for a real leaf and against a changed one.
  const pub = createPublicClient({ chain: foundry, transport: http(chain.url) });
  const proof = (await json(`/v1/proof/${a.proof.digest}`)).proof as Hex[];
  assert.equal(await pub.readContract({ address: chain.anchor, abi: anchorAbi, functionName: "verify", args: [BigInt(hour), a.proof.digest, proof] }), true);
  assert.equal(await pub.readContract({ address: chain.anchor, abi: anchorAbi, functionName: "verify", args: [BigInt(hour), `0x${"0".repeat(63)}1`, proof] }), false);
  const [root, n] = await pub.readContract({ address: chain.anchor, abi: anchorAbi, functionName: "roots", args: [BigInt(hour)] });
  assert.equal(root, roots.roots[0].root);
  assert.equal(n, count);
  assert.equal((await fetch(`${e.url}/v1/proof/0x${"9".repeat(64)}`)).status, 404);
});

// ---------- quality, indexes, oracle

test("quality scores come from the engine's own measurements and say what they are made of", async () => {
  const q = qualityOf(e.ctx, feed("macro.series"));
  assert.ok(q.score !== null && q.score >= 90 && q.grade === "A", JSON.stringify(q));
  assert.deepEqual(q.parts.map((p) => p.name), ["availability", "speed", "first source"]);
  const hour = Math.floor(nowSec() / 3600);
  e.ctx.db.prepare("INSERT INTO health_hour (feed, source, hour, ok, fail, ms_sum) VALUES ('sec.events', '*', ?, 90, 10, 90000)").run(hour);
  const bad = qualityOf(e.ctx, feed("sec.events"));
  assert.equal(bad.parts[0].score, 0, "90% availability scores nothing");
  assert.ok(bad.grade === "D" || bad.grade === "C");
  const idle = qualityOf(e.ctx, feed("sec.holdings"));
  assert.deepEqual([idle.score, idle.grade, idle.parts.length], [null, null, 0]);
  assert.equal((await json("/v1/quality")).feeds.length, FEEDS.length);
});

test("an index starts at 1000 and moves by the average move of its members, in exact integers", async () => {
  await stepIndexes(e.ctx);
  const first = (await s.index("ai")).data as J;
  assert.equal(first.value, "1000.00");
  assert.equal(first.constituents.length, INDEXES[0].symbols.length);
  assert.ok(first.constituents.every((c: J) => c.priced));
  // Raise one of fourteen members by 14%: the index must rise by exactly 1%.
  const key = Object.keys(Object.fromEntries(e.ctx.mem)).find((k) => k.startsWith("chain.prices?") && k.includes('"all"'))!;
  const board = structuredClone(e.ctx.mem.get(key)) as Datum & { data: { prices: J[] } };
  const nvda = board.data.prices.find((p) => p.symbol === "NVDA")!;
  nvda.raw = ((BigInt(nvda.raw) * 114n) / 100n).toString();
  board.collectedAt = nowSec() + 30;
  e.ctx.mem.set(key, board);
  await stepIndexes(e.ctx);
  const next = (await collect(e.ctx, feed("index.value"), { index: "ai" }, -1)).data as J;
  assert.ok(Math.abs(Number(next.value) - 1010) < 0.011, next.value);
  const majors = (await json("/v1/indexes")).indexes.find((i: J) => i.index === "majors");
  assert.equal(majors.value, "1000.00");
  assert.equal(majors.points.length, 1, "an index whose members did not move takes no new point");
  const hist = (await s.indexHistory("ai")).data as J;
  assert.deepEqual((hist.points as J[]).map((p) => p.value.split(".")[0]), ["1000", next.value.split(".")[0]]);
  await assert.rejects(s.index("nope"), (err: SpeculaError) => err.status === 400);
});

test("anyone can carry the engine's signed report to the oracle contract; a changed report is refused", async () => {
  const r = await s.oracleReport("index:ai");
  assert.equal(r.id, oracleId("index:ai"));
  assert.equal(r.signer, privateKeyToAccount(ENGINE_KEY).address.toLowerCase());
  const pub = createPublicClient({ chain: foundry, transport: http(chain.url), pollingInterval: 50 });
  const stranger = createWalletClient({ account: privateKeyToAccount(ANVIL_KEYS.agent2), chain: foundry, transport: http(chain.url) });
  await assert.rejects(stranger.writeContract({ address: chain.oracle, abi: oracleAbi, functionName: "post", args: [r.id, BigInt(r.value) + 1n, BigInt(r.timestamp), r.signature] }), /WrongSigner|revert/);
  const hash = await stranger.writeContract({ address: chain.oracle, abi: oracleAbi, functionName: "post", args: [r.id, BigInt(r.value), BigInt(r.timestamp), r.signature] });
  assert.equal((await pub.waitForTransactionReceipt({ hash })).status, "success");
  const [value, ts] = await pub.readContract({ address: chain.oracle, abi: oracleAbi, functionName: "latest", args: [r.id] });
  assert.equal(value, BigInt(r.value));
  assert.equal(Number(ts), r.timestamp);
  assert.equal(await pub.readContract({ address: chain.oracle, abi: oracleAbi, functionName: "signer" }), privateKeyToAccount(ENGINE_KEY).address);
  assert.equal((await fetch(`${e.url}/v1/oracle/bogus`)).status, 400);
});
