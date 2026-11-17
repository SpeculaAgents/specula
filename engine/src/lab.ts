import type { Hono } from "hono";
import type { Source } from "./collect.ts";
import type { Ctx } from "./ctx.ts";
import type { Helpers } from "./server.ts";
import { PRICE_FEEDS, type PricePoint } from "./chain/prices.ts";
import { HttpError, id, iso, nowSec } from "./util.ts";

/**
 * The strategy lab. A strategy is small and closed: one symbol, an entry (the price moved this much in this window),
 * a side, a size, and exits (time, take, stop). The same step function runs a backtest over recorded prices and a
 * paper run on live ones, so what was tested is exactly what runs. No money moves, ever. Dollar math is in cents.
 */
export interface Strategy {
  symbol: string;
  direction: "up" | "down";
  bps: number;
  windowMin: number;
  side: "long" | "short";
  sizeUsd: number;
  holdMin: number;
  takeBps: number | null;
  stopBps: number | null;
}
export interface Tick {
  t: number;
  p: bigint;
}
export interface Position {
  at: number;
  price: string;
}
export interface Trade {
  openedAt: string;
  closedAt: string;
  entry: string;
  exit: string;
  moveBps: number;
  pnlCents: number;
  why: "take" | "stop" | "time";
}
export interface State {
  position: Position | null;
  trades: Trade[];
  window: [number, string][];
}

const symbols = new Map(PRICE_FEEDS.map((f) => [f.symbol, f]));
const int = (v: string | undefined, min: number, max: number, name: string, fallback?: number) => {
  if (v === undefined || v === "") {
    if (fallback !== undefined) return fallback;
    throw new HttpError(400, "missing_param", `"${name}" is required.`);
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, "bad_param", `"${name}" is a whole number from ${min} to ${max}.`);
  return n;
};
export function parseStrategy(p: Record<string, string | undefined>): Strategy {
  const symbol = String(p.symbol ?? "").toUpperCase();
  if (!symbols.has(symbol)) throw new HttpError(404, "unknown_symbol", `No on-chain price feed for "${p.symbol ?? ""}".`);
  const direction = p.direction === "down" ? "down" : "up";
  return { symbol, direction, bps: int(p.bps, 1, 5000, "bps"), windowMin: int(p.windowMin, 1, 1440, "windowMin", 60), side: p.side === "short" ? "short" : p.side === "long" || !p.side ? "long" : "long", sizeUsd: int(p.sizeUsd, 1, 1_000_000, "sizeUsd", 1000), holdMin: int(p.holdMin, 1, 10080, "holdMin", 60), takeBps: p.takeBps ? int(p.takeBps, 1, 10000, "takeBps") : null, stopBps: p.stopBps ? int(p.stopBps, 1, 10000, "stopBps") : null };
}
const dec = (raw: bigint | string, d: number) => {
  const s = BigInt(raw).toString().padStart(d + 1, "0");
  return `${s.slice(0, -d)}.${s.slice(-d).replace(/0+$/, "").padEnd(2, "0")}`;
};

