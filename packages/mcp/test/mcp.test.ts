import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { makeServer } from "../src/server.ts";
import { optionsFromEnv } from "../src/index.ts";
import { localEngine } from "../../local-engine.ts";

let e: Awaited<ReturnType<typeof localEngine>>;
let client: Client;
type Result = { content: { type: string; text: string }[]; isError?: boolean };
const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as Result;

before(async () => {
  e = await localEngine();
  const { server } = await makeServer({ baseUrl: e.url });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: "test", version: "0" });
  await client.connect(b);
});
after(async () => {
  await client?.close();
  await e?.stop();
});

test("an MCP client sees one priced tool per feed, plus the account and the catalog", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  assert.ok(names.includes("specula_chain_price") && names.includes("specula_sec_insiders") && names.includes("specula_account") && names.includes("specula_catalog"));
  assert.equal(new Set(names).size, names.length);
  assert.ok(tools.length >= 26);
  const t = tools.find((x) => x.name === "specula_sec_events")!;
  assert.match(t.description!, /8-K|events/i);
  assert.match(t.description!, /Costs 0\.003 USDG per call/);
  assert.deepEqual((t.inputSchema as { required: string[] }).required, ["ticker"]);
  for (const x of tools) assert.equal((x.inputSchema as { type: string }).type, "object");
});

test("calling a tool returns the data with its source, time and cost", async () => {
  const r = await call("specula_macro_series", { series: "unemployment", limit: 2 });
  assert.ok(!r.isError);
  const out = JSON.parse(r.content[0].text) as { data: { title: string; observations: unknown[] }; source: string; paid: string; verified: boolean; collectedAt: string };
  assert.equal(out.data.title, "Unemployment rate");
  assert.equal(out.data.observations.length, 2);
  assert.deepEqual([out.source, out.paid, out.verified], ["publisher", "free allowance", true]);
  const events = JSON.parse((await call("specula_sec_events", { ticker: "NVDA", limit: 2 })).content[0].text) as { data: { events: unknown[] } };
  assert.equal(events.data.events.length, 2);
});

test("a wrong call comes back as an error the model can read, never as a crash", async () => {
  const bad = await call("specula_macro_series", { series: "nope" });
  assert.equal(bad.isError, true);
  assert.equal((JSON.parse(bad.content[0].text) as { error: string }).error, "bad_param");
  const missing = await call("specula_sec_events", {});
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /ticker/);
  const unknown = await call("specula_nope");
  assert.equal(unknown.isError, true);
});

test("the account and catalog tools are free and say plainly when no wallet is set", async () => {
  const acct = JSON.parse((await call("specula_account")).content[0].text) as { wallet: null; note: string };
  assert.equal(acct.wallet, null);
  assert.match(acct.note, /free allowance/);
  const cat = JSON.parse((await call("specula_catalog")).content[0].text) as { id: string; price: string }[];
  assert.ok(cat.length >= 24 && cat.every((f) => /^\d/.test(f.price)));
});

test("settings come from the environment, with safe limits when none are given", () => {
  const none = optionsFromEnv({});
  assert.deepEqual([none.account, none.maxPricePerCall, none.budget, none.fresh], [undefined, "0.05", "1.00", "live"]);
  const set = optionsFromEnv({ SPECULA_AGENT_KEY: `0x${"1".repeat(64)}`, SPECULA_MAX_PRICE: "0.01", SPECULA_BUDGET: "0.5", SPECULA_URL: "http://x", SPECULA_FRESH: "delayed" });
  assert.match(set.account!.address, /^0x[0-9a-fA-F]{40}$/);
  assert.deepEqual([set.maxPricePerCall, set.budget, set.baseUrl, set.fresh], ["0.01", "0.5", "http://x", "delayed"]);
  assert.throws(() => optionsFromEnv({ SPECULA_AGENT_KEY: "hunter2" }), /private key/);
});
