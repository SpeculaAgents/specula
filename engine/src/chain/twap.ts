// A time-weighted price per token, from the swaps the index has read. Built to be hard to move:
//   - trades in one block count once (their volume-weighted price), so stuffing a block buys nothing;
//   - blocks whose price is far from the middle of the window are trimmed before averaging;
//   - each price is weighted by how long it stood, and no single price may stand for more than a quarter of the window;
//   - when there is too little trading or liquidity for the number to mean anything, the answer is "thin market" and
//     carries no price at all.
// The same reading can be signed for the on-chain oracle (contracts/src/SpeculaTwapOracle.sol), which checks the
// engine's signature, so anyone can carry an update there and Specula pays no gas.
import { encodeAbiParameters, formatUnits, keccak256, type Address } from "viem";
import type { Ctx } from "../ctx.ts";
import type { Source } from "../collect.ts";
import { HttpError, iso, lower, nowSec, ZERO } from "../util.ts";
import { ADDR } from "./abi.ts";
import { indexHead, type TradeRow } from "./indexer.ts";
import { usdOf } from "./views.ts";

export interface TwapRule {
  windowSec: number;
  /** Fewer trades than this in the window is a thin market. */
  minTrades: number;
  /** Fewer distinct blocks with trades than this, after trimming, is a thin market. */
  minBlocks: number;
  /** Fewer distinct wallets than this is a thin market. */
  minTraders: number;
  /** Less traded than this in the window, in dollars, is a thin market. */
  minVolumeUsd: number;
  /** On a launch curve: less of the quote asset held by the curve than this, in dollars, is a thin market. */
  minCurveReserveUsd: number;
  /** A last trade older than this is a thin market. */
  maxAgeSec: number;
  /** A block is trimmed when its price is further than this from the median, in basis points (or 4 times the usual spread, if that is wider). */
  trimBps: number;
  /** More than this share of blocks trimmed means the prices are too scattered to average. */
  maxTrimmedShare: number;
  /** So does a usual distance from the median wider than this, in basis points: two prices at once is not one price. */
  maxScatterBps: number;
}
export const TWAP_WINDOWS: Record<string, number> = { "5m": 300, "30m": 1800, "1h": 3600, "4h": 14400 };
export const twapRule = (windowSec: number): TwapRule => ({ windowSec, minTrades: 12, minBlocks: 6, minTraders: 4, minVolumeUsd: 500, minCurveReserveUsd: 250, maxAgeSec: Math.min(windowSec, 900), trimBps: 1000, maxTrimmedShare: 0.4, maxScatterBps: 6000 });

