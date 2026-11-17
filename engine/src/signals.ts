import type { Hono } from "hono";
import { feedById } from "./registry.ts";
import { collect, type Source } from "./collect.ts";
import type { Ctx } from "./ctx.ts";
import { kvGet, kvSet } from "./db.ts";
import type { Helpers } from "./server.ts";
import type { TradeRow } from "./chain/indexer.ts";
import { PRICE_FEEDS, type PricePoint } from "./chain/prices.ts";
import { priceOf, usdOf } from "./chain/views.ts";
import { HttpError, id, isAddress, iso, lower, maskAddress, nowSec } from "./util.ts";

/** A signal rule. Small, closed shapes: every rule can be checked against data the engine already holds. */
export type Rule =
  | { kind: "price_move"; symbol: string; direction: "up" | "down" | "any"; bps: number; windowMin: number }
  | { kind: "price_cross"; symbol: string; direction: "above" | "below"; level: string }
  | { kind: "whale_trade"; token?: string; side: "buy" | "sell" | "any"; minUsd: number }
  | { kind: "launch" }
  | { kind: "sniped_launch"; minBuys: number }
  | { kind: "graduation" }
  | { kind: "burn"; token: string }
  | { kind: "concentration"; token: string; top10Bps: number }
  | { kind: "filing"; ticker: string; form?: string }
  | { kind: "insider"; ticker: string; side: "buy" | "sell" | "any" };

const symbols = new Set(PRICE_FEEDS.map((f) => f.symbol));
const int = (v: unknown, min: number, max: number) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

/** Accept only a rule that is fully formed. Whatever a model or a caller sends is rebuilt field by field. */
export function validRule(r: unknown): Rule | null {
  const v = buildRule(r);
  return v ? (JSON.parse(JSON.stringify(v)) as Rule) : null; // drops fields left undefined
}
function buildRule(r: unknown): Rule | null {
  const x = r as Record<string, unknown> | null;
  if (!x || typeof x !== "object") return null;
  const sym = typeof x.symbol === "string" ? x.symbol.toUpperCase() : "";
  const tick = typeof x.ticker === "string" && /^[A-Za-z.-]{1,6}$/.test(x.ticker) ? x.ticker.toUpperCase() : "";
  const tok = isAddress(x.token) ? lower(x.token) : undefined;
  const side = (v: unknown) => (v === "buy" || v === "sell" ? v : "any");
  switch (x.kind) {
    case "price_move":
      return symbols.has(sym) && int(x.bps, 1, 10000) && int(x.windowMin, 1, 10080) ? { kind: "price_move", symbol: sym, direction: x.direction === "up" || x.direction === "down" ? x.direction : "any", bps: x.bps as number, windowMin: x.windowMin as number } : null;
    case "price_cross":
      return symbols.has(sym) && /^\d+(\.\d+)?$/.test(String(x.level)) ? { kind: "price_cross", symbol: sym, direction: x.direction === "below" ? "below" : "above", level: String(x.level) } : null;
    case "whale_trade":
      return int(x.minUsd, 1, 1e9) ? { kind: "whale_trade", token: tok, side: side(x.side), minUsd: x.minUsd as number } : null;
    case "launch":
      return { kind: "launch" };
    case "sniped_launch":
      return int(x.minBuys, 2, 1000) ? { kind: "sniped_launch", minBuys: x.minBuys as number } : null;
    case "graduation":
      return { kind: "graduation" };
    case "burn":
      return tok ? { kind: "burn", token: tok } : null;
    case "concentration":
      return tok && int(x.top10Bps, 1, 10000) ? { kind: "concentration", token: tok, top10Bps: x.top10Bps as number } : null;
    case "filing":
      return tick ? { kind: "filing", ticker: tick, form: typeof x.form === "string" && /^[0-9A-Za-z/ -]{1,10}$/.test(x.form) ? x.form.toUpperCase() : undefined } : null;
    case "insider":
      return tick ? { kind: "insider", ticker: tick, side: side(x.side) } : null;
    default:
      return null;
  }
}

