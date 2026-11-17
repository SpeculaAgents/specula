import type { Hex } from "viem";
import { count, type Ctx } from "./ctx.ts";
import { signValue } from "./sign.ts";
import { reconcile, type AgreeRule, type History } from "./agree.ts";
import { canonical, HttpError, isAddress, lower, nowSec } from "./util.ts";

export interface ParamSpec {
  name: string;
  type: "symbol" | "address" | "int" | "string" | "enum";
  required?: boolean;
  default?: string;
  values?: string[];
  min?: number;
  max?: number;
  doc: string;
}

export interface Source {
  id: string;
  run(ctx: Ctx, params: Record<string, string>): Promise<{ data: unknown; collectedAt?: number }>;
}

export interface Feed {
  id: string;
  group: "chain" | "companies" | "economy" | "signals" | "answers" | "indexes" | "market" | "archive" | "lab";
  title: string;
  summary: string;
  params: ParamSpec[];
  /** Price for a live answer, as a decimal string in the payment asset. Parsed to base units once. */
  price: string;
  /** How long an answer counts as live, in seconds. */
  ttl: number;
  sources: Source[];
  example: Record<string, string>;
  stream?: string;
  /** A seller's feed: the buyer pays this wallet directly, never the engine. */
  payTo?: `0x${string}`;
  owner?: string;
  /** A private feed: only these wallets can see or buy it. */
  allow?: string[] | null;
  /** Answers of this feed are not kept in the archive (they are themselves reads of history, or one-off). */
  noArchive?: boolean;
  /** Ask every source each time and give out only what they agree on (see agree.ts). Without it, sources are a failover chain. */
  agree?: AgreeRule;
}

export interface Attempt {
  source: string;
  ok: boolean;
  ms: number;
  error?: string;
}

/** One collected answer in the common format. Signed once, when it is collected. */
export interface Datum {
  feed: string;
  params: Record<string, string>;
  data: unknown;
  source: string;
  collectedAt: number;
  digest: Hex;
  signature: Hex;
  tried: Attempt[];
  cached: boolean;
}

export function normalizeParams(feed: Feed, raw: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of feed.params) {
    let v = raw[p.name] ?? p.default;
    if (v === undefined || v === "") {
      if (p.required) throw new HttpError(400, "missing_param", `"${p.name}" is required: ${p.doc}`);
      continue;
    }
    v = String(v).trim();
    if (p.type === "address") {
      if (!isAddress(v)) throw new HttpError(400, "bad_param", `"${p.name}" must be a 0x address`);
      v = lower(v);
    } else if (p.type === "symbol") {
      v = v.toUpperCase();
      if (!/^[A-Z0-9./_-]{1,24}$/.test(v)) throw new HttpError(400, "bad_param", `"${p.name}" is not a valid symbol`);
    } else if (p.type === "int") {
      const n = Number(v);
      if (!Number.isInteger(n)) throw new HttpError(400, "bad_param", `"${p.name}" must be a whole number`);
      v = String(Math.min(p.max ?? n, Math.max(p.min ?? n, n)));
    } else if (p.type === "enum") {
      v = v.toLowerCase();
      if (!p.values?.includes(v)) throw new HttpError(400, "bad_param", `"${p.name}" must be one of: ${p.values?.join(", ")}`);
    } else if (v.length > 600) {
      throw new HttpError(400, "bad_param", `"${p.name}" is too long`);
    }
    out[p.name] = v;
  }
  return out;
}

const cacheKey = (feed: string, params: Record<string, string>) => `${feed}?${canonical(params)}`;

