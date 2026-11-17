// Records the fixtures the tests replay: one small range of real chain data and a handful of real public documents.
// Run with `npm run record` when the indexer's queries change. It only reads; it never sends a transaction.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PUBLIC_RPC } from "../src/config.ts";
import { FEEDS } from "../src/catalog.ts";
import { collect, normalizeParams } from "../src/collect.ts";
import { chainScenario, FIX, recordTransport, testCtx, type FetchTape, type Tape } from "../test/helpers.ts";

const only = process.argv[2];

if (!only || only === "chain") {
  const tape: Tape = {};
  const ctx = testCtx({}, { transport: recordTransport(PUBLIC_RPC, tape) });
  ctx.pace.gapMs = 200;
  ctx.pace.backoffMs = 3000;
  const head = await ctx.pub.getBlockNumber();
  delete tape["eth_blockNumber []"];
  // Look back for a range that has a launch in it, so holders and first buyers are exercised.
  const { getLogs } = await import("../src/chain/client.ts");
  const { ADDR, evLaunched } = await import("../src/chain/abi.ts");
  const launches = await getLogs(ctx, { address: ADDR.ponsFactory, event: evLaunched, fromBlock: head - 20_000n, toBlock: head - 400n });
  for (const k of Object.keys(tape)) if (k.startsWith("eth_getLogs")) delete tape[k];
  const at = launches.length ? launches[launches.length - 1].blockNumber : head - 500n;
  const from = at - 20n;
  const to = from + 299n;
  const { res } = await chainScenario(ctx, from, to);
  // The feeds the tests read from the index, so their chain calls are on the tape too.
  const tok = (ctx.db.prepare("SELECT address FROM tokens WHERE launch_seen = 1 LIMIT 1").get() as { address: string } | undefined)?.address;
  const busy = (ctx.db.prepare("SELECT token, COUNT(*) n FROM trades GROUP BY token ORDER BY n DESC LIMIT 1").get() as { token: string }).token;
  const wallet = (ctx.db.prepare("SELECT trader, COUNT(*) n FROM trades GROUP BY trader ORDER BY n DESC LIMIT 1").get() as { trader: string }).trader;
  const feed = (id: string) => FEEDS.find((f) => f.id === id)!;
  for (const [id, p] of [["chain.wallet", { address: wallet }], ["chain.token", { token: busy }], ["chain.holders", { token: tok ?? busy }], ["chain.fees", { token: tok ?? busy }]] as const)
    await collect(ctx, feed(id), normalizeParams(feed(id), p), 0).catch((e) => console.log(id, "->", (e as Error).message));
  writeFileSync(resolve(FIX, "chain.json"), JSON.stringify({ meta: { from: from.toString(), to: to.toString(), token: tok ?? null, busy, wallet, recordedAt: new Date().toISOString(), counts: { ...res, from: undefined, to: undefined } }, tape }));
  console.log("chain:", res, "entries", Object.keys(tape).length);
}

if (!only || only === "docs") {
  const tape: FetchTape = {};
  const trim = (url: string, body: string): string => {
    try {
      if (url.includes("company_tickers.json")) {
        const keep = new Set(["NVDA", "AAPL", "MSFT", "TSLA", "BRK-B", "AMZN", "META", "GOOGL", "COIN"]);
        return JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(body) as Record<string, { ticker: string }>).filter(([, v]) => keep.has(v.ticker))));
      }
      if (url.includes("/submissions/")) {
        const j = JSON.parse(body) as { filings: { recent: Record<string, unknown[]>; files?: unknown[] } };
        // Keep the newest rows plus the newest of each form the tests read, so the file stays small.
        const r = j.filings.recent;
        const forms = r.form as string[];
        const want = new Set<number>();
        for (let i = 0; i < Math.min(40, forms.length); i++) want.add(i);
        for (const f of ["4", "8-K", "10-Q", "10-K", "13F-HR"]) forms.forEach((x, i) => x === f && [...want].filter((k) => forms[k] === f).length < 6 && want.add(i));
        const idx = [...want].sort((a, b) => a - b);
        for (const k of Object.keys(r)) r[k] = idx.map((i) => r[k][i]);
        j.filings.files = [];
        return JSON.stringify(j);
      }
      if (url.includes("/companyconcept/")) {
        const j = JSON.parse(body) as { units: Record<string, unknown[]> };
        for (const u of Object.keys(j.units)) j.units[u] = j.units[u].slice(-40);
        return JSON.stringify(j);
      }
      if (/\.htm/.test(url)) return body.slice(0, 400_000);
    } catch {
      /* keep as is */
    }
    return body;
  };
  const recFetch: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const res = await fetch(url, init);
    const body = trim(url, await res.text());
    tape[url] = { status: res.status, body };
    return new Response(body, { status: res.status });
  }) as typeof fetch;
  const ctx = testCtx({ secMinGapMs: 600 }, { fetch: recFetch });
  const feed = (id: string) => FEEDS.find((f) => f.id === id)!;
  const calls: [string, Record<string, string>][] = [
    ["sec.filings", { ticker: "NVDA", limit: "10" }],
    ["sec.events", { ticker: "NVDA" }],
    ["sec.insiders", { ticker: "NVDA", limit: "3" }],
    ["sec.holdings", { manager: "BRK-B", limit: "10" }],
    ["sec.fundamentals", { ticker: "AAPL" }],
    ["sec.facts", { ticker: "AAPL", concept: "netIncome" }],
    ["sec.summary", { ticker: "NVDA", form: "8-K" }],
    ["macro.snapshot", {}],
    ["macro.series", { series: "cpi" }],
  ];
  for (const [id, p] of calls) {
    try {
      const d = await collect(ctx, feed(id), normalizeParams(feed(id), p), 0);
      console.log(id, "ok via", d.source, JSON.stringify(d.data).length, "bytes");
    } catch (e) {
      console.log(id, "FAILED", (e as Error).message, JSON.stringify((e as { extra?: unknown }).extra ?? ""));
    }
  }
  // The second way to the filing list, for the failover test.
  const { secFetch, cik10 } = await import("../src/sec/edgar.ts");
  await secFetch(ctx, `https://efts.sec.gov/LATEST/search-index?ciks=${cik10(1045810)}`).catch((e) => console.log("search failed", e.message));
  await ctx.fetch("https://api.bls.gov/publicAPI/v2/timeseries/data/CUUR0000SA0").catch(() => {});
  writeFileSync(resolve(FIX, "docs.json"), JSON.stringify(tape));
  console.log("docs:", Object.keys(tape).length, "documents", Math.round(JSON.stringify(tape).length / 1024), "KB");
}
process.exit(0);
