import type { Ctx } from "../ctx.ts";
import type { Source } from "../collect.ts";
import { HttpError } from "../util.ts";

/** Public statistics, straight from the agencies that publish them. No keys, no paid data. */
export interface Point {
  date: string;
  period: string;
  value: string;
}
interface SeriesDef {
  id: string;
  title: string;
  unit: string;
  frequency: "daily" | "monthly";
  publisher: string;
  kind: "bls" | "debt" | "avg_rate" | "yield";
  key: string;
}

export const SERIES: SeriesDef[] = [
  { id: "cpi", title: "Consumer price index, all urban consumers", unit: "index 1982-84=100", frequency: "monthly", publisher: "U.S. Bureau of Labor Statistics", kind: "bls", key: "CUUR0000SA0" },
  { id: "unemployment", title: "Unemployment rate", unit: "percent", frequency: "monthly", publisher: "U.S. Bureau of Labor Statistics", kind: "bls", key: "LNS14000000" },
  { id: "payrolls", title: "Nonfarm payroll employment", unit: "thousands of jobs", frequency: "monthly", publisher: "U.S. Bureau of Labor Statistics", kind: "bls", key: "CES0000000001" },
  { id: "hourly_earnings", title: "Average hourly earnings, private", unit: "dollars", frequency: "monthly", publisher: "U.S. Bureau of Labor Statistics", kind: "bls", key: "CES0500000003" },
  { id: "public_debt", title: "Total public debt outstanding", unit: "dollars", frequency: "daily", publisher: "U.S. Treasury Fiscal Data", kind: "debt", key: "tot_pub_debt_out_amt" },
  { id: "treasury_avg_rate", title: "Average interest rate on marketable Treasury debt", unit: "percent", frequency: "monthly", publisher: "U.S. Treasury Fiscal Data", kind: "avg_rate", key: "Total Marketable" },
  { id: "yield_3m", title: "Treasury par yield, 3 month", unit: "percent", frequency: "daily", publisher: "U.S. Treasury", kind: "yield", key: "BC_3MONTH" },
  { id: "yield_2y", title: "Treasury par yield, 2 year", unit: "percent", frequency: "daily", publisher: "U.S. Treasury", kind: "yield", key: "BC_2YEAR" },
  { id: "yield_10y", title: "Treasury par yield, 10 year", unit: "percent", frequency: "daily", publisher: "U.S. Treasury", kind: "yield", key: "BC_10YEAR" },
  { id: "yield_30y", title: "Treasury par yield, 30 year", unit: "percent", frequency: "daily", publisher: "U.S. Treasury", kind: "yield", key: "BC_30YEAR" },
];
const byId = new Map(SERIES.map((s) => [s.id, s]));

async function get(ctx: Ctx, url: string, as: "json" | "text"): Promise<unknown> {
  const memo = ctx.mem.get(`macro:${url}`) as { at: number; body: unknown } | undefined;
  if (memo && Date.now() - memo.at < 60_000) return memo.body;
  const res = await ctx.fetch(url, { headers: { "User-Agent": "specula-engine/0.1", Accept: as === "json" ? "application/json" : "*/*" }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`publisher answered ${res.status}`);
  const body = as === "json" ? await res.json() : await res.text();
  ctx.mem.set(`macro:${url}`, { at: Date.now(), body });
  return body;
}

export function parseBls(body: unknown): Point[] {
  const b = body as { status: string; message?: string[]; Results?: { series: { data: { year: string; period: string; periodName: string; value: string }[] }[] } };
  if (b.status !== "REQUEST_SUCCEEDED" || !b.Results?.series?.[0]) throw new Error(`BLS: ${b.message?.[0] ?? b.status}`);
  return b.Results.series[0].data
    .filter((d) => /^M(0[1-9]|1[0-2])$/.test(d.period) && d.value !== "-")
    .map((d) => ({ date: `${d.year}-${d.period.slice(1)}-01`, period: `${d.periodName} ${d.year}`, value: d.value }));
}

export function parseYields(xml: string, key: string): Point[] {
  const out: Point[] = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const date = m[1].match(/<d:NEW_DATE[^>]*>([^<T]+)/)?.[1];
    const v = m[1].match(new RegExp(`<d:${key}[^>]*>([^<]+)<`))?.[1];
    if (date && v) out.push({ date, period: date, value: v });
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : -1));
}

