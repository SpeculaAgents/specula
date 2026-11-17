import { createHash } from "node:crypto";
import { parseAbi, parseEventLogs, recoverMessageAddress, recoverTypedDataAddress, type Address, type Hex } from "viem";
import { accessMessage, authorizationTypedData, decodeHeader, type PaymentPayload, type PaymentRequirements } from "../../packages/sdk/src/protocol.ts";
import { USDG_DECIMALS } from "./config.ts";
import type { Feed } from "./collect.ts";
import { count, type Ctx } from "./ctx.ts";
import { checkGas, relay } from "./gas.ts";
import { signValue } from "./sign.ts";
import { fromUnits, HttpError, id, isAddress, lower, nowSec, sameAddress, toUnits } from "./util.ts";

export const tokenAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)",
  "function transfer(address to, uint256 value) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export type Tier = "live" | "recent" | "delayed";
/** Price by freshness: an answer that may be a few minutes old costs half, one that may be an hour old a fifth. */
export const TIERS: Record<Tier, { bps: number; maxAge: (ttl: number) => number; label: string }> = {
  live: { bps: 10000, maxAge: (ttl) => ttl, label: "Live" },
  recent: { bps: 5000, maxAge: (ttl) => Math.max(ttl, 300), label: "Up to 5 minutes old" },
  delayed: { bps: 2000, maxAge: (ttl) => Math.max(ttl, 3600), label: "Up to 1 hour old" },
};
/** Bulk levels by what a wallet paid in the last 30 days, in whole payment-asset units. */
export const LEVELS = [
  { level: 0, minSpend: "0", offBps: 0 },
  { level: 1, minSpend: "10", offBps: 1000 },
  { level: 2, minSpend: "100", offBps: 2000 },
  { level: 3, minSpend: "1000", offBps: 3000 },
];

export const network = (ctx: Ctx) => `eip155:${ctx.cfg.payChainId}`;
const dayStart = (t = nowSec()) => t - (t % 86400);

export function spent(ctx: Ctx, wallet: string, since: number): bigint {
  const rows = ctx.db.prepare("SELECT amount, kind FROM receipts WHERE wallet = ? AND at >= ? AND kind IN ('payment', 'credit_spend', 'refund')").all(wallet, since) as { amount: string; kind: string }[];
  return rows.reduce((n, r) => (r.kind === "refund" ? n - BigInt(r.amount) : n + BigInt(r.amount)), 0n);
}

export function levelOf(ctx: Ctx, wallet: string | null) {
  if (!wallet) return LEVELS[0];
  const s = spent(ctx, wallet, nowSec() - 30 * 86400);
  return [...LEVELS].reverse().find((l) => s >= toUnits(l.minSpend, USDG_DECIMALS)) ?? LEVELS[0];
}

export interface Quote {
  list: bigint;
  amount: bigint;
  tier: Tier;
  level: number;
}
/** The price of one call in base units: list price, times the tier, minus the bulk level. Never below one unit. */
export function quote(ctx: Ctx, feed: Feed, tier: Tier, wallet: string | null): Quote {
  const list = toUnits(feed.price, USDG_DECIMALS);
  const lvl = levelOf(ctx, wallet);
  let amount = (list * BigInt(TIERS[tier].bps)) / 10000n;
  amount = (amount * BigInt(10000 - lvl.offBps)) / 10000n;
  if (amount < 1n && list > 0n) amount = 1n;
  return { list, amount, tier, level: lvl.level };
}

export function requirements(ctx: Ctx, amount: bigint, resource: string, description: string, payTo: Address | null = ctx.cfg.payTo): PaymentRequirements {
  if (!payTo) throw new HttpError(503, "payments_not_configured", "This engine has no payment address configured.");
  return {
    scheme: "exact",
    network: network(ctx),
    maxAmountRequired: amount.toString(),
    resource,
    description,
    mimeType: "application/json",
    payTo,
    maxTimeoutSeconds: 120,
    asset: ctx.cfg.payAsset,
    extra: { name: ctx.cfg.payAssetName, version: ctx.cfg.payAssetVersion, decimals: USDG_DECIMALS, symbol: "USDG" },
  };
}

export const paymentRequired = (req: PaymentRequirements, error = "payment_required") => new HttpError(402, error, "Payment required.", { x402Version: 1, accepts: [req] });