export function describe(r: Rule): string {
  const pct = (b: number) => `${(b / 100).toFixed(b % 100 ? 2 : 0)}%`;
  switch (r.kind) {
    case "price_move":
      return `${r.symbol} ${r.direction === "any" ? "moves" : r.direction === "up" ? "rises" : "falls"} ${pct(r.bps)} or more within ${r.windowMin >= 60 && r.windowMin % 60 === 0 ? `${r.windowMin / 60} h` : `${r.windowMin} min`}`;
    case "price_cross":
      return `${r.symbol} crosses ${r.direction} ${r.level}`;
    case "whale_trade":
      return `A ${r.side === "any" ? "trade" : r.side} of $${r.minUsd.toLocaleString("en-US")} or more${r.token ? ` in ${maskAddress(r.token)}` : " on the DEX"}`;
    case "launch":
      return "A new token launches";
    case "sniped_launch":
      return `A launch gets ${r.minBuys} or more buys in its first 10 seconds`;
    case "graduation":
      return "A token graduates from its curve to a pool";
    case "burn":
      return `${maskAddress(r.token)} is burned`;
    case "concentration":
      return `The top 10 holders of ${maskAddress(r.token)} hold ${pct(r.top10Bps)} or more`;
    case "filing":
      return `${r.ticker} files ${r.form ? `a ${r.form}` : "anything"} with the SEC`;
    case "insider":
      return `An insider ${r.side === "any" ? "trades" : r.side === "buy" ? "buys" : "sells"} ${r.ticker} on the open market`;
  }
}

const MOVERS = ["NVDA", "TSLA", "AAPL", "MSFT", "AMZN", "META", "GOOGL", "AMD", "PLTR", "COIN", "MSTR", "SPY", "QQQ", "ETH", "BTC"];
const WATCH = ["NVDA", "TSLA", "AAPL", "MSFT", "AMZN", "META", "GOOGL", "COIN"];
export const BUILTIN: { id: string; rule: Rule }[] = [
  ...MOVERS.map((s) => ({ id: `move-${s.toLowerCase()}`, rule: { kind: "price_move", symbol: s, direction: "any", bps: 200, windowMin: 60 } as Rule })),
  { id: "whale-5k", rule: { kind: "whale_trade", side: "any", minUsd: 5000 } },
  { id: "whale-buy-25k", rule: { kind: "whale_trade", side: "buy", minUsd: 25000 } },
  { id: "launch", rule: { kind: "launch" } },
  { id: "sniped-launch", rule: { kind: "sniped_launch", minBuys: 5 } },
  { id: "graduation", rule: { kind: "graduation" } },
  ...WATCH.map((t) => ({ id: `8k-${t.toLowerCase()}`, rule: { kind: "filing", ticker: t, form: "8-K" } as Rule })),
  { id: "insider-nvda", rule: { kind: "insider", ticker: "NVDA", side: "any" } },
  { id: "insider-tsla", rule: { kind: "insider", ticker: "TSLA", side: "any" } },
];

interface RuleRow {
  id: string;
  owner: string | null;
  name: string;
  text: string | null;
  rule: string;
  builtin: number;
  created_at: number;
  active: number;
}
const rulesOf = (ctx: Ctx, kind?: Rule["kind"]) =>
  (ctx.db.prepare("SELECT * FROM signal_rules WHERE active = 1").all() as RuleRow[]).map((r) => ({ row: r, rule: JSON.parse(r.rule) as Rule })).filter((x) => !kind || x.rule.kind === kind);

export function seedSignals(ctx: Ctx) {
  const ins = ctx.db.prepare("INSERT INTO signal_rules (id, owner, name, text, rule, builtin, created_at) VALUES (?, NULL, ?, NULL, ?, 1, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, rule = excluded.rule");
  for (const b of BUILTIN) ins.run(b.id, describe(b.rule), JSON.stringify(b.rule), nowSec());
}

