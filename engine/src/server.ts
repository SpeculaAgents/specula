import { Hono, type Context } from "hono";
import { formatUnits } from "viem";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { encodeHeader } from "../../packages/sdk/src/protocol.ts";
import { FEEDS, feedById, GROUPS } from "./catalog.ts";
import { collect, feedUptime, health, peek, type Feed } from "./collect.ts";
import { USDG_DECIMALS, VERSION } from "./config.ts";
import { count, type Ctx } from "./ctx.ts";
import { buybackRuns, buybackState, buybackTotals } from "./buyback.ts";
import { kvGet } from "./db.ts";
import { addCredit, checkSettleGas, ipKey, LEVELS, network, paymentRequired, readPayment, requirements, settlePayment, shapeReceipt, TIERS, verifyPayment, walletAccount, whoIs, writeReceipt, quote } from "./pay.ts";
import { privateFeedIds, serve, shapeRequest, type RequestRow } from "./serve.ts";
import { indexStats, shapeTrade } from "./chain/views.ts";
import type { TradeRow } from "./chain/indexer.ts";
import type { PricePoint } from "./chain/prices.ts";
import { fromUnits, HttpError, iso, maskAddress, nowSec, toUnits, ZERO } from "./util.ts";

export type Registrar = (app: Hono, ctx: Ctx, h: Helpers) => void;
export interface Helpers {
  caller(c: Context, via?: string): { auth?: string; payment?: string; ip: string; tier?: string; via: string; resource: string };
  metered(c: Context, feed: Feed, params: Record<string, string | undefined>): Promise<Response>;
  wallet(c: Context): Promise<`0x${string}`>;
  cached<T>(key: string, ms: number, make: () => T | Promise<T>): Promise<T>;
  /** A per-caller limit for routes that are free but cost the engine something (a model call, a signature, chain reads). */
  limit(c: Context, route: string, perMinute: number): void;
}

/**
 * The caller's network address. Each trusted proxy in front of the engine appends the address it saw to
 * X-Forwarded-For, so the entry that many places from the right is the one no caller can write themselves.
 */
