import type { Hono } from "hono";
import { keyOf, normalizeParams, type Source } from "./collect.ts";
import type { Ctx } from "./ctx.ts";
import { feedById } from "./registry.ts";
import type { Helpers } from "./server.ts";
import { privateFeedIds } from "./serve.ts";
import { HttpError, iso, nowSec } from "./util.ts";

/**
 * The point-in-time archive. The engine keeps a copy of answers as they were collected, each with its original
 * signature, so an agent can ask "what did this feed say at that moment" and check the reply like any live answer.
 */
interface Row {
  feed: string;
  at: number;
  params: string;
  data: string;
  source: string;
  digest: string;
  signature: string;
}
const shape = (ctx: Ctx, r: Row) => ({ feed: r.feed, params: JSON.parse(r.params), data: JSON.parse(r.data), source: r.source, collectedAt: r.at, collectedAtIso: iso(r.at), proof: { engine: ctx.signer.address.toLowerCase(), digest: r.digest, signature: r.signature } });

/** "symbol=NVDA&limit=5" into the same normalised parameters the live feed would use. */
function target(p: Record<string, string>) {
  const feed = feedById(p.feed);
  if (!feed || feed.group === "archive" || feed.allow) throw new HttpError(404, "unknown_feed", "No such feed to look back on.");
  const raw = Object.fromEntries(new URLSearchParams(p.params ?? ""));
  return { feed, key: keyOf(feed.id, normalizeParams(feed, raw)) };
}
const when = (v: string | undefined, fallback: number) => {
  if (v === undefined) return fallback;
  const t = /^\d+$/.test(v) ? Number(v) : Math.floor(Date.parse(v) / 1000);
  if (!Number.isFinite(t)) throw new HttpError(400, "bad_param", "A time is unix seconds or an ISO date like 2026-11-16T21:00:00Z.");
  return t;
};

export const archiveSources: { at: Source; range: Source } = {
  at: {
    id: "archive",
    async run(ctx, p) {
      const { feed, key } = target(p);
      const t = when(p.at, nowSec());
      const row = ctx.db.prepare("SELECT * FROM archive WHERE key = ? AND at <= ? ORDER BY at DESC LIMIT 1").get(key, t) as Row | undefined;
      if (!row) throw new HttpError(404, "not_archived", `The archive holds no answer of ${feed.id} for these parameters at or before that time.`);
      return { data: { asked: iso(t), ageAtThatTime: t - row.at, answer: shape(ctx, row) } };
    },
  },
  range: {
    id: "archive",
    async run(ctx, p) {
      const { feed, key } = target(p);
      const to = when(p.to, nowSec());
      const from = when(p.from, to - 86400);
      const rows = ctx.db.prepare("SELECT * FROM archive WHERE key = ? AND at BETWEEN ? AND ? ORDER BY at LIMIT ?").all(key, from, to, Number(p.limit ?? 24)) as Row[];
      return { data: { feed: feed.id, from: iso(from), to: iso(to), count: rows.length, answers: rows.map((r) => shape(ctx, r)) } };
    },
  },
};

export function pruneArchive(ctx: Ctx) {
  return ctx.db.prepare("DELETE FROM archive WHERE at < ?").run(nowSec() - ctx.cfg.archiveDays * 86400).changes;
}

export function registerArchive(app: Hono, ctx: Ctx, h: Helpers) {
  /** What the archive holds, per feed. Free to look at. */
  app.get("/v1/archive", async (c) =>
    c.json(
      await h.cached("archive", 5000, () => {
        const rows = ctx.db.prepare("SELECT feed, COUNT(*) n, MIN(at) first, MAX(at) last, COUNT(DISTINCT key) series FROM archive GROUP BY feed ORDER BY n DESC").all() as { feed: string; n: number; first: number; last: number; series: number }[];
        // A feed that is or ever was private stays out, listed or taken down.
        const hidden = privateFeedIds(ctx);
        const pub = rows.filter((r) => !hidden.has(r.feed) && !feedById(r.feed)?.allow);
        return { keepsDays: ctx.cfg.archiveDays, answers: pub.reduce((n, r) => n + r.n, 0), feeds: pub.map((r) => ({ feed: r.feed, answers: r.n, series: r.series, from: iso(r.first), to: iso(r.last) })) };
      }),
    ),
  );
}
