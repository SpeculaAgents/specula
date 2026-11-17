import type { Hono } from "hono";
import { USDG_DECIMALS } from "./config.ts";
import type { Ctx } from "./ctx.ts";
import { spent } from "./pay.ts";
import { FEEDS } from "./registry.ts";
import type { Helpers } from "./server.ts";
import { cleanName } from "./chain/indexer.ts";
import { fromUnits, HttpError, id, isAddress, iso, lower, nowSec, toUnits } from "./util.ts";

/**
 * Teams: one owner, many agent wallets, one shared daily budget and one report. A wallet belongs to at most one team.
 * The team budget is checked together with the wallet's own budget before anything is charged. The owner invites a
 * wallet; it joins only when that wallet accepts with its own signature, and it can leave whenever it wants.
 */
const dayStart = () => nowSec() - (nowSec() % 86400);
interface TeamRow { id: string; owner: string; name: string; daily: string | null; created_at: number }

export function teamOf(ctx: Ctx, wallet: string): TeamRow | null {
  return (ctx.db.prepare("SELECT t.* FROM teams t JOIN team_members m ON m.team = t.id WHERE m.wallet = ?").get(wallet) as TeamRow | undefined) ?? null;
}
const invites = (ctx: Ctx, team: string) => (ctx.db.prepare("SELECT wallet, at FROM team_invites WHERE team = ? ORDER BY at").all(team) as { wallet: string; at: number }[]);
const members = (ctx: Ctx, team: string) => (ctx.db.prepare("SELECT wallet, role, added_at FROM team_members WHERE team = ? ORDER BY added_at").all(team) as { wallet: string; role: string; added_at: number }[]);

/** Refuse a charge that would take the team past its shared daily budget. Called before anything is taken. */
export function checkTeamBudget(ctx: Ctx, wallet: string, amount: bigint) {
  const t = teamOf(ctx, wallet);
  if (!t?.daily) return;
  const used = members(ctx, t.id).reduce((n, m) => n + spent(ctx, m.wallet, dayStart()), 0n);
  if (used + amount > BigInt(t.daily))
    throw new HttpError(403, "team_budget_reached", "The team's shared daily budget would be passed by this call. Nothing was charged.", { team: { name: t.name, daily: fromUnits(t.daily, USDG_DECIMALS), spentToday: fromUnits(used, USDG_DECIMALS) } });
}

function report(ctx: Ctx, t: TeamRow) {
  const ms = members(ctx, t.id);
  const since = nowSec() - 30 * 86400;
  const per = ms.map((m) => {
    const calls = ctx.db.prepare("SELECT COUNT(*) n FROM requests WHERE wallet = ? AND status = 'ok' AND at >= ?").get(m.wallet, since) as { n: number };
    const top = ctx.db.prepare("SELECT feed, COUNT(*) n FROM requests WHERE wallet = ? AND status = 'ok' AND at >= ? GROUP BY feed ORDER BY n DESC LIMIT 1").get(m.wallet, since) as { feed: string; n: number } | undefined;
    return { wallet: m.wallet, role: m.role, addedAt: iso(m.added_at), spentToday: fromUnits(spent(ctx, m.wallet, dayStart()), USDG_DECIMALS), spent30d: fromUnits(spent(ctx, m.wallet, since), USDG_DECIMALS), calls30d: calls.n, mostUsedFeed: top?.feed ?? null };
  });
  const today = ms.reduce((n, m) => n + spent(ctx, m.wallet, dayStart()), 0n);
  return { id: t.id, name: t.name, owner: t.owner, budget: t.daily ? { daily: fromUnits(t.daily, USDG_DECIMALS), spentToday: fromUnits(today, USDG_DECIMALS), left: fromUnits(BigInt(t.daily) > today ? BigInt(t.daily) - today : 0n, USDG_DECIMALS) } : null, spent30d: fromUnits(ms.reduce((n, m) => n + spent(ctx, m.wallet, since), 0n), USDG_DECIMALS), members: per, invited: invites(ctx, t.id).map((i) => ({ wallet: i.wallet, invitedAt: iso(i.at) })), createdAt: iso(t.created_at), feeds: FEEDS.filter((f) => !f.allow).length };
}

