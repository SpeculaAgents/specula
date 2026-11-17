import type { Hono } from "hono";
import { keccak256, parseAbi, toBytes, type Address, type Hex } from "viem";
import type { Feed, ParamSpec, Source } from "./collect.ts";
import { feedUptime } from "./collect.ts";
import { isLocalChain, USDG_DECIMALS } from "./config.ts";
import { fetchPinned, publicTarget, readCapped, TooLarge, type Target } from "./net.ts";
import type { Ctx } from "./ctx.ts";
import { FEEDS, feedById } from "./registry.ts";
import type { Helpers } from "./server.ts";
import { cleanName } from "./chain/indexer.ts";
import { fromUnits, HttpError, id, isAddress, iso, lower, maskAddress, nowSec, toUnits } from "./util.ts";

/**
 * The marketplace. Anyone with a wallet can list a feed: an https endpoint of theirs that returns JSON. Specula
 * fetches it per request, wraps the reply in the common signed format (the signature says "this is what the seller
 * returned at this time", not that it is true), and the buyer pays the seller's wallet directly. The engine never
 * holds a seller's money. A listing with an allow list is a private feed: invisible to every other wallet.
 */
interface Row {
  id: string;
  owner: string;
  title: string;
  summary: string;
  price: string;
  url: string;
  params: string;
  allow: string | null;
  ttl: number;
  active: number;
  created_at: number;
}

/** The test-only way to list a local endpoint: switched on in config and only honoured while payments settle on a local chain. */
export const allowLocal = (ctx: Ctx) => ctx.cfg.marketAllowLocal && isLocalChain(ctx.cfg);

/** A seller's endpoint must be a public https address. Checked when listed and again on every fetch. */
export async function checkUrl(ctx: Ctx, raw: string): Promise<URL> {
  return (await sellerTarget(ctx, raw)).url;
}

async function sellerTarget(ctx: Ctx, raw: string): Promise<Target | { url: URL; local: true }> {
  if (allowLocal(ctx)) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new HttpError(400, "bad_url", "The endpoint is not a valid URL.");
    }
    if (!/^https?:$/.test(u.protocol)) throw new HttpError(400, "bad_url", "The endpoint must be a plain https URL.");
    return { url: u, local: true };
  }
  return publicTarget(raw);
}

const SELLER_MAX_BYTES = 262_144;
const SELLER_TIMEOUT_MS = 8000;

const sellerSource = (row: Row): Source => ({
  id: `seller:${maskAddress(row.owner)}`,
  async run(ctx, params) {
    const t = await sellerTarget(ctx, row.url);
    for (const [k, v] of Object.entries(params)) t.url.searchParams.set(k, v);
    const headers = { Accept: "application/json", "User-Agent": "specula-market/0.1" };
    let status: number;
    let text: string;
    try {
      if ("local" in t) {
        const res = await ctx.fetch(t.url, { headers, redirect: "manual", signal: AbortSignal.timeout(SELLER_TIMEOUT_MS) });
        if (res.status >= 300 && res.status < 400) throw new Error(`the endpoint answered ${res.status} (a redirect, not followed)`);
        status = res.status;
        text = res.ok ? await readCapped(res, SELLER_MAX_BYTES) : "";
      } else ({ status, text } = await fetchPinned(t, { timeoutMs: SELLER_TIMEOUT_MS, maxBytes: SELLER_MAX_BYTES, headers }));
    } catch (e) {
      if (e instanceof TooLarge) throw new Error("the seller's answer is larger than 256 KB");
      throw e;
    }
    if (status < 200 || status >= 300) throw new Error(`the seller's endpoint answered ${status}`);
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("the seller's answer is not JSON");
    }
    if (data === null || typeof data !== "object") throw new Error("the seller's answer is not a JSON object or list");
    return { data };
  },
});

const toFeed = (row: Row): Feed => ({
  id: row.id,
  group: "market",
  title: row.title,
  summary: row.summary,
  params: JSON.parse(row.params) as ParamSpec[],
  price: row.price,
  ttl: row.ttl,
  sources: [sellerSource(row)],
  example: {},
  payTo: row.owner as Address,
  owner: row.owner,
  allow: row.allow ? (JSON.parse(row.allow) as string[]) : null,
});