const X18 = 10n ** 18n;
const median = (xs: bigint[]) => {
  const s = [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2n;
};
const absDiff = (a: bigint, b: bigint) => (a > b ? a - b : b - a);

export interface Twap {
  token: string;
  symbol: string | null;
  venue: "curve" | "pool" | null;
  quoteAsset: string;
  window: { seconds: number; from: string; to: string };
  /** True when there is no price: too little trading or liquidity for one. `reasons` says which checks failed. */
  thin: boolean;
  reasons: string[];
  /** Quote asset per whole token, as a decimal string. Null in a thin market. */
  price: string | null;
  /** The same number with 18 decimals, as the oracle contract stores it. */
  priceX18: string | null;
  priceUsd: string | null;
  /** Time of the last trade that counted. The oracle update carries this as its timestamp. */
  at: string | null;
  atSec: number | null;
  stats: { trades: number; blocks: number; blocksTrimmed: number; traders: number; volume: string; volumeUsd: string | null; curveReserveUsd: string | null; poolLiquidity: string | null; lastTradeAgeSec: number | null };
  evidence: { firstBlock: number | null; lastBlock: number | null; firstTx: string | null; lastTx: string | null; trimmed: { block: number; price: string; offBps: number }[] };
  rule: TwapRule;
}

/** The time-weighted price of one token over the window ending at `now`. Reads only the index. */
export function twap(ctx: Ctx, token: string, rule: TwapRule, now = nowSec()): Twap {
  const tok = ctx.db.prepare("SELECT symbol, phase, pool_id, launch_seen FROM tokens WHERE address = ?").get(token) as { symbol: string | null; phase: number; pool_id: string | null; launch_seen: number } | undefined;
  const from = now - rule.windowSec;
  const all = ctx.db.prepare("SELECT * FROM trades WHERE token = ? AND time > ? AND time <= ? ORDER BY block, log_index").all(token, from, now) as TradeRow[];
  // Price where the token trades now: the venue and quote asset of its latest trade.
  const last = all[all.length - 1];
  const rows = last ? all.filter((t) => t.venue === last.venue && t.quote_asset === last.quote_asset && BigInt(t.amount) > 0n) : [];
  const quoteAsset = last?.quote_asset ?? ZERO;
  const quoteDecimals = quoteAsset === lower(ADDR.usdg) ? 6 : 18;
  const reasons: string[] = [];

  // One price per block: everything traded in the block, volume weighted.
  const blocks = new Map<number, { quote: bigint; amount: bigint; time: number; tx: string }>();
  let volume = 0n;
  const traders = new Set<string>();
  for (const t of rows) {
    const b = blocks.get(t.block) ?? { quote: 0n, amount: 0n, time: t.time, tx: t.tx };
    b.quote += BigInt(t.quote);
    b.amount += BigInt(t.amount);
    blocks.set(t.block, b);
    volume += BigInt(t.quote);
    traders.add(t.trader);
  }
  // quote base units per whole token, with 18 decimals of the quote asset's own unit
  const pts = [...blocks.entries()].map(([block, b]) => ({ block, time: b.time, tx: b.tx, price: (b.quote * X18 * 10n ** BigInt(18 - quoteDecimals) * X18) / b.amount / X18 })).filter((p) => p.price > 0n);

  // Trim blocks far from the middle. The band is the wider of the fixed one and four times the usual spread.
  const mid = pts.length ? median(pts.map((p) => p.price)) : 0n;
  const mad = pts.length ? median(pts.map((p) => absDiff(p.price, mid))) : 0n;
  const band = mid === 0n ? 0n : (() => {
    const fixed = (mid * BigInt(rule.trimBps)) / 10000n;
    const wide = mad * 4n;
    return wide > fixed ? wide : fixed;
  })();
  const kept = pts.filter((p) => absDiff(p.price, mid) <= band);
  const trimmed = pts.filter((p) => absDiff(p.price, mid) > band);

  // Weight each price by how long it stood, capped so one quiet stretch cannot carry the average.
  const cap = Math.max(1, Math.floor(rule.windowSec / 4));
  let sum = 0n;
  let weight = 0n;
  kept.forEach((p, i) => {
    const until = i + 1 < kept.length ? kept[i + 1].time : now;
    const w = BigInt(Math.max(1, Math.min(cap, until - p.time)));
    sum += p.price * w;
    weight += w;
  });
  const priceX18 = weight > 0n ? sum / weight : null;

  const volumeUsd = usdOf(ctx, quoteAsset, volume);
  const lastKept = kept[kept.length - 1];
  const ageSec = last ? now - last.time : null;
  let curveReserveUsd: string | null = null;
  let poolLiquidity: string | null = null;
  if (!last) reasons.push("no trade in the window");
  else {
    if (rows.length < rule.minTrades) reasons.push(`${rows.length} trades in the window, fewer than ${rule.minTrades}`);
    if (kept.length < rule.minBlocks) reasons.push(`trades in ${kept.length} blocks after trimming, fewer than ${rule.minBlocks}`);
    if (traders.size < rule.minTraders) reasons.push(`${traders.size} wallets traded, fewer than ${rule.minTraders}`);
    if (volumeUsd === null) reasons.push("the traded volume cannot be valued in dollars");
    else if (Number(volumeUsd) < rule.minVolumeUsd) reasons.push(`$${volumeUsd} traded in the window, less than $${rule.minVolumeUsd}`);
    if (ageSec! > rule.maxAgeSec) reasons.push(`the last trade was ${ageSec} seconds ago, more than ${rule.maxAgeSec}`);
    const scatterBps = mid === 0n ? 0 : Number((mad * 10000n) / mid);
    if (scatterBps > rule.maxScatterBps) reasons.push(`block prices sit ${scatterBps} basis points from their median on average: too scattered to average`);
    if (pts.length && trimmed.length / pts.length > rule.maxTrimmedShare) reasons.push(`${trimmed.length} of ${pts.length} blocks were far from the middle price: too scattered to average`);
    if (last.venue === "curve") {
      // What the curve holds of the quote asset: everything paid in minus everything paid out, over the token's indexed life.
      const r = ctx.db.prepare("SELECT side, quote FROM trades WHERE token = ? AND venue = 'curve' AND time <= ?").all(token, now) as { side: string; quote: string }[];
      const reserve = r.reduce((n, t) => (t.side === "buy" ? n + BigInt(t.quote) : n - BigInt(t.quote)), 0n);
      curveReserveUsd = usdOf(ctx, quoteAsset, reserve > 0n ? reserve : 0n);
      if (tok?.launch_seen && curveReserveUsd !== null && Number(curveReserveUsd) < rule.minCurveReserveUsd) reasons.push(`the curve holds $${curveReserveUsd}, less than $${rule.minCurveReserveUsd}`);
    } else if (tok?.pool_id) {
      const liq = (ctx.db.prepare("SELECT delta FROM liquidity WHERE pool_id = ? AND time <= ?").all(tok.pool_id, now) as { delta: string }[]).reduce((n, l) => n + BigInt(l.delta), 0n);
      const seen = (ctx.db.prepare("SELECT COUNT(*) n FROM liquidity WHERE pool_id = ?").get(tok.pool_id) as { n: number }).n;
      poolLiquidity = seen ? liq.toString() : null;
      if (seen && liq <= 0n) reasons.push("the liquidity added to the pool has been taken out again");
    }
  }
  const thin = reasons.length > 0 || priceX18 === null;
  return {
    token,
    symbol: tok?.symbol ?? null,
    venue: last?.venue ?? null,
    quoteAsset: quoteAsset === lower(ADDR.usdg) ? "USDG" : "ETH",
    window: { seconds: rule.windowSec, from: iso(from), to: iso(now) },
    thin,
    reasons,
    price: thin ? null : formatUnits(priceX18!, 18),
    priceX18: thin ? null : priceX18!.toString(),
    priceUsd: thin ? null : quoteAsset === lower(ADDR.usdg) ? formatUnits(priceX18!, 18) : usdX18(ctx, priceX18!),
    at: lastKept ? iso(lastKept.time) : null,
    atSec: lastKept ? lastKept.time : null,
    stats: { trades: rows.length, blocks: kept.length, blocksTrimmed: trimmed.length, traders: traders.size, volume: formatUnits(volume, quoteDecimals), volumeUsd, curveReserveUsd, poolLiquidity, lastTradeAgeSec: ageSec },
    evidence: {
      firstBlock: kept[0]?.block ?? null,
      lastBlock: lastKept?.block ?? null,
      firstTx: kept[0]?.tx ?? null,
      lastTx: lastKept?.tx ?? null,
      trimmed: trimmed.slice(0, 10).map((p) => ({ block: p.block, price: formatUnits(p.price, 18), offBps: mid === 0n ? 0 : Number((absDiff(p.price, mid) * 10000n) / mid) })),
    },
    rule,
  };
}

/** Dollars per whole token for a price in ETH with 18 decimals, as a decimal string with up to 12 places. */
function usdX18(ctx: Ctx, priceX18: bigint): string | null {
  const px = ctx.mem.get("ethusd") as bigint | undefined; // ETH/USD with 8 decimals
  if (px === undefined) return null;
  return formatUnits((priceX18 * px) / 10n ** 14n, 12);
}

export const twapSource: Source = {
  id: "index",
  async run(ctx, p) {
    if (indexHead(ctx) === null) throw new HttpError(409, "indexing", "The chain index is reading its first blocks. Ask again in a minute. You were not charged.", { retryAfter: 30 });
    return { data: twap(ctx, p.token, twapRule(TWAP_WINDOWS[p.window ?? "30m"] ?? 1800)) };
  },
};

/**
 * An update for the token oracle contract. The engine signs it; whoever submits it pays the gas. A thin market is
 * signed too, with price zero and the thin flag set, so the contract stops giving out the last good price.
 */
export async function twapUpdate(ctx: Ctx, t: Twap, now = nowSec()) {
  const oracle = ctx.cfg.tokenOracle ?? ZERO;
  const price = t.thin ? 0n : BigInt(t.priceX18!);
  // A thin reading has no last trade to date it by, so it is dated when it was made.
  const timestamp = t.thin ? now : t.atSec!;
  const hash = twapUpdateHash(BigInt(ctx.cfg.payChainId), oracle, t.token as Address, price, timestamp, t.window.seconds, t.thin);
  const signature = await ctx.signer.signMessage({ message: { raw: hash } });
  return { token: t.token, price: price.toString(), decimals: 18, quoteAsset: t.quoteAsset, timestamp, window: t.window.seconds, thin: t.thin, reasons: t.reasons, chainId: ctx.cfg.payChainId, oracle: ctx.cfg.tokenOracle, signer: ctx.signer.address.toLowerCase(), hash, signature };
}

/** The bytes the contract hashes. Kept next to the contract's own `updateHash`; a test holds the two together. */
export const twapUpdateHash = (chainId: bigint, oracle: Address, token: Address, price: bigint, timestamp: number, windowSec: number, thin: boolean) =>
  keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint64" }, { type: "uint32" }, { type: "bool" }], [chainId, oracle, token, price, BigInt(timestamp), windowSec, thin]));
