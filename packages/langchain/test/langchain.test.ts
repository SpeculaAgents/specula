import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { speculaToolkit } from "../src/index.ts";
import { localEngine } from "../../local-engine.ts";

let e: Awaited<ReturnType<typeof localEngine>>;
before(async () => void (e = await localEngine()));
after(() => e?.stop());

test("the toolkit is one LangChain tool per feed, named and priced", async () => {
  const tools = await speculaToolkit({ baseUrl: e.url });
  assert.ok(tools.length >= 24);
  const t = tools.find((x) => x.name === "specula_sec_filings")!;
  assert.match(t.description, /Costs 0\.002 USDG per call/);
  assert.equal(new Set(tools.map((x) => x.name)).size, tools.length);
});

test("invoking a tool returns JSON text with the data, its source and cost", async () => {
  const [series] = await speculaToolkit({ baseUrl: e.url, only: ["macro.series"] });
  const out = JSON.parse(await series.invoke({ series: "cpi", limit: 2 })) as { data: { series: string; observations: unknown[] }; source: string; paid: string };
  assert.equal(out.data.series, "cpi");
  assert.equal(out.data.observations.length, 2);
  assert.equal(out.paid, "free allowance");
  const viaString = JSON.parse(await series.invoke({ series: "cpi", limit: "1" })) as { data: { observations: unknown[] } };
  assert.equal(viaString.data.observations.length, 1);
});

test("the schema refuses a call the feed could not answer, before any request is made", async () => {
  const [series] = await speculaToolkit({ baseUrl: e.url, only: ["macro.series"] });
  await assert.rejects(series.invoke({ series: "not-a-series" }));
  await assert.rejects(series.invoke({}));
  const [filings] = await speculaToolkit({ baseUrl: e.url, only: ["sec.filings"] });
  const out = JSON.parse(await filings.invoke({ ticker: "ZZZZZ" })) as { error: string };
  assert.equal(out.error, "unknown_ticker", "an engine refusal is returned as a result the model can read");
});