const lastPrice = (ctx: Ctx, symbol: string, atOrBefore?: number) =>
  (atOrBefore === undefined
    ? ctx.db.prepare("SELECT answer, time FROM price_ticks WHERE symbol = ? ORDER BY time DESC LIMIT 1").get(symbol)
    : ctx.db.prepare("SELECT answer, time FROM price_ticks WHERE symbol = ? AND time <= ? ORDER BY time DESC LIMIT 1").get(symbol, atOrBefore)) as { answer: string; time: number } | undefined;
const tokenPrice = (ctx: Ctx, token: string) => {
  const t = ctx.db.prepare("SELECT quote, amount FROM trades WHERE token = ? ORDER BY block DESC, log_index DESC LIMIT 1").get(token) as { quote: string; amount: string } | undefined;
  return t && BigInt(t.amount) > 0n ? ((BigInt(t.quote) * 10n ** 18n) / BigInt(t.amount)).toString() : null;
};
const dec = (feedSymbol: string) => PRICE_FEEDS.find((f) => f.symbol === feedSymbol)?.decimals ?? 8;
const fmt = (raw: string, d: number) => {
  const s = raw.padStart(d + 1, "0");
  return `${s.slice(0, -d)}.${s.slice(-d).slice(0, 2)}`;
};

/** Record a fire once (the dedupe key decides) and tell the streams. What to measure an hour later goes with it. */
export function fire(ctx: Ctx, ruleId: string, subject: string, detail: Record<string, unknown>, opts: { dedupe: string; track?: { kind: "symbol" | "token"; key: string; dir?: "up" | "down" } }) {
  const fid = id("sig");
  const t = nowSec();
  const ref = opts.track ? (opts.track.kind === "symbol" ? lastPrice(ctx, opts.track.key)?.answer ?? null : tokenPrice(ctx, opts.track.key)) : null;
  const full = { ...detail, track: opts.track ?? null };
  const r = ctx.db.prepare("INSERT OR IGNORE INTO signal_fires (id, rule_id, at, subject, detail, ref_value, check_at, dedupe) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(fid, ruleId, t, subject, JSON.stringify(full), ref, ref ? t + 3600 : null, `${ruleId}|${opts.dedupe}`);
  if (!r.changes) return null;
  const row = ctx.db.prepare("SELECT name FROM signal_rules WHERE id = ?").get(ruleId) as { name: string } | undefined;
  const out = { id: fid, rule: ruleId, name: row?.name ?? ruleId, at: iso(t), subject, detail };
  ctx.bus.emit("signal", out);
  return out;
}

/** Wire the rules to the engine's own event bus. Everything here reads data the engine already collected. */
export function watchSignals(ctx: Ctx) {
  ctx.bus.on("prices", (pts: PricePoint[]) => {
    const t = nowSec();
    const moves = rulesOf(ctx, "price_move");
    const crosses = rulesOf(ctx, "price_cross");
    for (const p of pts) {
      if (p.resting) continue;
      const now = BigInt(p.raw);
      for (const { row, rule } of moves) {
        if (rule.kind !== "price_move" || rule.symbol !== p.symbol) continue;
        const ref = lastPrice(ctx, p.symbol, t - rule.windowMin * 60) ?? (ctx.db.prepare("SELECT answer, time FROM price_ticks WHERE symbol = ? AND time >= ? ORDER BY time LIMIT 1").get(p.symbol, t - rule.windowMin * 60) as { answer: string; time: number } | undefined);
        if (!ref || t - ref.time > rule.windowMin * 60 * 3) continue; // no reading near the start of the window (a rested market reopening is not a move)
        const was = BigInt(ref.answer);
        if (was <= 0n) continue;
        const move = Number(((now - was) * 10000n) / was);
        const hit = rule.direction === "up" ? move >= rule.bps : rule.direction === "down" ? -move >= rule.bps : Math.abs(move) >= rule.bps;
        if (hit) fire(ctx, row.id, p.symbol, { symbol: p.symbol, moveBps: move, from: fmt(ref.answer, p.decimals), to: p.price, windowMin: rule.windowMin }, { dedupe: `${Math.floor(t / (rule.windowMin * 60))}`, track: { kind: "symbol", key: p.symbol, dir: move >= 0 ? "up" : "down" } });
      }
      for (const { row, rule } of crosses) {
        if (rule.kind !== "price_cross" || rule.symbol !== p.symbol) continue;
        const prev = ctx.db.prepare("SELECT answer FROM price_ticks WHERE symbol = ? ORDER BY time DESC LIMIT 1 OFFSET 1").get(p.symbol) as { answer: string } | undefined;
        if (!prev) continue;
        const [i, f = ""] = rule.level.split(".");
        const level = BigInt(i + f.padEnd(p.decimals, "0").slice(0, p.decimals));
        const was = BigInt(prev.answer);
        const crossed = rule.direction === "above" ? was < level && now >= level : was > level && now <= level;
        if (crossed) fire(ctx, row.id, p.symbol, { symbol: p.symbol, level: rule.level, price: p.price }, { dedupe: `${p.roundId}`, track: { kind: "symbol", key: p.symbol, dir: rule.direction === "above" ? "up" : "down" } });
      }
    }
  });
  ctx.bus.on("trade", (t: TradeRow) => {
    const usd = usdOf(ctx, t.quote_asset, BigInt(t.quote));
    if (usd === null) return;
    const dollars = Number(usd.split(".")[0]);
    for (const { row, rule } of rulesOf(ctx, "whale_trade")) {
      if (rule.kind !== "whale_trade" || dollars < rule.minUsd) continue;
      if (rule.side !== "any" && rule.side !== t.side) continue;
      if (rule.token && rule.token !== t.token) continue;
      const sym = (ctx.db.prepare("SELECT symbol FROM assets WHERE address = ?").get(t.token) as { symbol: string | null } | undefined)?.symbol ?? null;
      fire(ctx, row.id, sym ?? t.token, { token: t.token, symbol: sym, side: t.side, valueUsd: usd, trader: t.trader, price: priceOf(BigInt(t.quote), BigInt(t.amount), 18, 18), tx: t.tx, venue: t.venue }, { dedupe: `${t.block}:${t.log_index}`, track: { kind: "token", key: t.token, dir: t.side === "buy" ? "up" : "down" } });
    }
  });
  const tokenInfo = (token: string) => ctx.db.prepare("SELECT name, symbol, deployer FROM tokens WHERE address = ?").get(token) as { name: string; symbol: string; deployer: string } | undefined;
  ctx.bus.on("launch", (l: { token: string; tx: string }) => {
    const k = tokenInfo(l.token);
    for (const { row } of rulesOf(ctx, "launch")) fire(ctx, row.id, k?.symbol || l.token, { token: l.token, name: k?.name ?? null, symbol: k?.symbol ?? null, deployer: k?.deployer ?? null, tx: l.tx }, { dedupe: l.token });
  });
  ctx.bus.on("graduation", (g: { token: string; tx: string }) => {
    const k = tokenInfo(g.token);
    for (const { row } of rulesOf(ctx, "graduation")) fire(ctx, row.id, k?.symbol || g.token, { token: g.token, symbol: k?.symbol ?? null, tx: g.tx }, { dedupe: g.token, track: { kind: "token", key: g.token, dir: "up" } });
  });
}

/** Rules that need a look rather than an event: fast-bought launches, burns, concentration, new filings. */
export async function pollSignals(ctx: Ctx, what: "chain" | "filings") {
  const t = nowSec();
  if (what === "chain") {
    for (const { row, rule } of rulesOf(ctx, "sniped_launch")) {
      if (rule.kind !== "sniped_launch") continue;
      const rows = ctx.db.prepare("SELECT k.address, k.symbol, COUNT(*) n FROM tokens k JOIN trades t ON t.token = k.address WHERE k.launch_seen = 1 AND k.launch_time BETWEEN ? AND ? AND t.side = 'buy' AND t.time - k.launch_time <= 10 GROUP BY k.address HAVING n >= ?").all(t - 1800, t - 12, rule.minBuys) as { address: string; symbol: string; n: number }[];
      for (const r of rows) fire(ctx, row.id, r.symbol || r.address, { token: r.address, symbol: r.symbol, buysInFirst10s: r.n }, { dedupe: r.address, track: { kind: "token", key: r.address, dir: "up" } });
    }
    for (const { row, rule } of rulesOf(ctx, "burn")) {
      if (rule.kind !== "burn") continue;
      const since = Number(kvGet(ctx.db, `sig:${row.id}`) ?? t);
      for (const b of ctx.db.prepare("SELECT * FROM burns WHERE token = ? AND time > ? ORDER BY block").all(rule.token, since) as { amount: string; tx: string; block: number; log_index: number }[]) fire(ctx, row.id, rule.token, { token: rule.token, amountUnits: b.amount, tx: b.tx }, { dedupe: `${b.block}:${b.log_index}` });
      kvSet(ctx.db, `sig:${row.id}`, String(t));
    }
    for (const { row, rule } of rulesOf(ctx, "concentration")) {
      if (rule.kind !== "concentration") continue;
      const d = await collect(ctx, feedById("chain.holders")!, { token: rule.token, limit: "1" }, 300).catch(() => null);
      const top = (d?.data as { concentration?: { top10Bps: number } } | undefined)?.concentration?.top10Bps;
      if (top !== undefined && top >= rule.top10Bps) fire(ctx, row.id, rule.token, { token: rule.token, top10Bps: top }, { dedupe: `${Math.floor(t / 86400)}` });
    }
    return;
  }
  for (const { row, rule } of [...rulesOf(ctx, "filing"), ...rulesOf(ctx, "insider")]) {
    try {
      if (rule.kind === "filing") {
        const d = await collect(ctx, feedById("sec.filings")!, { ticker: rule.ticker, ...(rule.form ? { form: rule.form } : {}), limit: "5" }, 540);
        const list = (d.data as { filings: { accession: string; form: string; filedAt: string; url: string; items: string[] }[] }).filings;
        const seenKey = `sig:${row.id}`;
        const seen = kvGet(ctx.db, seenKey);
        if (seen !== null) for (const f of list) {
          if (f.accession === seen) break;
          fire(ctx, row.id, rule.ticker, { ticker: rule.ticker, form: f.form, filedAt: f.filedAt, items: f.items, url: f.url, accession: f.accession }, { dedupe: f.accession, track: symbols.has(rule.ticker) ? { kind: "symbol", key: rule.ticker } : undefined });
        }
        if (list[0]) kvSet(ctx.db, seenKey, list[0].accession);
        else if (seen === null) kvSet(ctx.db, seenKey, "");
      } else if (rule.kind === "insider") {
        const d = await collect(ctx, feedById("sec.insiders")!, { ticker: rule.ticker, limit: "3" }, 3500);
        const txs = (d.data as { transactions: { accession: string; side: string; owner: string; role: string; shares: string | null; value: string | null; derivative: boolean; date: string | null }[] }).transactions.filter((x) => !x.derivative && x.side !== "other" && (rule.side === "any" || rule.side === x.side));
        const seenKey = `sig:${row.id}`;
        const seen = new Set((kvGet(ctx.db, seenKey) ?? "").split(",").filter(Boolean));
        const first = kvGet(ctx.db, seenKey) === null;
        for (const x of txs) {
          if (!first && !seen.has(x.accession)) fire(ctx, row.id, rule.ticker, { ticker: rule.ticker, side: x.side, owner: x.owner, role: x.role, shares: x.shares, valueUsd: x.value, date: x.date, accession: x.accession }, { dedupe: `${x.accession}:${x.side}:${x.shares}`, track: symbols.has(rule.ticker) ? { kind: "symbol", key: rule.ticker, dir: x.side === "buy" ? "up" : "down" } : undefined });
          seen.add(x.accession);
        }
        kvSet(ctx.db, seenKey, [...seen].slice(-40).join(","));
      }
    } catch {
      /* the source's health is already recorded by collect; the next round tries again */
    }
  }
}

/** One hour after a fire, measure what the price did. This is the public track record: outcomes, not opinions. */
export function settleOutcomes(ctx: Ctx) {
  const due = ctx.db.prepare("SELECT id, detail, ref_value FROM signal_fires WHERE outcome IS NULL AND check_at IS NOT NULL AND check_at <= ?").all(nowSec()) as { id: string; detail: string; ref_value: string }[];
  for (const f of due) {
    const track = (JSON.parse(f.detail) as { track: { kind: "symbol" | "token"; key: string; dir?: "up" | "down" } | null }).track;
    const now = track ? (track.kind === "symbol" ? lastPrice(ctx, track.key)?.answer ?? null : tokenPrice(ctx, track.key)) : null;
    const ref = BigInt(f.ref_value);
    if (!now || ref <= 0n) {
      ctx.db.prepare("UPDATE signal_fires SET outcome = 'unknown' WHERE id = ?").run(f.id);
      continue;
    }
    const move = Number(((BigInt(now) - ref) * 10000n) / ref);
    const outcome = move === 0 ? "flat" : move > 0 ? "up" : "down";
    ctx.db.prepare("UPDATE signal_fires SET outcome = ?, outcome_value = ? WHERE id = ?").run(outcome, String(move), f.id);
  }
  return due.length;
}

export function trackRecord(ctx: Ctx, ruleId: string) {
  const rows = ctx.db.prepare("SELECT detail, outcome, outcome_value FROM signal_fires WHERE rule_id = ?").all(ruleId) as { detail: string; outcome: string | null; outcome_value: string | null }[];
  const measured = rows.filter((r) => r.outcome && r.outcome !== "unknown" && r.outcome_value !== null);
  const moves = measured.map((r) => Number(r.outcome_value));
  let withDir = 0;
  let followed = 0;
  for (const r of measured) {
    const dir = (JSON.parse(r.detail) as { track: { dir?: string } | null }).track?.dir;
    if (!dir) continue;
    withDir++;
    if (r.outcome === dir) followed++;
  }
  const sorted = [...moves].sort((a, b) => a - b);
  return {
    fires: rows.length,
    measured: measured.length,
    pending: rows.filter((r) => !r.outcome).length,
    after1h: measured.length ? { averageMoveBps: Math.round(moves.reduce((a, b) => a + b, 0) / moves.length), medianMoveBps: sorted[Math.floor(sorted.length / 2)], upShare: measured.filter((r) => r.outcome === "up").length / measured.length, followedThroughShare: withDir ? followed / withDir : null } : null,
  };
}

const shapeRule = (ctx: Ctx, r: RuleRow, withRecord = true) => ({ id: r.id, name: r.name, text: r.text, rule: JSON.parse(r.rule) as Rule, builtin: !!r.builtin, owner: r.owner ? maskAddress(r.owner) : null, createdAt: iso(r.created_at), ...(withRecord ? { record: trackRecord(ctx, r.id) } : {}) });
const shapeFire = (f: { id: string; rule_id: string; at: number; subject: string; detail: string; outcome: string | null; outcome_value: string | null; name?: string }) => {
  const { track, ...detail } = JSON.parse(f.detail) as Record<string, unknown>;
  void track;
  return { id: f.id, rule: f.rule_id, name: f.name ?? f.rule_id, at: iso(f.at), subject: f.subject, detail, after1h: f.outcome ? { outcome: f.outcome, moveBps: f.outcome_value === null ? null : Number(f.outcome_value) } : null };
};
const recentFires = (ctx: Ctx, limit: number, rule?: string) =>
  ((rule
    ? ctx.db.prepare("SELECT f.*, r.name FROM signal_fires f LEFT JOIN signal_rules r ON r.id = f.rule_id WHERE f.rule_id = ? ORDER BY f.at DESC, f.rowid DESC LIMIT ?").all(rule, limit)
    : ctx.db.prepare("SELECT f.*, r.name FROM signal_fires f LEFT JOIN signal_rules r ON r.id = f.rule_id ORDER BY f.at DESC, f.rowid DESC LIMIT ?").all(limit)) as Parameters<typeof shapeFire>[0][]).map(shapeFire);

export const signalSources: { recent: Source; record: Source } = {
  recent: { id: "signals", run: async (ctx, p) => ({ data: { fires: recentFires(ctx, Number(p.limit ?? 20), p.rule) } }) },
  record: {
    id: "signals",
    async run(ctx) {
      const rules = (ctx.db.prepare("SELECT * FROM signal_rules WHERE active = 1 AND builtin = 1 ORDER BY rowid").all() as RuleRow[]).map((r) => shapeRule(ctx, r));
      return { data: { rules: rules.length, fires: rules.reduce((n, r) => n + r.record!.fires, 0), record: rules.map((r) => ({ id: r.id, name: r.name, ...r.record! })) } };
    },
  },
};

export function registerSignals(app: Hono, ctx: Ctx, h: Helpers) {
  /** Public: the built-in rules with their track record, and the latest fires. */
  app.get("/v1/signals", async (c) =>
    c.json(
      await h.cached("signals", 2000, () => {
        const rules = (ctx.db.prepare("SELECT * FROM signal_rules WHERE active = 1 AND builtin = 1 ORDER BY rowid").all() as RuleRow[]).map((r) => shapeRule(ctx, r));
        const total = ctx.db.prepare("SELECT COUNT(*) n, SUM(outcome IS NOT NULL AND outcome != 'unknown') m FROM signal_fires").get() as { n: number; m: number | null };
        return { rules, custom: (ctx.db.prepare("SELECT COUNT(*) n FROM signal_rules WHERE builtin = 0 AND active = 1").get() as { n: number }).n, fires: total.n, measured: total.m ?? 0, recent: recentFires(ctx, 30) };
      }),
    ),
  );
  app.get("/v1/signals/mine", async (c) => {
    const w = await h.wallet(c);
    return c.json({ rules: (ctx.db.prepare("SELECT * FROM signal_rules WHERE owner = ? AND active = 1 ORDER BY created_at DESC").all(w) as RuleRow[]).map((r) => shapeRule(ctx, r)) });
  });
  /** Try a sentence without saving it: what rule would it become? Open to anyone, so the site can show it. */
  app.post("/v1/signals/parse", async (c) => {
    // Free to try, but each try may be a model call: a few a minute per caller.
    h.limit(c, "parse", 20);
    const body = (await c.req.json().catch(() => ({}))) as { text?: string };
    const text = String(body.text ?? "").slice(0, 300);
    if (text.length < 4) throw new HttpError(400, "bad_param", "Say what to watch for, in a sentence.");
    const rule = validRule(await ctx.ai.parseRule(text));
    return c.json({ text, understood: !!rule, rule, reads: rule ? describe(rule) : null, model: ctx.ai.id });
  });
  app.post("/v1/signals", async (c) => {
    h.limit(c, "parse", 20);
    const w = await h.wallet(c);
    const body = (await c.req.json().catch(() => ({}))) as { text?: string; rule?: unknown };
    const text = body.text ? String(body.text).slice(0, 300) : null;
    const rule = validRule(body.rule ?? (text ? await ctx.ai.parseRule(text) : null));
    if (!rule) throw new HttpError(422, "not_understood", "That could not be turned into a rule. Try a sentence like: tell me when NVDA falls 3% in an hour.");
    const mine = (ctx.db.prepare("SELECT COUNT(*) n FROM signal_rules WHERE owner = ? AND active = 1").get(w) as { n: number }).n;
    if (mine >= 25) throw new HttpError(409, "too_many", "A wallet can keep 25 rules. Delete one first.");
    const rid = id("rule");
    ctx.db.prepare("INSERT INTO signal_rules (id, owner, name, text, rule, builtin, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)").run(rid, w, describe(rule), text, JSON.stringify(rule), nowSec());
    return c.json(shapeRule(ctx, ctx.db.prepare("SELECT * FROM signal_rules WHERE id = ?").get(rid) as RuleRow), 201);
  });
  app.delete("/v1/signals/:id", async (c) => {
    const w = await h.wallet(c);
    const r = ctx.db.prepare("UPDATE signal_rules SET active = 0 WHERE id = ? AND owner = ? AND builtin = 0").run(c.req.param("id"), w);
    if (!r.changes) throw new HttpError(404, "not_found", "No such rule of yours.");
    return c.json({ deleted: true });
  });
}
