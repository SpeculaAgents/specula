import { formatUnits, type Address } from "viem";
import type { Ctx } from "../ctx.ts";
import type { Source } from "../collect.ts";
import type { AgreeRule, Dropped, Reading, Verdict } from "../agree.ts";
import { HttpError, iso, nowSec } from "../util.ts";
import { aggregatorAbi } from "./abi.ts";
import registry from "./feeds.json" with { type: "json" };

export interface PriceFeed {
  symbol: string;
  base: string;
  quote: string;
  name: string;
  kind: "equity" | "crypto" | "rate";
  session: string;
  proxy: string;
  secondary: string | null;
  decimals: number;
  heartbeat: number;
}
export const PRICE_FEEDS = registry as PriceFeed[];
const bySymbol = new Map(PRICE_FEEDS.map((f) => [f.symbol, f]));
export const priceFeed = (symbol: string): PriceFeed => {
  const f = bySymbol.get(symbol.toUpperCase());
  if (!f) throw new HttpError(404, "unknown_symbol", `No on-chain price feed for "${symbol}". See /v1/feeds/chain.prices for the list.`);
  return f;
};

export interface PricePoint {
  symbol: string;
  name: string;
  kind: string;
  session: string;
  quote: string;
  price: string;
  raw: string;
  decimals: number;
  roundId: string;
  updatedAt: string;
  updatedAtSec: number;
  ageSeconds: number;
  heartbeat: number;
  /** True when the reading is older than the feed's heartbeat (equity feeds rest on weekends). */
  resting: boolean;
  feed: string;
}

async function read(ctx: Ctx, feeds: PriceFeed[], which: "proxy" | "secondary"): Promise<PricePoint[]> {
  const usable = feeds.filter((f) => f[which]);
  if (!usable.length) throw new Error("no feed address for this source");
  const res = await ctx.pub.multicall({ contracts: usable.map((f) => ({ address: f[which] as Address, abi: aggregatorAbi, functionName: "latestRoundData" as const })), allowFailure: true });
  const t = nowSec();
  const out: PricePoint[] = [];
  usable.forEach((f, i) => {
    const r = res[i];
    if (r.status !== "success") return;
    const [roundId, answer, , updatedAt] = r.result as readonly [bigint, bigint, bigint, bigint, bigint];
    if (answer <= 0n || updatedAt === 0n) return;
    const age = Math.max(0, t - Number(updatedAt));
    out.push({
      symbol: f.symbol,
      name: f.name,
      kind: f.kind,
      session: f.session,
      quote: f.quote,
      price: formatUnits(answer, f.decimals),
      raw: answer.toString(),
      decimals: f.decimals,
      roundId: roundId.toString(),
      updatedAt: iso(Number(updatedAt)),
      updatedAtSec: Number(updatedAt),
      ageSeconds: age,
      heartbeat: f.heartbeat,
      resting: age > f.heartbeat,
      feed: f[which]!.toLowerCase(),
    });
  });
  if (!out.length) throw new Error("no feed answered");
  return out;
}

const one = (which: "proxy" | "secondary"): Source => ({
  id: which === "proxy" ? "chainlink" : "chainlink-secondary",
  async run(ctx, p) {
    const [pt] = await read(ctx, [priceFeed(p.symbol)], which);
    return { data: pt };
  },
});
const all = (which: "proxy" | "secondary"): Source => ({
  id: which === "proxy" ? "chainlink" : "chainlink-secondary",
  async run(ctx, p) {
    const kind = p.kind && p.kind !== "all" ? p.kind : null;
    const pts = await read(ctx, PRICE_FEEDS.filter((f) => !kind || f.kind === kind), which);
    return { data: { count: pts.length, prices: pts } };
  },
});
export const priceSources = { one: [one("proxy"), one("secondary")], all: [all("proxy"), all("secondary")] };

/** Two price sources agree when they are within this many basis points of each other. */
export const PRICE_TOLERANCE_BPS = 100;
const reading = (p: PricePoint): Reading => ({ key: p.symbol, value: Number(p.price), at: p.updatedAtSec, heartbeat: p.heartbeat });
const limits = { toleranceBps: PRICE_TOLERANCE_BPS, maxLagSec: 3600, frozenAfter: 3 };