function recordHealth(ctx: Ctx, feed: string, a: Attempt) {
  const t = nowSec();
  const hour = Math.floor(t / 3600);
  ctx.db
    .prepare(
      `INSERT INTO source_health (feed, source, ok, fail, last_ok_at, last_fail_at, last_error, ms_sum) VALUES (@feed, @source, @ok, @fail, @okAt, @failAt, @err, @ms)
       ON CONFLICT(feed, source) DO UPDATE SET ok = ok + @ok, fail = fail + @fail, last_ok_at = COALESCE(@okAt, last_ok_at),
         last_fail_at = COALESCE(@failAt, last_fail_at), last_error = CASE WHEN @fail = 1 THEN @err ELSE last_error END, ms_sum = ms_sum + @ms`,
    )
    .run({ feed, source: a.source, ok: a.ok ? 1 : 0, fail: a.ok ? 0 : 1, okAt: a.ok ? t : null, failAt: a.ok ? null : t, err: a.error ?? null, ms: a.ok ? a.ms : 0 });
  ctx.db
    .prepare(
      `INSERT INTO health_hour (feed, source, hour, ok, fail, ms_sum) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(feed, source, hour) DO UPDATE SET ok = ok + excluded.ok, fail = fail + excluded.fail, ms_sum = ms_sum + excluded.ms_sum`,
    )
    .run(feed, a.source, hour, a.ok ? 1 : 0, a.ok ? 0 : 1, a.ok ? a.ms : 0);
}

const clean = (e: unknown) => String((e as Error)?.message ?? e).replace(/https?:\/\/\S+/g, "[url]").slice(0, 200);

function readCache(ctx: Ctx, key: string): Datum | null {
  const mem = ctx.mem.get(key) as Datum | undefined;
  if (mem) return mem;
  const row = ctx.db.prepare("SELECT * FROM cache WHERE key = ?").get(key) as { feed: string; params: string; data: string; source: string; collected_at: number; digest: Hex; signature: Hex } | undefined;
  if (!row) return null;
  const d: Datum = { feed: row.feed, params: JSON.parse(row.params), data: JSON.parse(row.data), source: row.source, collectedAt: row.collected_at, digest: row.digest, signature: row.signature, tried: [], cached: true };
  ctx.mem.set(key, d);
  return d;
}

/** The last collected answer for these parameters, however old, without collecting. */
export const peek = (ctx: Ctx, feed: Feed, raw: Record<string, string | undefined>): Datum | null => readCache(ctx, cacheKey(feed.id, normalizeParams(feed, raw)));

