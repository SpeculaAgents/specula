import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { recoverMessageAddress, recoverTypedDataAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { accessMessage, accessToken, answerDigest, authorizationTypedData, canonical, decodeHeader, encodeHeader, feedTools, signPayment, Specula, SpeculaError, tickersIn, toolName, verifyAnswer, verifyInclusion, type Answer, type PaymentRequirements } from "../src/index.ts";
import { ENGINE_ADDRESS, localEngine } from "../../local-engine.ts";

let e: Awaited<ReturnType<typeof localEngine>>;
before(async () => void (e = await localEngine()));
after(() => e?.stop());
const agent = privateKeyToAccount(generatePrivateKey());

test("an answer comes back typed, signed and already checked against the engine's address", async () => {
  const s = new Specula({ baseUrl: e.url, account: agent });
  const a = await s.series("cpi", 3);
  assert.equal(a.feed, "macro.series");
  assert.deepEqual(a.params, { series: "cpi", limit: "3" });
  assert.equal(a.source, "publisher");
  assert.equal(a.proof.engine, ENGINE_ADDRESS.toLowerCase());
  assert.equal(a.meta.paidBy, "free");
  assert.ok(await verifyAnswer(a, ENGINE_ADDRESS));
  assert.equal(answerDigest(a), a.proof.digest);
  assert.deepEqual(await s.verify(a), { signature: true, inclusion: null, root: null, anchored: null });
  assert.equal(s.spent, "0");
});

test("an answer changed on the way is refused, and so is one signed by a different engine than the one pinned", async () => {
  const tamper = (async (u: string, i?: RequestInit) => {
    const r = await fetch(u, i);
    if (!String(u).includes("/v1/feeds/")) return r;
    const j = (await r.json()) as Answer<{ latest: { value: string } }>;
    j.data.latest.value = "999.999";
    return new Response(JSON.stringify(j), { status: 200 });
  }) as typeof fetch;
  await assert.rejects(new Specula({ baseUrl: e.url, fetch: tamper }).series("cpi"), (err: SpeculaError) => err.code === "bad_signature");
  await assert.rejects(new Specula({ baseUrl: e.url, engine: "0x0000000000000000000000000000000000000001" }).series("cpi"), (err: SpeculaError) => err.code === "bad_signature");
  const unchecked = await new Specula({ baseUrl: e.url, fetch: tamper, verify: false }).series("cpi");
  assert.equal(unchecked.data && (unchecked.data as { latest: { value: string } }).latest.value, "999.999", "checking can be switched off, on purpose");
});

test("engine errors arrive as one error type with the engine's own code and words", async () => {
  const s = new Specula({ baseUrl: e.url });
  await assert.rejects(s.series("nope"), (err: SpeculaError) => err instanceof SpeculaError && err.status === 400 && err.code === "bad_param");
  await assert.rejects(s.get("no.such"), (err: SpeculaError) => err.status === 404 && err.code === "unknown_feed");
  await assert.rejects(s.filings("ZZZZZ"), (err: SpeculaError) => err.code === "unknown_ticker");
  await assert.rejects(s.account(), (err: SpeculaError) => err.status === 401);
  await assert.rejects(new Specula({ baseUrl: "http://127.0.0.1:9" }).status(), /fetch failed|ECONNREFUSED/);
});

test("the free reads describe the engine: catalog, status, quotes, signals", async () => {
  const s = new Specula({ baseUrl: e.url, account: agent });
  const cat = await s.catalog();
  assert.ok(cat.count >= 24 && cat.feeds.every((f) => f.id && f.price.live.amount));
  assert.deepEqual(await s.quote("sec.summary"), { live: { amount: "0.03", list: "0.03", level: 0 }, recent: { amount: "0.015", list: "0.03", level: 0 }, delayed: { amount: "0.006", list: "0.03", level: 0 } });
  assert.equal((await s.status()).ok, true);
  assert.equal((await s.signalRules()).rules.length, 30);
  assert.equal((await s.parseSignal("Tesla files an 8-K")).reads, "TSLA files a 8-K with the SEC");
  const acct = await s.account();
  assert.equal(acct.wallet, agent.address.toLowerCase());
  assert.equal(acct.level, 0);
});

test("feeds become tools: a name, a priced description, a strict schema and a function that runs", async () => {
  const s = new Specula({ baseUrl: e.url });
  const tools = await feedTools(s);
  assert.equal(tools.length, (await s.catalog()).count);
  const t = tools.find((x) => x.feed === "macro.series")!;
  assert.equal(t.name, "specula_macro_series");
  assert.equal(toolName("chain.price"), "specula_chain_price");
  assert.match(t.description, /Costs 0\.002 USDG per call/);
  assert.deepEqual(t.schema.required, ["series"]);
  assert.equal(t.schema.additionalProperties, false);
  assert.ok(t.schema.properties.series.enum!.includes("cpi"));
  assert.equal(t.schema.properties.limit.type, "integer");
  const out = await t.run({ series: "cpi", limit: 2, ignored: undefined });
  assert.equal(out.paid, "free allowance");
  assert.equal(out.source, "publisher");
  assert.equal((out.data as { observations: unknown[] }).observations.length, 2);
  assert.deepEqual((await feedTools(s, { only: ["sec."] })).map((x) => x.feed.split(".")[0]).filter((g, i, a) => a.indexOf(g) === i), ["sec"]);
  assert.match((await feedTools(s, { fresh: "delayed", only: ["macro.series"] }))[0].description, /Costs 0\.0004 USDG/);
});

test("a payment signature authorises exactly one transfer of the asked amount to the asked address", async () => {
  const req: PaymentRequirements = { scheme: "exact", network: "eip155:4663", maxAmountRequired: "1000", resource: "x", description: "", mimeType: "application/json", payTo: "0x00000000000000000000000000000000000000bb", maxTimeoutSeconds: 120, asset: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", extra: { name: "Global Dollar", version: "1", decimals: 6, symbol: "USDG" } };
  const p = await signPayment(agent, req, 1_800_000_000);
  const a = p.payload.authorization;
  assert.deepEqual([a.from, a.to, a.value, a.validAfter, a.validBefore], [agent.address, req.payTo, "1000", "0", "1800000120"]);
  assert.match(a.nonce, /^0x[0-9a-f]{64}$/);
  assert.notEqual((await signPayment(agent, req)).payload.authorization.nonce, a.nonce, "every payment has its own nonce");
  const signer = await recoverTypedDataAddress({ ...authorizationTypedData(4663, req.asset, "Global Dollar", "1", a), signature: p.payload.signature });
  assert.equal(signer, agent.address);
  const other = await recoverTypedDataAddress({ ...authorizationTypedData(4663, req.asset, "Global Dollar", "1", { ...a, value: "999999" }), signature: p.payload.signature });
  assert.notEqual(other, agent.address, "the signature does not cover any other amount");
  assert.deepEqual(decodeHeader(encodeHeader(p)), p);
});

test("the client signs only USDG with six decimals: a server cannot stretch the price cap with another token", async () => {
  const usdg = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
  const ask = (over: Partial<PaymentRequirements> & { decimals?: number }) => {
    let paidWith: string | null = null;
    const req: PaymentRequirements = { scheme: "exact", network: "eip155:4663", maxAmountRequired: "50000000000000000", resource: "x", description: "", mimeType: "application/json", payTo: "0x00000000000000000000000000000000000000bb", maxTimeoutSeconds: 120, asset: usdg, extra: { name: "Global Dollar", version: "1", decimals: over.decimals ?? 6, symbol: "USDG" }, ...over };
    const f = (async (_u: string, i?: RequestInit) => {
      const h = (i?.headers ?? {}) as Record<string, string>;
      if (h["X-PAYMENT"]) paidWith = h["X-PAYMENT"];
      return new Response(JSON.stringify({ x402Version: 1, error: "payment_required", accepts: [req] }), { status: 402 });
    }) as typeof fetch;
    return { client: new Specula({ baseUrl: "https://engine.invalid", account: agent, verify: false, fetch: f }), paid: () => paidWith };
  };
  // 0.05 of an 18-decimal token reads as 50 billion dollars at six decimals: never under a 0.10 cap.
  const stretched = ask({ decimals: 18 });
  await assert.rejects(stretched.client.series("cpi"), (err: SpeculaError) => err.code === "unexpected_asset");
  assert.equal(stretched.paid(), null, "nothing was signed");
  const lookAlike = ask({ asset: "0x00000000000000000000000000000000000000aa", maxAmountRequired: "1000" });
  await assert.rejects(lookAlike.client.series("cpi"), (err: SpeculaError) => err.code === "unexpected_asset");
  assert.equal(lookAlike.paid(), null);
  const real = ask({ maxAmountRequired: "1000" });
  await assert.rejects(real.client.series("cpi"), (err: SpeculaError) => err.status === 402);
  assert.ok(real.paid(), "the real token at a price under the cap is signed");
});

test("the sign-in line is readable, expires, and recovers to the wallet", async () => {
  const token = await accessToken(agent, 600, 1_800_000_000);
  const [addr, expiry, sig] = token.split(".");
  assert.equal(addr, agent.address.toLowerCase());
  assert.equal(expiry, "1800000600");
  assert.equal(accessMessage(agent.address, 1800000600), `Specula access for ${agent.address.toLowerCase()} until 1800000600`);
  assert.equal(await recoverMessageAddress({ message: accessMessage(addr, 1800000600), signature: sig as `0x${string}` }), agent.address);
});

test("small helpers: canonical JSON, inclusion proofs, symbols in text", () => {
  assert.equal(canonical({ b: [1, { d: 1, c: undefined }], a: "x" }), '{"a":"x","b":[1,{"d":1}]}');
  const leaf = `0x${"1".repeat(64)}` as const;
  assert.ok(verifyInclusion(leaf, [], leaf));
  assert.ok(!verifyInclusion(leaf, [`0x${"2".repeat(64)}`], leaf));
  assert.deepEqual(tickersIn("What is the PRICE of NVDA and $ETH in USD?"), ["NVDA", "ETH"]);
});
