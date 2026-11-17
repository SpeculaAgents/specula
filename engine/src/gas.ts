import type { Abi, Address, Hex, TransactionReceipt } from "viem";
import { count, type Ctx } from "./ctx.ts";
import { HttpError, lower, nowSec } from "./util.ts";

/**
 * Everything the relayer pays gas for goes through here. Each kind of call has a ceiling per transaction; the gas of
 * the day is kept in the database (a restart does not reset it), with one pot for the day and a share per payer or
 * account inside it, so no single caller can use the pot up. Gas is reserved from the estimate before sending and
 * corrected to what the receipt says was used.
 */
export const GAS_LIMITS = {
  /** transferWithAuthorization: one signature check and one token move. */
  settle: 120_000n,
  /** One hourly root on the anchor contract. */
  anchor: 150_000n,
} as const;
export type GasKind = keyof typeof GAS_LIMITS;

const dayOf = (t = nowSec()) => Math.floor(t / 86400);

export function gasUsed(ctx: Ctx, account?: string): bigint {
  const rows = (account
    ? ctx.db.prepare("SELECT gas FROM gas_spend WHERE day = ? AND account = ?").all(dayOf(), lower(account))
    : ctx.db.prepare("SELECT gas FROM gas_spend WHERE day = ?").all(dayOf())) as { gas: string }[];
  return rows.reduce((n, r) => n + BigInt(r.gas), 0n);
}

function add(ctx: Ctx, kind: GasKind, account: string, gas: bigint, txs = 0) {
  ctx.db
    .prepare("INSERT INTO gas_spend (day, kind, account, gas, txs) VALUES (?, ?, ?, ?, ?) ON CONFLICT(day, kind, account) DO UPDATE SET gas = CAST(CAST(gas AS INTEGER) + CAST(excluded.gas AS INTEGER) AS TEXT), txs = txs + excluded.txs")
    .run(dayOf(), kind, lower(account), gas.toString(), txs);
}

/** Refuse before any work is done when this account, or the day, has no gas left for one more call of this kind. */
export function checkGas(ctx: Ctx, kind: GasKind, account: string, need: bigint = GAS_LIMITS[kind]) {
  if (gasUsed(ctx) + need > ctx.cfg.gasDaily) throw new HttpError(503, "relayer_daily_gas_used", "The engine has used the gas it may spend today on submitting payments. Pay with prepaid credits, or try again tomorrow. Nothing was charged.");
  if (gasUsed(ctx, account) + need > ctx.cfg.gasDailyPerAccount)
    throw new HttpError(429, "relayer_share_used", "This wallet has used its share of the engine's gas for today. Top up prepaid credits once and pay from them; that needs no gas per call. Nothing was charged.");
}

export interface RelayCall {
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
}

/**
 * Estimate, check the ceiling and the day's gas, reserve, send, wait, and book what was really used. A call that
 * would revert fails at the estimate and costs nothing.
 */
export async function relay(ctx: Ctx, kind: GasKind, account: string, call: RelayCall): Promise<{ hash: Hex; receipt: TransactionReceipt }> {
  const relayer = ctx.relayer;
  if (!relayer?.account) throw new HttpError(503, "payments_not_configured", "This engine cannot submit transactions yet.");
  const estimate = await ctx.payPub.estimateContractGas({ ...call, account: relayer.account } as never);
  if (estimate > GAS_LIMITS[kind]) {
    count(ctx, `gas_refused_${kind}`);
    throw new HttpError(422, "gas_above_limit", `This ${kind} would need ${estimate} gas, above the ${GAS_LIMITS[kind]} the engine pays for one. Nothing was sent.`);
  }
  // Check and reserve in one step so two calls at once cannot both take the last of the share.
  ctx.db.transaction(() => {
    checkGas(ctx, kind, account, estimate);
    add(ctx, kind, account, estimate, 1);
  })();
  let hash: Hex;
  try {
    hash = await relayer.writeContract({ ...call, account: relayer.account, chain: relayer.chain, gas: GAS_LIMITS[kind] } as never);
  } catch (e) {
    add(ctx, kind, account, -estimate, -1);
    throw e;
  }
  const receipt = await ctx.payPub.waitForTransactionReceipt({ hash, timeout: 60_000 });
  add(ctx, kind, account, receipt.gasUsed - estimate);
  return { hash, receipt };
}
