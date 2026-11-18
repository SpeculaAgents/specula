import "server-only";
import { cache } from "react";
import { connection } from "next/server";
import type { Catalog, FeedDetail, Indexes, Quality, Roots, Signals, SiteData, Status } from "./types";

export const ENGINE = (process.env.SPECULA_ENGINE_URL ?? "http://127.0.0.1:4100").replace(/\/$/, "");

/** One read from the engine. Null when it cannot be reached: pages then show a clear empty state, never a made-up number. */
async function read<T>(path: string): Promise<T | null> {
  await connection();
  try {
    const res = await fetch(`${ENGINE}${path}`, { cache: "no-store", signal: AbortSignal.timeout(12_000) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export const getSite = cache(() => read<SiteData>("/v1/site"));
export const getCatalog = cache(() => read<Catalog>("/v1/catalog"));
export const getFeed = cache((id: string) => read<FeedDetail>(`/v1/catalog/${encodeURIComponent(id)}`));
export const getStatus = cache(() => read<Status>("/v1/status"));
export const getQuality = cache(() => read<Quality>("/v1/quality"));
export const getSignals = cache(() => read<Signals>("/v1/signals"));
export const getRoots = cache(() => read<Roots>("/v1/roots"));
export const getIndexes = cache(() => read<Indexes>("/v1/indexes"));
export interface Buyback { on: boolean; wallet: string | null; splitter: string | null; everyMin: number; lastAt: string | null; nextAt: string | null; runs: number; ethSpent: string; burned: string; recent: { time: string; eth: string; burned: string; buyTx: string; burnTx: string | null; via: string }[] }
export const getToken = cache(() => read<{ live: boolean; burns: { amount: string; tx: string; time: string }[]; totalBurned: string | null; buyback?: Buyback }>("/v1/token"));
export const getBriefing = cache(() => read<{ day: string | null; at: string | null; sections: { title: string; lines: { text: string; feed: string }[] }[] }>("/v1/briefing"));
export interface MarketFeed { rank: number; id: string; title: string; summary: string; price: string; seller: string; paid30d: string; paidCalls30d: number; buyers30d: number; uptime24h: number | null }
export const getMarket = cache(() => read<{ count: number; sellers: number; privateFeeds: number; feeds: MarketFeed[] }>("/v1/market"));
export interface Bounty { id: string; title: string; detail: string; amount: string; funder: string; deadline: string; status: string; winner: string | null; offers: { feed: string; seller: string }[] }
export const getBounties = cache(() => read<{ escrow: string | null; count: number; open: number; openAmount: string; bounties: Bounty[] }>("/v1/bounties"));
export const getArchive = cache(() => read<{ keepsDays: number; answers: number; feeds: { feed: string; answers: number; series: number; from: string; to: string }[] }>("/v1/archive"));
export const getLab = cache(() => read<{ pricesRecorded: number; symbols: number; since: string | null; paperRuns: number }>("/v1/lab"));
export const getDemand = cache(() => read<{ window: string; calls: number; feedsAsked: number; feeds: { rank: number; feed: string; title: string; calls7d: number; calls24h: number; paidCalls7d: number; callers7d: number; shareBps: number }[] }>("/v1/demand"));
