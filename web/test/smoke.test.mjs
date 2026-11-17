// Builds the site, serves it against an engine that answers from recorded fixtures, and checks the real HTML of
// every page. Run with `npm test` from web/.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE_PORT = 4310;
const ENGINE_PORT = 4311;
const site = `http://127.0.0.1:${SITE_PORT}`;
const env = { ...process.env, SPECULA_DIST_DIR: ".next-smoke", SPECULA_ENGINE_URL: `http://127.0.0.1:${ENGINE_PORT}`, NODE_ENV: "production", PORT: String(SITE_PORT) };
const procs = [];
const next = join(web, "node_modules", "next", "dist", "bin", "next");
const run = (cmd, args, opts) => new Promise((res, rej) => {
  const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (out += d));
  p.on("exit", (code) => (code === 0 ? res(out) : rej(new Error(`${args.join(" ")} failed:\n${out.slice(-3000)}`))));
});
const until = async (fn, label) => {
  for (let i = 0; i < 240; i++) {
    if (await fn().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${label}`);
};
const page = async (path) => {
  const res = await fetch(site + path, { redirect: "manual" });
  return { res, html: await res.text() };
};

before(async () => {
  procs.push(spawn("npx", ["tsx", "scripts/fixture-engine.ts", String(ENGINE_PORT)], { cwd: join(web, "..", "engine"), stdio: "ignore" }));
  await run(process.execPath, [next, "build"], { cwd: web, env });
  procs.push(spawn(process.execPath, [next, "start", "-p", String(SITE_PORT)], { cwd: web, env, stdio: "ignore" }));
  await until(async () => (await fetch(`http://127.0.0.1:${ENGINE_PORT}/v1/briefing`)).ok && (await (await fetch(`http://127.0.0.1:${ENGINE_PORT}/v1/indexes`)).json()).indexes[0].value, "the engine");
  await until(async () => (await fetch(site + "/own-risk")).ok, "the site");
}, { timeout: 240_000 });
after(() => {
  for (const p of procs) p.kill("SIGTERM");
});

const PAGES = {
  "/": ["Robinhood Chain, as it happens.", "Robinhood Chain, live", "Launches", "Data your agent buys by the answer.", "How it works", "The catalog", "For developers", 'id="how"', 'id="feeds"', 'id="developers"', 'id="live"', "Who sniped a launch", "Economy snapshot"],
  "/feeds": ["The feed catalog", "chain.price", "chain.snipers", "chain.smartmoney", "chain.twap", "sec.insiders", "macro.snapshot", "answers.ask", "index.value", "Bulk levels", 'id="chain"', 'id="companies"', 'id="economy"'],
  "/feeds/chain.prices": ["Price board", "Try it", "Price by freshness", "fresh=delayed", "chainlink-secondary", "The last real answer", "Sources, all asked and compared"],
  "/feeds/chain.snipers": ["Who sniped a launch", "Try it", "blocks"],
  "/feeds/chain.deployer": ["Deployer history", "Try it"],
  "/feeds/chain.clusters": ["Holder clusters", "Try it"],
  "/feeds/chain.smartmoney": ["Wallets early in tokens that rose", "Try it"],
  "/feeds/chain.twap": ["Time-weighted token price", "thin market"],
  "/feeds/sec.insiders": ["Insider trades (Form 4)", "sec-data-api", "openMarket"],
  "/docs": ["Docs you can run", "Quick start", "Paying", "x402Version", "transferWithAuthorization", "@specula/mcp", "Recipes", 'id="sdk"', 'id="mcp"', 'id="recipes"', 'id="errors"'],
  "/terminal": ["The terminal", "Price board", "DEX trades", "New launches", "Signals", "Command line"],
  "/signals": ["Signals, with their record", "Built-in signals", "The record, rule by rule", "NVDA moves 2% or more within 1 h", "not fired yet"],
  "/ask": ["Ask the data", "Today&#x27;s briefing", "Ask in plain words"],
  "/verify": ["Check it yourself", "Sealed hours", "Prove one answer"],
  "/indexes": ["Specula indexes", "Specula AI Index", "1000.00", "How an index moves"],
  "/status": ["Feed uptime, 24h", "The chain index", "Background jobs", "chain.prices"],
  "/roadmap": ["Twenty-two phases", "The data engine", "Marketplace", "Token", "Built, not switched on", "Open for listings"],
  "/changelog": ["Changelog", "Pay per request"],
  "/token": ["The Specula token", "not live yet", "No burns to show"],
  "/market": ["Sell data to agents", "List a feed in one call", "No seller has listed a feed yet", "Bounties: data that does not exist yet"],
  "/lab": ["Test before it trades", "Build a strategy", "Archive and replay", "What the archive holds", "macro.snapshot"],
  "/demand": ["What agents ask for", "The ranking opens at 1,000 paid answers"],
  "/own-risk": ["Use at your own risk", "Not advice", "hello@speculaagents.fun"],
};

for (const [path, needles] of Object.entries(PAGES))
  test(`${path} renders what it should and nothing it should not`, async () => {
    const { res, html } = await page(path);
    assert.equal(res.status, 200);
    for (const n of needles) assert.ok(html.includes(n), `${path} is missing: ${n}`);
    // Chrome: logo left, GitHub and X on the right, the risk line in the footer.
    assert.ok(html.includes('aria-label="Specula, home"') && html.includes("https://github.com/SpeculaAgents") && html.includes("https://x.com/SpeculaAgents"));
    assert.ok(html.includes("Specula is software, not financial advice; use at your own risk."));
    const text = html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ");
    assert.ok(!/[—–]/.test(text), `${path} has a long dash`);
    // No emoji, and no symbol characters that phones draw as emoji.
    assert.ok(!/[←-↑↓-⇿☀-➿️]|[\u{1f300}-\u{1faff}]/u.test(text), `${path} has an emoji or symbol character`);
    for (const bad of [/\bsample\b/i, /\bdemo\b/i, /lorem/i, /placeholder text/i, /coming soon/i, /undefined|NaN\b/]) assert.ok(!bad.test(text), `${path} says ${bad}`);
    assert.ok(html.length < 600_000, `${path} is ${html.length} bytes`);
    assert.match(html, /<title>[^<]{5,80}<\/title>/);
  });

test("every page has the theme switch, sets the theme before paint, and ships both themes", async () => {
  for (const path of ["/", "/feeds", "/terminal", "/docs", "/nope"]) {
    const { html } = await page(path);
    assert.ok(html.includes('aria-label="Switch between light and dark"'), `${path} has no theme switch`);
    assert.ok(html.includes('localStorage.getItem(\\"specula-theme\\")') || html.includes('localStorage.getItem("specula-theme")'), `${path} does not set the theme before paint`);
    assert.ok(html.indexOf("specula-theme") < html.indexOf("<body"), `${path} sets the theme too late`);
  }
  const { html } = await page("/");
  const sheets = [...html.matchAll(/href="([^"]+\.css[^"]*)"/g)].map((m) => m[1]);
  assert.ok(sheets.length > 0);
  const css = (await Promise.all(sheets.map(async (h) => (await fetch(site + h)).text()))).join("\n");
  assert.match(css, /\[data-theme=["']?dark["']?\]/, "the dark theme is in the stylesheet");
  assert.match(css, /--page:\s*#fff/i, "the light theme is in the stylesheet");
  assert.match(css, /--page:\s*#0a0a0a/i, "the dark page colour is in the stylesheet");
});

test("the token page never names a tax, a split or the chain", async () => {
  const text = (await page("/token")).html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ");
  for (const bad of [/\btax\b/i, /\d+\s?%/, /robinhood/i, /\bsplit\b/i, /memecoin/i]) assert.ok(!bad.test(text.split("Specula is software")[0].split("Own risk").slice(1).join(" ")), `the token page says ${bad}`);
});

test("pages that do not exist are a real 404, and odd paths do not break the server", async () => {
  for (const p of ["/nope", "/feeds/nope.nope", "/feeds/..%2f..%2fetc", "/feeds/chain.price/extra", "/.env", "/wp-admin"]) assert.equal((await page(p)).res.status, 404, p);
  assert.ok((await page("/nope")).html.includes("The tower sees no such page."));
});

test("the site forwards only the public engine routes", async () => {
  const j = async (p, init) => {
    const r = await fetch(site + p, init);
    return { status: r.status, body: await r.json().catch(() => null), type: r.headers.get("content-type") };
  };
  assert.equal((await j("/api/v1/site")).body.stats.feeds >= 24, true);
  assert.equal((await j("/api/v1/catalog")).body.count >= 24, true);
  const a = await j("/api/v1/feeds/macro.series?series=cpi&limit=1");
  assert.equal(a.status, 200);
  assert.match(a.body.proof.signature, /^0x[0-9a-f]{130}$/);
  assert.equal((await j("/api/v1/signals/parse", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Tesla files an 8-K" }) })).body.understood, true);
  for (const p of ["/api/v1/metrics", "/api/v1/admin", "/api/v1/feeds/../metrics", "/api/v1", "/api/v1/oracle/x"]) assert.equal((await j(p)).status, 404, p);
  assert.equal((await j("/api/v1/account")).status, 401);
  const sse = await fetch(site + "/api/v1/events");
  assert.match(sse.headers.get("content-type"), /text\/event-stream/);
  await sse.body.cancel();
});

test("security headers are set and the page talks only to its own origin", async () => {
  const { res } = await page("/");
  const h = (k) => res.headers.get(k) ?? "";
  assert.match(h("content-security-policy"), /default-src 'self'/);
  assert.match(h("content-security-policy"), /connect-src 'self'/);
  assert.match(h("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(h("x-frame-options"), "DENY");
  assert.equal(h("x-content-type-options"), "nosniff");
  assert.match(h("strict-transport-security"), /max-age=\d+/);
  assert.equal(h("x-powered-by"), "");
  const { html } = await page("/");
  assert.ok(!/https?:\/\/(?!speculaagents\.fun|github\.com\/SpeculaAgents|x\.com\/SpeculaAgents|www\.w3\.org)[a-z0-9.-]+\.[a-z]{2,}[^"']*\.(js|css|woff2?)/i.test(html), "no script, style or font is loaded from another origin");
});

test("the price widget may be framed by other sites, and only the widget", async () => {
  const w = await page("/embed/price/ETH");
  assert.equal(w.res.status, 200);
  assert.ok(w.html.includes("on-chain reading") && w.html.includes("ETH"));
  assert.equal(w.res.headers.get("x-frame-options"), null);
  assert.match(w.res.headers.get("content-security-policy"), /frame-ancestors \*/);
  assert.ok((await page("/embed/price/NOPE")).html.includes("no on-chain price feed"));
  assert.equal((await page("/market")).res.headers.get("x-frame-options"), "DENY");
});

test("the site can be installed to a phone's home screen", async () => {
  const m = await (await fetch(site + "/manifest.webmanifest")).json();
  assert.deepEqual([m.name, m.display, m.start_url, m.icons.length], ["Specula", "standalone", "/terminal", 2]);
  const icon = await fetch(site + "/pwa-192.png");
  const buf = Buffer.from(await icon.arrayBuffer());
  assert.equal(icon.headers.get("content-type"), "image/png");
  assert.deepEqual([buf.readUInt32BE(16), buf.readUInt32BE(20)], [192, 192]);
});

test("the share card, the icon, the sitemap and the robots file exist", async () => {
  const og = await fetch(site + "/opengraph-image");
  const buf = Buffer.from(await og.arrayBuffer());
  assert.equal(og.headers.get("content-type"), "image/png");
  assert.deepEqual([buf.readUInt32BE(16), buf.readUInt32BE(20)], [1200, 630]);
  assert.equal((await fetch(site + "/logo.png")).status, 200);
  assert.equal((await fetch(site + "/icon.png")).headers.get("content-type"), "image/png");
  assert.match(await (await fetch(site + "/sitemap.xml")).text(), /speculaagents\.fun\/feeds/);
  assert.match(await (await fetch(site + "/robots.txt")).text(), /Disallow: \/api\//);
  for (const f of ["sans", "mono"]) assert.equal((await fetch(`${site}/fonts/${f}.woff2`)).status, 200);
});