/** Put every active listing into the live feed list. Called at boot and after each change. */
export function loadMarket(ctx: Ctx) {
  for (let i = FEEDS.length - 1; i >= 0; i--) if (FEEDS[i].group === "market") FEEDS.splice(i, 1);
  for (const row of ctx.db.prepare("SELECT * FROM market_feeds WHERE active = 1 ORDER BY created_at").all() as Row[]) FEEDS.push(toFeed(row));
}

function usage(ctx: Ctx, feed: string) {
  const r = ctx.db.prepare("SELECT COUNT(*) n, COUNT(DISTINCT who) buyers FROM requests WHERE feed = ? AND status = 'ok' AND paid_by = 'x402' AND at >= ?").get(feed, nowSec() - 30 * 86400) as { n: number; buyers: number };
  const paid = (ctx.db.prepare("SELECT price FROM requests WHERE feed = ? AND status = 'ok' AND paid_by = 'x402' AND at >= ?").all(feed, nowSec() - 30 * 86400) as { price: string }[]).reduce((n, x) => n + BigInt(x.price), 0n);
  return { paidCalls30d: r.n, buyers30d: r.buyers, paid30dUnits: paid, paid30d: fromUnits(paid, USDG_DECIMALS) };
}
const shape = (ctx: Ctx, row: Row, full = false) => {
  const u = usage(ctx, row.id);
  return { id: row.id, title: row.title, summary: row.summary, price: row.price, seller: maskAddress(row.owner), private: !!row.allow, liveForSeconds: row.ttl, params: JSON.parse(row.params) as ParamSpec[], listedAt: iso(row.created_at), paidCalls30d: u.paidCalls30d, buyers30d: u.buyers30d, paid30d: u.paid30d, uptime24h: feedUptime(ctx, row.id).uptime, path: `/v1/feeds/${row.id}`, ...(full ? { url: row.url, allow: row.allow ? (JSON.parse(row.allow) as string[]) : null } : {}) };
};

// ---------- bounties ----------

export const bountiesAbi = parseAbi([
  "function open(bytes32 id, uint256 amount, uint64 deadline)",
  "function award(bytes32 id, address seller)",
  "function refund(bytes32 id)",
  "function bountyOf(address funder, bytes32 id) view returns (address funder, uint256 amount, uint64 deadline, address winner, bool closed)",
  "function token() view returns (address)",
]);
interface BountyRow {
  id: string;
  chain_id: Hex;
  funder: string;
  title: string;
  detail: string;
  amount: string;
  deadline: number;
  status: string;
  winner: string | null;
  created_at: number;
}

/** A bounty is only ever shown as funded when the escrow contract itself says the money is there. */
export async function syncBounty(ctx: Ctx, b: BountyRow): Promise<BountyRow> {
  if (!ctx.cfg.bounties) return b;
  // The escrow must hold the payment asset itself; one built on any other token never shows money as funded.
  if (!(await escrowHoldsPayAsset(ctx))) return b;
  // The escrow keys each bounty by its funder, so nobody else can take the id first.
  const [funder, amount, , winner, closed] = await ctx.payPub.readContract({ address: ctx.cfg.bounties, abi: bountiesAbi, functionName: "bountyOf", args: [b.funder as Address, b.chain_id] });
  let status = b.status;
  let win: string | null = b.winner;
  if (lower(funder) === b.funder && amount >= BigInt(b.amount)) {
    win = closed && BigInt(winner) !== 0n ? lower(winner) : null;
    status = !closed ? "funded" : win ? "awarded" : "refunded";
  }
  if (status !== b.status || win !== b.winner) ctx.db.prepare("UPDATE bounties SET status = ?, winner = ? WHERE id = ?").run(status, win, b.id);
  return { ...b, status, winner: win };
}
async function escrowHoldsPayAsset(ctx: Ctx): Promise<boolean> {
  const key = `escrow_token:${ctx.cfg.bounties}`;
  let ok = ctx.mem.get(key) as boolean | undefined;
  if (ok === undefined) {
    const token = await ctx.payPub.readContract({ address: ctx.cfg.bounties!, abi: bountiesAbi, functionName: "token" });
    ok = token.toLowerCase() === ctx.cfg.payAsset.toLowerCase();
    ctx.mem.set(key, ok);
  }
  return ok;
}

