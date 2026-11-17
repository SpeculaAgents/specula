import assert from "node:assert/strict";
import { test } from "node:test";
import { answerDigest, canonical as sdkCanonical, verifyAnswer, type Answer } from "../../packages/sdk/src/protocol.ts";
import { collect, feedUptime, health, normalizeParams, peek, type Feed, type Source } from "../src/collect.ts";
import { FEEDS } from "../src/catalog.ts";
import { envelope } from "../src/serve.ts";
import { digestOf, verifyValue } from "../src/sign.ts";
import { bps, canonical, fromUnits, HttpError, sameAddress, toUnits } from "../src/util.ts";
import { testCtx } from "./helpers.ts";

const feedOf = (sources: Source[], extra: Partial<Feed> = {}): Feed => ({ id: "t.feed", group: "chain", title: "T", summary: "", params: [{ name: "symbol", type: "symbol", required: true, doc: "" }, { name: "limit", type: "int", default: "5", min: 1, max: 10, doc: "" }], price: "0.001", ttl: 60, sources, example: {}, ...extra });
const ok = (id: string, data: unknown, calls = { n: 0 }): Source & { calls: { n: number } } => ({ id, calls, run: async () => (calls.n++, { data }) });
const bad = (id: string, calls = { n: 0 }): Source & { calls: { n: number } } => ({ id, calls, run: async () => (calls.n++, Promise.reject(new Error("upstream down at https://secret.example/key=abc"))) });

test("money is parsed on the digits and never through a float", () => {
  assert.equal(toUnits("0.001", 6), 1000n);
  assert.equal(toUnits("0.05", 18), 50000000000000000n);
  assert.equal(toUnits("1234.567891", 6), 1234567891n);
  assert.equal(fromUnits(1000n, 6), "0.001");
  assert.equal(fromUnits("1500000", 6), "1.5");
  assert.equal(bps(1n, 3n), 3333);
  assert.equal(bps(5n, 0n), 0);
});

test("addresses compare without regard to case, and never weaker than plain equality", () => {
  assert.ok(sameAddress("0xAbCdEf0000000000000000000000000000000001", "0xabcdef0000000000000000000000000000000001"));
  assert.ok(!sameAddress("0xabcdef0000000000000000000000000000000001", "0xabcdef0000000000000000000000000000000002"));
  assert.ok(!sameAddress(null, "0xabcdef0000000000000000000000000000000001"));
  assert.ok(sameAddress("not-an-address", "not-an-address"));
  assert.ok(!sameAddress("Not-An-Address", "not-an-address"));
});

test("canonical JSON is the same bytes whatever the key order, in the engine and in the SDK", () => {
  const a = { b: 1, a: [3, { z: null, y: "x" }], c: { d: true } };
  const b = { c: { d: true }, a: [3, { y: "x", z: null }], b: 1 };
  assert.equal(canonical(a), canonical(b));
  assert.equal(canonical(a), '{"a":[3,{"y":"x","z":null}],"b":1,"c":{"d":true}}');
  assert.equal(sdkCanonical(a), canonical(a));
  assert.equal(digestOf(a), digestOf(b));
});

test("parameters are checked and normalised: symbols upper, addresses lower, numbers clamped, defaults filled", () => {
  const f = feedOf([], { params: [{ name: "symbol", type: "symbol", required: true, doc: "s" }, { name: "who", type: "address", doc: "" }, { name: "limit", type: "int", default: "5", min: 1, max: 10, doc: "" }, { name: "kind", type: "enum", values: ["a", "b"], default: "a", doc: "" }] });
  assert.deepEqual(normalizeParams(f, { symbol: "nvda", who: "0xAbCdEf0000000000000000000000000000000001", limit: "999" }), { symbol: "NVDA", who: "0xabcdef0000000000000000000000000000000001", limit: "10", kind: "a" });
  assert.throws(() => normalizeParams(f, {}), (e: HttpError) => e.status === 400 && e.code === "missing_param");
  assert.throws(() => normalizeParams(f, { symbol: "NVDA", who: "0x123" }), (e: HttpError) => e.code === "bad_param");
  assert.throws(() => normalizeParams(f, { symbol: "NVDA", limit: "1.5" }), (e: HttpError) => e.code === "bad_param");
  assert.throws(() => normalizeParams(f, { symbol: "NVDA", kind: "zzz" }), (e: HttpError) => e.code === "bad_param");
  assert.throws(() => normalizeParams(f, { symbol: "<script>" }), (e: HttpError) => e.code === "bad_param");
  assert.deepEqual(normalizeParams(f, { symbol: "ETH", extra: "ignored" } as never), { symbol: "ETH", limit: "5", kind: "a" });
});

test("collection tries sources in order, fails over, and records every attempt", async () => {
  const ctx = testCtx();
  const first = bad("primary");
  const second = ok("backup", { v: 1 });
  const third = ok("third", { v: 2 });
  const d = await collect(ctx, feedOf([first, second, third]), { symbol: "X" });
  assert.equal(d.source, "backup");
  assert.deepEqual(d.data, { v: 1 });
  assert.deepEqual(d.tried.map((t) => [t.source, t.ok]), [["primary", false], ["backup", true]]);
  assert.equal(third.calls.n, 0, "a source after the one that answered is not called");
  const h = health(ctx);
  const p = h.find((x) => x.source === "primary")!;
  assert.equal(p.fail, 1);
  assert.equal(p.state, "down");
  assert.ok(!p.lastError!.includes("secret.example"), "source URLs never reach the health record");
  assert.equal(h.find((x) => x.source === "backup")!.state, "ok");
  assert.equal(feedUptime(ctx, "t.feed").uptime, 1, "the feed answered, so its uptime is whole");
});

