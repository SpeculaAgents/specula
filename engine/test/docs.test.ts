import assert from "node:assert/strict";
import { test } from "node:test";
import { standin, standinParseRule, standinPlan } from "../src/ai.ts";
import { FEEDS } from "../src/catalog.ts";
import { collect, health, normalizeParams } from "../src/collect.ts";
import { filingsFromSearch, ITEMS_8K, mulDecimal, paragraphLink, paragraphsOf, parse13F, parseForm4, secFetch } from "../src/sec/edgar.ts";
import { parseBls, parseYields, SERIES } from "../src/sec/macro.ts";
import { HttpError } from "../src/util.ts";
import { readJson, replayFetch, testCtx, type FetchTape } from "./helpers.ts";

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const tape = readJson<FetchTape>("docs.json");
const feed = (id: string) => FEEDS.find((f) => f.id === id)!;
const mk = (over: Record<string, { status: number; body: string }> = {}, ai?: typeof standin) => testCtx({}, { fetch: replayFetch(tape, over), ai });
const ask = async (ctx: ReturnType<typeof testCtx>, id: string, p: Record<string, string>) => collect(ctx, feed(id), normalizeParams(feed(id), p), 0);
const url = (part: string) => Object.keys(tape).find((u) => u.includes(part))!;

test("company filings come back newest first with working links, from the SEC's own API", async () => {
  const d = await ask(mk(), "sec.filings", { ticker: "nvda", limit: "10" });
  const x = d.data as J;
  assert.equal(d.source, "sec-data-api");
  assert.equal(x.company.cik, 1045810);
  assert.match(x.company.name, /NVIDIA/i);
  assert.equal(x.filings.length, 10);
  const dates = (x.filings as J[]).map((f) => f.filedAt);
  assert.deepEqual(dates, [...dates].sort().reverse());
  for (const f of x.filings as J[]) {
    assert.match(f.accession, /^\d{10}-\d{2}-\d{6}$/);
    assert.ok(f.url.startsWith("https://www.sec.gov/Archives/edgar/data/1045810/"));
  }
  const only = (await ask(mk(), "sec.filings", { ticker: "NVDA", form: "8-K" })).data as J;
  assert.ok(only.filings.length > 0 && (only.filings as J[]).every((f) => f.form.startsWith("8-K")));
});

test("when the SEC's API is down the filing list comes from the search index instead, and health shows both", async () => {
  const ctx = mk({ [url("submissions/CIK0001045810")]: { status: 500, body: "down" } });
  const d = await ask(ctx, "sec.filings", { ticker: "NVDA", limit: "5" });
  assert.equal(d.source, "sec-search-index");
  assert.deepEqual(d.tried.map((t) => [t.source, t.ok]), [["sec-data-api", false], ["sec-search-index", true]]);
  const x = d.data as J;
  assert.equal(x.filings.length, 5);
  assert.match(x.filings[0].accession, /^\d{10}-\d{2}-\d{6}$/);
  const h = health(ctx).filter((r) => r.feed === "sec.filings");
  assert.equal(h.find((r) => r.source === "sec-data-api")!.state, "down");
  assert.equal(h.find((r) => r.source === "sec-search-index")!.state, "ok");
  assert.throws(() => filingsFromSearch(1, { nothing: true }));
});

test("an unknown ticker is refused before anything is fetched for it", async () => {
  await assert.rejects(ask(mk(), "sec.filings", { ticker: "ZZZZZ" }), (e: HttpError) => e.status === 404 && e.code === "unknown_ticker");
});

test("8-K events are decoded to plain words and weighted", async () => {
  const x = (await ask(mk(), "sec.events", { ticker: "NVDA" })).data as J;
  assert.ok(x.events.length > 0);
  for (const e of x.events as J[]) {
    assert.ok(e.weight >= 1 && e.weight <= 5);
    for (const i of e.items as J[]) assert.equal(i.meaning, ITEMS_8K[i.code] ?? "Other");
  }
  assert.ok((x.events as J[]).some((e) => (e.items as J[]).length > 0));
  assert.equal(ITEMS_8K["2.02"], "Results of operations and financial condition");
});

