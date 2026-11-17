import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { Specula, SpeculaError, accessToken, encodeHeader, signPayment, verifyAnswer, type Answer, type PaymentRequiredBody } from "../../packages/sdk/src/index.ts";
import { startEngine, type Engine } from "../src/main.ts";
import { verifyValue } from "../src/sign.ts";
import { nowSec } from "../src/util.ts";
import { ANVIL_KEYS, ENGINE_KEY, localChain, readJson, replayFetch, replayTransport, type FetchTape, type LocalChain, type Tape } from "./helpers.ts";

const chainFix = readJson<{ tape: Tape }>("chain.json");
const docs = readJson<FetchTape>("docs.json");
const agent = privateKeyToAccount(ANVIL_KEYS.agent);
const agent2 = privateKeyToAccount(ANVIL_KEYS.agent2);
const treasury = privateKeyToAccount(ANVIL_KEYS.treasury).address;
const BOARD = "/v1/feeds/chain.prices?kind=all"; // 0.005 USDG live
const LIVE = 5000n;

let chain: LocalChain;
let e: Engine;
let n = 0;
const ip = () => `10.0.0.${++n}`;
const get = (path: string, headers: Record<string, string> = {}) => fetch(`${e.url}${path}`, { headers: { "x-forwarded-for": ip(), ...headers } });
const sdk = (account = agent, extra: Record<string, unknown> = {}) => new Specula({ baseUrl: e.url, account, ...extra });
/** Use up a wallet's free calls so the next one has to be paid. */
const drain = async (account = agent) => {
  const auth = { Authorization: `Specula ${await accessToken(account)}` };
  for (let i = 0; i < 3; i++) if ((await get(BOARD, auth)).status === 402) return auth;
  throw new Error("the allowance never ran out");
};

before(async () => {
  chain = await localChain(4145, privateKeyToAccount(ENGINE_KEY).address);
  await chain.mint(agent.address, 5_000_000n);
  e = await startEngine(
    { port: 0, dbPath: ":memory:", engineKey: ENGINE_KEY, payments: true, payRpcUrl: chain.url, payChainId: 31337, payAsset: chain.usdg, payTo: treasury, relayerKey: ANVIL_KEYS.relayer, freeDaily: 2, freeDailyAnon: 1, secMinGapMs: 0 },
    { jobs: false, env: {}, transport: replayTransport(chainFix.tape), fetch: replayFetch(docs) },
  );
});
after(async () => {
  await e?.stop();
  chain?.stop();
});

test("the free allowance comes first; after it the engine asks for payment in the x402 shape", async () => {
  const who = { "x-forwarded-for": "10.9.9.9" };
  const t0 = Date.now();
  const a = await fetch(`${e.url}${BOARD}`, { headers: who });
  assert.equal(a.status, 200);
  const first = (await a.json()) as Answer;
  assert.equal(first.meta.paidBy, "free");
  assert.ok(Date.now() - t0 < 3000, `slow first answer: ${Date.now() - t0} ms, tried ${JSON.stringify(first.meta.tried)}`);
  assert.deepEqual(first.meta.allowance, { used: 1, limit: 1 });
  const b = await fetch(`${e.url}${BOARD}`, { headers: who });
  assert.equal(b.status, 402);
  const need = (await b.json()) as PaymentRequiredBody;
  assert.equal(need.x402Version, 1);
  assert.equal(need.error, "free_allowance_used");
  const r = need.accepts[0];
  assert.equal(r.scheme, "exact");
  assert.equal(r.network, "eip155:31337");
  assert.equal(r.maxAmountRequired, LIVE.toString());
  assert.equal(r.payTo.toLowerCase(), treasury.toLowerCase());
  assert.equal(r.asset.toLowerCase(), chain.usdg.toLowerCase());
  assert.deepEqual(r.extra, { name: "Global Dollar", version: "1", decimals: 6, symbol: "USDG" });
  assert.ok(r.resource.includes("/v1/feeds/chain.prices"));
});

