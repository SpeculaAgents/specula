import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Specula } from "@specula/sdk";
import { run as watch } from "../launch-watcher.ts";
import { run as read } from "../filing-reader.ts";
import { run as desk } from "../morning-desk.ts";
import { clientFromEnv } from "../shared.ts";
import { chainScenario, readJson } from "../../../engine/test/helpers.ts";
import { localEngine } from "../../local-engine.ts";

let e: Awaited<ReturnType<typeof localEngine>>;
let specula: Specula;
before(async () => {
  e = await localEngine();
  const meta = readJson<{ meta: { from: string; to: string } }>("chain.json").meta;
  await chainScenario(e.ctx, BigInt(meta.from), BigInt(meta.to)); // the recorded blocks, indexed
  specula = new Specula({ baseUrl: e.url });
});
after(() => e?.stop());

test("the launch watcher writes a note per launch from first buyers and the deployer's history", async () => {
  const notes = await watch(specula, { limit: 3 });
  assert.ok(notes.length >= 1);
  for (const n of notes) {
    assert.match(n.token, /^0x[0-9a-f]{40}$/);
    assert.match(n.note, /launched 20\d\d-/);
    assert.match(n.note, /buys and \d+ sells from \d+ traders/);
    assert.ok(n.note.endsWith(".") && !/undefined|NaN/.test(n.note));
    assert.ok(Array.isArray(n.flags));
  }
});

test("the filing reader reports events, insider trades and cited points, and says what it could not read", async () => {
  const [nvda, other] = await read(specula, ["NVDA", "ZZZZ"]);
  assert.match(nvda.company, /NVIDIA/i);
  assert.ok(nvda.events.length >= 1 && nvda.events.every((x) => /^\d{4}-\d{2}-\d{2}: /.test(x)));
  assert.match(nvda.insiders, /^\d+ open-market buys \(\$[\d.]+\) and \d+ sales \(\$[\d.]+\) in the last 3 insider filings$/);
  assert.ok(nvda.points.length >= 1 && nvda.points.every((p) => p.link.includes("#:~:text=")));
  assert.deepEqual(nvda.skipped, []);
  assert.equal(other.company, "ZZZZ");
  assert.equal(other.skipped.length, 3, "an unknown ticker is reported, not fatal");
  assert.equal(other.insiders, "not read");
});

test("the morning desk prints one page and stays inside its budget", async () => {
  const d = await desk(specula);
  assert.match(d.page, /^Morning desk, 20\d\d-\d\d-\d\d\n\nPRICES\n/);
  assert.match(d.page, /ETH\s+[\d,.]+/);
  assert.match(d.page, /ECONOMY\n {2}Consumer price index/);
  assert.match(d.page, /BRIEFING/);
  assert.deepEqual(d.missing, []);
  assert.equal(d.spent, "0");
  // With payments on and no wallet, a recipe reports what it could not buy instead of crashing.
  const broke = new Specula({ baseUrl: e.url, fetch: (async () => new Response(JSON.stringify({ x402Version: 1, error: "free_allowance_used", accepts: [{ maxAmountRequired: "1000", extra: { decimals: 6 } }] }), { status: 402 })) as typeof fetch });
  const empty = await desk(broke);
  assert.equal(empty.missing.length, 3);
  assert.match(empty.missing[0], /no wallet/);
});

test("a recipe's client comes from the environment with a budget", () => {
  const c = clientFromEnv("0.25", { SPECULA_URL: "http://x:1", SPECULA_AGENT_KEY: `0x${"2".repeat(64)}` });
  assert.equal(c.baseUrl, "http://x:1");
  assert.equal(c.spent, "0");
});
