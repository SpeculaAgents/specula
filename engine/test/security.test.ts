import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { WebSocket } from "ws";
import { createPublicClient, createWalletClient, http, parseAbi, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { accessToken, encodeHeader, signPayment, type PaymentRequiredBody } from "../../packages/sdk/src/index.ts";
import { askSource } from "../src/ask.ts";
import { startEngine, type Engine } from "../src/main.ts";
import { ANVIL_KEYS, ENGINE_KEY, localChain, readJson, replayFetch, replayTransport, type FetchTape, type LocalChain, type Tape } from "./helpers.ts";

/**
 * Attacks on the engine from the outside, through its HTTP API, each with the answer it must give. Every test here
 * failed before the fix it stands for.
 */
type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const BOARD = "/v1/feeds/chain.prices?kind=all";
const seller = privateKeyToAccount(ANVIL_KEYS.agent2);
const buyer = privateKeyToAccount(ANVIL_KEYS.agent);
const friend = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");
const treasury = privateKeyToAccount(ANVIL_KEYS.treasury).address;
let chain: LocalChain;
let e: Engine;
let shop: Server;
let shopUrl = "";
let shopHits = 0;

const auth = async (a: PrivateKeyAccount) => ({ Authorization: `Specula ${await accessToken(a)}` });
const call = async (path: string, who: PrivateKeyAccount | null, o: { method?: string; body?: unknown; ip?: string; headers?: Record<string, string> } = {}) => {
  const r = await fetch(`${e.url}${path}`, { method: o.method ?? "GET", headers: { ...(who ? await auth(who) : {}), "content-type": "application/json", "x-forwarded-for": o.ip ?? "10.20.0.1", ...o.headers }, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as J };
};
/** Ask for a paid answer: take the 402, sign exactly what it asks, send it again. */
const paid = async (path: string, payer: PrivateKeyAccount, signedIn: PrivateKeyAccount | null, ip: string) => {
  const first = await call(path, signedIn, { ip });
  assert.equal(first.status, 402, JSON.stringify(first.body));
  const need = (first.body as PaymentRequiredBody).accepts[0];
  return call(path, signedIn, { ip, headers: { "X-PAYMENT": encodeHeader(await signPayment(payer, need)) } });
};

before(async () => {
  shop = createServer((req, res) => {
    shopHits++;
    const u = new URL(req.url!, "http://x");
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ city: u.searchParams.get("city"), secret: "desk notes" }));
  });
  await new Promise<void>((r) => shop.listen(0, "127.0.0.1", r));
  shopUrl = `http://127.0.0.1:${(shop.address() as { port: number }).port}`;
  chain = await localChain(4148, privateKeyToAccount(ENGINE_KEY).address);
  for (const a of [buyer, friend, seller]) await chain.mint(a.address, 50_000_000n);
  const replay = replayFetch(readJson<FetchTape>("docs.json"));
  const net: typeof fetch = ((u: string | URL | Request, i?: RequestInit) => (String(u).startsWith(shopUrl) ? fetch(u, i) : replay(u, i))) as typeof fetch;
  e = await startEngine(
    { port: 0, dbPath: ":memory:", engineKey: ENGINE_KEY, payments: true, payRpcUrl: chain.url, payChainId: 31337, payAsset: chain.usdg, payTo: treasury, relayerKey: ANVIL_KEYS.relayer, bounties: chain.bounties, marketAllowLocal: true, freeDaily: 2, freeDailyAnon: 1, secMinGapMs: 0 },
    { jobs: false, env: {}, transport: replayTransport(readJson<{ tape: Tape }>("chain.json").tape), fetch: net },
  );
});
after(async () => {
  await e?.stop();
  chain?.stop();
  shop?.close();
});

// ---------- who is calling

test("a caller cannot pick its own address with X-Forwarded-For: the proxy's entry counts, not the caller's", async () => {
  const proxy = "10.30.0.7";
  assert.equal((await call(BOARD, null, { ip: `6.6.6.1, ${proxy}` })).status, 200);
  const second = await call(BOARD, null, { ip: `6.6.6.2, ${proxy}` });
  assert.equal(second.status, 402, "a made-up first entry does not buy a new free allowance");
  assert.equal(second.body.error, "free_allowance_used");
});

test("free calls are held to the caller's address too: signing in with new wallets does not multiply them", async () => {
  const ip = "10.30.1.1";
  const [w1, w2] = [privateKeyToAccount(generatePrivateKey()), privateKeyToAccount(generatePrivateKey())];
  for (let i = 0; i < 2; i++) assert.equal((await call(BOARD, w1, { ip })).status, 200);
  assert.equal((await call(BOARD, w1, { ip })).status, 402);
  const fresh = await call(BOARD, w2, { ip });
  assert.equal(fresh.status, 402, "a second wallet from the same address has no free calls left");
  assert.equal(fresh.body.error, "free_allowance_used");
  assert.equal((await call(BOARD, w2, { ip: "10.30.1.2" })).status, 200, "from its own address it has its own");
});