const shapeBounty = (ctx: Ctx, b: BountyRow) => ({
  id: b.id,
  escrowId: b.chain_id,
  title: b.title,
  detail: b.detail,
  amount: fromUnits(b.amount, USDG_DECIMALS),
  amountUnits: b.amount,
  funder: maskAddress(b.funder),
  deadline: iso(b.deadline),
  status: b.status,
  winner: b.winner ? maskAddress(b.winner) : null,
  postedAt: iso(b.created_at),
  offers: (ctx.db.prepare("SELECT o.feed, o.seller, o.at FROM bounty_offers o LEFT JOIN market_feeds m ON m.id = o.feed WHERE o.bounty = ? AND m.allow IS NULL ORDER BY o.at").all(b.id) as { feed: string; seller: string; at: number }[]).map((o) => ({ feed: o.feed, seller: maskAddress(o.seller), at: iso(o.at), listed: !!feedById(o.feed) })),
});

export function registerMarket(app: Hono, ctx: Ctx, h: Helpers) {
  loadMarket(ctx);

  /** Public listings, ranked by what agents actually paid for them in the last 30 days. */
  app.get("/v1/market", async (c) =>
    c.json(
      await h.cached("market", 2000, () => {
        const rows = (ctx.db.prepare("SELECT * FROM market_feeds WHERE active = 1 AND allow IS NULL").all() as Row[]).map((r) => ({ r, u: usage(ctx, r.id) }));
        rows.sort((a, b) => (a.u.paid30dUnits < b.u.paid30dUnits ? 1 : a.u.paid30dUnits > b.u.paid30dUnits ? -1 : a.r.created_at - b.r.created_at));
        return { count: rows.length, sellers: new Set(rows.map((x) => x.r.owner)).size, privateFeeds: (ctx.db.prepare("SELECT COUNT(*) n FROM market_feeds WHERE active = 1 AND allow IS NOT NULL").get() as { n: number }).n, ranking: "by USDG paid in the last 30 days", feeds: rows.map((x, i) => ({ rank: i + 1, ...shape(ctx, x.r) })) };
      }),
    ),
  );
  app.get("/v1/market/mine", async (c) => {
    const w = await h.wallet(c);
    const rows = ctx.db.prepare("SELECT * FROM market_feeds WHERE owner = ? AND active = 1 ORDER BY created_at DESC").all(w) as Row[];
    const mine = rows.map((r) => shape(ctx, r, true));
    return c.json({ feeds: mine, earned30d: fromUnits(rows.reduce((n, r) => n + usage(ctx, r.id).paid30dUnits, 0n), USDG_DECIMALS), paidTo: w, visibleToMe: (ctx.db.prepare("SELECT * FROM market_feeds WHERE active = 1 AND allow IS NOT NULL AND owner != ?").all(w) as Row[]).filter((r) => (JSON.parse(r.allow!) as string[]).includes(w)).map((r) => shape(ctx, r)) });
  });
  /** List a feed, or change one you own. Send "allow" (a list of wallets) to make it private. */
  app.post("/v1/market/feeds", async (c) => {
    const w = await h.wallet(c);
    const b = (await c.req.json().catch(() => ({}))) as { slug?: string; title?: string; summary?: string; price?: string; url?: string; params?: unknown; allow?: unknown; liveForSeconds?: number };
    const slug = String(b.slug ?? "").toLowerCase();
    if (!/^[a-z][a-z0-9]{2,23}$/.test(slug)) throw new HttpError(400, "bad_param", '"slug" is 3 to 24 lowercase letters and digits, starting with a letter.');
    const title = cleanName(b.title, 60);
    const summary = cleanName(b.summary, 240);
    if (title.length < 3 || summary.length < 20) throw new HttpError(400, "bad_param", "Give the feed a title and a summary of at least 20 characters that says what it answers.");
    if (!/^\d+(\.\d{1,6})?$/.test(String(b.price)) || toUnits(String(b.price), USDG_DECIMALS) <= 0n || toUnits(String(b.price), USDG_DECIMALS) > toUnits("100", USDG_DECIMALS)) throw new HttpError(400, "bad_param", '"price" is USDG per call, above 0 and at most 100.');
    await checkUrl(ctx, String(b.url ?? ""));
    const params: ParamSpec[] = (Array.isArray(b.params) ? b.params : []).slice(0, 8).map((p: { name?: unknown; doc?: unknown; required?: unknown }) => {
      if (!/^[a-zA-Z][a-zA-Z0-9_]{0,23}$/.test(String(p?.name))) throw new HttpError(400, "bad_param", "A parameter name is letters, digits and underscores.");
      return { name: String(p.name), type: "string" as const, required: !!p.required, doc: cleanName(p.doc, 120) || "Passed to the seller's endpoint." };
    });
    let allow: string[] | null = null;
    if (b.allow !== undefined && b.allow !== null) {
      if (!Array.isArray(b.allow) || !b.allow.length || b.allow.length > 200 || !b.allow.every(isAddress)) throw new HttpError(400, "bad_param", '"allow" is a list of 1 to 200 wallet addresses.');
      allow = [...new Set(b.allow.map((a) => lower(a as string)))];
    }
    const fid = `market.${slug}`;
    const existing = ctx.db.prepare("SELECT owner FROM market_feeds WHERE id = ?").get(fid) as { owner: string } | undefined;
    if (existing && existing.owner !== w) throw new HttpError(409, "taken", "That name belongs to another seller.");
    if (!existing && (ctx.db.prepare("SELECT COUNT(*) n FROM market_feeds WHERE owner = ? AND active = 1").get(w) as { n: number }).n >= 20) throw new HttpError(409, "too_many", "A wallet can list 20 feeds.");
    const ttl = Math.min(86400, Math.max(5, Math.round(Number(b.liveForSeconds ?? 30)) || 30));
    ctx.db
      .prepare("INSERT INTO market_feeds (id, owner, title, summary, price, url, params, allow, ttl, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?) ON CONFLICT(id) DO UPDATE SET title = excluded.title, summary = excluded.summary, price = excluded.price, url = excluded.url, params = excluded.params, allow = excluded.allow, ttl = excluded.ttl, active = 1")
      .run(fid, w, title, summary, String(b.price), String(b.url), JSON.stringify(params), allow ? JSON.stringify(allow) : null, ttl, nowSec());
    loadMarket(ctx);
    return c.json(shape(ctx, ctx.db.prepare("SELECT * FROM market_feeds WHERE id = ?").get(fid) as Row, true), existing ? 200 : 201);
  });
  app.delete("/v1/market/feeds/:slug", async (c) => {
    const w = await h.wallet(c);
    const r = ctx.db.prepare("UPDATE market_feeds SET active = 0 WHERE id = ? AND owner = ? AND active = 1").run(`market.${c.req.param("slug")}`, w);
    if (!r.changes) throw new HttpError(404, "not_found", "No such listing of yours.");
    loadMarket(ctx);
    return c.json({ removed: true });
  });

  // ---- bounties: ask for data that does not exist yet
  app.get("/v1/bounties", async (c) => {
    // Each listing reads the escrow for every open bounty: a few a minute per caller, so it cannot be turned into node load.
    h.limit(c, "bounties", 30);
    return c.json(
      await h.cached("bounties", 0, async () => {
        const rows = ctx.db.prepare("SELECT * FROM bounties ORDER BY created_at DESC LIMIT 100").all() as BountyRow[];
        const synced = await Promise.all(rows.map((b) => (b.status === "pledged" || b.status === "funded" ? syncBounty(ctx, b).catch(() => b) : b)));
        const funded = synced.filter((b) => b.status === "funded");
        return { escrow: ctx.cfg.bounties, count: synced.length, open: funded.length, openAmount: fromUnits(funded.reduce((n, b) => n + BigInt(b.amount), 0n), USDG_DECIMALS), bounties: synced.map((b) => shapeBounty(ctx, b)) };
      }),
    );
  });
  app.post("/v1/bounties", async (c) => {
    const w = await h.wallet(c);
    const b = (await c.req.json().catch(() => ({}))) as { title?: string; detail?: string; amount?: string; days?: number };
    const title = cleanName(b.title, 80);
    const detail = cleanName(b.detail, 600);
    if (title.length < 8 || detail.length < 30) throw new HttpError(400, "bad_param", "Say what data you want: a title, and a description of at least 30 characters.");
    if (!/^\d+(\.\d{1,6})?$/.test(String(b.amount)) || toUnits(String(b.amount), USDG_DECIMALS) < toUnits("1", USDG_DECIMALS)) throw new HttpError(400, "bad_param", '"amount" is the reward in USDG, at least 1.');
    const days = Math.min(90, Math.max(1, Math.round(Number(b.days ?? 14)) || 14));
    if ((ctx.db.prepare("SELECT COUNT(*) n FROM bounties WHERE funder = ? AND status = 'pledged' AND deadline > ?").get(w, nowSec()) as { n: number }).n >= 10)
      throw new HttpError(409, "too_many", "A wallet can hold 10 unfunded bounties. Fund one or let one lapse first.");
    const bid = id("bnty");
    const chainId = keccak256(toBytes(bid));
    const deadline = nowSec() + days * 86400;
    ctx.db.prepare("INSERT INTO bounties (id, chain_id, funder, title, detail, amount, deadline, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(bid, chainId, w, title, detail, toUnits(String(b.amount), USDG_DECIMALS).toString(), deadline, nowSec());
    const row = ctx.db.prepare("SELECT * FROM bounties WHERE id = ?").get(bid) as BountyRow;
    return c.json({ ...shapeBounty(ctx, row), fund: ctx.cfg.bounties ? { contract: ctx.cfg.bounties, call: "open(bytes32 id, uint256 amount, uint64 deadline)", args: [chainId, row.amount, deadline], note: "Approve the contract for the amount first. The bounty shows as funded once the contract holds the money." } : { contract: null, note: "The escrow contract is not deployed. Until it is, a bounty is a pledge and is shown as one." } }, 201);
  });
  /** A seller answers a bounty by pointing at a feed they listed. */
  app.post("/v1/bounties/:id/offers", async (c) => {
    const w = await h.wallet(c);
    const b = ctx.db.prepare("SELECT * FROM bounties WHERE id = ?").get(c.req.param("id")) as BountyRow | undefined;
    if (!b) throw new HttpError(404, "not_found", "No such bounty.");
    if (b.status === "awarded" || b.status === "refunded" || b.deadline < nowSec()) throw new HttpError(409, "closed", "This bounty is closed.");
    const body = (await c.req.json().catch(() => ({}))) as { feed?: string };
    const f = feedById(String(body.feed ?? ""));
    if (!f || f.group !== "market" || f.owner !== w) throw new HttpError(400, "bad_param", '"feed" must be a marketplace feed you listed.');
    // Offers are public; a private feed would be named to everyone.
    if (f.allow) throw new HttpError(400, "bad_param", "A private feed cannot be offered. Offer a public listing.");
    ctx.db.prepare("INSERT OR IGNORE INTO bounty_offers (bounty, feed, seller, at) VALUES (?, ?, ?, ?)").run(b.id, f.id, w, nowSec());
    return c.json(shapeBounty(ctx, b), 201);
  });
  app.get("/v1/bounties/:id", async (c) => {
    h.limit(c, "bounty", 60);
    const b = ctx.db.prepare("SELECT * FROM bounties WHERE id = ?").get(c.req.param("id")) as BountyRow | undefined;
    if (!b) throw new HttpError(404, "not_found", "No such bounty.");
    return c.json(shapeBounty(ctx, await syncBounty(ctx, b).catch(() => b)));
  });
}