test("insider trades are parsed from the Form 4 documents themselves, with exact values", async () => {
  const x = (await ask(mk(), "sec.insiders", { ticker: "NVDA", limit: "3" })).data as J;
  assert.equal(x.filingsRead, 3);
  assert.ok(x.count > 0);
  for (const t of x.transactions as J[]) {
    assert.ok(t.owner.length > 2 && t.role.length > 2);
    assert.ok(["buy", "sell", "other"].includes(t.side));
    if (t.shares && t.price) assert.equal(t.value, mulDecimal(t.shares, t.price));
  }
  const o = x.openMarket;
  const sold = (x.transactions as J[]).filter((t) => t.side === "sell" && !t.derivative).reduce((n, t) => n + BigInt(t.value.replace(".", "")), 0n);
  assert.equal(o.soldUsd.replace(".", ""), sold.toString().padStart(3, "0"));
});

test("Form 4 parsing reads roles, codes and both transaction tables", () => {
  const xml = `<ownershipDocument><issuer><issuerName>ACME &amp; Co</issuerName></issuer><reportingOwner><reportingOwnerId><rptOwnerName>DOE JANE</rptOwnerName></reportingOwnerId><reportingOwnerRelationship><isDirector>1</isDirector><isOfficer>true</isOfficer><officerTitle>Chief Financial Officer</officerTitle></reportingOwnerRelationship></reportingOwner>
  <nonDerivativeTable><nonDerivativeTransaction><securityTitle><value>Common Stock</value></securityTitle><transactionDate><value>2026-11-02</value></transactionDate><transactionCoding><transactionCode>P</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>1500</value></transactionShares><transactionPricePerShare><value>12.345</value></transactionPricePerShare><transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode></transactionAmounts><postTransactionAmounts><sharesOwnedFollowingTransaction><value>20000</value></sharesOwnedFollowingTransaction></postTransactionAmounts></nonDerivativeTransaction></nonDerivativeTable>
  <derivativeTable><derivativeTransaction><securityTitle><value>Stock Option</value></securityTitle><transactionDate><value>2026-11-02</value></transactionDate><transactionCoding><transactionCode>M</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>100</value></transactionShares><transactionPricePerShare><value>0</value></transactionPricePerShare></transactionAmounts></derivativeTransaction></derivativeTable></ownershipDocument>`;
  const p = parseForm4(xml);
  assert.equal(p.issuer, "ACME & Co");
  assert.equal(p.role, "Director, Chief Financial Officer");
  assert.equal(p.transactions.length, 2);
  assert.deepEqual({ ...p.transactions[0] }, { owner: "DOE JANE", role: "Director, Chief Financial Officer", security: "Common Stock", date: "2026-11-02", code: "P", kind: "open market purchase", side: "buy", shares: "1500", price: "12.345", value: "18517.50", sharesAfter: "20000", derivative: false });
  assert.equal(p.transactions[1].derivative, true);
  assert.equal(p.transactions[1].price, null);
  assert.equal(mulDecimal("0.1", "0.2"), "0.02");
  assert.equal(mulDecimal("3", "7"), "21.00");
  assert.equal(mulDecimal("1e5", "2"), null);
});

test("a fund's 13F is read from its information table and ranked by value with weights that add up", async () => {
  const x = (await ask(mk(), "sec.holdings", { manager: "brk.b", limit: "10" })).data as J;
  assert.match(x.manager.name, /BERKSHIRE/i);
  assert.equal(x.holdings.length, 10);
  const values = (x.holdings as J[]).map((h) => BigInt(h.valueUsd));
  assert.deepEqual(values, [...values].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)));
  assert.ok(BigInt(x.totalValueUsd) >= values.reduce((a, b) => a + b, 0n));
  assert.ok((x.holdings as J[]).every((h) => h.weightBps >= 0 && h.weightBps <= 10000 && /^[0-9A-Z]{9}$/.test(h.cusip)));
  assert.equal(parse13F(`<ns1:infoTable><ns1:nameOfIssuer>X &amp; Y</ns1:nameOfIssuer><ns1:titleOfClass>COM</ns1:titleOfClass><ns1:cusip>123456789</ns1:cusip><ns1:value>100</ns1:value><ns1:shrsOrPrnAmt><ns1:sshPrnamt>5</ns1:sshPrnamt></ns1:shrsOrPrnAmt></ns1:infoTable>`)[0].issuer, "X & Y");
});