/** One tick through a strategy. Pure: the state that comes out depends only on the state and tick that went in. */
export function step(s: Strategy, st: State, tick: Tick, decimals = 8): State {
  const window = [...st.window.filter(([t]) => t >= tick.t - s.windowMin * 60 * 2), [tick.t, tick.p.toString()] as [number, string]].slice(-600);
  if (st.position) {
    const entry = BigInt(st.position.price);
    const raw = Number(((tick.p - entry) * 10000n) / entry);
    const move = s.side === "long" ? raw : -raw;
    const why = s.takeBps !== null && move >= s.takeBps ? "take" : s.stopBps !== null && -move >= s.stopBps ? "stop" : tick.t - st.position.at >= s.holdMin * 60 ? "time" : null;
    if (!why) return { ...st, window };
    // Profit in cents: size times the price change over the entry price, signed by the side, rounded toward zero.
    const diff = s.side === "long" ? tick.p - entry : entry - tick.p;
    const pnl = Number((BigInt(s.sizeUsd) * 100n * diff) / entry);
    return { position: null, window, trades: [...st.trades, { openedAt: iso(st.position.at), closedAt: iso(tick.t), entry: dec(entry, decimals), exit: dec(tick.p, decimals), moveBps: move, pnlCents: pnl, why }] };
  }
  // Flat: has the price moved enough since the reading at the start of the window?
  const startT = tick.t - s.windowMin * 60;
  const ref = [...window].reverse().find(([t]) => t <= startT) ?? null;
  if (!ref || startT - ref[0] > s.windowMin * 60) return { ...st, window };
  const was = BigInt(ref[1]);
  if (was <= 0n) return { ...st, window };
  const moved = Number(((tick.p - was) * 10000n) / was);
  const hit = s.direction === "up" ? moved >= s.bps : -moved >= s.bps;
  return hit ? { ...st, window, position: { at: tick.t, price: tick.p.toString() } } : { ...st, window };
}

export function summarize(s: Strategy, st: State, ticks: number, from: number | null, to: number | null) {
  const pnl = st.trades.reduce((n, t) => n + t.pnlCents, 0);
  let peak = 0;
  let run = 0;
  let dd = 0;
  for (const t of st.trades) {
    run += t.pnlCents;
    peak = Math.max(peak, run);
    dd = Math.max(dd, peak - run);
  }
  const cents = (c: number) => `${c < 0 ? "-" : ""}${Math.floor(Math.abs(c) / 100)}.${String(Math.abs(c) % 100).padStart(2, "0")}`;
  const wins = st.trades.filter((t) => t.pnlCents > 0).length;
  return {
    strategy: s,
    reads: `${s.side === "long" ? "Buy" : "Short"} $${s.sizeUsd.toLocaleString("en-US")} of ${s.symbol} when it ${s.direction === "up" ? "rises" : "falls"} ${(s.bps / 100).toFixed(2)}% within ${s.windowMin} min; close after ${s.holdMin} min${s.takeBps ? `, or at +${(s.takeBps / 100).toFixed(2)}%` : ""}${s.stopBps ? `, or at -${(s.stopBps / 100).toFixed(2)}%` : ""}.`,
    pricesRead: ticks,
    from: from ? iso(from) : null,
    to: to ? iso(to) : null,
    trades: st.trades.length,
    wins,
    winShare: st.trades.length ? wins / st.trades.length : null,
    pnlUsd: cents(pnl),
    maxDrawdownUsd: cents(dd),
    open: st.position ? { since: iso(st.position.at), entry: dec(st.position.price, 8) } : null,
    lastTrades: st.trades.slice(-20).reverse().map((t) => ({ ...t, pnlUsd: cents(t.pnlCents) })),
    note: "A test over recorded prices with no fees, no slippage and instant fills. It describes the past and is not advice.",
  };
}

export function backtest(s: Strategy, ticks: Tick[]) {
  let st: State = { position: null, trades: [], window: [] };
  for (const t of ticks) st = step(s, st, t);
  return summarize(s, st, ticks.length, ticks[0]?.t ?? null, ticks[ticks.length - 1]?.t ?? null);
}

const ticksOf = (ctx: Ctx, symbol: string, from: number, to: number): Tick[] =>
  (ctx.db.prepare("SELECT time, answer FROM price_ticks WHERE symbol = ? AND time BETWEEN ? AND ? ORDER BY time").all(symbol, from, to) as { time: number; answer: string }[]).map((r) => ({ t: r.time, p: BigInt(r.answer) }));

export const backtestSource: Source = {
  id: "engine",
  async run(ctx, p) {
    const s = parseStrategy(p);
    const to = nowSec();
    const days = int(p.days, 1, 365, "days", 30);
    const ticks = ticksOf(ctx, s.symbol, to - days * 86400, to);
    if (ticks.length < 2) throw new HttpError(409, "no_history", `The engine has recorded fewer than two prices of ${s.symbol} in that window. History grows from the day the engine started.`);
    return { data: backtest(s, ticks) };
  },
};

