import type { Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { USDG_DECIMALS } from "./config.ts";
import { count, type Ctx } from "./ctx.ts";
import { addCredit, allowance, creditOf, ipKey, whoIs, writeReceipt } from "./pay.ts";
import { callerIp } from "./server.ts";
import { shapeTrade } from "./chain/views.ts";
import type { TradeRow } from "./chain/indexer.ts";
import { fromUnits, id, nowSec, toUnits } from "./util.ts";

/** Channels a client can subscribe to. "requests" and "status" are open; the data channels are metered by the minute. */
export const CHANNELS: Record<string, { event: string; paid: boolean; pricePerMinute: string; about: string }> = {
  requests: { event: "request", paid: false, pricePerMinute: "0", about: "Every request the engine serves, as it happens." },
  prices: { event: "prices", paid: true, pricePerMinute: "0.0005", about: "Price feed rounds as they change." },
  trades: { event: "trade", paid: true, pricePerMinute: "0.0005", about: "DEX trades as they are indexed." },
  launches: { event: "launch", paid: true, pricePerMinute: "0.0005", about: "New token launches." },
  signals: { event: "signal", paid: true, pricePerMinute: "0.0005", about: "Signals as they fire." },
};

interface Client {
  ws: WebSocket;
  wallet: string | null;
  who: string;
  ip: string;
  subs: Map<string, number>; // channel -> paid until (sec)
}

/** One minute of a channel: free while the daily allowance lasts, then from prepaid credits. */
async function payMinute(ctx: Ctx, c: Client, channel: string): Promise<{ ok: true; paidBy: string } | { ok: false; reason: string }> {
  const ch = CHANNELS[channel];
  const price = toUnits(ch.pricePerMinute, USDG_DECIMALS);
  let paidBy = "free";
  if (ch.paid && ctx.cfg.payments) {
    const a = allowance(ctx, c.who, !!c.wallet, c.ip);
    if (a.used >= a.limit) {
      if (!c.wallet || creditOf(ctx, c.wallet) < price) return { ok: false, reason: c.wallet ? "free_allowance_used_and_no_credits" : "free_allowance_used" };
      addCredit(ctx, c.wallet, -price);
      await writeReceipt(ctx, { requestId: null, wallet: c.wallet, kind: "credit_spend", amount: price, tx: null, feed: `stream.${channel}` });
      paidBy = "credits";
    }
  }
  if (ch.paid)
    ctx.db.prepare("INSERT INTO requests (id, at, feed, params, wallet, who, ip, tier, price, paid_by, status, ms, via) VALUES (?, ?, ?, '{}', ?, ?, ?, 'live', ?, ?, 'ok', 0, 'stream')").run(id("req"), nowSec(), `stream.${channel}`, c.wallet, c.who, c.ip, paidBy === "credits" ? price.toString() : "0", paidBy);
  return { ok: true, paidBy };
}

export function attachStreams(ctx: Ctx, server: Server) {
  // Messages are a few hundred bytes; anything far larger is refused by the socket itself.
  const wss = new WebSocketServer({ server, path: "/v1/stream", maxPayload: 4096 });
  const perIp = new Map<string, number>();
  const clients = new Set<Client>();
  const send = (c: Client, msg: unknown) => c.ws.readyState === 1 && c.ws.send(JSON.stringify(msg));

  const fan = (channel: string, shape: (d: unknown) => unknown) => (d: unknown) => {
    let body: unknown;
    for (const c of clients) if (c.subs.has(channel)) send(c, { op: "event", channel, data: (body ??= shape(d)), at: nowSec() });
  };
  const listeners: [string, (d: unknown) => void][] = [
    ["request", fan("requests", (d) => d)],
    ["prices", fan("prices", (d) => d)],
    ["trade", fan("trades", (d) => shapeTrade(ctx, d as TradeRow))],
    ["launch", fan("launches", (d) => d)],
    ["signal", fan("signals", (d) => d)],
  ];
  for (const [e, fn] of listeners) ctx.bus.on(e, fn);

  wss.on("connection", async (ws, req) => {
    const url = new URL(req.url ?? "/", "http://x");
    const ip = ipKey(callerIp(req.headers["x-forwarded-for"] as string | undefined, req.socket.remoteAddress, ctx.cfg.trustProxy));
    if (clients.size >= 5000 || (perIp.get(ip) ?? 0) >= 16) return void ws.close(1013, "too many connections");
    perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
    const token = url.searchParams.get("auth");
    const wallet = token ? await whoIs(`Specula ${token}`) : null;
    const c: Client = { ws, wallet, who: wallet ?? ip, ip, subs: new Map() };
    clients.add(c);
    count(ctx, "ws_open");
    send(c, { op: "hello", wallet, channels: Object.fromEntries(Object.entries(CHANNELS).map(([k, v]) => [k, { paid: v.paid, pricePerMinute: v.pricePerMinute, about: v.about }])), asset: "USDG" });
    ws.on("message", async (raw) => {
      let m: { op?: string; channels?: string[]; token?: string };
      try {
        m = JSON.parse(String(raw).slice(0, 2000));
      } catch {
        return send(c, { op: "error", error: "bad_json" });
      }
      if (m.op === "auth" && m.token) {
        const w = await whoIs(`Specula ${m.token}`);
        if (w) {
          c.wallet = w;
          c.who = w;
        }
        return send(c, { op: "auth", wallet: c.wallet });
      }
      if (m.op === "subscribe")
        for (const ch of (m.channels ?? []).slice(0, 10)) {
          if (!CHANNELS[ch]) {
            send(c, { op: "error", error: "unknown_channel", channel: ch });
            continue;
          }
          if (c.subs.has(ch)) continue;
          const r = await payMinute(ctx, c, ch);
          if (!r.ok) send(c, { op: "paused", channel: ch, reason: r.reason, topUp: "/v1/credits/topup" });
          else {
            c.subs.set(ch, nowSec() + 60);
            send(c, { op: "subscribed", channel: ch, paidBy: r.paidBy, pricePerMinute: CHANNELS[ch].pricePerMinute });
          }
        }
      if (m.op === "unsubscribe") for (const ch of m.channels ?? []) c.subs.delete(ch) && send(c, { op: "unsubscribed", channel: ch });
      if (m.op === "ping") send(c, { op: "pong", at: nowSec() });
    });
    let gone = false;
    const leave = () => {
      clients.delete(c);
      if (gone) return;
      gone = true;
      const n = (perIp.get(ip) ?? 1) - 1;
      if (n <= 0) perIp.delete(ip);
      else perIp.set(ip, n);
    };
    ws.on("close", leave);
    ws.on("error", leave);
  });

  // Each subscription is renewed minute by minute; one that cannot pay is paused, with a word on why.
  const timer = setInterval(async () => {
    const t = nowSec();
    for (const c of clients)
      for (const [ch, until] of c.subs) {
        if (until > t) continue;
        const r = await payMinute(ctx, c, ch).catch(() => ({ ok: false as const, reason: "error" }));
        if (r.ok) c.subs.set(ch, t + 60);
        else {
          c.subs.delete(ch);
          send(c, { op: "paused", channel: ch, reason: r.reason, topUp: "/v1/credits/topup", credits: c.wallet ? fromUnits(creditOf(ctx, c.wallet), USDG_DECIMALS) : null });
        }
      }
  }, 5000);
  timer.unref();
  return {
    clients: () => clients.size,
    close: () => {
      clearInterval(timer);
      for (const [e, fn] of listeners) ctx.bus.off(e, fn);
      for (const c of clients) c.ws.terminate();
      wss.close();
    },
  };
}
