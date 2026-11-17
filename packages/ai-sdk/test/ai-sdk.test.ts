import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { speculaTools } from "../src/index.ts";
import { localEngine } from "../../local-engine.ts";

let e: Awaited<ReturnType<typeof localEngine>>;
before(async () => void (e = await localEngine()));
after(() => e?.stop());
const ctx = { toolCallId: "t1", messages: [] };

test("every feed is an AI SDK tool with a description that states the price and a JSON schema", async () => {
  const tools = await speculaTools({ baseUrl: e.url });
  const names = Object.keys(tools);
  assert.ok(names.length >= 24 && names.includes("specula_chain_trades") && names.includes("specula_answers_ask"));
  const t = tools.specula_sec_fundamentals;
  assert.match(t.description!, /Costs 0\.01 USDG per call/);
  const schema = (t.inputSchema as { jsonSchema: { required: string[]; properties: Record<string, unknown> } }).jsonSchema;
  assert.deepEqual(schema.required, ["ticker"]);
  assert.ok("ticker" in schema.properties);
});

test("executing a tool asks the engine and returns the data with its source and cost", async () => {
  const tools = await speculaTools({ baseUrl: e.url, only: ["macro.", "sec.fundamentals"] });
  assert.deepEqual(Object.keys(tools).sort(), ["specula_macro_series", "specula_macro_snapshot", "specula_sec_fundamentals"]);
  const out = (await tools.specula_sec_fundamentals.execute!({ ticker: "AAPL" }, ctx)) as { data: { company: { name: string }; facts: Record<string, unknown> }; source: string; paid: string };
  assert.match(out.data.company.name, /Apple/i);
  assert.ok(out.data.facts.revenue);
  assert.deepEqual([out.source, out.paid], ["sec-xbrl-api", "free allowance"]);
});

test("a refusal or a bad call is handed to the model as a plain result it can act on", async () => {
  const tools = await speculaTools({ baseUrl: e.url });
  const out = (await tools.specula_macro_series.execute!({ series: "nope" }, ctx)) as { error: string; message: string };
  assert.equal(out.error, "bad_param");
  assert.match(out.message, /series/);
});
