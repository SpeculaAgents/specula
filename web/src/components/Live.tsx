"use client";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { Fire, PriceCell, Req, SiteData, Trade } from "@/lib/types";

interface LiveState {
  site: SiteData | null;
  /** Symbols whose price changed in the last moment, for the flash. */
  hits: Record<string, number>;
  fires: Fire[];
  connected: boolean;
  now: number;
}
const Ctx = createContext<LiveState>({ site: null, hits: {}, fires: [], connected: false, now: 0 });
export const useLive = () => useContext(Ctx);

/** Holds what the engine says right now: refetched on a slow poll and patched by the event stream in between. */
export function Live({ initial, children }: { initial: SiteData | null; children: ReactNode }) {
  const [site, setSite] = useState<SiteData | null>(initial);
  const [hits, setHits] = useState<Record<string, number>>({});
  const [fires, setFires] = useState<Fire[]>([]);
  const [connected, setConnected] = useState(false);
  const [now, setNow] = useState(() => (initial ? Date.parse(initial.now) : 0));
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    const load = async () => {
      try {
        const res = await fetch("/api/v1/site", { cache: "no-store" });
        if (res.ok && alive.current) setSite((await res.json()) as SiteData);
      } catch {
        /* the next poll tries again */
      }
    };
    const poll = setInterval(load, 12_000);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    const first = setTimeout(load, 0);
    const es = new EventSource("/api/v1/events");
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.addEventListener("prices", (e) => {
      const pts = JSON.parse((e as MessageEvent).data) as PriceCell[];
      const t = Date.now();
      setSite((s) => (s?.prices ? { ...s, prices: { ...s.prices, points: s.prices.points.map((p) => pts.find((x) => x.symbol === p.symbol) ?? p) } } : s));
      setHits((h) => ({ ...h, ...Object.fromEntries(pts.map((p) => [p.symbol, t])) }));
    });
    es.addEventListener("request", (e) => {
      const r = JSON.parse((e as MessageEvent).data) as Req;
      setSite((s) => (s ? { ...s, requests: [r, ...s.requests.filter((x) => x.id !== r.id)].slice(0, 40), stats: { ...s.stats, requests24h: s.stats.requests24h + 1, requestsTotal: s.stats.requestsTotal + 1 } } : s));
    });
    es.addEventListener("trade", (e) => {
      const t = JSON.parse((e as MessageEvent).data) as Trade;
      setSite((s) => (s ? { ...s, trades: [t, ...s.trades.filter((x) => !(x.tx === t.tx && x.amount === t.amount))].slice(0, 30) } : s));
    });
    es.addEventListener("signal", (e) => {
      const f = JSON.parse((e as MessageEvent).data) as Fire;
      setFires((x) => [{ ...f, after1h: null }, ...x].slice(0, 30));
    });
    return () => {
      alive.current = false;
      clearInterval(poll);
      clearInterval(clock);
      clearTimeout(first);
      es.close();
    };
  }, []);

  return <Ctx.Provider value={{ site, hits, fires, connected, now }}>{children}</Ctx.Provider>;
}
