import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import speculaPlugin, { askAction, clientFor, priceAction, spendProvider, type Runtime } from "../src/index.ts";
import { localEngine } from "../../local-engine.ts";

let e: Awaited<ReturnType<typeof localEngine>>;
let runtime: Runtime;
before(async () => {
  e = await localEngine();
  runtime = { getSetting: (k) => (k === "SPECULA_URL" ? e.url : null) };
});
after(() => e?.stop());
const msg = (text: string) => ({ content: { text } });

test("the plugin has the shape an Eliza character loads", () => {
  assert.equal(speculaPlugin.name, "specula");
  assert.deepEqual(speculaPlugin.actions.map((a) => a.name), ["SPECULA_ASK", "SPECULA_PRICE"]);
  for (const a of speculaPlugin.actions) assert.ok(a.description.length > 20 && a.similes.length && a.examples.length && typeof a.handler === "function" && typeof a.validate === "function");
  assert.equal(speculaPlugin.providers[0].name, "specula_spend");
});

test("asking a question answers from signed data and lists the sources under it", async () => {
  assert.equal(await askAction.validate(runtime, msg("hi")), false);
  assert.equal(await askAction.validate(runtime, msg("How is inflation?")), true);
  const said: { text: string; content?: unknown }[] = [];
  const ok = await askAction.handler(runtime, msg("How is inflation and unemployment?"), undefined, undefined, (r) => void said.push(r));
  assert.equal(ok, true);
  assert.match(said[0].text, /Consumer price index/);
  assert.match(said[0].text, /Sources:\n\[f1\] macro\.snapshot, publishers, collected 20/);
  assert.equal((said[0].content as { answered: boolean }).answered, true);
});

test("a price request only runs when the message names a symbol, and a failed lookup is said plainly", async () => {
  assert.equal(await priceAction.validate(runtime, msg("how are you today")), false);
  assert.equal(await priceAction.validate(runtime, msg("Price of TSLA?")), true);
  const said: string[] = [];
  const none = await priceAction.handler(runtime, msg("Price of ZZZZ?"), undefined, undefined, (r) => void said.push(r.text));
  assert.equal(none, true);
  assert.equal(said[0], "None of those symbols has an on-chain price feed.");
  // This symbol's reading is not in the recorded data, so every source fails, like an outage.
  const failed = await priceAction.handler(runtime, msg("Price of TSLA?"), undefined, undefined, (r) => void said.push(r.text));
  assert.equal(failed, false);
  assert.match(said[1], /^Specula did not answer: No source could answer chain\.price/);
});

test("one client per runtime, and the agent can see what it has spent", async () => {
  assert.equal(clientFor(runtime), clientFor(runtime));
  assert.deepEqual(await spendProvider.get(runtime, msg("")), { text: "Specula data spend this session: 0 USDG." });
});