export function callerIp(forwarded: string | undefined, socket: string | undefined, trustProxy: number): string {
  const hops = (forwarded ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (trustProxy > 0 && hops.length) return hops[Math.max(0, hops.length - trustProxy)];
  return socket || "local";
}

/** Public lists leave private feeds out. */
const isPublicFeed = (f: Feed) => !f.allow;

/** Example parameters with the placeholder address swapped for a token and a wallet that really trade. */
export function exampleOf(ctx: Ctx, feed: Feed): Record<string, string> {
  const out = { ...feed.example };
  if (out.token === ZERO) out.token = (feed.id === "chain.snipers" ? kvGet(ctx.db, "example_launch") : null) ?? kvGet(ctx.db, "example_token") ?? ZERO;
  if (out.address === ZERO) out.address = (feed.id === "chain.deployer" ? kvGet(ctx.db, "example_deployer") : null) ?? kvGet(ctx.db, "example_wallet") ?? ZERO;
  return out;
}

export function catalogEntry(ctx: Ctx, f: Feed) {
  const list = toUnits(f.price, USDG_DECIMALS);
  const up = feedUptime(ctx, f.id);
  const example = exampleOf(ctx, f);
  const qs = new URLSearchParams(example).toString();
  return {
    id: f.id,
    group: f.group,
    groupTitle: GROUPS[f.group],
    title: f.title,
    summary: f.summary,
    params: f.params,
    price: Object.fromEntries(Object.entries(TIERS).map(([k, t]) => [k, { amount: fromUnits((list * BigInt(t.bps)) / 10000n || (list > 0n ? 1n : 0n), USDG_DECIMALS), label: t.label }])),
    asset: "USDG",
    liveForSeconds: f.ttl,
    sources: f.sources.map((s) => s.id),
    /** Set when every source is asked each time and the answer is what they agree on. */
    agree: f.agree ? { toleranceBps: f.agree.toleranceBps } : null,
    stream: f.stream ?? null,
    seller: f.owner ? maskAddress(f.owner) : null,
    uptime24h: up.uptime,
    avgMs: up.avgMs,
    collections24h: up.collections,
    example,
    path: `/v1/feeds/${f.id}${qs ? `?${qs}` : ""}`,
  };
}

export function makeApp(ctx: Ctx, registrars: Registrar[] = []) {
  const app = new Hono();
  app.use("/v1/*", cors({ origin: "*", allowHeaders: ["Authorization", "X-PAYMENT", "Content-Type"], exposeHeaders: ["X-PAYMENT-RESPONSE"], maxAge: 600 }));
  // No request body the engine reads is anywhere near this; a larger one is refused before it is read.
  app.use("/v1/*", bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: "too_large", message: "The request body is larger than 64 KB." }, 413) }));

  const micro = new Map<string, { at: number; v: unknown }>();
  // Anything that changes state drops the short caches, so a write is visible to the very next read.
  app.use("/v1/*", async (c, next) => {
    await next();
    if (c.req.method !== "GET") micro.clear();
  });
  ctx.bus.on("request", () => (micro.delete("market"), micro.delete("demand")));
  const perMinute = new Map<string, { t: number; n: number }>();
  const ipOf = (c: Context) => callerIp(c.req.header("x-forwarded-for"), (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress, ctx.cfg.trustProxy);
  const h: Helpers = {
    limit(c, route, max) {
      const t = Math.floor(Date.now() / 60_000);
      const key = `${route}|${ipKey(ipOf(c))}`;
      const hit = perMinute.get(key);
      if (!hit || hit.t !== t) {
        if (perMinute.size > 50_000) perMinute.clear();
        perMinute.set(key, { t, n: 1 });
        return;
      }
      if (++hit.n > max) throw new HttpError(429, "slow_down", "Too many requests this minute. Try again shortly.", { retryAfter: 60 - (Math.floor(Date.now() / 1000) % 60) });
    },
    caller(c, via) {
      return { auth: c.req.header("authorization"), payment: c.req.header("x-payment"), ip: ipOf(c), tier: c.req.query("fresh") ?? undefined, via: via ?? (c.req.header("x-specula-client") ?? "api").slice(0, 24).replace(/[^a-z0-9._-]/gi, ""), resource: `${ctx.cfg.publicUrl}${new URL(c.req.url).pathname}${new URL(c.req.url).search}` };
    },
    async metered(c, feed, params) {
      const { answer, payerHeader } = await serve(ctx, feed, params, h.caller(c));
      if (payerHeader) c.header("X-PAYMENT-RESPONSE", encodeHeader(JSON.parse(payerHeader)));
      return c.json(answer);
    },
    async wallet(c) {
      const w = await whoIs(c.req.header("authorization"));
      if (!w) throw new HttpError(401, "sign_in", 'Send "Authorization: Specula <address>.<expiry>.<signature>". The SDK does this for you.');
      return w;
    },
    async cached(key, ms, make) {
      const hit = micro.get(key);
      if (hit && Date.now() - hit.at < ms) return hit.v as never;
      const v = await make();
      micro.set(key, { at: Date.now(), v });
      return v;
    },
  };

  app.onError((e, c) => {
    if (e instanceof HttpError) {
      if (e.status === 402) return c.json({ ...e.extra, error: e.code, message: e.code === "payment_required" || e.code === "free_allowance_used" ? "Pay the amount in accepts[0] and send the request again with an X-PAYMENT header." : `The payment was not accepted: ${e.code}. Nothing was charged.` }, 402);
      if (e.extra.retryAfter) c.header("Retry-After", String(e.extra.retryAfter));
      return c.json({ error: e.code, message: e.message, ...e.extra }, e.status as never);
    }
    count(ctx, "errors");
    console.error("[engine]", e);
    return c.json({ error: "internal", message: "Something went wrong on our side. Nothing was charged." }, 500);
  });
  app.notFound((c) => c.json({ error: "not_found", message: "No such route. See /v1 for the map." }, 404));

  app.get("/healthz", (c) => c.text("ok"));
  app.get("/v1", (c) =>
    c.json({
      name: "Specula",
      about: "Data for AI agents, paid per request.",
      version: VERSION,
      engine: ctx.signer.address.toLowerCase(),
      payments: ctx.cfg.payments ? { on: true, network: network(ctx), asset: ctx.cfg.payAsset, payTo: ctx.cfg.payTo, tiers: TIERS, levels: LEVELS, freeDaily: { wallet: ctx.cfg.freeDaily, anonymous: ctx.cfg.freeDailyAnon } } : { on: false },
      routes: { catalog: "/v1/catalog", feed: "/v1/feeds/{id}", status: "/v1/status", stream: "/v1/stream", account: "/v1/account", receipts: "/v1/receipts", signals: "/v1/signals", ask: "/v1/ask", roots: "/v1/roots", indexes: "/v1/indexes" },
    }),
  );

  app.get("/v1/catalog", async (c) => c.json(await h.cached("catalog", 2000, () => ({ count: FEEDS.length, payments: ctx.cfg.payments, asset: "USDG", tiers: TIERS, levels: LEVELS, freeDaily: { wallet: ctx.cfg.freeDaily, anonymous: ctx.cfg.freeDailyAnon }, feeds: FEEDS.filter(isPublicFeed).map((f) => catalogEntry(ctx, f)) }))));

  app.get("/v1/catalog/:id", async (c) => {
    const f = feedById(c.req.param("id"));
    if (!f || f.allow) throw new HttpError(404, "unknown_feed", "No such feed. See /v1/catalog.");
    // The example answer is the engine's own last real answer for the example parameters, kept warm by a job.
    const d = (() => {
      try {
        return peek(ctx, f, exampleOf(ctx, f));
      } catch {
        return null;
      }
    })();
    return c.json({
      ...catalogEntry(ctx, f),
      health: health(ctx).filter((x) => x.feed === f.id),
      exampleAnswer: d ? { feed: f.id, params: d.params, data: d.data, source: d.source, collectedAt: d.collectedAt, collectedAtIso: iso(d.collectedAt), proof: { engine: ctx.signer.address.toLowerCase(), digest: d.digest, signature: d.signature } } : null,
    });
  });

  const feedRoute = async (c: Context) => {
    const f = feedById(c.req.param("id") ?? "");
    if (!f) throw new HttpError(404, "unknown_feed", "No such feed. See /v1/catalog.");
    const body = c.req.method === "POST" ? ((await c.req.json().catch(() => ({}))) as Record<string, string>) : {};
    return h.metered(c, f, { ...c.req.query(), ...Object.fromEntries(Object.entries(body).map(([k, v]) => [k, String(v)])) });
  };
  app.get("/v1/feeds/:id", feedRoute);
  app.post("/v1/feeds/:id", feedRoute);

  /** Recent answered requests, leaving out every feed that is or was private. */
  const recentRequests = (limit: number) => {
    const hidden = [...privateFeedIds(ctx)];
    return ctx.db.prepare(`SELECT * FROM requests WHERE status = 'ok' AND feed NOT IN (${hidden.map(() => "?").join(",")}) ORDER BY at DESC, rowid DESC LIMIT ?`).all(...hidden, limit) as RequestRow[];
  };
  app.get("/v1/requests", (c) => {
    const limit = Math.min(100, Math.max(1, Math.floor(Number(c.req.query("limit") ?? 30)) || 30));
    const rows = recentRequests(limit);
    return c.json({ count: rows.length, requests: rows.map(shapeRequest) });
  });

  const stats = () => {
    const t = nowSec();
    const one = (sql: string, ...a: unknown[]) => ctx.db.prepare(sql).get(...a) as Record<string, number | null>;
    const day = one("SELECT COUNT(*) n, SUM(paid_by != 'free') paid, COUNT(DISTINCT who) callers, AVG(ms) ms FROM requests WHERE status = 'ok' AND at >= ?", t - 86400);
    const paidUnits = (ctx.db.prepare("SELECT price FROM requests WHERE status = 'ok' AND paid_by != 'free'").all() as { price: string }[]).reduce((n, r) => n + BigInt(r.price), 0n);
    const pub = FEEDS.filter(isPublicFeed);
    const ids = new Set(pub.map((f) => f.id));
    const hs = health(ctx).filter((x) => ids.has(x.feed));
    const ups = pub.map((f) => feedUptime(ctx, f.id).uptime).filter((u): u is number => u !== null);
    return {
      feeds: pub.length,
      sources: new Set(pub.flatMap((f) => f.sources.map((s) => s.id))).size,
      sourcesOk: hs.filter((x) => x.state === "ok").length,
      sourcesSeen: hs.filter((x) => x.state !== "idle").length,
      requests24h: day.n ?? 0,
      paid24h: day.paid ?? 0,
      callers24h: day.callers ?? 0,
      avgMs24h: day.ms === null ? null : Math.round(day.ms),
      requestsTotal: one("SELECT COUNT(*) n FROM requests WHERE status = 'ok'").n ?? 0,
      paidAnswers: one("SELECT COUNT(*) n FROM requests WHERE status = 'ok' AND paid_by != 'free'").n ?? 0,
      paidTotal: fromUnits(paidUnits, USDG_DECIMALS),
      answersSigned: one("SELECT COUNT(*) n FROM leaves").n ?? 0,
      uptime24h: ups.length ? ups.reduce((a, b) => a + b, 0) / ups.length : null,
    };
  };

  app.get("/v1/status", async (c) =>
    c.json(
      await h.cached("status", 1500, () => ({
        ok: true,
        version: VERSION,
        now: iso(nowSec()),
        startedAt: new Date(ctx.startedAt).toISOString(),
        engine: ctx.signer.address.toLowerCase(),
        payments: { on: ctx.cfg.payments, network: network(ctx), settles: !!ctx.relayer },
        model: ctx.ai.id,
        stats: stats(),
        index: indexStats(ctx),
        jobs: [...((ctx.mem.get("jobs") as Map<string, { runs: number; fails: number; lastMs: number; lastAt: number; lastError: string | null }> | undefined) ?? new Map())].map(([name, j]) => ({ name, ...j, lastAt: j.lastAt ? iso(j.lastAt) : null })),
        feeds: FEEDS.filter(isPublicFeed).map((f) => ({ id: f.id, title: f.title, group: f.group, ...feedUptime(ctx, f.id), sources: health(ctx).filter((x) => x.feed === f.id) })),
      })),
    ),
  );

  app.get("/v1/site", async (c) =>
    c.json(
      await h.cached("site", 750, async () => {
        const board = await collect(ctx, feedById("chain.prices")!, { kind: "all" }, 30).catch(() => null);
        const trades = ctx.db.prepare("SELECT * FROM trades ORDER BY block DESC, log_index DESC LIMIT 14").all() as TradeRow[];
        const launches = ctx.db.prepare("SELECT address, name, symbol, launch_time FROM tokens WHERE launch_seen = 1 ORDER BY launch_block DESC LIMIT 8").all() as { address: string; name: string; symbol: string; launch_time: number }[];
        const reqs = recentRequests(24);
        return {
          now: iso(nowSec()),
          engine: ctx.signer.address.toLowerCase(),
          payments: ctx.cfg.payments,
          stats: stats(),
          index: indexStats(ctx),
          prices: board ? { collectedAt: board.collectedAt, source: board.source, points: ((board.data as { prices: PricePoint[] }).prices ?? []).map((p) => ({ symbol: p.symbol, kind: p.kind, price: p.price, quote: p.quote, updatedAtSec: p.updatedAtSec, resting: p.resting })) } : null,
          trades: trades.map((t) => shapeTrade(ctx, t)),
          launches: launches.map((l) => ({ token: l.address, name: l.name, symbol: l.symbol, launchedAt: iso(l.launch_time) })),
          requests: reqs.map(shapeRequest),
        };
      }),
    ),
  );

  // ---- account, credits, budgets, receipts
  app.get("/v1/account", async (c) => c.json(walletAccount(ctx, await h.wallet(c))));
  app.post("/v1/budget", async (c) => {
    const w = await h.wallet(c);
    const body = (await c.req.json().catch(() => ({}))) as { daily?: string | null };
    if (body.daily === null || body.daily === undefined || body.daily === "") ctx.db.prepare("DELETE FROM budgets WHERE wallet = ?").run(w);
    else {
      if (!/^\d+(\.\d{1,6})?$/.test(String(body.daily))) throw new HttpError(400, "bad_param", '"daily" is a decimal amount of USDG, for example "2.50".');
      ctx.db.prepare("INSERT INTO budgets (wallet, daily, updated_at) VALUES (?, ?, ?) ON CONFLICT(wallet) DO UPDATE SET daily = excluded.daily, updated_at = excluded.updated_at").run(w, toUnits(String(body.daily), USDG_DECIMALS).toString(), nowSec());
    }
    return c.json(walletAccount(ctx, w));
  });
  app.post("/v1/credits/topup", async (c) => {
    if (!ctx.cfg.payments) throw new HttpError(503, "payments_off", "Payments are not switched on for this engine yet.");
    const amountText = c.req.query("amount") ?? "1";
    if (!/^\d+(\.\d{1,6})?$/.test(amountText)) throw new HttpError(400, "bad_param", '"amount" is a decimal amount of USDG.');
    const amount = toUnits(amountText, USDG_DECIMALS);
    if (amount < toUnits("0.1", USDG_DECIMALS)) throw new HttpError(400, "bad_param", "The smallest top-up is 0.1 USDG.");
    const cl = h.caller(c);
    const req = requirements(ctx, amount, cl.resource, `Prepaid credits, ${amountText} USDG`);
    const p = readPayment(cl.payment);
    if (!p) throw paymentRequired(req);
    const v = await verifyPayment(ctx, p, req);
    if (!v.ok) throw paymentRequired(req, v.reason);
    checkSettleGas(ctx, v.payer);
    const { tx, value: paid } = await settlePayment(ctx, p, req);
    addCredit(ctx, v.payer, paid);
    const receipt = await writeReceipt(ctx, { requestId: null, wallet: v.payer, kind: "topup", amount: paid, tx, feed: null });
    c.header("X-PAYMENT-RESPONSE", encodeHeader({ success: true, transaction: tx, network: req.network, payer: v.payer }));
    return c.json({ ...walletAccount(ctx, v.payer), receipt });
  });
  app.get("/v1/receipts", async (c) => {
    const w = await h.wallet(c);
    const rows = ctx.db.prepare("SELECT * FROM receipts WHERE wallet = ? ORDER BY at DESC, rowid DESC LIMIT 200").all(w) as Parameters<typeof shapeReceipt>[1][];
    return c.json({ count: rows.length, receipts: rows.map((r) => shapeReceipt(ctx, r)) });
  });
  app.get("/v1/receipts/:id", (c) => {
    const r = ctx.db.prepare("SELECT * FROM receipts WHERE id = ?").get(c.req.param("id")) as Parameters<typeof shapeReceipt>[1] | undefined;
    if (!r) throw new HttpError(404, "not_found", "No such receipt.");
    return c.json(shapeReceipt(ctx, r));
  });
  app.get("/v1/quote/:id", async (c) => {
    const f = feedById(c.req.param("id"));
    const w = await whoIs(c.req.header("authorization"));
    // A private feed has no price for anyone not on its list: to them it does not exist.
    if (!f || (f.allow && !(w && (f.allow.includes(w) || w === f.owner)))) throw new HttpError(404, "unknown_feed", "No such feed.");
    return c.json(Object.fromEntries(Object.keys(TIERS).map((t) => {
      const q = quote(ctx, f, t as keyof typeof TIERS, w);
      return [t, { amount: fromUnits(q.amount, USDG_DECIMALS), list: fromUnits(q.list, USDG_DECIMALS), level: q.level }];
    })));
  });

  // ---- live events for the site (server-sent)
  let sseOpen = 0;
  const ssePerIp = new Map<string, number>();
  app.get("/v1/events", (c) => {
    // Each open stream holds a connection and listeners: a cap in all and per caller.
    const ipk = ipKey(ipOf(c));
    if (sseOpen >= 2000 || (ssePerIp.get(ipk) ?? 0) >= 8) throw new HttpError(429, "too_many_streams", "Too many open event streams. Close one and try again.", { retryAfter: 30 });
    sseOpen++;
    ssePerIp.set(ipk, (ssePerIp.get(ipk) ?? 0) + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      sseOpen--;
      const n = (ssePerIp.get(ipk) ?? 1) - 1;
      if (n <= 0) ssePerIp.delete(ipk);
      else ssePerIp.set(ipk, n);
    };
    return streamSSE(c, async (stream) => {
      count(ctx, "sse_open");
      const send = (event: string) => (data: unknown) => void stream.writeSSE({ event, data: JSON.stringify(data) }).catch(() => {});
      const on: [string, (d: unknown) => void][] = [
        ["request", send("request")],
        ["prices", (pts) => send("prices")((pts as PricePoint[]).map((p) => ({ symbol: p.symbol, kind: p.kind, price: p.price, quote: p.quote, updatedAtSec: p.updatedAtSec, resting: p.resting })))],
        ["trade", (t) => send("trade")(shapeTrade(ctx, t as TradeRow))],
        ["launch", send("launch")],
        ["signal", send("signal")],
      ];
      for (const [e, fn] of on) ctx.bus.on(e, fn);
      let open = true;
      stream.onAbort(() => {
        open = false;
        release();
      });
      try {
        await stream.writeSSE({ event: "hello", data: JSON.stringify({ now: nowSec() }) });
        while (open) {
          await stream.sleep(20_000);
          if (open) await stream.writeSSE({ event: "ping", data: String(nowSec()) }).catch(() => (open = false));
        }
      } finally {
        for (const [e, fn] of on) ctx.bus.off(e, fn);
        release();
      }
    });
  });

  /** The latest daily briefing as the engine holds it, for the site. Agents buy the same text from answers.briefing. */
  app.get("/v1/briefing", (c) => {
    const row = ctx.db.prepare("SELECT body FROM briefings ORDER BY day DESC LIMIT 1").get() as { body: string } | undefined;
    return c.json(row ? JSON.parse(row.body) : { day: null, at: null, sections: [] });
  });

  /** The buyback wallet's runs, its next run for the countdown, and the totals. */
  const buybackView = (ctx: Ctx) => {
    const st = buybackState(ctx);
    const tot = buybackTotals(ctx);
    return {
      on: st.on, wallet: st.wallet, splitter: st.splitter, everyMin: st.everyMin,
      lastAt: st.lastAt ? new Date(st.lastAt).toISOString() : null, nextAt: st.nextAt ? new Date(st.nextAt).toISOString() : null,
      runs: tot.runs, ethSpent: formatUnits(tot.ethIn, 18), burned: formatUnits(tot.burned, 18),
      recent: buybackRuns(ctx, 50).map((r) => ({ time: iso(r.at), eth: formatUnits(BigInt(r.eth_in), 18), burned: formatUnits(BigInt(r.bought), 18), buyTx: r.buy_tx, burnTx: r.burn_tx, via: r.via })),
    };
  };

  /** Burns of the project's own token, read from the chain index. Nothing is shown until the token exists. */
  app.get("/v1/token", (c) => {
    const token = ctx.cfg.token?.toLowerCase();
    if (!token) return c.json({ live: false, burns: [], totalBurned: null, buyback: buybackView(ctx) });
    const rows = ctx.db.prepare("SELECT amount, tx, time FROM burns WHERE token = ? ORDER BY block DESC, log_index DESC LIMIT 100").all(token) as { amount: string; tx: string; time: number }[];
    const total = (ctx.db.prepare("SELECT burned FROM holder_progress WHERE token = ?").get(token) as { burned: string } | undefined)?.burned ?? "0";
    if (!ctx.db.prepare("SELECT 1 FROM holder_progress WHERE token = ?").get(token)) ctx.db.prepare("INSERT OR IGNORE INTO holder_progress (token, from_block, last_block) SELECT ?, launch_block, launch_block - 1 FROM tokens WHERE address = ? AND launch_seen = 1").run(token, token);
    return c.json({ live: true, burns: rows.map((r) => ({ amount: formatUnits(BigInt(r.amount), 18), tx: r.tx, time: iso(r.time) })), totalBurned: formatUnits(BigInt(total), 18), buyback: buybackView(ctx) });
  });

  app.get("/v1/metrics", (c) => {
    const lines = [...ctx.counters].map(([k, v]) => `specula_${k} ${v}`);
    const ix = indexStats(ctx);
    lines.push(`specula_index_behind_blocks ${ix.behindBlocks ?? 0}`, `specula_uptime_seconds ${Math.round((Date.now() - ctx.startedAt) / 1000)}`);
    return c.text(lines.join("\n") + "\n");
  });

  for (const r of registrars) r(app, ctx, h);
  return app;
}