test("an agent pays for one answer from its own wallet: exact amount moves, the answer is signed, a receipt is written", async () => {
  await drain();
  const [a0, t0] = [await chain.balance(agent.address), await chain.balance(treasury)];
  const s = sdk();
  const ans = await s.prices("all");
  assert.equal(ans.meta.paidBy, "x402");
  assert.equal(ans.meta.price.units, LIVE.toString());
  assert.equal(ans.meta.price.amount, "0.005");
  assert.match(ans.meta.transaction!, /^0x[0-9a-f]{64}$/);
  assert.equal((await chain.balance(agent.address)) - a0, -LIVE);
  assert.equal((await chain.balance(treasury)) - t0, LIVE);
  assert.equal(s.spent, "0.005");
  assert.ok(await verifyAnswer(ans, privateKeyToAccount(ENGINE_KEY).address));
  const rc = (await s.receipts()).receipts[0];
  assert.equal(rc.id, ans.meta.receipt);
  assert.equal(rc.kind, "payment");
  assert.equal(rc.transaction, ans.meta.transaction);
  const full = (await (await get(`/v1/receipts/${rc.id}`)).json()) as { id: string; requestId: string; wallet: string; kind: string; amountUnits: string; asset: string; transaction: string; at: number; feed: string; signature: `0x${string}`; engine: string };
  assert.ok(await verifyValue({ id: full.id, requestId: full.requestId, wallet: full.wallet, kind: full.kind, amountUnits: full.amountUnits, asset: full.asset, network: "eip155:31337", transaction: full.transaction, at: full.at, feed: full.feed }, full.signature, full.engine), "the receipt is signed by the engine");
});

test("the raw protocol works without the SDK, and the response names the transaction", async () => {
  const auth = await drain(agent2);
  await chain.mint(agent2.address, 100_000n);
  const need = (await (await get(BOARD, auth)).json()) as PaymentRequiredBody;
  const payment = await signPayment(agent2, need.accepts[0]);
  const res = await get(BOARD, { ...auth, "X-PAYMENT": encodeHeader(payment) });
  assert.equal(res.status, 200);
  const pr = JSON.parse(Buffer.from(res.headers.get("x-payment-response")!, "base64").toString()) as { success: boolean; transaction: string; network: string; payer: string };
  assert.equal(pr.success, true);
  assert.equal(pr.payer, agent2.address.toLowerCase());
  assert.equal(pr.network, "eip155:31337");
  // The same signed payment cannot be used twice.
  const again = await get(BOARD, { ...auth, "X-PAYMENT": encodeHeader(payment) });
  assert.equal(again.status, 402);
  assert.equal(((await again.json()) as { error: string }).error, "nonce_already_used");
  assert.equal(await chain.balance(agent2.address), 100_000n - LIVE);
});

test("older answers cost less: half for up to five minutes old, a fifth for up to an hour", async () => {
  const q = (await (await get("/v1/quote/chain.prices")).json()) as Record<string, { amount: string }>;
  assert.deepEqual([q.live.amount, q.recent.amount, q.delayed.amount], ["0.005", "0.0025", "0.001"]);
  await drain();
  const before = await chain.balance(agent.address);
  const s = sdk();
  const r = await s.prices("all", { fresh: "recent" });
  const d = await s.prices("all", { fresh: "delayed" });
  assert.equal(r.meta.price.units, "2500");
  assert.equal(d.meta.price.units, "1000");
  assert.equal(d.meta.tier, "delayed");
  assert.equal(before - (await chain.balance(agent.address)), 3500n);
  assert.equal((await get(`${BOARD}&fresh=stale`)).status, 400);
});

test("a payment that is short, misdirected, expired, forged or unfunded is refused and nothing moves", async () => {
  const auth = await drain();
  const need = ((await (await get(BOARD, auth)).json()) as PaymentRequiredBody).accepts[0];
  const before = [await chain.balance(agent.address), await chain.balance(treasury)];
  const tryWith = async (p: unknown) => {
    const res = await get(BOARD, { ...auth, "X-PAYMENT": encodeHeader(p) });
    return { status: res.status, error: ((await res.json()) as { error: string }).error };
  };
  assert.deepEqual(await tryWith(await signPayment(agent, { ...need, maxAmountRequired: "4999" })), { status: 402, error: "amount_too_low" });
  assert.deepEqual(await tryWith(await signPayment(agent, { ...need, payTo: agent2.address })), { status: 402, error: "wrong_recipient" });
  assert.deepEqual(await tryWith(await signPayment(agent, need, nowSec() - 3600)), { status: 402, error: "authorization_expired" });
  assert.deepEqual(await tryWith({ ...(await signPayment(agent, need)), network: "eip155:1" }), { status: 402, error: "wrong_network" });
  const forged = await signPayment(agent2, need);
  forged.payload.authorization.from = agent.address; // someone else's signature over the agent's money
  assert.deepEqual(await tryWith(forged), { status: 402, error: "bad_signature" });
  const tampered = await signPayment(agent, need);
  tampered.payload.authorization.value = "5001"; // changed after signing
  assert.deepEqual(await tryWith(tampered), { status: 402, error: "bad_signature" });
  const broke = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");
  const brokeAuth = await drain(broke);
  const r = await get(BOARD, { ...brokeAuth, "X-PAYMENT": encodeHeader(await signPayment(broke, need)) });
  assert.equal(((await r.json()) as { error: string }).error, "insufficient_funds");
  assert.equal((await get(BOARD, { ...auth, "X-PAYMENT": "not-base64-json" })).status, 402);
  assert.deepEqual([await chain.balance(agent.address), await chain.balance(treasury)], before);
});