test("reported numbers come straight from the company's own tagged filings", async () => {
  const x = (await ask(mk(), "sec.fundamentals", { ticker: "AAPL" })).data as J;
  for (const k of ["revenue", "netIncome", "assets", "liabilities", "equity", "cash", "epsDiluted"]) assert.ok(x.facts[k]?.latest, `${k} missing`);
  assert.ok(x.facts.assets.latest.value > 1e11);
  assert.equal(x.facts.assets.latest.span, "instant");
  assert.ok(x.facts.revenue.lastFullYear.value > x.facts.netIncome.lastFullYear.value);
  const f = (await ask(mk(), "sec.facts", { ticker: "AAPL", concept: "netIncome", limit: "6" })).data as J;
  assert.equal(f.tag, "NetIncomeLoss");
  assert.equal(f.points.length, 6);
  const ends = (f.points as J[]).map((p) => p.end);
  assert.deepEqual(ends, [...ends].sort().reverse());
  assert.ok((f.points as J[]).every((p) => p.accession && p.form && ["year", "quarter", "half", "nine months"].includes(p.span)));
});

test("a filing summary only ever points at paragraphs that exist, and links open the filing at those words", async () => {
  const d = await ask(mk(), "sec.summary", { ticker: "NVDA", form: "8-K" });
  const x = d.data as J;
  assert.equal(x.model, "standin");
  assert.ok(x.points.length >= 1 && x.points.length <= 6);
  const html = tape[x.filing.url].body;
  const paras = paragraphsOf(html);
  for (const p of x.points as J[]) {
    assert.ok(p.paragraph >= 0 && p.paragraph < x.paragraphsRead);
    assert.ok(paras[p.paragraph].startsWith(p.quote.slice(0, 40)), "the quote is the paragraph the point cites");
    assert.ok(p.link.startsWith(`${x.filing.url}#:~:text=`));
    assert.ok(!/[—–]/.test(p.text));
  }
  // A model that invents a paragraph number does not get its point served.
  const liar = { ...standin, id: "liar", summarize: async () => [{ text: "Made up.", paragraph: 99999 }, { text: "Real.", paragraph: 0 }] };
  const y = (await ask(mk({}, liar), "sec.summary", { ticker: "NVDA", form: "8-K" })).data as J;
  assert.deepEqual((y.points as J[]).map((p) => p.text), ["Real."]);
});

test("filing text becomes numbered paragraphs with markup and entities removed", () => {
  const paras = paragraphsOf(`<html><head><style>p{}</style></head><body><p>Short.</p><p>The Company announced financial results for the quarter &amp; declared a dividend of $0.01 per share&nbsp;today.</p><script>bad()</script><div>Revenue increased 12% to $1.2 billion compared with the prior year period, driven by data center demand.</div></body></html>`);
  assert.equal(paras.length, 2);
  assert.ok(paras[0].includes("results for the quarter & declared") && !paras[0].includes("<"));
  assert.equal(paragraphLink("https://x/y.htm", "one two three four five six seven eight nine ten"), "https://x/y.htm#:~:text=one%20two%20three%20four%20five%20six%20seven%20eight");
});

test("the SEC client identifies itself, keeps a gap between requests and backs off when told to", async () => {
  const seen: { ua: string | null; at: number }[] = [];
  const f = (async (_u: string, init?: RequestInit) => (seen.push({ ua: new Headers(init?.headers).get("user-agent"), at: Date.now() }), new Response("{}", { status: 200 }))) as typeof fetch;
  const ctx = testCtx({ secMinGapMs: 60 }, { fetch: f });
  await Promise.all([1, 2, 3, 4].map((i) => secFetch(ctx, `https://data.sec.gov/x${i}`)));
  assert.ok(seen.every((s) => s.ua === "Specula data engine (contact via speculaagents.fun)"));
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i].at - seen[i - 1].at >= 55, "requests are spaced, never in a burst");
  const limited = testCtx({}, { fetch: (async () => new Response("slow down", { status: 429 })) as typeof fetch });
  await assert.rejects(secFetch(limited, "https://data.sec.gov/y"), /slow down/);
  assert.ok((limited.mem.get("sec_last") as number) > Date.now() + 5000, "after a 429 everything waits");
});