export function readPayment(header: string | undefined): PaymentPayload | null {
  if (!header) return null;
  try {
    const p = decodeHeader<PaymentPayload>(header);
    if (!p?.payload?.authorization || !p.payload.signature) return null;
    return p;
  } catch {
    return null;
  }
}

export type Verdict = { ok: true; payer: Address } | { ok: false; reason: string; payer?: Address };

export async function verifyPayment(ctx: Ctx, p: PaymentPayload, req: PaymentRequirements): Promise<Verdict> {
  const a = p.payload.authorization;
  const bad = (reason: string): Verdict => ({ ok: false, reason, payer: isAddress(a?.from) ? lower(a.from) : undefined });
  if (p.scheme !== "exact") return bad("unsupported_scheme");
  if (p.network !== req.network) return bad("wrong_network");
  if (!isAddress(a.from) || !isAddress(a.to) || !/^0x[0-9a-fA-F]{64}$/.test(a.nonce)) return bad("malformed_authorization");
  if (!sameAddress(a.to, req.payTo)) return bad("wrong_recipient");
  // Paying yourself moves nothing and would only buy ranking with the engine's gas.
  if (sameAddress(a.from, a.to)) return bad("self_payment");
  let value: bigint, before: bigint, after: bigint;
  try {
    [value, before, after] = [BigInt(a.value), BigInt(a.validBefore), BigInt(a.validAfter)];
  } catch {
    return bad("malformed_authorization");
  }
  if (value < BigInt(req.maxAmountRequired)) return bad("amount_too_low");
  const t = BigInt(nowSec());
  if (before <= t + 5n) return bad("authorization_expired");
  if (after > t) return bad("authorization_not_yet_valid");
  if (ctx.db.prepare("SELECT 1 FROM used_nonces WHERE asset = ? AND payer = ? AND nonce = ?").get(lower(req.asset), lower(a.from), a.nonce.toLowerCase())) return bad("nonce_already_used");
  // Recovered here, from the signature alone: a contract posing as a wallet (one that calls any signature valid)
  // never passes, because the token itself only accepts a key's own signature.
  const signer = await recoverTypedDataAddress({ ...authorizationTypedData(ctx.cfg.payChainId, req.asset, req.extra.name, req.extra.version, a), signature: p.payload.signature }).catch(() => null);
  if (!sameAddress(signer, a.from)) return bad("bad_signature");
  const [used, bal] = await Promise.all([
    ctx.payPub.readContract({ address: req.asset, abi: tokenAbi, functionName: "authorizationState", args: [a.from, a.nonce] }).catch(() => false),
    ctx.payPub.readContract({ address: req.asset, abi: tokenAbi, functionName: "balanceOf", args: [a.from] }),
  ]);
  if (used) return bad("nonce_already_used");
  if (bal < value) return bad("insufficient_funds");
  return { ok: true, payer: lower(a.from) };
}

/**
 * Move the money: the relayer submits the signed authorization. Paid means proven: the transaction's own receipt
 * must hold the payment asset's Transfer log from the payer to the payee for at least the price. Returns the
 * transaction hash and the amount that moved.
 */
export async function settlePayment(ctx: Ctx, p: PaymentPayload, req: PaymentRequirements): Promise<{ tx: Hex; value: bigint }> {
  if (!ctx.relayer?.account) throw new HttpError(503, "payments_not_configured", "This engine cannot settle payments yet.");
  const a = p.payload.authorization;
  if (!sameAddress(req.asset, ctx.cfg.payAsset)) throw new HttpError(402, "wrong_asset", "Only the listed payment asset is accepted.");
  // Claim the nonce first so the same signature cannot be raced through twice.
  const claim = ctx.db.prepare("INSERT OR IGNORE INTO used_nonces (asset, payer, nonce, at) VALUES (?, ?, ?, ?)").run(lower(req.asset), lower(a.from), a.nonce.toLowerCase(), nowSec());
  if (!claim.changes) throw new HttpError(402, "nonce_already_used", "This payment was already used.");
  let mined = false;
  try {
    const { hash, receipt: rc } = await relay(ctx, "settle", a.from, {
      address: req.asset,
      abi: tokenAbi,
      functionName: "transferWithAuthorization",
      args: [a.from, a.to, BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce, p.payload.signature],
    });
    mined = true;
    if (rc.status !== "success") throw new Error("the transfer reverted");
    const moved = provenTransfer(rc.logs, req.asset, a.from, req.payTo);
    if (moved < BigInt(req.maxAmountRequired)) {
      count(ctx, "settle_unproven");
      throw new Error("the receipt holds no transfer of the price to the payee");
    }
    count(ctx, "settled");
    return { tx: hash, value: moved };
  } catch (e) {
    // A transaction that was mined used the authorization up on chain; only an unsent one frees the nonce again.
    if (!mined) ctx.db.prepare("DELETE FROM used_nonces WHERE asset = ? AND payer = ? AND nonce = ?").run(lower(req.asset), lower(a.from), a.nonce.toLowerCase());
    if (e instanceof HttpError) throw e;
    count(ctx, "settle_failed");
    throw new HttpError(402, "settlement_failed", "The payment could not be settled on chain. Nothing was charged.");
  }
}