/** What an answer says about how its sources compared. */
export interface Agreement {
  /** Sources that gave this reading. */
  sources: number;
  /** Sources that agreed on it. Two or more means the price was checked against an independent source. */
  agreed: number;
  agreedSources: string[];
  spreadBps: number | null;
  toleranceBps: number;
  dropped: Dropped[];
  unreachable: string[];
  checked: boolean;
}
const agreementOf = (v: Verdict, toleranceBps: number, unreachable: string[]): Agreement => ({ sources: v.sources, agreed: v.agreed, agreedSources: v.agreedSources, spreadBps: v.spreadBps, toleranceBps, dropped: v.dropped, unreachable, checked: v.agreed >= 2 });

/** One price: both sources are asked. The answer says how many agreed and how far apart they were, or why there is no answer. */
export const priceAgreeOne: AgreeRule = {
  ...limits,
  read: (data) => [reading(data as PricePoint)],
  merge(answers, verdicts, summary) {
    const first = answers[0].data as PricePoint;
    const v = verdicts.get(first.symbol)!;
    const agreement = agreementOf(v, summary.toleranceBps, summary.unreachable);
    if (!v.ok) throw new HttpError(503, "sources_disagree", `No price for ${first.symbol} right now. ${v.why} You were not charged.`, { agreement });
    const from = answers.find((a) => v.agreedSources.includes(a.source))!;
    return { data: { ...(from.data as PricePoint), agreement }, source: from.source };
  },
};

/** The board: every symbol is compared on its own. A symbol whose sources do not agree is left out and listed as withheld. */
export const priceAgreeAll: AgreeRule = {
  ...limits,
  read: (data) => (data as { prices: PricePoint[] }).prices.map(reading),
  merge(answers, verdicts, summary) {
    const by = answers.map((a) => ({ source: a.source, pts: new Map((a.data as { prices: PricePoint[] }).prices.map((p) => [p.symbol, p])) }));
    const prices: (PricePoint & { agreed: number; spreadBps: number | null })[] = [];
    const withheld: { symbol: string; why: string; spreadBps: number | null; dropped: Dropped[] }[] = [];
    const dropped: (Dropped & { symbol: string })[] = [];
    for (const v of verdicts.values()) {
      for (const d of v.dropped) dropped.push({ symbol: v.key, ...d });
      if (!v.ok) {
        withheld.push({ symbol: v.key, why: v.why ?? "", spreadBps: v.spreadBps, dropped: v.dropped });
        continue;
      }
      const from = by.find((a) => v.agreedSources.includes(a.source) && a.pts.has(v.key))!;
      prices.push({ ...from.pts.get(v.key)!, agreed: v.agreed, spreadBps: v.spreadBps });
    }
    if (!prices.length) throw new HttpError(503, "sources_disagree", "No price on the board could be confirmed by its sources right now. You were not charged.", { withheld });
    const order = new Map(PRICE_FEEDS.map((f, i) => [f.symbol, i]));
    prices.sort((a, b) => (order.get(a.symbol) ?? 0) - (order.get(b.symbol) ?? 0));
    const agreement = { toleranceBps: summary.toleranceBps, sourcesKnown: summary.sourcesKnown, sourcesAnswered: summary.sourcesAnswered, unreachable: summary.unreachable, checked: prices.filter((p) => p.agreed >= 2).length, single: prices.filter((p) => p.agreed < 2).length, withheld, dropped };
    return { data: { count: prices.length, prices, agreement }, source: answers[0].source };
  },
};

/** Latest ETH/USD reading as base units with 8 decimals, from the last collected price board. Null until one exists. */
export function ethUsd(ctx: Ctx): bigint | null {
  const v = ctx.mem.get("ethusd") as bigint | undefined;
  return v ?? null;
}

/** Keep the price board warm and remember each new round. Emits "prices" with the points that changed. */
export function rememberPrices(ctx: Ctx, pts: PricePoint[]) {
  const last = (ctx.mem.get("lastRounds") as Map<string, string> | undefined) ?? new Map<string, string>();
  const ins = ctx.db.prepare("INSERT OR IGNORE INTO price_ticks (symbol, time, answer, updated_at) VALUES (?, ?, ?, ?)");
  const changed: PricePoint[] = [];
  const t = nowSec();
  ctx.db.transaction(() => {
    for (const p of pts) {
      if (p.symbol === "ETH") ctx.mem.set("ethusd", BigInt(p.raw));
      if (last.get(p.symbol) === p.roundId + p.raw) continue;
      if (last.size) changed.push(p);
      last.set(p.symbol, p.roundId + p.raw);
      ins.run(p.symbol, t, p.raw, p.updatedAtSec);
    }
  })();
  ctx.mem.set("lastRounds", last);
  if (changed.length) ctx.bus.emit("prices", changed);
}