test("economic series come from the publishing agencies with the change worked out", async () => {
  const ctx = mk();
  const cpi = (await ask(ctx, "macro.series", { series: "cpi", limit: "5" })).data as J;
  assert.equal(cpi.publisher, "U.S. Bureau of Labor Statistics");
  assert.equal(cpi.observations.length, 5);
  assert.ok(Number(cpi.latest.value) > 250 && /^\d{4}-\d{2}-01$/.test(cpi.latest.date));
  assert.ok(cpi.changeFromYearAgo && Math.abs(Number(cpi.changeFromYearAgo.percent)) < 20);
  const snap = (await ask(ctx, "macro.snapshot", {})).data as J;
  assert.equal(snap.count, SERIES.length);
  assert.ok(Number(snap.series.public_debt.value) > 1e13);
  assert.ok(Number(snap.series.yield_10y.value) > 0 && Number(snap.series.yield_10y.value) < 25);
  assert.ok("points" in snap.series.unemployment.changeFromPrevious, "a percent series changes in points, not percent of percent");
  await assert.rejects(ask(ctx, "macro.series", { series: "nope" }), (e: HttpError) => e.code === "bad_param");
});

test("a series falls over to the publisher's second endpoint, and the snapshot survives one publisher being down", async () => {
  const ctx = mk({ [url("publicAPI/v1/timeseries/data/CUUR0000SA0")]: { status: 503, body: "" } });
  const d = await ask(ctx, "macro.series", { series: "cpi" });
  assert.equal(d.source, "publisher-alt");
  const down = Object.fromEntries(Object.keys(tape).filter((u) => u.includes("api.bls.gov")).map((u) => [u, { status: 500, body: "" }]));
  const snap = (await ask(mk(down), "macro.snapshot", {})).data as J;
  assert.equal(snap.series.cpi.value, null);
  assert.ok(snap.series.public_debt.value !== null && snap.count === SERIES.length - 4);
  assert.throws(() => parseBls({ status: "REQUEST_NOT_PROCESSED", message: ["daily threshold reached"] }), /daily threshold/);
  assert.deepEqual(parseYields(`<entry><content><m:properties><d:NEW_DATE m:type="Edm.DateTime">2026-11-13T00:00:00</d:NEW_DATE><d:BC_10YEAR m:type="Edm.Double">4.11</d:BC_10YEAR></m:properties></content></entry>`, "BC_10YEAR"), [{ date: "2026-11-13", period: "2026-11-13", value: "4.11" }]);
});

test("the stand-in model turns plain sentences into rules and questions into feed calls, the same way every time", async () => {
  assert.deepEqual(standinParseRule("tell me when NVDA falls 3% in an hour"), { kind: "price_move", symbol: "NVDA", direction: "down", bps: 300, windowMin: 60 });
  assert.deepEqual(standinParseRule("alert if ETH moves 1.5 percent within 15 minutes"), { kind: "price_move", symbol: "ETH", direction: "any", bps: 150, windowMin: 15 });
  assert.deepEqual(standinParseRule("when bitcoin goes above $70,000"), { kind: "price_cross", symbol: "BTC", direction: "above", level: "70000" });
  assert.deepEqual(standinParseRule("any buy over $10k on the dex"), { kind: "whale_trade", token: undefined, side: "buy", minUsd: 10000 });
  assert.deepEqual(standinParseRule("Tesla files an 8-K"), { kind: "filing", ticker: "TSLA", form: "8-K" });
  assert.deepEqual(standinParseRule("an insider sells AAPL"), { kind: "insider", ticker: "AAPL", side: "sell" });
  assert.deepEqual(standinParseRule("a new token launches"), { kind: "launch" });
  assert.deepEqual(standinParseRule("a token graduates"), { kind: "graduation" });
  assert.equal(standinParseRule("make me rich"), null);
  assert.deepEqual(standinPlan("What is NVDA trading at?"), [{ feed: "chain.price", params: { symbol: "NVDA" } }]);
  assert.deepEqual(standinPlan("Did any insider sell TSLA lately?").map((c) => c.feed), ["sec.insiders"]);
  assert.deepEqual(standinPlan("How is inflation and the 10 year yield?").map((c) => c.feed), ["macro.snapshot"]);
  assert.deepEqual(standinPlan("who holds 0x00000000000000000000000000000000000000aa").map((c) => c.feed), ["chain.holders"]);
  assert.deepEqual(standinPlan("what is the meaning of life"), []);
  const s = await standin.summarize({ title: "t", max: 2, paragraphs: ["Too short.", "Revenue increased 12% to $1.2 billion compared with the prior year, driven by demand. More words follow here.", "This statement contains forward-looking statements subject to risks; revenue may increase or decrease by a material percent.", "The Board appointed a new director and declared a dividend of $0.05 per share payable in December."] });
  assert.deepEqual(s.map((p) => p.paragraph), [1, 3]);
});