/** Keep a point-in-time copy, at most one per interval per answer, so history can be read back with its signature. */
function archiveDatum(ctx: Ctx, feed: Feed, key: string, d: Datum) {
  if (feed.noArchive || feed.group === "archive" || feed.group === "lab" || feed.group === "answers" || ctx.cfg.archiveDays <= 0) return;
  const every = Math.max(feed.ttl * 4, ctx.cfg.archiveEverySec);
  const last = (ctx.db.prepare("SELECT MAX(at) t FROM archive WHERE key = ?").get(key) as { t: number | null }).t;
  if (last !== null && d.collectedAt - last < every) return;
  ctx.db.prepare("INSERT OR IGNORE INTO archive (feed, key, at, params, data, source, digest, signature) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(feed.id, key, d.collectedAt, JSON.stringify(d.params), JSON.stringify(d.data), d.source, d.digest, d.signature);
}
export const keyOf = (feed: string, params: Record<string, string>) => `${feed}?${canonical(params)}`;

const inflight = new WeakMap<Ctx, Map<string, Promise<Datum>>>();
const histories = new WeakMap<Ctx, History>();

/** Ask every source at once and reconcile. Each attempt is written to the health tables like any other. */
async function askAll(ctx: Ctx, feed: Feed, params: Record<string, string>, tried: Attempt[]): Promise<{ data: unknown; source: string; collectedAt?: number } | null> {
  const rule = feed.agree!;
  const runs = await Promise.all(
    feed.sources.map(async (src) => {
      const t0 = Date.now();
      try {
        const res = await src.run(ctx, params);
        const a: Attempt = { source: src.id, ok: true, ms: Date.now() - t0 };
        tried.push(a);
        recordHealth(ctx, feed.id, a);
        return { source: src.id, data: res.data };
      } catch (e) {
        if (e instanceof HttpError && e.status < 500) throw e;
        const a: Attempt = { source: src.id, ok: false, ms: Date.now() - t0, error: clean(e) };
        tried.push(a);
        recordHealth(ctx, feed.id, a);
        return null;
      }
    }),
  );
  const answers = runs.filter((r): r is { source: string; data: unknown } => r !== null);
  if (!answers.length) return null;
  let hist = histories.get(ctx);
  if (!hist) histories.set(ctx, (hist = new Map()));
  const verdicts = reconcile(answers.map((a) => ({ source: a.source, readings: rule.read(a.data) })), rule, hist);
  const unreachable = feed.sources.map((s) => s.id).filter((id) => !answers.some((a) => a.source === id));
  return rule.merge(answers, verdicts, { toleranceBps: rule.toleranceBps, sourcesKnown: feed.sources.length, sourcesAnswered: answers.length, unreachable });
}

/**
 * Collect one answer. A cached answer no older than maxAge is served from the hot cache; otherwise the feed's sources
 * are tried in order until one answers. Every attempt is written to the health tables. If all fail, it throws.
 */
export async function collect(ctx: Ctx, feed: Feed, params: Record<string, string>, maxAge: number = feed.ttl): Promise<Datum> {
  const key = cacheKey(feed.id, params);
  const hit = readCache(ctx, key);
  if (hit && nowSec() - hit.collectedAt <= maxAge) {
    count(ctx, "cache_hit");
    return { ...hit, tried: [], cached: true };
  }
  let flights = inflight.get(ctx);
  if (!flights) inflight.set(ctx, (flights = new Map()));
  const running = flights.get(key);
  if (running) return running;
  const job = (async (): Promise<Datum> => {
    const tried: Attempt[] = [];
    const finish = async (res: { data: unknown; collectedAt?: number }, source: string): Promise<Datum> => {
      const collectedAt = res.collectedAt ?? nowSec();
      const data = JSON.parse(canonical(res.data)) as unknown;
      const { digest, signature } = await signValue(ctx, { feed: feed.id, params, data, source, collectedAt });
      const d: Datum = { feed: feed.id, params, data, source, collectedAt, digest, signature, tried, cached: false };
      ctx.mem.set(key, d);
      ctx.db
        .prepare("INSERT INTO cache (key, feed, params, data, source, collected_at, digest, signature) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data, source = excluded.source, collected_at = excluded.collected_at, digest = excluded.digest, signature = excluded.signature")
        .run(key, feed.id, JSON.stringify(params), JSON.stringify(data), source, collectedAt, digest, signature);
      archiveDatum(ctx, feed, key, d);
      ctx.db.prepare("INSERT OR IGNORE INTO leaves (digest, hour, feed, at) VALUES (?, ?, ?, ?)").run(digest, Math.floor(collectedAt / 3600), feed.id, collectedAt);
      recordHealth(ctx, feed.id, { source: "*", ok: true, ms: tried.reduce((n, x) => n + x.ms, 0) });
      count(ctx, "collected");
      return d;
    };
    if (feed.agree) {
      let res: Awaited<ReturnType<typeof askAll>>;
      try {
        res = await askAll(ctx, feed, params, tried);
      } catch (e) {
        // The sources answered but do not agree: that is a failed collection, and the caller is told why.
        if (e instanceof HttpError && e.status >= 500) recordHealth(ctx, feed.id, { source: "*", ok: false, ms: 0, error: e.code });
        throw e;
      }
      if (res) return finish(res, res.source);
      recordHealth(ctx, feed.id, { source: "*", ok: false, ms: 0, error: "all sources failed" });
      count(ctx, "collect_failed");
      throw new HttpError(502, "all_sources_failed", `No source could answer ${feed.id} right now.`, { tried });
    }
    for (const src of feed.sources) {
      const t0 = Date.now();
      try {
        const res = await src.run(ctx, params);
        const a: Attempt = { source: src.id, ok: true, ms: Date.now() - t0 };
        tried.push(a);
        recordHealth(ctx, feed.id, a);
        const collectedAt = res.collectedAt ?? nowSec();
        // Round-trip through JSON so the signed bytes are exactly what a client will parse.
        const data = JSON.parse(canonical(res.data)) as unknown;
        const { digest, signature } = await signValue(ctx, { feed: feed.id, params, data, source: src.id, collectedAt });
        const d: Datum = { feed: feed.id, params, data, source: src.id, collectedAt, digest, signature, tried, cached: false };
        ctx.mem.set(key, d);
        ctx.db
          .prepare("INSERT INTO cache (key, feed, params, data, source, collected_at, digest, signature) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data, source = excluded.source, collected_at = excluded.collected_at, digest = excluded.digest, signature = excluded.signature")
          .run(key, feed.id, JSON.stringify(params), JSON.stringify(data), src.id, collectedAt, digest, signature);
        archiveDatum(ctx, feed, key, d);
        ctx.db.prepare("INSERT OR IGNORE INTO leaves (digest, hour, feed, at) VALUES (?, ?, ?, ?)").run(digest, Math.floor(collectedAt / 3600), feed.id, collectedAt);
        recordHealth(ctx, feed.id, { source: "*", ok: true, ms: tried.reduce((n, x) => n + x.ms, 0) });
        count(ctx, "collected");
        return d;
      } catch (e) {
        if (e instanceof HttpError && e.status < 500) throw e; // the request is wrong, not the source
        const a: Attempt = { source: src.id, ok: false, ms: Date.now() - t0, error: clean(e) };
        tried.push(a);
        recordHealth(ctx, feed.id, a);
      }
    }
    recordHealth(ctx, feed.id, { source: "*", ok: false, ms: 0, error: "all sources failed" });
    count(ctx, "collect_failed");
    throw new HttpError(502, "all_sources_failed", `No source could answer ${feed.id} right now.`, { tried });
  })();
  flights.set(key, job);
  try {
    return await job;
  } finally {
    flights.delete(key);
  }
}

export interface HealthRow {
  feed: string;
  source: string;
  ok: number;
  fail: number;
  lastOkAt: number | null;
  lastFailAt: number | null;
  lastError: string | null;
  avgMs: number | null;
  uptime24h: number | null;
  state: "ok" | "degraded" | "down" | "idle";
}

export function health(ctx: Ctx): HealthRow[] {
  const hour = Math.floor(nowSec() / 3600);
  const day = new Map<string, { ok: number; fail: number }>();
  for (const r of ctx.db.prepare("SELECT feed, source, SUM(ok) ok, SUM(fail) fail FROM health_hour WHERE hour > ? GROUP BY feed, source").all(hour - 24) as { feed: string; source: string; ok: number; fail: number }[])
    day.set(`${r.feed}|${r.source}`, r);
  return (ctx.db.prepare("SELECT * FROM source_health WHERE source != '*' ORDER BY feed, source").all() as { feed: string; source: string; ok: number; fail: number; last_ok_at: number | null; last_fail_at: number | null; last_error: string | null; ms_sum: number }[]).map((r) => {
    const d = day.get(`${r.feed}|${r.source}`);
    const n = d ? d.ok + d.fail : 0;
    const uptime = n ? d!.ok / n : null;
    const lastFailed = (r.last_fail_at ?? 0) > (r.last_ok_at ?? 0);
    const state = n === 0 ? "idle" : lastFailed ? (uptime! < 0.5 ? "down" : "degraded") : uptime! < 0.9 ? "degraded" : "ok";
    return { feed: r.feed, source: r.source, ok: r.ok, fail: r.fail, lastOkAt: r.last_ok_at, lastFailAt: r.last_fail_at, lastError: lastFailed ? r.last_error : null, avgMs: r.ok ? Math.round(r.ms_sum / r.ok) : null, uptime24h: uptime, state };
  });
}

/** Uptime of a feed over 24 hours: the share of collections where at least one source answered. */
export function feedUptime(ctx: Ctx, feedId: string): { uptime: number | null; avgMs: number | null; collections: number } {
  const hour = Math.floor(nowSec() / 3600);
  const r = ctx.db.prepare("SELECT SUM(ok) ok, SUM(fail) fail, SUM(ms_sum) ms FROM health_hour WHERE feed = ? AND source = '*' AND hour > ?").get(feedId, hour - 24) as { ok: number | null; fail: number | null; ms: number | null };
  const ok = r.ok ?? 0;
  const n = ok + (r.fail ?? 0);
  return { uptime: n ? ok / n : null, avgMs: ok ? Math.round((r.ms ?? 0) / ok) : null, collections: n };
}