interface RunRow {
  id: string;
  owner: string;
  strategy: string;
  state: string;
  created_at: number;
  active: number;
}
const shapeRun = (r: RunRow) => {
  const s = JSON.parse(r.strategy) as Strategy;
  const st = JSON.parse(r.state) as State & { ticks?: number };
  return { id: r.id, startedAt: iso(r.created_at), ...summarize(s, st, st.ticks ?? 0, r.created_at, null) };
};

/** Live prices move every paper run of that symbol one step. Positions are pretend; the prices are real. */
export function watchPaper(ctx: Ctx) {
  ctx.bus.on("prices", (pts: PricePoint[]) => {
    const t = nowSec();
    for (const p of pts) {
      if (p.resting) continue;
      const runs = ctx.db.prepare("SELECT * FROM paper_runs WHERE active = 1 AND json_extract(strategy, '$.symbol') = ?").all(p.symbol) as RunRow[];
      for (const r of runs) {
        const st = JSON.parse(r.state) as State & { ticks?: number };
        const next = step(JSON.parse(r.strategy) as Strategy, st, { t, p: BigInt(p.raw) });
        ctx.db.prepare("UPDATE paper_runs SET state = ? WHERE id = ?").run(JSON.stringify({ ...next, trades: next.trades.slice(-200), ticks: (st.ticks ?? 0) + 1 }), r.id);
      }
    }
  });
}

export function registerLab(app: Hono, ctx: Ctx, h: Helpers) {
  app.get("/v1/lab", async (c) => c.json(await h.cached("lab", 5000, () => {
    const hist = ctx.db.prepare("SELECT COUNT(*) n, COUNT(DISTINCT symbol) symbols, MIN(time) first FROM price_ticks").get() as { n: number; symbols: number; first: number | null };
    return { pricesRecorded: hist.n, symbols: hist.symbols, since: hist.first ? iso(hist.first) : null, paperRuns: (ctx.db.prepare("SELECT COUNT(*) n FROM paper_runs WHERE active = 1").get() as { n: number }).n };
  })));
  app.get("/v1/lab/paper", async (c) => {
    const w = await h.wallet(c);
    return c.json({ runs: (ctx.db.prepare("SELECT * FROM paper_runs WHERE owner = ? AND active = 1 ORDER BY created_at DESC").all(w) as RunRow[]).map(shapeRun) });
  });
  app.post("/v1/lab/paper", async (c) => {
    const w = await h.wallet(c);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const s = parseStrategy(Object.fromEntries(Object.entries(body).map(([k, v]) => [k, v === null || v === undefined ? undefined : String(v)])));
    if ((ctx.db.prepare("SELECT COUNT(*) n FROM paper_runs WHERE owner = ? AND active = 1").get(w) as { n: number }).n >= 10) throw new HttpError(409, "too_many", "A wallet can keep 10 paper runs. Stop one first.");
    const rid = id("paper");
    ctx.db.prepare("INSERT INTO paper_runs (id, owner, strategy, state, created_at) VALUES (?, ?, ?, ?, ?)").run(rid, w, JSON.stringify(s), JSON.stringify({ position: null, trades: [], window: [], ticks: 0 }), nowSec());
    return c.json(shapeRun(ctx.db.prepare("SELECT * FROM paper_runs WHERE id = ?").get(rid) as RunRow), 201);
  });
  app.delete("/v1/lab/paper/:id", async (c) => {
    const w = await h.wallet(c);
    if (!ctx.db.prepare("UPDATE paper_runs SET active = 0 WHERE id = ? AND owner = ?").run(c.req.param("id"), w).changes) throw new HttpError(404, "not_found", "No such paper run of yours.");
    return c.json({ stopped: true });
  });
}