async function fetchSeries(ctx: Ctx, s: SeriesDef, version: "v1" | "v2" = "v1"): Promise<Point[]> {
  if (s.kind === "bls") return parseBls(await get(ctx, `https://api.bls.gov/publicAPI/${version}/timeseries/data/${s.key}`, "json"));
  if (s.kind === "debt") {
    const b = (await get(ctx, "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/debt_to_penny?sort=-record_date&page%5Bsize%5D=30", "json")) as { data: Record<string, string>[] };
    return b.data.map((d) => ({ date: d.record_date, period: d.record_date, value: d[s.key] }));
  }
  if (s.kind === "avg_rate") {
    const b = (await get(ctx, `https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/avg_interest_rates?sort=-record_date&page%5Bsize%5D=24&filter=security_desc:eq:${encodeURIComponent(s.key)}`, "json")) as { data: Record<string, string>[] };
    return b.data.map((d) => ({ date: d.record_date, period: d.record_date.slice(0, 7), value: d.avg_interest_rate_amt }));
  }
  const now = new Date();
  const month = (d: Date) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  const url = (m: string) => `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value_month=${m}`;
  let pts = parseYields((await get(ctx, url(month(now)), "text")) as string, s.key);
  if (pts.length < 5) {
    // Early in a month there are few rows yet: add the month before.
    const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    pts = [...pts, ...parseYields((await get(ctx, url(month(prev)), "text")) as string, s.key)];
  }
  return pts;
}

function shape(s: SeriesDef, pts: Point[], limit: number) {
  if (!pts.length) throw new Error("the publisher returned no observations");
  const [latest, prev] = pts;
  const yearAgo = s.frequency === "monthly" ? pts[12] : undefined;
  const pct = (a: string, b: string) => (Number(b) ? (((Number(a) - Number(b)) / Number(b)) * 100).toFixed(2) : null);
  return {
    series: s.id,
    title: s.title,
    unit: s.unit,
    frequency: s.frequency,
    publisher: s.publisher,
    latest,
    previous: prev ?? null,
    changeFromPrevious: prev ? (s.unit === "percent" ? { points: (Number(latest.value) - Number(prev.value)).toFixed(2) } : { percent: pct(latest.value, prev.value) }) : null,
    changeFromYearAgo: yearAgo ? (s.unit === "percent" ? { points: (Number(latest.value) - Number(yearAgo.value)).toFixed(2) } : { percent: pct(latest.value, yearAgo.value) }) : null,
    observations: pts.slice(0, limit),
  };
}

const def = (id: string) => {
  const s = byId.get(id.toLowerCase());
  if (!s) throw new HttpError(404, "unknown_series", `Unknown series "${id}". Known: ${SERIES.map((x) => x.id).join(", ")}.`);
  return s;
};

export const seriesSources: Source[] = [
  { id: "publisher", run: async (ctx, p) => ({ data: shape(def(p.series), await fetchSeries(ctx, def(p.series)), Number(p.limit ?? 13)) }) },
  {
    id: "publisher-alt",
    async run(ctx, p) {
      const s = def(p.series);
      if (s.kind !== "bls") throw new Error("this series has one publisher endpoint");
      return { data: shape(s, await fetchSeries(ctx, s, "v2"), Number(p.limit ?? 13)) };
    },
  },
];

export const snapshotSource: Source = {
  id: "publishers",
  async run(ctx) {
    const out: Record<string, unknown> = {};
    let ok = 0;
    for (const s of SERIES) {
      try {
        const pts = await fetchSeries(ctx, s); // the four yields share one document, read once
        const sh = shape(s, pts, 1);
        out[s.id] = { title: sh.title, unit: sh.unit, value: sh.latest.value, period: sh.latest.period, date: sh.latest.date, changeFromPrevious: sh.changeFromPrevious, changeFromYearAgo: sh.changeFromYearAgo, publisher: s.publisher };
        ok++;
      } catch (e) {
        out[s.id] = { title: s.title, value: null, error: String((e as Error).message).slice(0, 80) };
      }
    }
    if (!ok) throw new Error("no publisher answered");
    return { data: { count: ok, series: out } };
  },
};