export function registerTeams(app: Hono, ctx: Ctx, h: Helpers) {
  const owned = async (c: Parameters<Helpers["wallet"]>[0]) => {
    const w = await h.wallet(c);
    const t = ctx.db.prepare("SELECT * FROM teams WHERE id = ?").get(c.req.param("id")) as TeamRow | undefined;
    if (!t || t.owner !== w) throw new HttpError(404, "not_found", "No such team of yours.");
    return t;
  };
  app.post("/v1/teams", async (c) => {
    const w = await h.wallet(c);
    const b = (await c.req.json().catch(() => ({}))) as { name?: string; daily?: string | null };
    const name = cleanName(b.name, 40);
    if (name.length < 2) throw new HttpError(400, "bad_param", "Give the team a name.");
    if (b.daily != null && !/^\d+(\.\d{1,6})?$/.test(String(b.daily))) throw new HttpError(400, "bad_param", '"daily" is a decimal amount of USDG.');
    if (teamOf(ctx, w)) throw new HttpError(409, "in_a_team", "This wallet is already in a team.");
    const tid = id("team");
    ctx.db.transaction(() => {
      ctx.db.prepare("INSERT INTO teams (id, owner, name, daily, created_at) VALUES (?, ?, ?, ?, ?)").run(tid, w, name, b.daily != null ? toUnits(String(b.daily), USDG_DECIMALS).toString() : null, nowSec());
      ctx.db.prepare("INSERT INTO team_members (team, wallet, role, added_at) VALUES (?, ?, 'owner', ?)").run(tid, w, nowSec());
    })();
    return c.json(report(ctx, ctx.db.prepare("SELECT * FROM teams WHERE id = ?").get(tid) as TeamRow), 201);
  });
  /** The team a wallet is in, with the report. Any member can read it; only the owner can change it. */
  app.get("/v1/teams/mine", async (c) => {
    const w = await h.wallet(c);
    const t = teamOf(ctx, w);
    if (!t) {
      const open = ctx.db.prepare("SELECT t.id, t.name FROM team_invites i JOIN teams t ON t.id = i.team WHERE i.wallet = ? ORDER BY i.at").all(w) as { id: string; name: string }[];
      throw new HttpError(404, "no_team", "This wallet is not in a team.", { invites: open.map((x) => ({ team: x.id, name: x.name, accept: `POST /v1/teams/${x.id}/members with {"wallet": "${w}"}` })) });
    }
    return c.json(report(ctx, t));
  });
  /**
   * The owner sends { wallet } to invite it. The invited wallet sends { wallet: <itself> } to accept. Until it
   * accepts, the team's budget does not apply to it and the owner sees nothing of its spending.
   */
  app.post("/v1/teams/:id/members", async (c) => {
    const w = await h.wallet(c);
    const t = ctx.db.prepare("SELECT * FROM teams WHERE id = ?").get(c.req.param("id")) as TeamRow | undefined;
    const b = (await c.req.json().catch(() => ({}))) as { wallet?: string };
    if (t && t.owner !== w && isAddress(b.wallet) && lower(b.wallet) === w) {
      if (!ctx.db.prepare("SELECT 1 FROM team_invites WHERE team = ? AND wallet = ?").get(t.id, w)) throw new HttpError(404, "not_found", "No invite to this team for this wallet.");
      if (teamOf(ctx, w)) throw new HttpError(409, "in_a_team", "This wallet is already in a team. Leave it first.");
      if (members(ctx, t.id).length >= 100) throw new HttpError(409, "too_many", "A team holds 100 wallets.");
      ctx.db.transaction(() => {
        ctx.db.prepare("INSERT INTO team_members (team, wallet, role, added_at) VALUES (?, ?, 'member', ?)").run(t.id, w, nowSec());
        ctx.db.prepare("DELETE FROM team_invites WHERE wallet = ?").run(w);
      })();
      return c.json(report(ctx, t), 201);
    }
    if (!t || t.owner !== w) throw new HttpError(404, "not_found", "No such team of yours.");
    if (!isAddress(b.wallet)) throw new HttpError(400, "bad_param", '"wallet" is a 0x address.');
    const to = lower(b.wallet);
    if (teamOf(ctx, to)) throw new HttpError(409, "in_a_team", "That wallet is already in a team.");
    if (members(ctx, t.id).length + invites(ctx, t.id).length >= 100) throw new HttpError(409, "too_many", "A team holds 100 wallets.");
    if (!ctx.db.prepare("INSERT OR IGNORE INTO team_invites (team, wallet, at) VALUES (?, ?, ?)").run(t.id, to, nowSec()).changes) throw new HttpError(409, "invited", "That wallet is already invited.");
    return c.json(report(ctx, t), 201);
  });
  /** The owner removes a member or takes back an invite; a member removes itself to leave. */
  app.delete("/v1/teams/:id/members/:wallet", async (c) => {
    const me = await h.wallet(c);
    const t = ctx.db.prepare("SELECT * FROM teams WHERE id = ?").get(c.req.param("id")) as TeamRow | undefined;
    const w = lower(c.req.param("wallet"));
    if (!t || (t.owner !== me && w !== me)) throw new HttpError(404, "not_found", "No such team of yours.");
    if (w === t.owner) throw new HttpError(400, "bad_param", "The owner cannot be removed.");
    const gone = ctx.db.prepare("DELETE FROM team_members WHERE team = ? AND wallet = ?").run(t.id, w).changes + ctx.db.prepare("DELETE FROM team_invites WHERE team = ? AND wallet = ?").run(t.id, w).changes;
    if (!gone) throw new HttpError(404, "not_found", "That wallet is not in the team.");
    return c.json(t.owner === me ? report(ctx, t) : { left: true });
  });
  app.post("/v1/teams/:id/budget", async (c) => {
    const t = await owned(c);
    const b = (await c.req.json().catch(() => ({}))) as { daily?: string | null };
    if (b.daily != null && !/^\d+(\.\d{1,6})?$/.test(String(b.daily))) throw new HttpError(400, "bad_param", '"daily" is a decimal amount of USDG, or null for no limit.');
    ctx.db.prepare("UPDATE teams SET daily = ? WHERE id = ?").run(b.daily != null ? toUnits(String(b.daily), USDG_DECIMALS).toString() : null, t.id);
    return c.json(report(ctx, ctx.db.prepare("SELECT * FROM teams WHERE id = ?").get(t.id) as TeamRow));
  });

  /** The public data index: which data agents ask for most, from the engine's own request log. */
  app.get("/v1/demand", async (c) =>
    c.json(
      await h.cached("demand", 3000, () => {
        const t = nowSec();
        const rows = ctx.db.prepare("SELECT feed, COUNT(*) calls, SUM(paid_by != 'free') paid, COUNT(DISTINCT who) callers, SUM(at >= ?) day FROM requests WHERE status = 'ok' AND at >= ? AND feed NOT LIKE 'stream.%' GROUP BY feed ORDER BY calls DESC").all(t - 86400, t - 7 * 86400) as { feed: string; calls: number; paid: number; callers: number; day: number }[];
        const pub = rows.filter((r) => FEEDS.some((f) => f.id === r.feed && !f.allow));
        const total = pub.reduce((n, r) => n + r.calls, 0);
        return { window: "7 days", calls: total, feedsAsked: pub.length, feeds: pub.map((r, i) => ({ rank: i + 1, feed: r.feed, title: FEEDS.find((f) => f.id === r.feed)!.title, calls7d: r.calls, calls24h: r.day, paidCalls7d: r.paid, callers7d: r.callers, shareBps: total ? Math.round((r.calls * 10000) / total) : 0 })) };
      }),
    ),
  );
}
