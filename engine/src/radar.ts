// The insider radar: what officers and directors of every stock with a price feed on the chain bought and sold on the
// open market, read from their latest Form 4 filings with the SEC. Built in the background every few hours, one company
// after another (the SEC asks for a slow pace), and served from the last reading. Nothing here is advice.
import type { Hono } from "hono";
import type { Ctx } from "./ctx.ts";
import { kvGet, kvSet } from "./db.ts";
import { INDEXES } from "./indexes.ts";
import { insidersSource, type InsiderTx } from "./sec/edgar.ts";
import type { Helpers } from "./server.ts";
import { iso, nowSec } from "./util.ts";

type Tx = InsiderTx & { filedAt: string; accession: string; url: string };

export interface RadarTrade { ticker: string; company: string; owner: string; role: string; date: string | null; side: "buy" | "sell"; shares: string | null; price: string | null; valueUsd: string; url: string }
export interface RadarCompany { ticker: string; company: string; filingsRead: number; buys: number; sells: number; boughtUsd: string; soldUsd: string; netUsd: string; biggest: RadarTrade | null; lastDate: string | null }
export interface Radar { updatedAt: string | null; companies: RadarCompany[]; biggest: RadarTrade[]; totals: { soldUsd: string; boughtUsd: string; companies: number; withTrades: number }; note: string }

const KEY = "radar_v1";
const SYMBOLS = INDEXES.find((i) => i.id === "equities")?.symbols ?? [];
const toCents = (v: string | null) => (v ? BigInt(v.replace(".", "").replace(/^(-?)0+(?=\d)/, "$1")) : 0n);
const fromCents = (c: bigint) => { const neg = c < 0n; const a = neg ? -c : c; return `${neg ? "-" : ""}${a / 100n}.${String(a % 100n).padStart(2, "0")}`; };

export function radarView(ctx: Ctx): Radar {
  const raw = kvGet(ctx.db, KEY);
  if (raw) return JSON.parse(raw) as Radar;
  return { updatedAt: null, companies: [], biggest: [], totals: { soldUsd: "0.00", boughtUsd: "0.00", companies: SYMBOLS.length, withTrades: 0 }, note: "The first reading is being built." };
}

/** Reads every company's latest Form 4s and stores one radar. A company that cannot be read is skipped this round. */
export async function buildRadar(ctx: Ctx): Promise<string> {
  const companies: RadarCompany[] = [];
  const trades: RadarTrade[] = [];
  for (const ticker of SYMBOLS) {
    try {
      const r = await insidersSource.run(ctx, { ticker, limit: "10" });
      const d = r.data as { company: { name: string; ticker: string }; filingsRead: number; transactions: Tx[] };
      const open = d.transactions.filter((t) => !t.derivative && (t.side === "buy" || t.side === "sell") && t.value);
      const mine: RadarTrade[] = open.map((t) => ({ ticker, company: d.company.name, owner: t.owner, role: t.role, date: t.date, side: t.side as "buy" | "sell", shares: t.shares, price: t.price, valueUsd: t.value!, url: t.url }));
      const sold = mine.filter((t) => t.side === "sell").reduce((n, t) => n + toCents(t.valueUsd), 0n);
      const bought = mine.filter((t) => t.side === "buy").reduce((n, t) => n + toCents(t.valueUsd), 0n);
      const biggest = [...mine].sort((a, b) => (toCents(b.valueUsd) > toCents(a.valueUsd) ? 1 : -1))[0] ?? null;
      const lastDate = mine.map((t) => t.date).filter(Boolean).sort().at(-1) ?? null;
      companies.push({ ticker, company: d.company.name, filingsRead: d.filingsRead, buys: mine.filter((t) => t.side === "buy").length, sells: mine.filter((t) => t.side === "sell").length, boughtUsd: fromCents(bought), soldUsd: fromCents(sold), netUsd: fromCents(bought - sold), biggest, lastDate });
      trades.push(...mine);
    } catch {
      /* not an SEC filer with Form 4s (foreign issuers file 20-F), or the SEC did not answer: skipped this round */
    }
  }
  companies.sort((a, b) => (toCents(b.soldUsd) + toCents(b.boughtUsd) > toCents(a.soldUsd) + toCents(a.boughtUsd) ? 1 : -1));
  const biggest = trades.sort((a, b) => (toCents(b.valueUsd) > toCents(a.valueUsd) ? 1 : -1)).slice(0, 12);
  const sold = companies.reduce((n, c) => n + toCents(c.soldUsd), 0n);
  const bought = companies.reduce((n, c) => n + toCents(c.boughtUsd), 0n);
  const radar: Radar = {
    updatedAt: iso(nowSec()),
    companies,
    biggest,
    totals: { soldUsd: fromCents(sold), boughtUsd: fromCents(bought), companies: companies.length, withTrades: companies.filter((c) => c.buys + c.sells > 0).length },
    note: "Open-market purchases and sales from each company's latest ten Form 4 filings with the SEC. Gifts, option exercises and tax withholding are left out. Not advice.",
  };
  kvSet(ctx.db, KEY, JSON.stringify(radar));
  return `${companies.length} companies read, $${radar.totals.soldUsd} sold, $${radar.totals.boughtUsd} bought`;
}

export function registerRadar(app: Hono, ctx: Ctx, h: Helpers) {
  app.get("/v1/radar", async (c) => c.json(await h.cached("radar", 30_000, () => radarView(ctx))));
}