test("a failed answer is never charged: the payment is only settled after the answer is ready", async () => {
  const auth = await drain();
  // This symbol's reading is not on the recorded tape, so every source fails, like a node outage.
  const path = "/v1/feeds/chain.price?symbol=NVDA";
  const need = ((await (await get(path, auth)).json()) as PaymentRequiredBody).accepts[0];
  const payment = await signPayment(agent, need);
  const before = await chain.balance(agent.address);
  const res = await get(path, { ...auth, "X-PAYMENT": encodeHeader(payment) });
  assert.equal(res.status, 502);
  const body = (await res.json()) as { error: string; charged: boolean; tried: unknown[] };
  assert.equal(body.error, "all_sources_failed");
  assert.equal(body.charged, false);
  assert.equal(body.tried.length, 2);
  assert.equal(await chain.balance(agent.address), before);
  assert.equal(e.ctx.db.prepare("SELECT COUNT(*) n FROM used_nonces WHERE nonce = ?").get(payment.payload.authorization.nonce.toLowerCase()) && (e.ctx.db.prepare("SELECT COUNT(*) n FROM used_nonces WHERE nonce = ?").get(payment.payload.authorization.nonce.toLowerCase()) as { n: number }).n, 0, "the signed payment was not consumed");
  const failed = e.ctx.db.prepare("SELECT status, price FROM requests WHERE feed = 'chain.price' ORDER BY rowid DESC LIMIT 1").get() as { status: string; price: string };
  assert.deepEqual(failed, { status: "failed", price: "0" });
});

test("budgets hold on both sides: the wallet's daily budget on the engine and the client's own limits", async () => {
  const w = privateKeyToAccount("0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e");
  await chain.mint(w.address, 1_000_000n);
  await drain(w);
  const s = sdk(w);
  const acct = (await s.setBudget("0.006")) as { budget: { daily: string } };
  assert.equal(acct.budget.daily, "0.006");
  await s.prices("all");
  const bal = await chain.balance(w.address);
  await assert.rejects(s.prices("all"), (err: SpeculaError) => err.status === 403 && err.code === "budget_reached" && (err.body.budget as { spentToday: string }).spentToday === "0.005");
  assert.equal(await chain.balance(w.address), bal, "the refused call was not charged");
  await s.prices("all", { fresh: "delayed" }); // 0.001 still fits under 0.006
  await s.setBudget(null);
  await s.prices("all");
  // Client-side guards refuse before anything is signed.
  const tight = sdk(w, { maxPricePerCall: "0.001" });
  await assert.rejects(tight.prices("all"), (err: SpeculaError) => err.code === "over_max_price");
  const capped = sdk(w, { budget: "0.007" });
  await capped.prices("all");
  await assert.rejects(capped.prices("all"), (err: SpeculaError) => err.code === "over_budget");
  assert.equal(capped.spent, "0.005");
  await assert.rejects(new Specula({ baseUrl: e.url, fetch: ((u: string, i?: RequestInit) => fetch(u, { ...i, headers: { ...(i?.headers as object), "x-forwarded-for": "10.9.9.9" } })) as typeof fetch }).prices("all"), (err: SpeculaError) => err.status === 402 && /no wallet/.test(err.message));
  assert.equal((await get("/v1/account")).status, 401);
  assert.equal((await fetch(`${e.url}/v1/budget`, { method: "POST", headers: { Authorization: `Specula ${await accessToken(w)}`, "content-type": "application/json" }, body: JSON.stringify({ daily: "abc" }) })).status, 400);
});

test("prepaid credits: one top-up on chain, then calls are paid from the balance to the exact unit", async () => {
  const w = privateKeyToAccount("0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356");
  await chain.mint(w.address, 2_000_000n);
  await drain(w);
  const s = sdk(w);
  const top = await s.topUp("0.5");
  assert.equal(top.credits, "0.5");
  assert.match(top.receipt.transaction, /^0x[0-9a-f]{64}$/);
  assert.equal(await chain.balance(w.address), 1_500_000n);
  const a = await s.prices("all");
  const b = await s.prices("all", { fresh: "recent" });
  assert.equal(a.meta.paidBy, "credits");
  assert.equal(a.meta.transaction, null);
  assert.equal(b.meta.price.units, "2500");
  assert.equal(await chain.balance(w.address), 1_500_000n, "no further transfers: the credits cover it");
  const acct = await s.account();
  assert.equal(acct.credits, "0.4925");
  assert.equal(acct.spentToday, "0.0075");
  assert.deepEqual((await s.receipts()).receipts.map((r) => [r.kind, r.amount]), [["credit_spend", "0.0025"], ["credit_spend", "0.005"], ["topup", "0.5"]]);
  // A failed answer leaves the balance alone.
  await assert.rejects(s.price("NVDA"), (err: SpeculaError) => err.status === 502 && err.body.charged === false);
  assert.equal((await s.account()).credits, "0.4925");
  assert.equal((await fetch(`${e.url}/v1/credits/topup?amount=0.01`, { method: "POST" })).status, 400);
});