test("a live answer is served from the hot cache until it is older than asked for", async () => {
  const ctx = testCtx();
  const src = ok("s", { v: 1 });
  const f = feedOf([src]);
  const a = await collect(ctx, f, { symbol: "X" });
  const b = await collect(ctx, f, { symbol: "X" });
  assert.equal(src.calls.n, 1);
  assert.equal(a.cached, false);
  assert.equal(b.cached, true);
  assert.equal(b.signature, a.signature, "a cached answer keeps the signature made when it was collected");
  await collect(ctx, f, { symbol: "Y" });
  assert.equal(src.calls.n, 2, "other parameters are another answer");
  await collect(ctx, f, { symbol: "X" }, -1);
  assert.equal(src.calls.n, 3, "an answer older than the caller accepts is collected again");
  const n = await collect(ctx, f, normalizeParams(f, { symbol: "x" }));
  assert.equal(peek(ctx, f, { symbol: "X" })!.digest, n.digest, "peek finds the last answer for the same normalised parameters");
});

test("many callers asking at once share one collection", async () => {
  const ctx = testCtx();
  const calls = { n: 0 };
  const slow: Source = { id: "slow", run: async () => (calls.n++, await new Promise((r) => setTimeout(r, 30)), { data: { v: 1 } }) };
  const f = feedOf([slow]);
  const all = await Promise.all(Array.from({ length: 20 }, () => collect(ctx, f, { symbol: "X" })));
  assert.equal(calls.n, 1);
  assert.ok(all.every((d) => d.digest === all[0].digest));
});

test("when every source fails the caller gets a clear error and the feed's uptime shows it", async () => {
  const ctx = testCtx();
  const f = feedOf([bad("a"), bad("b")]);
  await assert.rejects(collect(ctx, f, { symbol: "X" }), (e: HttpError) => e.status === 502 && e.code === "all_sources_failed" && (e.extra.tried as unknown[]).length === 2);
  assert.equal(feedUptime(ctx, "t.feed").uptime, 0);
  await collect(ctx, feedOf([ok("a", 1)]), { symbol: "X" });
  assert.equal(feedUptime(ctx, "t.feed").uptime, 0.5);
});

test("a wrong request is the caller's error, not a source failure", async () => {
  const ctx = testCtx();
  const second = ok("b", 1);
  const f = feedOf([{ id: "a", run: async () => Promise.reject(new HttpError(404, "unknown_symbol", "no")) }, second]);
  await assert.rejects(collect(ctx, f, { symbol: "X" }), (e: HttpError) => e.status === 404);
  assert.equal(second.calls.n, 0);
  assert.equal(health(ctx).length, 0);
});

test("every answer is signed by the engine key and checks out with the SDK; a changed answer does not", async () => {
  const ctx = testCtx();
  const d = await collect(ctx, feedOf([ok("s", { price: "1.5", nested: { b: 2, a: 1 } })]), { symbol: "X" });
  const signed = { feed: d.feed, params: d.params, data: d.data, source: d.source, collectedAt: d.collectedAt };
  assert.ok(await verifyValue(signed, d.signature, ctx.signer.address));
  const answer: Answer = envelope(ctx, d, { tier: "live", requestId: "r", price: { amount: "0", units: "0", asset: "USDG", listAmount: "0", level: 0 }, paidBy: "free", receipt: null, transaction: null, allowance: { used: 0, limit: null } });
  const wire = JSON.parse(JSON.stringify(answer)) as Answer;
  assert.equal(answerDigest(wire), d.digest);
  assert.ok(await verifyAnswer(wire, ctx.signer.address));
  assert.ok(await verifyAnswer(wire));
  assert.ok(!(await verifyAnswer({ ...wire, data: { price: "1.6", nested: { a: 1, b: 2 } } }, ctx.signer.address)), "a changed number breaks the signature");
  assert.ok(!(await verifyAnswer({ ...wire, collectedAt: wire.collectedAt + 1 }, ctx.signer.address)), "a changed time breaks the signature");
  assert.ok(!(await verifyAnswer({ ...wire, source: "other" }, ctx.signer.address)), "a changed source breaks the signature");
  assert.ok(!(await verifyAnswer(wire, "0x0000000000000000000000000000000000000001")), "another engine's address does not match");
});

test("the catalog is well formed: unique ids, a price, a source and working example parameters for every feed", () => {
  const ids = new Set<string>();
  for (const f of FEEDS) {
    assert.ok(!ids.has(f.id), `duplicate ${f.id}`);
    ids.add(f.id);
    assert.ok(/^\d+(\.\d{1,6})?$/.test(f.price) && toUnits(f.price, 6) > 0n, `${f.id} price`);
    assert.ok(f.sources.length >= 1 && f.ttl > 0);
    assert.ok(f.summary.length > 30 && !f.summary.includes("—"), `${f.id} summary`);
    assert.doesNotThrow(() => normalizeParams(f, f.example), `${f.id} example`);
  }
  assert.ok(FEEDS.length >= 24);
});