/** What the payment asset's own Transfer logs in a receipt moved from `from` to `to`. Logs of any other contract count for nothing. */
export function provenTransfer(logs: readonly { address: string; topics: readonly Hex[]; data: Hex }[], asset: string, from: string, to: string): bigint {
  const events = parseEventLogs({ abi: tokenAbi, eventName: "Transfer", logs: logs as never, strict: true }) as unknown as { address: string; args: { from: string; to: string; value: bigint } }[];
  return events.filter((l) => sameAddress(l.address, asset) && sameAddress(l.args.from, from) && sameAddress(l.args.to, to)).reduce((n, l) => n + l.args.value, 0n);
}

/** Before collecting an answer: will the relayer be able to submit this payer's payment today? */
export const checkSettleGas = (ctx: Ctx, payer: string) => checkGas(ctx, "settle", payer);

export interface Receipt {
  id: string;
  requestId: string | null;
  wallet: string;
  kind: "payment" | "topup" | "credit_spend" | "refund";
  amount: string;
  amountUnits: string;
  asset: string;
  transaction: string | null;
  at: number;
  feed: string | null;
  engine: string;
  digest: Hex;
  signature: Hex;
}

export async function writeReceipt(ctx: Ctx, r: { requestId: string | null; wallet: string; kind: Receipt["kind"]; amount: bigint; tx: string | null; feed: string | null }): Promise<Receipt> {
  const rid = id("rcpt");
  const at = nowSec();
  const body = { id: rid, requestId: r.requestId, wallet: r.wallet, kind: r.kind, amountUnits: r.amount.toString(), asset: lower(ctx.cfg.payAsset), network: network(ctx), transaction: r.tx, at, feed: r.feed };
  const { digest, signature } = await signValue(ctx, body);
  ctx.db.prepare("INSERT INTO receipts (id, request_id, wallet, kind, amount, asset, tx, at, feed, digest, signature) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(rid, r.requestId, r.wallet, r.kind, r.amount.toString(), lower(ctx.cfg.payAsset), r.tx, at, r.feed, digest, signature);
  return shapeReceipt(ctx, { id: rid, request_id: r.requestId, wallet: r.wallet, kind: r.kind, amount: r.amount.toString(), asset: lower(ctx.cfg.payAsset), tx: r.tx, at, feed: r.feed, digest, signature });
}

export const shapeReceipt = (ctx: Ctx, r: { id: string; request_id: string | null; wallet: string; kind: string; amount: string; asset: string; tx: string | null; at: number; feed: string | null; digest: string; signature: string }): Receipt => ({
  id: r.id,
  requestId: r.request_id,
  wallet: r.wallet,
  kind: r.kind as Receipt["kind"],
  amount: fromUnits(r.amount, USDG_DECIMALS),
  amountUnits: r.amount,
  asset: r.asset,
  transaction: r.tx,
  at: r.at,
  feed: r.feed,
  engine: ctx.signer.address.toLowerCase(),
  digest: r.digest as Hex,
  signature: r.signature as Hex,
});

// ---------- who is asking ----------

const tokens = new Map<string, { wallet: Address; expiry: number }>();
/** "Authorization: Specula <address>.<expiry>.<signature>": a wallet proving itself with one readable signed line. */
export async function whoIs(header: string | undefined): Promise<Address | null> {
  const m = header?.match(/^Specula\s+(0x[0-9a-fA-F]{40})\.(\d+)\.(0x[0-9a-fA-F]+)$/);
  if (!m) return null;
  const hit = tokens.get(m[0]);
  const t = nowSec();
  if (hit) return hit.expiry > t ? hit.wallet : null;
  const expiry = Number(m[2]);
  if (expiry <= t || expiry > t + 7 * 86400) return null;
  const signer = await recoverMessageAddress({ message: accessMessage(m[1], expiry), signature: m[3] as Hex }).catch(() => null);
  if (!sameAddress(signer, m[1])) return null;
  if (tokens.size > 5000) tokens.clear();
  tokens.set(m[0], { wallet: lower(m[1]), expiry });
  return lower(m[1]);
}

export const ipKey = (ip: string) => `ip:${createHash("sha256").update(`specula|${ip}`).digest("hex").slice(0, 16)}`;

/**
 * The free calls left today. A wallet's allowance is also held to its network address: new wallets from one address
 * share that address's day, so signing in with many keys does not multiply it.
 */
export function allowance(ctx: Ctx, who: string, isWallet: boolean, ip?: string) {
  const day = dayStart();
  const used = (ctx.db.prepare("SELECT COUNT(*) n FROM requests WHERE who = ? AND at >= ? AND paid_by = 'free' AND status = 'ok'").get(who, day) as { n: number }).n;
  const limit = isWallet ? ctx.cfg.freeDaily : ctx.cfg.freeDailyAnon;
  if (!isWallet || !ip) return { used, limit };
  const fromIp = (ctx.db.prepare("SELECT COUNT(*) n FROM requests WHERE ip = ? AND at >= ? AND paid_by = 'free' AND status = 'ok'").get(ip, day) as { n: number }).n;
  return { used: Math.max(used, Math.min(limit, fromIp)), limit };
}

// ---------- credits and budgets ----------

export const creditOf = (ctx: Ctx, wallet: string): bigint => BigInt((ctx.db.prepare("SELECT balance FROM credits WHERE wallet = ?").get(wallet) as { balance: string } | undefined)?.balance ?? "0");
export function addCredit(ctx: Ctx, wallet: string, delta: bigint): bigint {
  const next = creditOf(ctx, wallet) + delta;
  if (next < 0n) throw new HttpError(402, "insufficient_credits", "Not enough prepaid credits.");
  ctx.db.prepare("INSERT INTO credits (wallet, balance) VALUES (?, ?) ON CONFLICT(wallet) DO UPDATE SET balance = excluded.balance").run(wallet, next.toString());
  return next;
}

export const budgetOf = (ctx: Ctx, wallet: string): bigint | null => {
  const r = ctx.db.prepare("SELECT daily FROM budgets WHERE wallet = ?").get(wallet) as { daily: string } | undefined;
  return r ? BigInt(r.daily) : null;
};
/** Extra budget checks (the team budget) run before the wallet's own. Registered at boot, which keeps imports one-way. */
export const budgetHooks: ((ctx: Ctx, wallet: string, amount: bigint) => void)[] = [];
export function checkBudget(ctx: Ctx, wallet: string, amount: bigint) {
  for (const hook of budgetHooks) hook(ctx, wallet, amount);
  const b = budgetOf(ctx, wallet);
  if (b === null) return;
  const s = spent(ctx, wallet, dayStart());
  if (s + amount > b)
    throw new HttpError(403, "budget_reached", "This wallet's daily budget would be passed by this call. Nothing was charged.", { budget: { daily: fromUnits(b, USDG_DECIMALS), spentToday: fromUnits(s, USDG_DECIMALS), thisCall: fromUnits(amount, USDG_DECIMALS) } });
}
export const walletAccount = (ctx: Ctx, wallet: string) => {
  const b = budgetOf(ctx, wallet);
  const lvl = levelOf(ctx, wallet);
  const next = LEVELS[lvl.level + 1];
  return {
    wallet,
    credits: fromUnits(creditOf(ctx, wallet), USDG_DECIMALS),
    budget: b === null ? null : { daily: fromUnits(b, USDG_DECIMALS) },
    spentToday: fromUnits(spent(ctx, wallet, dayStart()), USDG_DECIMALS),
    spent30d: fromUnits(spent(ctx, wallet, nowSec() - 30 * 86400), USDG_DECIMALS),
    level: lvl.level,
    discountBps: lvl.offBps,
    nextLevel: next ? { level: next.level, atSpend30d: next.minSpend, discountBps: next.offBps } : null,
    allowance: allowance(ctx, wallet, true),
  };
};
