import type { Hono } from "hono";
import { FEEDS } from "./registry.ts";
import { feedUptime, type Feed } from "./collect.ts";
import type { Ctx } from "./ctx.ts";
import { kvGet, kvSet } from "./db.ts";
import type { Helpers } from "./server.ts";
import { PRICE_FEEDS } from "./chain/prices.ts";
import { aggregatorAbi } from "./chain/abi.ts";
import { nowSec } from "./util.ts";

/**
 * A quality score per feed, 0 to 100, from things the engine measures about itself: did collections succeed, how
 * fast, how often the first source was enough, and (for prices) whether a feed's two addresses agree.
 */
export function qualityOf(ctx: Ctx, f: Feed) {
  const hour = Math.floor(nowSec() / 3600);
  const up24 = feedUptime(ctx, f.id);
  const week = ctx.db.prepare("SELECT SUM(ok) ok, SUM(fail) fail FROM health_hour WHERE feed = ? AND source = '*' AND hour > ?").get(f.id, hour - 168) as { ok: number | null; fail: number | null };
  const first = ctx.db.prepare("SELECT SUM(ok) ok, SUM(fail) fail FROM health_hour WHERE feed = ? AND source = ? AND hour > ?").get(f.id, f.sources[0].id, hour - 168) as { ok: number | null; fail: number | null };
  const n7 = (week.ok ?? 0) + (week.fail ?? 0);
  const parts: { name: string; score: number; weight: number; detail: string }[] = [];
  if (n7) {
    const a = (week.ok ?? 0) / n7;
    // Availability is scored hard: 99% is 80 points, 95% is 0.
    parts.push({ name: "availability", weight: 45, score: Math.round(Math.max(0, Math.min(1, (a - 0.95) / 0.05)) * 100), detail: `${(a * 100).toFixed(2)}% of ${n7} ${n7 === 1 ? "collection" : "collections"} answered in 7 days` });
  }
  if (up24.avgMs !== null) parts.push({ name: "speed", weight: 20, score: Math.round(Math.max(0, Math.min(1, 1 - (up24.avgMs - 300) / 4700)) * 100), detail: `${up24.avgMs} ms average collection` });
  const nf = (first.ok ?? 0) + (first.fail ?? 0);
  if (nf) parts.push({ name: "first source", weight: 15, score: Math.round(((first.ok ?? 0) / nf) * 100), detail: `${f.sources[0].id} answered ${first.ok ?? 0} of ${nf} ${nf === 1 ? "time" : "times"} without a fallback` });
  if (f.id.startsWith("chain.price")) {
    const agree = kvGet(ctx.db, "quality_agreement");
    if (agree) {
      const a = JSON.parse(agree) as { maxBps: number; compared: number; at: number };
      parts.push({ name: "agreement", weight: 20, score: Math.round(Math.max(0, 1 - a.maxBps / 100) * 100), detail: `the two addresses of ${a.compared} feeds read within ${(a.maxBps / 100).toFixed(2)}% of each other` });
    }
  }
  const w = parts.reduce((n, p) => n + p.weight, 0);
  const score = w ? Math.round(parts.reduce((n, p) => n + p.score * p.weight, 0) / w) : null;
  return { feed: f.id, title: f.title, score, grade: score === null ? null : score >= 90 ? "A" : score >= 75 ? "B" : score >= 55 ? "C" : "D", measured: n7, parts };
}

/** Read every price feed through both of its addresses in one call and keep the largest disagreement. */
export async function crossCheckPrices(ctx: Ctx) {
  const both = PRICE_FEEDS.filter((f) => f.secondary);
  const res = await ctx.pub.multicall({ contracts: both.flatMap((f) => [{ address: f.proxy as `0x${string}`, abi: aggregatorAbi, functionName: "latestRoundData" as const }, { address: f.secondary as `0x${string}`, abi: aggregatorAbi, functionName: "latestRoundData" as const }]), allowFailure: true });
  let maxBps = 0;
  let compared = 0;
  both.forEach((_, i) => {
    const [a, b] = [res[i * 2], res[i * 2 + 1]];
    if (a.status !== "success" || b.status !== "success") return;
    const x = (a.result as readonly bigint[])[1];
    const y = (b.result as readonly bigint[])[1];
    if (x <= 0n || y <= 0n) return;
    compared++;
    const d = Number(((x > y ? x - y : y - x) * 10000n) / x);
    if (d > maxBps) maxBps = d;
  });
  if (compared) kvSet(ctx.db, "quality_agreement", JSON.stringify({ maxBps, compared, at: nowSec() }));
  return { maxBps, compared };
}

export function registerQuality(app: Hono, ctx: Ctx, h: Helpers) {
  app.get("/v1/quality", async (c) => c.json(await h.cached("quality", 5000, () => ({ scale: "0 to 100, from the engine's own measurements over 7 days", feeds: FEEDS.filter((f) => !f.allow).map((f) => qualityOf(ctx, f)) }))));
}
