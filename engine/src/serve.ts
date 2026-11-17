import type { Answer } from "../../packages/sdk/src/protocol.ts";
import { USDG_DECIMALS } from "./config.ts";
import { collect, normalizeParams, type Datum, type Feed } from "./collect.ts";
import { count, type Ctx } from "./ctx.ts";
import { addCredit, allowance, checkBudget, checkSettleGas, creditOf, ipKey, paymentRequired, quote, readPayment, requirements, settlePayment, TIERS, verifyPayment, whoIs, writeReceipt, type Tier } from "./pay.ts";
import { SIGN_ALG } from "./sign.ts";
import { fromUnits, HttpError, id, iso, maskAddress, nowSec } from "./util.ts";

export interface Caller {
  auth?: string;
  payment?: string;
  ip: string;
  tier?: string;
  via: string;
  resource: string;
}

const hits = new Map<string, { t: number; n: number }>();
/** A soft guard for the upstream sources, not a product limit: a burst from one caller waits a minute. */
function rate(who: string) {
  const t = Math.floor(Date.now() / 60_000);
  const h = hits.get(who);
  if (!h || h.t !== t) {
    if (hits.size > 20_000) hits.clear();
    hits.set(who, { t, n: 1 });
    return;
  }
  if (++h.n > 600) throw new HttpError(429, "slow_down", "Too many requests this minute. Try again shortly.", { retryAfter: 60 - (Math.floor(Date.now() / 1000) % 60) });
}

export interface RequestRow {
  id: string;
  at: number;
  feed: string;
  wallet: string | null;
  tier: string;
  price: string;
  paid_by: string;
  status: string;
  ms: number;
  via: string | null;
}
export const shapeRequest = (r: RequestRow) => ({
  id: r.id,
  at: iso(r.at),
  feed: r.feed,
  tier: r.tier,
  price: fromUnits(r.price, USDG_DECIMALS),
  paidBy: r.paid_by,
  buyer: r.wallet ? maskAddress(r.wallet) : "anonymous",
  ms: r.ms,
  status: r.status,
  via: r.via ?? "api",
});

function record(ctx: Ctx, row: RequestRow & { params: string; who: string; ip: string }, isPrivate: boolean) {
  ctx.db.prepare("INSERT INTO requests (id, at, feed, params, wallet, who, ip, tier, price, paid_by, status, ms, via) VALUES (@id, @at, @feed, @params, @wallet, @who, @ip, @tier, @price, @paid_by, @status, @ms, @via)").run(row);
  count(ctx, `requests_${row.status}`);
  // A private feed is not even named in the public request feed.
  if (row.status === "ok" && !isPrivate) ctx.bus.emit("request", shapeRequest(row));
}

/** Every marketplace feed that has, or ever had, an allow list. Listed or taken down, its name stays out of public views. */
export function privateFeedIds(ctx: Ctx): Set<string> {
  return new Set((ctx.db.prepare("SELECT id FROM market_feeds WHERE allow IS NOT NULL").all() as { id: string }[]).map((r) => r.id));
}

export function envelope(ctx: Ctx, d: Datum, meta: Omit<Answer["meta"], "collectedAtIso" | "servedAt" | "ageSeconds" | "cached" | "tried">): Answer {
  const t = nowSec();
  return {
    feed: d.feed,
    params: d.params,
    data: d.data,
    source: d.source,
    collectedAt: d.collectedAt,
    meta: { collectedAtIso: iso(d.collectedAt), servedAt: iso(t), ageSeconds: Math.max(0, t - d.collectedAt), cached: d.cached, tried: d.tried, ...meta },
    proof: { engine: ctx.signer.address.toLowerCase() as `0x${string}`, alg: SIGN_ALG, digest: d.digest, signature: d.signature },
  };
}

/**
 * Answer one metered request. The order matters: decide who pays, check the payment can settle, collect the answer,
 * and only then take the money. A failed collection is never charged.
 */