// ---------- payments

test("the receipt and the spending belong to the wallet whose money moved, not to whoever signed in", async () => {
  const ip = "10.30.2.1";
  const lurker = privateKeyToAccount(generatePrivateKey());
  for (let i = 0; i < 2; i++) await call(BOARD, lurker, { ip });
  const r = await paid(BOARD, buyer, lurker, ip);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const rc = (await call(`/v1/receipts/${r.body.meta.receipt}`, null)).body;
  assert.equal(rc.wallet, buyer.address.toLowerCase());
  assert.equal((await call("/v1/receipts", lurker)).body.count, 0, "the signed-in wallet paid nothing and has no receipt");
});

test("a wallet cannot pay itself: a seller buying its own feed is refused before any gas is spent", async () => {
  const made = await call("/v1/market/feeds", seller, { method: "POST", body: { slug: "selfie", title: "Self paid feed", summary: "A feed whose seller tries to buy it to climb the ranking.", price: "0.01", url: `${shopUrl}/selfie` } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const relayer = privateKeyToAccount(ANVIL_KEYS.relayer).address;
  const pub = createPublicClient({ chain: foundry, transport: http(chain.url) });
  const nonce = await pub.getTransactionCount({ address: relayer });
  const r = await paid("/v1/feeds/market.selfie?city=A", seller, seller, "10.30.3.1");
  assert.equal(r.status, 402);
  assert.equal(r.body.error, "self_payment");
  assert.equal(await pub.getTransactionCount({ address: relayer }), nonce, "the relayer sent nothing");
  assert.equal((await call("/v1/market", null)).body.feeds.find((f: J) => f.id === "market.selfie").paidCalls30d, 0);
});

// ---------- private feeds

test("a private feed is named nowhere public: status, quality, quotes, the request feeds, the archive, offers or answers", async () => {
  const made = await call("/v1/market/feeds", seller, { method: "POST", body: { slug: "hidden", title: "Hidden desk notes", summary: "Notes from a desk, only for the wallets on the list.", price: "0.01", url: `${shopUrl}/hidden`, params: [{ name: "city" }], allow: [friend.address] } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const events: J[] = [];
  const listen = (d: J) => events.push(d);
  e.ctx.bus.on("request", listen);
  const r = await paid("/v1/feeds/market.hidden?city=A", friend, friend, "10.30.4.1");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  e.ctx.bus.off("request", listen);
  assert.equal(events.filter((x) => x.feed === "market.hidden").length, 0, "the live request stream does not name it");
  const leaks = (what: string, body: unknown) => assert.ok(!JSON.stringify(body).includes("market.hidden") && !JSON.stringify(body).includes("Hidden desk"), `${what} names the private feed`);
  for (const path of ["/v1/status", "/v1/quality", "/v1/requests?limit=100", "/v1/site", "/v1/catalog", "/v1/demand", "/v1/market"]) leaks(path, (await call(path, null)).body);
  assert.equal((await call("/v1/quote/market.hidden", null)).status, 404, "a stranger gets no price for it");
  assert.equal((await call("/v1/quote/market.hidden", buyer)).status, 404);
  assert.equal((await call("/v1/quote/market.hidden", friend)).status, 200, "a wallet on the list does");
  // A bounty offer is public, so a private feed cannot be one.
  const b = await call("/v1/bounties", buyer, { method: "POST", body: { title: "Desk notes wanted", detail: "Daily notes from a trading desk, one paragraph per market.", amount: "2" } });
  assert.equal((await call(`/v1/bounties/${b.body.id}/offers`, seller, { method: "POST", body: { feed: "market.hidden" } })).status, 400);
  leaks("the bounty", (await call(`/v1/bounties/${b.body.id}`, null)).body);
  // Asking the data never reaches a seller's or a private feed, whatever the model plans.
  const plan = e.ctx.ai.plan;
  e.ctx.ai.plan = async () => [{ feed: "market.hidden", params: { city: "A" } }, { feed: "market.selfie", params: { city: "A" } }];
  const hits = shopHits;
  try {
    const out = (await askSource.run(e.ctx, { q: "what do the desk notes say" })).data as J;
    assert.equal(out.citations.length, 0);
    assert.equal(shopHits, hits, "the seller's endpoint was never called");
    leaks("the answer", out.answer);
  } finally {
    e.ctx.ai.plan = plan;
  }
  // Taken down, it stays out of the public archive and request lists.
  assert.equal((await call("/v1/market/feeds/hidden", seller, { method: "DELETE" })).status, 200);
  for (const path of ["/v1/archive", "/v1/requests?limit=100", "/v1/site"]) leaks(path, (await call(path, null)).body);
});

// ---------- teams

test("a wallet joins a team only with its own yes, and can always leave", async () => {
  const owner = privateKeyToAccount(generatePrivateKey());
  const agentW = privateKeyToAccount(generatePrivateKey());
  const t = await call("/v1/teams", owner, { method: "POST", body: { name: "Squeeze" } });
  assert.equal(t.status, 201);
  const tid = t.body.id;
  const invited = await call(`/v1/teams/${tid}/members`, owner, { method: "POST", body: { wallet: agentW.address } });
  assert.equal(invited.status, 201);
  assert.equal(invited.body.members.length, 1, "an invite is not a membership");
  assert.deepEqual(invited.body.invited.map((x: J) => x.wallet), [agentW.address.toLowerCase()]);
  // Until it accepts, its calls are not in the owner's report and the team's budget is not its budget.
  assert.equal((await call(BOARD, agentW, { ip: "10.30.5.1" })).status, 200);
  assert.equal((await call("/v1/teams/mine", agentW)).status, 404);
  assert.equal((await call("/v1/teams/mine", agentW)).body.invites[0].team, tid);
  assert.ok(!JSON.stringify((await call("/v1/teams/mine", owner)).body.members).includes(agentW.address.toLowerCase()));
  // Someone else cannot accept for it.
  assert.equal((await call(`/v1/teams/${tid}/members`, buyer, { method: "POST", body: { wallet: buyer.address } })).status, 404);
  const joined = await call(`/v1/teams/${tid}/members`, agentW, { method: "POST", body: { wallet: agentW.address } });
  assert.equal(joined.status, 201);
  assert.equal(joined.body.members.length, 2);
  assert.equal((await call(`/v1/teams/${tid}/members/${agentW.address}`, agentW, { method: "DELETE" })).body.left, true);
  assert.equal((await call("/v1/teams/mine", agentW)).status, 404);
});

// ---------- bounties

test("a bounty is funded only by its own funder's deposit: opening its id first from another wallet changes nothing", async () => {
  const made = (await call("/v1/bounties", buyer, { method: "POST", body: { title: "Port congestion hourly", detail: "Ships waiting at the ten largest container ports, every hour.", amount: "3" } })).body;
  const pub = createPublicClient({ chain: foundry, transport: http(chain.url), pollingInterval: 50 });
  const abi = parseAbi(["function approve(address spender, uint256 value) returns (bool)", "function open(bytes32 id, uint256 amount, uint64 deadline)"]);
  const mined = (hash: Hex) => pub.waitForTransactionReceipt({ hash });
  const squat = createWalletClient({ account: seller, chain: foundry, transport: http(chain.url) });
  await mined(await squat.writeContract({ address: chain.usdg, abi, functionName: "approve", args: [chain.bounties, 10n ** 12n] }));
  await mined(await squat.writeContract({ address: chain.bounties, abi, functionName: "open", args: [made.fund.args[0], 3_000_000n, BigInt(made.fund.args[2])] }));
  assert.equal((await call(`/v1/bounties/${made.id}`, null)).body.status, "pledged", "someone else's deposit does not fund it");
  const w = createWalletClient({ account: buyer, chain: foundry, transport: http(chain.url) });
  await mined(await w.writeContract({ address: chain.usdg, abi, functionName: "approve", args: [chain.bounties, 10n ** 12n] }));
  await mined(await w.writeContract({ address: chain.bounties, abi, functionName: "open", args: [made.fund.args[0], 3_000_000n, BigInt(made.fund.args[2])] }));
  assert.equal((await call(`/v1/bounties/${made.id}`, null)).body.status, "funded", "the funder could still lock it");
});

// ---------- size and rate

test("request bodies are capped, and the free rule parser is a few calls a minute per caller", async () => {
  const big = await call("/v1/signals/parse", null, { method: "POST", body: { text: "x".repeat(100_000) } });
  assert.equal(big.status, 413);
  let last = 0;
  for (let i = 0; i < 25; i++) last = (await call("/v1/signals/parse", null, { method: "POST", ip: "10.30.6.1", body: { text: "tell me when NVDA falls 3% in an hour" } })).status;
  assert.equal(last, 429);
  assert.equal((await call("/v1/signals/parse", null, { method: "POST", ip: "10.30.6.2", body: { text: "tell me when NVDA falls 3% in an hour" } })).status, 200, "other callers are not affected");
});

test("a stream message far larger than any real one closes the socket", { timeout: 5000 }, async () => {
  const ws = new WebSocket(`${e.url.replace("http", "ws")}/v1/stream`);
  await new Promise((r) => ws.once("message", r));
  const closed = new Promise<number>((r) => ws.once("close", (code) => r(code)));
  ws.send(JSON.stringify({ op: "subscribe", channels: ["requests"], pad: "x".repeat(64 * 1024) }));
  assert.equal(await closed, 1009);
});