test("bulk levels: a wallet that spent more in the last 30 days pays less per call", async () => {
  const w = privateKeyToAccount("0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97");
  await chain.mint(w.address, 1_000_000n);
  await drain(w);
  const s = sdk(w);
  assert.equal((await s.quote("chain.prices")).live.amount, "0.005");
  // Twelve dollars of earlier spend puts the wallet on level 1 (10% off).
  e.ctx.db.prepare("INSERT INTO receipts (id, request_id, wallet, kind, amount, asset, tx, at, feed, digest, signature) VALUES ('rcpt_old', NULL, ?, 'payment', '12000000', ?, NULL, ?, 'chain.prices', '0x', '0x')").run(w.address.toLowerCase(), chain.usdg.toLowerCase(), nowSec() - 86400 * 3);
  const q = await s.quote("chain.prices");
  assert.deepEqual([q.live.amount, q.live.level, q.delayed.amount], ["0.0045", 1, "0.0009"]);
  const ans = await s.prices("all");
  assert.equal(ans.meta.price.units, "4500");
  assert.equal(ans.meta.price.level, 1);
  assert.equal(await chain.balance(w.address), 1_000_000n - 4500n);
  const acct = await s.account();
  assert.equal(acct.level, 1);
  assert.equal(acct.discountBps, 1000);
  // Spend older than 30 days no longer counts.
  e.ctx.db.prepare("UPDATE receipts SET at = ? WHERE id = 'rcpt_old'").run(nowSec() - 86400 * 31);
  assert.equal((await s.quote("chain.prices")).live.level, 0);
});

test("the public request feed shows what was bought without showing who", async () => {
  const list = ((await (await get("/v1/requests?limit=100")).json()) as { requests: { feed: string; paidBy: string; buyer: string; price: string; status: string }[] }).requests;
  assert.ok(list.length > 10);
  assert.ok(list.some((r) => r.paidBy === "x402" && r.price === "0.005"));
  assert.ok(list.some((r) => r.paidBy === "credits"));
  assert.ok(list.every((r) => r.status === "ok" && (r.buyer === "anonymous" || /^0x[0-9a-f]{4}…[0-9a-f]{4}$/.test(r.buyer))), "wallets are masked");
  const site = (await (await get("/v1/site")).json()) as { stats: { paid24h: number; paidTotal: string; requests24h: number } };
  assert.ok(site.stats.paid24h >= 6 && Number(site.stats.paidTotal) > 0.02 && site.stats.requests24h >= list.length, JSON.stringify(site.stats));
});

test("live streams: open channels are free, data channels are paid by the minute from allowance or credits", async () => {
  const w = privateKeyToAccount("0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6");
  await chain.mint(w.address, 1_000_000n);
  await drain(w);
  const s = sdk(w);
  const notices: Record<string, unknown>[] = [];
  const events: { channel: string; data: unknown }[] = [];
  const h1 = s.stream(["requests", "prices"], (ev) => events.push(ev), (m) => notices.push(m));
  await h1.ready;
  assert.ok(notices.some((m) => m.op === "subscribed" && m.channel === "requests"));
  assert.ok(notices.some((m) => m.op === "paused" && m.channel === "prices" && m.reason === "free_allowance_used_and_no_credits"), "no allowance and no credits: the channel is paused, with the reason");
  h1.close();
  await s.topUp("0.1");
  const n2: Record<string, unknown>[] = [];
  const h2 = s.stream(["prices", "trades", "nope"], (ev) => events.push(ev), (m) => n2.push(m));
  await h2.ready;
  assert.ok(n2.some((m) => m.op === "subscribed" && m.channel === "prices" && m.paidBy === "credits"));
  assert.ok(n2.some((m) => m.op === "error" && m.error === "unknown_channel"));
  assert.equal((await s.account()).credits, "0.099", "two channels, one minute each, 0.0005 a minute");
  e.ctx.bus.emit("prices", [{ symbol: "ETH", price: "1", raw: "100000000", resting: true }]);
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(events.some((ev) => ev.channel === "prices"));
  h2.close();
});