export async function serve(ctx: Ctx, feed: Feed, raw: Record<string, string | undefined>, c: Caller): Promise<{ answer: Answer; payerHeader: string | null }> {
  const params = normalizeParams(feed, raw);
  const tier = (c.tier ?? "live") as Tier;
  if (!TIERS[tier]) throw new HttpError(400, "bad_param", `"fresh" must be one of: ${Object.keys(TIERS).join(", ")}`);
  const authed = await whoIs(c.auth);
  // A private feed does not exist for anyone who is not on its list.
  if (feed.allow && !(authed && (feed.allow.includes(authed) || authed === feed.owner))) throw new HttpError(404, "unknown_feed", "No such feed. See /v1/catalog.");
  const payment = readPayment(c.payment);
  // The price level of the wallet that says it pays; the request is only booked to a wallet once that is proven.
  const claimed = authed ?? (payment ? (payment.payload.authorization.from.toLowerCase() as `0x${string}`) : null);
  const ip = ipKey(c.ip);
  const who = authed ?? ip;
  rate(who);
  const q = quote(ctx, feed, tier, claimed);
  const rid = id("req");
  const t0 = Date.now();
  const base = { id: rid, at: nowSec(), feed: feed.id, params: JSON.stringify(params), wallet: authed as string | null, who, ip, tier, via: c.via };
  const isPrivate = !!feed.allow;

  let paidBy: "free" | "credits" | "x402" = "free";
  let payer: string | null = null;
  let allow = { used: 0, limit: null as number | null };
  const req = ctx.cfg.payments && q.amount > 0n ? requirements(ctx, q.amount, c.resource, `${feed.title} (${TIERS[tier].label.toLowerCase()})`, feed.payTo ?? ctx.cfg.payTo) : null;
  if (req) {
    // A seller's feed is paid to the seller on every call: no free allowance and no engine credits apply to it.
    const a = feed.payTo ? { used: 0, limit: 0 } : allowance(ctx, who, !!authed, ip);
    allow = a;
    if (a.used >= a.limit) {
      if (payment) {
        const v = await verifyPayment(ctx, payment, req);
        if (!v.ok) throw paymentRequired(req, v.reason);
        checkBudget(ctx, v.payer, q.amount);
        checkSettleGas(ctx, v.payer);
        payer = v.payer;
        base.wallet = authed ?? v.payer;
        paidBy = "x402";
      } else if (!feed.payTo && authed && creditOf(ctx, authed) >= q.amount) {
        checkBudget(ctx, authed, q.amount);
        paidBy = "credits";
      } else throw paymentRequired(req, a.limit ? "free_allowance_used" : "payment_required");
    }
  }

  let datum: Datum;
  try {
    datum = await collect(ctx, feed, params, TIERS[tier].maxAge(feed.ttl));
  } catch (e) {
    if (e instanceof HttpError && e.status >= 500) {
      record(ctx, { ...base, price: "0", paid_by: paidBy, status: "failed", ms: Date.now() - t0 }, isPrivate);
      e.extra = { ...e.extra, charged: false, refund: paidBy === "free" ? null : "Nothing was taken: payment is only settled after an answer is ready." };
    }
    throw e;
  }

  let receipt: string | null = null;
  let tx: string | null = null;
  let moved = 0n;
  if (paidBy === "x402") {
    ({ tx, value: moved } = await settlePayment(ctx, payment!, req!));
    // The receipt belongs to the wallet whose money moved, whoever signed in.
    receipt = (await writeReceipt(ctx, { requestId: rid, wallet: payer!, kind: "payment", amount: moved, tx, feed: feed.id })).id;
  } else if (paidBy === "credits") {
    addCredit(ctx, authed!, -q.amount);
    receipt = (await writeReceipt(ctx, { requestId: rid, wallet: authed!, kind: "credit_spend", amount: q.amount, tx: null, feed: feed.id })).id;
  }
  const charged = paidBy === "x402" ? moved : paidBy === "credits" ? q.amount : 0n;
  record(ctx, { ...base, price: charged.toString(), paid_by: paidBy, status: "ok", ms: Date.now() - t0 }, isPrivate);
  const answer = envelope(ctx, datum, {
    tier,
    requestId: rid,
    price: { amount: fromUnits(charged, USDG_DECIMALS), units: charged.toString(), asset: "USDG", listAmount: fromUnits(q.amount, USDG_DECIMALS), level: q.level },
    paidBy,
    receipt,
    transaction: tx,
    allowance: { used: allow.used + (paidBy === "free" && req ? 1 : 0), limit: allow.limit },
  });
  return { answer, payerHeader: tx ? JSON.stringify({ success: true, transaction: tx, network: req!.network, payer }) : null };
}
