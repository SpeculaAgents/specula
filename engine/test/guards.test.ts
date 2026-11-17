import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttps, type Server } from "node:https";
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import { createPublicClient, createWalletClient, http, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { signPayment, type PaymentPayload } from "../../packages/sdk/src/index.ts";
import { checkUrl } from "../src/market.ts";
import { fetchPinned, publicTarget, refusalOf, TooLarge } from "../src/net.ts";
import { gasUsed, GAS_LIMITS } from "../src/gas.ts";
import { requirements, settlePayment, verifyPayment } from "../src/pay.ts";
import { callerIp } from "../src/server.ts";
import type { HttpError } from "../src/util.ts";
import { ANVIL_KEYS, ENGINE_KEY, HERE, localChain, testCtx, type LocalChain } from "./helpers.ts";

/** The engine's guards one by one: addresses it may fetch, payments it may count, gas it may spend. */
const TMP = resolve(HERE, ".tmp");
const agent = privateKeyToAccount(ANVIL_KEYS.agent);
const agent2 = privateKeyToAccount(ANVIL_KEYS.agent2);
const treasury = privateKeyToAccount(ANVIL_KEYS.treasury).address;
const bad = (code: string) => (err: HttpError) => err.status >= 400 && err.code === code;

// ---------- addresses

test("every address that is not on the public internet is refused, IPv4 hidden inside IPv6 among them", () => {
  const refused = [
    "0.0.0.0", "10.1.2.3", "100.64.0.1", "100.100.100.200", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.0.0.8", "192.0.2.1",
    "192.168.1.1", "198.18.0.1", "198.51.100.7", "203.0.113.9", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255",
    "::", "::1", "::127.0.0.1", "::7f00:1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "0:0:0:0:0:ffff:0a00:0001",
    "64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe", "64:ff9b:1::a00:1", "2002:7f00:1::", "2002:a9fe:a9fe::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2",
    "2001:db8::1", "fc00::1", "fd00:ec2::254", "fe80::1", "fec0::1", "ff02::1", "100::1", "3fff::1",
  ];
  for (const ip of refused) assert.notEqual(refusalOf(ip), null, ip);
  for (const ip of ["1.1.1.1", "8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "2a00:1450:4001:80b::200e"]) assert.equal(refusalOf(ip), null, ip);
});

test("a seller's endpoint written as IPv6 or as a private name is refused when it is listed", async () => {
  const ctx = testCtx();
  for (const url of ["https://[::ffff:7f00:1]/x", "https://[::ffff:127.0.0.1]/x", "https://[::ffff:a9fe:a9fe]/latest", "https://[64:ff9b::a9fe:a9fe]/", "https://[2002:a9fe:a9fe::]/", "https://[fd00:ec2::254]/", "https://0x7f.1/x", "https://2130706433/x", "https://metadata/x", "https://engine.railway.internal/v1", "https://localhost./x", "https://printer.local./x"])
    await assert.rejects(checkUrl(ctx, url), bad("bad_url"), url);
});

test("a host is resolved once and every address it gives must be public", async () => {
  await assert.rejects(publicTarget("https://feeds.example.org/x", async () => [{ address: "10.0.0.5", family: 4 }]), bad("bad_url"));
  await assert.rejects(publicTarget("https://feeds.example.org/x", async () => [{ address: "93.184.215.14", family: 4 }, { address: "::ffff:127.0.0.1", family: 6 }]), bad("bad_url"), "one private answer among public ones is enough");
  await assert.rejects(publicTarget("https://feeds.example.org/x", async () => []), bad("bad_url"));
  let asked = 0;
  const t = await publicTarget("https://feeds.example.org/x?y=1", async () => (asked++, [{ address: "93.184.215.14", family: 4 }]));
  assert.deepEqual([t.address, t.host, asked], ["93.184.215.14", "feeds.example.org", 1]);
});

test("the local-endpoint shortcut for tests only works while payments settle on a local chain", async () => {
  const live = testCtx({ marketAllowLocal: true, payChainId: 4663, payRpcUrl: "https://rpc.mainnet.chain.robinhood.com" });
  await assert.rejects(checkUrl(live, "http://127.0.0.1:4100/v1/metrics"), bad("bad_url"));
  const fakeLocal = testCtx({ marketAllowLocal: true, payChainId: 31337, payRpcUrl: "https://rpc.example.org" });
  await assert.rejects(checkUrl(fakeLocal, "http://127.0.0.1:4100/v1/metrics"), bad("bad_url"));
  const local = testCtx({ marketAllowLocal: true, payChainId: 31337, payRpcUrl: "http://127.0.0.1:8545" });
  assert.equal((await checkUrl(local, "http://127.0.0.1:4100/x")).port, "4100");
});

test("the caller's address is the entry the proxy wrote, never one the caller wrote", () => {
  assert.equal(callerIp("6.6.6.6, 10.0.0.9", "10.0.0.1", 1), "10.0.0.9");
  assert.equal(callerIp("6.6.6.6, 10.0.0.9, 10.0.0.2", "10.0.0.1", 2), "10.0.0.9");
  assert.equal(callerIp("6.6.6.6", "10.0.0.1", 0), "10.0.0.1", "with no trusted proxy the header is ignored");
  assert.equal(callerIp(undefined, "10.0.0.1", 1), "10.0.0.1");
});

// ---------- the pinned connection

const openssl = (() => {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
let tls: Server;
let port = 0;
let cert = "";
let mode: "ok" | "redirect" | "big" | "slow" = "ok";
before(async () => {
  if (!openssl) return;
  // A certificate for a name that does not resolve anywhere: the request can only arrive if it went to the pinned address.
  const dir = resolve(TMP, "tls");
  mkdirSync(dir, { recursive: true });
  const [key, crt] = [resolve(dir, "seller.key"), resolve(dir, "seller.crt")];
  if (!existsSync(crt)) execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", key, "-out", crt, "-subj", "/CN=seller.invalid", "-addext", "subjectAltName=DNS:seller.invalid", "-days", "3650"], { stdio: "ignore" });
  cert = readFileSync(crt, "utf8");
  tls = createHttps({ key: readFileSync(key), cert }, (req, res) => {
    if (mode === "redirect") return void res.writeHead(302, { location: "https://169.254.169.254/latest/meta-data/" }).end();
    if (mode === "big") return void res.writeHead(200).end("x".repeat(300_000));
    if (mode === "slow") return void res.writeHead(200).write("{");
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ host: req.headers.host, path: req.url }));
  });
  await new Promise<void>((r) => tls.listen(0, "127.0.0.1", r));
  port = (tls.address() as { port: number }).port;
});
after(() => {
  tls?.close();
  (tls as unknown as { closeAllConnections?: () => void })?.closeAllConnections?.();
});

test("the connection goes to the address that was checked, with the name for TLS; no redirect, size or time past the caps", { skip: !openssl }, async () => {
  const target = { url: new URL(`https://seller.invalid:${port}/q?city=A`), host: "seller.invalid", address: "127.0.0.1" };
  const o = { timeoutMs: 1500, maxBytes: 262_144, ca: cert };
  mode = "ok";
  const r = await fetchPinned(target, o);
  assert.deepEqual([r.status, JSON.parse(r.text)], [200, { host: `seller.invalid:${port}`, path: "/q?city=A" }]);
  await assert.rejects(fetchPinned({ ...target, host: "other.invalid", url: new URL(`https://other.invalid:${port}/`) }, o), /altnames|Hostname/i, "a certificate for another name is refused");
  mode = "redirect";
  await assert.rejects(fetchPinned(target, o), /redirect, not followed/);
  mode = "big";
  await assert.rejects(fetchPinned(target, o), (err: Error) => err instanceof TooLarge);
  mode = "slow";
  const t0 = Date.now();
  await assert.rejects(fetchPinned(target, o), /no complete answer/);
  assert.ok(Date.now() - t0 < 3000);
  mode = "ok";
});

// ---------- payments and gas on a local chain

let chain: LocalChain;
const out = (file: string, name: string) => JSON.parse(readFileSync(resolve(HERE, "../../contracts/out", file, `${name}.json`), "utf8")) as { abi: Abi; bytecode: { object: Hex } };
let silent: Address;
let yesWallet: Address;

before(async () => {
  chain = await localChain(4149, privateKeyToAccount(ENGINE_KEY).address);
  await chain.mint(agent.address, 50_000_000n);
  await chain.mint(agent2.address, 50_000_000n);
  const deployer = createWalletClient({ account: privateKeyToAccount(ANVIL_KEYS.deployer), chain: foundry, transport: http(chain.url) });
  const pub = createPublicClient({ chain: foundry, transport: http(chain.url) });
  const deploy = async (name: string) => {
    const a = out("Fakes.sol", name);
    return (await pub.waitForTransactionReceipt({ hash: await deployer.deployContract({ abi: a.abi, bytecode: a.bytecode.object }) })).contractAddress!;
  };
  silent = await deploy("SilentUSDG");
  yesWallet = await deploy("YesWallet");
  await chain.mint(yesWallet, 50_000_000n);
});
after(() => chain?.stop());

const payCtx = (over: Parameters<typeof testCtx>[0] = {}) => testCtx({ payments: true, payRpcUrl: chain.url, payChainId: 31337, payAsset: chain.usdg, payTo: treasury, relayerKey: ANVIL_KEYS.relayer, ...over });

test("a contract posing as a wallet is not a payer, whatever its own signature check says", async () => {
  const ctx = payCtx();
  const req = requirements(ctx, 5000n, "https://x/v1/feeds/chain.prices", "test");
  const t = Math.floor(Date.now() / 1000);
  const p: PaymentPayload = { x402Version: 1, scheme: "exact", network: req.network, payload: { signature: `0x${"11".repeat(65)}`, authorization: { from: yesWallet, to: treasury, value: "5000", validAfter: "0", validBefore: String(t + 120), nonce: `0x${"ab".repeat(32)}` } } };
  const v = await verifyPayment(ctx, p, req);
  assert.deepEqual([v.ok, (v as { reason: string }).reason], [false, "bad_signature"]);
});

test("paid means proven: a token call that succeeds but moves nothing is never counted, even with a look-alike Transfer", async () => {
  const ctx = payCtx({ payAsset: silent });
  const req = requirements(ctx, 5000n, "https://x/v1/feeds/chain.prices", "test");
  const p = await signPayment(agent, req);
  await assert.rejects(settlePayment(ctx, p, req), bad("settlement_failed"));
  assert.equal(ctx.counters.get("settle_unproven"), 1);
  assert.equal((ctx.db.prepare("SELECT COUNT(*) n FROM used_nonces").get() as { n: number }).n, 1, "the mined authorization stays used");
  await assert.rejects(settlePayment(ctx, p, req), bad("nonce_already_used"));
});

test("the relayer pays gas only up to a ceiling per kind of call; above it nothing is sent", async () => {
  const ctx = payCtx({ payAsset: silent });
  const req = requirements(ctx, 7n, "https://x/v1/feeds/chain.prices", "test");
  const pub = createPublicClient({ chain: foundry, transport: http(chain.url) });
  const relayer = privateKeyToAccount(ANVIL_KEYS.relayer).address;
  const nonce = await pub.getTransactionCount({ address: relayer });
  await assert.rejects(settlePayment(ctx, await signPayment(agent, req), req), bad("gas_above_limit"));
  assert.equal(await pub.getTransactionCount({ address: relayer }), nonce);
  assert.equal(gasUsed(ctx), 0n);
  assert.equal((ctx.db.prepare("SELECT COUNT(*) n FROM used_nonces").get() as { n: number }).n, 0, "an unsent payment can be used again");
});

test("each payer has its own daily share of the relayer's gas, the day has a pot, and both survive a restart", async () => {
  mkdirSync(TMP, { recursive: true });
  const dbPath = resolve(TMP, `gas-${process.pid}.sqlite`);
  rmSync(dbPath, { force: true });
  const ctx = payCtx({ dbPath, gasDailyPerAccount: 100_000n, gasDaily: 10_000_000n });
  const req = requirements(ctx, 5000n, "https://x/v1/feeds/chain.prices", "test");
  const r = await settlePayment(ctx, await signPayment(agent, req), req);
  assert.equal(r.value, 5000n);
  const one = gasUsed(ctx, agent.address);
  assert.ok(one > 30_000n && one < GAS_LIMITS.settle, `${one}`);
  await assert.rejects(settlePayment(ctx, await signPayment(agent, req), req), bad("relayer_share_used"));
  await settlePayment(ctx, await signPayment(agent2, req), req);
  ctx.db.close();
  // A restart reads the same day back from the database.
  const again = payCtx({ dbPath, gasDailyPerAccount: 100_000n, gasDaily: 10_000_000n });
  assert.equal(gasUsed(again, agent.address), one);
  await assert.rejects(settlePayment(again, await signPayment(agent, req), req), bad("relayer_share_used"));
  const day = gasUsed(again);
  again.db.close();
  // When the day's pot is nearly spent, nobody's call is relayed, however much of their own share is left.
  const tight = payCtx({ dbPath, gasDailyPerAccount: 10_000_000n, gasDaily: day + 1000n });
  await assert.rejects(settlePayment(tight, await signPayment(agent2, req), req), bad("relayer_daily_gas_used"));
  tight.db.close();
  rmSync(dbPath, { force: true });
});
