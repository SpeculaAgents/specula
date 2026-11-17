import type { Ctx } from "../ctx.ts";
import type { Source } from "../collect.ts";
import { HttpError, nowSec, sleep } from "../util.ts";

/**
 * SEC EDGAR, the public filing system. Free to use and to redistribute. The SEC asks automated clients to identify
 * themselves and to stay under 10 requests a second; this client keeps one request in flight and a gap between them.
 */
const gate = new WeakMap<Ctx, Promise<unknown>>();
export async function secFetch(ctx: Ctx, url: string, as: "json" | "text" = "json", maxBytes = 3_000_000): Promise<unknown> {
  const prev = gate.get(ctx) ?? Promise.resolve();
  const run = prev
    .catch(() => {})
    .then(async () => {
      const last = (ctx.mem.get("sec_last") as number | undefined) ?? 0;
      const wait = ctx.cfg.secMinGapMs - (Date.now() - last);
      if (wait > 0) await sleep(wait);
      ctx.mem.set("sec_last", Date.now());
      const res = await ctx.fetch(url, { headers: { "User-Agent": ctx.cfg.secUserAgent, "Accept-Encoding": "gzip, deflate", Accept: as === "json" ? "application/json" : "*/*" }, signal: AbortSignal.timeout(20_000) });
      if (res.status === 404) throw new HttpError(404, "not_found", "The SEC has no such record.");
      if (res.status === 429 || res.status === 403) {
        ctx.mem.set("sec_last", Date.now() + 10_000); // told to slow down: hold everything for ten seconds
        throw new Error(`SEC asked us to slow down (${res.status})`);
      }
      if (!res.ok) throw new Error(`SEC answered ${res.status}`);
      const text = await res.text();
      const body = text.length > maxBytes ? text.slice(0, maxBytes) : text;
      return as === "json" ? JSON.parse(body) : body;
    });
  gate.set(ctx, run);
  return run;
}

function ensureTables(ctx: Ctx) {
  if (ctx.mem.get("sec_tables")) return;
  ctx.db.exec(`CREATE TABLE IF NOT EXISTS companies (ticker TEXT PRIMARY KEY, cik INTEGER NOT NULL, name TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS companies_cik ON companies(cik);
    CREATE TABLE IF NOT EXISTS sec_docs (key TEXT PRIMARY KEY, json TEXT NOT NULL, at INTEGER NOT NULL);`);
  ctx.mem.set("sec_tables", true);
}

/** A filing never changes once accepted, so a parsed one is kept for good. */
async function kept<T>(ctx: Ctx, key: string, make: () => Promise<T>): Promise<T> {
  ensureTables(ctx);
  const row = ctx.db.prepare("SELECT json FROM sec_docs WHERE key = ?").get(key) as { json: string } | undefined;
  if (row) return JSON.parse(row.json) as T;
  const v = await make();
  ctx.db.prepare("INSERT OR REPLACE INTO sec_docs (key, json, at) VALUES (?, ?, ?)").run(key, JSON.stringify(v), nowSec());
  return v;
}

export interface Company {
  ticker: string;
  cik: number;
  name: string;
}
export const cik10 = (cik: number) => String(cik).padStart(10, "0");

export async function company(ctx: Ctx, tickerOrCik: string): Promise<Company> {
  ensureTables(ctx);
  const q = tickerOrCik.toUpperCase().replace(/\./g, "-");
  const age = nowSec() - Number((ctx.db.prepare("SELECT value FROM kv WHERE key = 'sec_tickers_at'").get() as { value: string } | undefined)?.value ?? 0);
  const have = (ctx.db.prepare("SELECT COUNT(*) n FROM companies").get() as { n: number }).n;
  if (!have || age > 86400) {
    try {
      const map = (await secFetch(ctx, "https://www.sec.gov/files/company_tickers.json")) as Record<string, { cik_str: number; ticker: string; title: string }>;
      const ins = ctx.db.prepare("INSERT OR REPLACE INTO companies (ticker, cik, name) VALUES (?, ?, ?)");
      ctx.db.transaction(() => {
        for (const c of Object.values(map)) ins.run(String(c.ticker).toUpperCase(), c.cik_str, c.title);
      })();
      ctx.db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('sec_tickers_at', ?)").run(String(nowSec()));
    } catch (e) {
      if (!have) throw e; // an old list is better than none
    }
  }
  const row = (/^\d+$/.test(q) ? ctx.db.prepare("SELECT * FROM companies WHERE cik = ? LIMIT 1").get(Number(q)) : ctx.db.prepare("SELECT * FROM companies WHERE ticker = ?").get(q)) as Company | undefined;
  if (row) return row;
  if (/^\d+$/.test(q)) return { ticker: "", cik: Number(q), name: "" };
  throw new HttpError(404, "unknown_ticker", `No SEC registrant trades under "${tickerOrCik}".`);
}

export interface Filing {
  accession: string;
  form: string;
  filedAt: string;
  acceptedAt: string | null;
  reportDate: string | null;
  items: string[];
  title: string | null;
  primaryDocument: string | null;
  url: string;
  indexUrl: string;
}

const archive = (cik: number, accession: string) => `https://www.sec.gov/Archives/edgar/data/${cik}/${accession.replace(/-/g, "")}`;

interface Submissions {
  name: string;
  sicDescription?: string;
  tickers?: string[];
  exchanges?: string[];
  fiscalYearEnd?: string;
  filings: { recent: Record<string, (string | number)[]> };
}

export function filingsFromSubmissions(cik: number, sub: Submissions): Filing[] {
  const r = sub.filings.recent;
  const n = (r.accessionNumber ?? []).length;
  const out: Filing[] = [];
  for (let i = 0; i < n; i++) {
    const accession = String(r.accessionNumber[i]);
    const doc = r.primaryDocument?.[i] ? String(r.primaryDocument[i]) : null;
    out.push({
      accession,
      form: String(r.form[i]),
      filedAt: String(r.filingDate[i]),
      acceptedAt: r.acceptanceDateTime?.[i] ? String(r.acceptanceDateTime[i]) : null,
      reportDate: r.reportDate?.[i] ? String(r.reportDate[i]) : null,
      items: String(r.items?.[i] ?? "").split(",").map((s) => s.trim()).filter(Boolean),
      title: r.primaryDocDescription?.[i] ? String(r.primaryDocDescription[i]) : null,
      primaryDocument: doc,
      url: doc ? `${archive(cik, accession)}/${doc}` : `${archive(cik, accession)}/`,
      indexUrl: `${archive(cik, accession)}/${accession}-index.htm`,
    });
  }
  return out;
}

/** EDGAR's full-text search index: the second way to the same filing list. */
export function filingsFromSearch(cik: number, body: unknown): Filing[] {
  const hits = (body as { hits?: { hits?: { _id: string; _source: { adsh: string; form: string; file_date: string; period_ending?: string; items?: string[]; file_description?: string } }[] } }).hits?.hits;
  if (!Array.isArray(hits)) throw new Error("the search index did not return a filing list");
  const seen = new Set<string>();
  const out: Filing[] = [];
  for (const h of hits) {
    const s = h._source;
    if (!s?.adsh || seen.has(s.adsh)) continue;
    seen.add(s.adsh);
    const doc = h._id.split(":")[1] ?? null;
    out.push({
      accession: s.adsh,
      form: s.form,
      filedAt: s.file_date,
      acceptedAt: null,
      reportDate: s.period_ending ?? null,
      items: s.items ?? [],
      title: s.file_description ?? null,
      primaryDocument: doc,
      url: doc ? `${archive(cik, s.adsh)}/${doc}` : `${archive(cik, s.adsh)}/`,
      indexUrl: `${archive(cik, s.adsh)}/${s.adsh}-index.htm`,
    });
  }
  return out.sort((x, y) => (x.filedAt < y.filedAt ? 1 : x.filedAt > y.filedAt ? -1 : 0));
}

async function submissions(ctx: Ctx, c: Company): Promise<{ sub: Submissions; filings: Filing[] }> {
  const sub = (await secFetch(ctx, `https://data.sec.gov/submissions/CIK${cik10(c.cik)}.json`, "json", 30_000_000)) as Submissions;
  return { sub, filings: filingsFromSubmissions(c.cik, sub) };
}

const head = (c: Company, sub?: Submissions) => ({ ticker: c.ticker || sub?.tickers?.[0] || null, cik: c.cik, name: sub?.name ?? c.name, industry: sub?.sicDescription ?? null });
const formOk = (want: string | undefined, form: string) => !want || form.toUpperCase() === want.toUpperCase() || form.toUpperCase() === `${want.toUpperCase()}/A`;

export const filingsSources: Source[] = [
  {
    id: "sec-data-api",
    async run(ctx, p) {
      const c = await company(ctx, p.ticker);
      const { sub, filings } = await submissions(ctx, c);
      const list = filings.filter((f) => formOk(p.form, f.form)).slice(0, Number(p.limit ?? 20));
      return { data: { company: head(c, sub), count: list.length, filings: list } };
    },
  },
  {
    id: "sec-search-index",
    async run(ctx, p) {
      const c = await company(ctx, p.ticker);
      const body = await secFetch(ctx, `https://efts.sec.gov/LATEST/search-index?ciks=${cik10(c.cik)}${p.form ? `&forms=${encodeURIComponent(p.form)}` : ""}`);
      const list = filingsFromSearch(c.cik, body).filter((f) => formOk(p.form, f.form)).slice(0, Number(p.limit ?? 20));
      return { data: { company: head(c), count: list.length, filings: list } };
    },
  },
];

/** What each 8-K item number means, from the form's own instructions. */
export const ITEMS_8K: Record<string, string> = {
  "1.01": "Entry into a material agreement",
  "1.02": "Termination of a material agreement",
  "1.03": "Bankruptcy or receivership",
  "1.05": "Material cybersecurity incident",
  "2.01": "Completion of an acquisition or disposal of assets",
  "2.02": "Results of operations and financial condition",
  "2.03": "New direct financial obligation",
  "2.04": "Triggering event that accelerates an obligation",
  "2.05": "Costs of exit or disposal activities",
  "2.06": "Material impairments",
  "3.01": "Notice of delisting or listing rule failure",
  "3.02": "Unregistered sale of equity securities",
  "3.03": "Material change to the rights of security holders",
  "4.01": "Change of the certifying accountant",
  "4.02": "Earlier financial statements can no longer be relied on",
  "5.01": "Change in control",
  "5.02": "Departure or appointment of directors or officers",
  "5.03": "Amendments to articles or bylaws, change in fiscal year",
  "5.07": "Results of a shareholder vote",
  "7.01": "Regulation FD disclosure",
  "8.01": "Other events",
  "9.01": "Financial statements and exhibits",
};
const WEIGHT: Record<string, number> = { "1.03": 5, "4.02": 5, "5.01": 5, "1.05": 4, "2.06": 4, "3.01": 4, "2.01": 4, "1.01": 3, "1.02": 3, "2.02": 3, "5.02": 3, "2.04": 3, "2.05": 3 };

export const eventsSource: Source = {
  id: "sec-data-api",
  async run(ctx, p) {
    const c = await company(ctx, p.ticker);
    const { sub, filings } = await submissions(ctx, c);
    const list = filings.filter((f) => f.form === "8-K" || f.form === "8-K/A").slice(0, Number(p.limit ?? 15));
    return {
      data: {
        company: head(c, sub),
        count: list.length,
        events: list.map((f) => ({
          filedAt: f.filedAt,
          acceptedAt: f.acceptedAt,
          eventDate: f.reportDate,
          items: f.items.map((code) => ({ code, meaning: ITEMS_8K[code] ?? "Other" })),
          weight: Math.max(1, ...f.items.map((i) => WEIGHT[i] ?? 1)),
          accession: f.accession,
          url: f.url,
        })),
      },
    };
  },
};

// ---------- Form 4: insider trades ----------

const xmlVal = (xml: string, tag: string): string | null => {
  const m = xml.match(new RegExp(`<${tag}>\\s*(?:<value>)?\\s*([^<]*?)\\s*(?:</value>[\\s\\S]*?)?</${tag}>`));
  return m ? m[1].trim().replace(/&amp;/g, "&") || null : null;
};
const TX_CODES: Record<string, string> = { P: "open market purchase", S: "open market sale", A: "grant or award", M: "option exercise", F: "shares withheld for tax", G: "gift", D: "returned to the company", C: "conversion", X: "option exercise", J: "other" };

export interface InsiderTx {
  owner: string;
  role: string;
  security: string;
  date: string | null;
  code: string;
  kind: string;
  side: "buy" | "sell" | "other";
  shares: string | null;
  price: string | null;
  value: string | null;
  sharesAfter: string | null;
  derivative: boolean;
}

/** Decimal multiply on digits, to two places, rounded down. No floats near money. */
export function mulDecimal(a: string, b: string): string | null {
  const parse = (s: string): [bigint, number] | null => {
    if (!/^\d+(\.\d+)?$/.test(s)) return null;
    const [i, f = ""] = s.split(".");
    return [BigInt(i + f), f.length];
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  const scale = x[1] + y[1];
  const cents = scale >= 2 ? (x[0] * y[0]) / 10n ** BigInt(scale - 2) : x[0] * y[0] * 10n ** BigInt(2 - scale);
  return `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
}

export function parseForm4(xml: string): { issuer: string | null; owner: string; role: string; transactions: InsiderTx[] } {
  const owner = xmlVal(xml, "rptOwnerName") ?? "";
  const roles: string[] = [];
  if (/<isDirector>\s*(1|true)\s*</.test(xml)) roles.push("Director");
  const title = xmlVal(xml, "officerTitle");
  if (/<isOfficer>\s*(1|true)\s*</.test(xml)) roles.push(title ?? "Officer");
  if (/<isTenPercentOwner>\s*(1|true)\s*</.test(xml)) roles.push("10% owner");
  const role = roles.join(", ") || "Insider";
  const transactions: InsiderTx[] = [];
  for (const m of xml.matchAll(/<(nonDerivativeTransaction|derivativeTransaction)>([\s\S]*?)<\/\1>/g)) {
    const t = m[2];
    const code = xmlVal(t, "transactionCode") ?? "";
    const shares = xmlVal(t, "transactionShares");
    const price = xmlVal(t, "transactionPricePerShare");
    transactions.push({
      owner,
      role,
      security: xmlVal(t, "securityTitle") ?? "",
      date: xmlVal(t, "transactionDate"),
      code,
      kind: TX_CODES[code] ?? "other",
      side: code === "P" ? "buy" : code === "S" ? "sell" : "other",
      shares,
      price: price && Number(price) > 0 ? price : null,
      value: shares && price && Number(price) > 0 ? mulDecimal(shares, price) : null,
      sharesAfter: xmlVal(t, "sharesOwnedFollowingTransaction"),
      derivative: m[1] === "derivativeTransaction",
    });
  }
  return { issuer: xmlVal(xml, "issuerName"), owner, role, transactions };
}

export const insidersSource: Source = {
  id: "sec-data-api",
  async run(ctx, p) {
    const c = await company(ctx, p.ticker);
    const { sub, filings } = await submissions(ctx, c);
    const forms = filings.filter((f) => f.form === "4" && f.primaryDocument).slice(0, Number(p.limit ?? 6));
    const out: (InsiderTx & { filedAt: string; accession: string; url: string })[] = [];
    for (const f of forms) {
      const raw = f.primaryDocument!.replace(/^xsl[^/]+\//, "");
      const parsed = await kept(ctx, `form4:${f.accession}`, async () => parseForm4((await secFetch(ctx, `${archive(c.cik, f.accession)}/${raw}`, "text")) as string));
      for (const t of parsed.transactions) out.push({ ...t, filedAt: f.filedAt, accession: f.accession, url: f.url });
    }
    const open = out.filter((t) => !t.derivative && t.side !== "other");
    const sum = (side: string) => open.filter((t) => t.side === side).reduce((n, t) => n + BigInt((t.value ?? "0.00").replace(".", "")), 0n);
    const cents = (v: bigint) => `${v / 100n}.${String(v % 100n).padStart(2, "0")}`;
    return {
      data: {
        company: head(c, sub),
        filingsRead: forms.length,
        count: out.length,
        openMarket: { buys: open.filter((t) => t.side === "buy").length, sells: open.filter((t) => t.side === "sell").length, boughtUsd: cents(sum("buy")), soldUsd: cents(sum("sell")) },
        transactions: out,
      },
    };
  },
};

// ---------- 13F: what a fund holds ----------

export interface Holding {
  issuer: string;
  class: string;
  cusip: string;
  valueUsd: string;
  shares: string;
  putCall: string | null;
}

export function parse13F(xml: string): Holding[] {
  const out: Holding[] = [];
  for (const m of xml.matchAll(/<(?:\w+:)?infoTable>([\s\S]*?)<\/(?:\w+:)?infoTable>/g)) {
    const t = m[1].replace(/<(\/?)\w+:/g, "<$1");
    const v = (tag: string) => t.match(new RegExp(`<${tag}>\\s*([^<]*?)\\s*</${tag}>`))?.[1]?.replace(/&amp;/g, "&") ?? "";
    out.push({ issuer: v("nameOfIssuer"), class: v("titleOfClass"), cusip: v("cusip"), valueUsd: v("value"), shares: v("sshPrnamt"), putCall: v("putCall") || null });
  }
  return out;
}

export const holdingsSource: Source = {
  id: "sec-data-api",
  async run(ctx, p) {
    const c = await company(ctx, p.manager);
    const { sub, filings } = await submissions(ctx, c);
    const f = filings.find((x) => x.form === "13F-HR" || x.form === "13F-HR/A");
    if (!f) throw new HttpError(404, "no_13f", "This registrant has not filed a 13F holdings report.");
    const rows = await kept(ctx, `13f:${f.accession}`, async () => {
      const idx = (await secFetch(ctx, `${archive(c.cik, f.accession)}/index.json`)) as { directory: { item: { name: string; size: string }[] } };
      const table = idx.directory.item.filter((i) => /\.xml$/i.test(i.name) && !/primary_doc/i.test(i.name)).sort((a, b) => Number(b.size) - Number(a.size))[0];
      if (!table) throw new Error("no information table in the filing");
      return parse13F((await secFetch(ctx, `${archive(c.cik, f.accession)}/${table.name}`, "text", 40_000_000)) as string);
    });
    // One line per issuer and class: funds list the same stock once per manager inside the firm.
    const by = new Map<string, { issuer: string; class: string; cusip: string; value: bigint; shares: bigint; putCall: string | null }>();
    for (const r of rows) {
      const k = `${r.cusip}|${r.putCall ?? ""}`;
      const e = by.get(k) ?? { issuer: r.issuer, class: r.class, cusip: r.cusip, value: 0n, shares: 0n, putCall: r.putCall };
      e.value += BigInt(r.valueUsd.replace(/\D/g, "") || "0");
      e.shares += BigInt(r.shares.replace(/\D/g, "") || "0");
      by.set(k, e);
    }
    const all = [...by.values()].sort((a, b) => (a.value < b.value ? 1 : a.value > b.value ? -1 : 0));
    const total = all.reduce((n, h) => n + h.value, 0n);
    return {
      data: {
        manager: head(c, sub),
        period: f.reportDate,
        filedAt: f.filedAt,
        accession: f.accession,
        url: f.indexUrl,
        positions: all.length,
        totalValueUsd: total.toString(),
        holdings: all.slice(0, Number(p.limit ?? 25)).map((h, i) => ({ rank: i + 1, issuer: h.issuer, class: h.class, cusip: h.cusip, putCall: h.putCall, valueUsd: h.value.toString(), shares: h.shares.toString(), weightBps: total ? Number((h.value * 10000n) / total) : 0 })),
      },
    };
  },
};

// ---------- XBRL: numbers companies report ----------

interface Concept {
  label?: string;
  units: Record<string, { end: string; start?: string; val: number; fy: number; fp: string; form: string; filed: string; accn: string; frame?: string }[]>;
}
const CONCEPTS: Record<string, string[]> = {
  revenue: ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet"],
  netIncome: ["NetIncomeLoss"],
  operatingIncome: ["OperatingIncomeLoss"],
  epsDiluted: ["EarningsPerShareDiluted"],
  assets: ["Assets"],
  liabilities: ["Liabilities"],
  equity: ["StockholdersEquity"],
  cash: ["CashAndCashEquivalentsAtCarryingValue"],
};

async function concept(ctx: Ctx, cik: number, tag: string) {
  const c = (await secFetch(ctx, `https://data.sec.gov/api/xbrl/companyconcept/CIK${cik10(cik)}/us-gaap/${tag}.json`, "json", 30_000_000)) as Concept;
  const unit = Object.keys(c.units)[0];
  // Keep one row per period: the latest filing that reports it.
  const by = new Map<string, Concept["units"][string][number]>();
  for (const r of c.units[unit]) {
    const k = `${r.start ?? ""}|${r.end}`;
    const cur = by.get(k);
    if (!cur || r.filed > cur.filed) by.set(k, r);
  }
  const days = (r: { start?: string; end: string }) => (r.start ? (Date.parse(r.end) - Date.parse(r.start)) / 86400000 : 0);
  const rows = [...by.values()].sort((a, b) => (a.end < b.end ? 1 : a.end > b.end ? -1 : days(a) - days(b)));
  return {
    tag,
    label: c.label ?? tag,
    unit,
    points: rows.map((r) => ({ period: r.start ? `${r.start} to ${r.end}` : r.end, end: r.end, span: r.start ? (days(r) > 300 ? "year" : days(r) > 150 ? "half" : days(r) > 100 ? "nine months" : "quarter") : "instant", value: r.val, fiscalYear: r.fy, fiscalPeriod: r.fp, form: r.form, filedAt: r.filed, accession: r.accn })),
  };
}

export const factsSource: Source = {
  id: "sec-xbrl-api",
  async run(ctx, p) {
    const c = await company(ctx, p.ticker);
    const tags = CONCEPTS[p.concept] ?? [p.concept];
    let last: unknown;
    for (const tag of tags) {
      try {
        const r = await concept(ctx, c.cik, tag);
        return { data: { company: head(c), concept: p.concept, ...r, points: r.points.slice(0, Number(p.limit ?? 12)) } };
      } catch (e) {
        last = e;
      }
    }
    throw last instanceof HttpError ? new HttpError(404, "no_such_fact", `This company does not report "${p.concept}" under a standard tag.`) : last;
  },
};

export const fundamentalsSource: Source = {
  id: "sec-xbrl-api",
  async run(ctx, p) {
    const c = await company(ctx, p.ticker);
    const out: Record<string, unknown> = {};
    let got = 0;
    let lastErr: unknown;
    for (const [name, tags] of Object.entries(CONCEPTS)) {
      out[name] = null;
      for (const tag of tags) {
        try {
          const r = await concept(ctx, c.cik, tag);
          const annual = r.points.find((x) => x.span === "year" || (x.span === "instant" && x.form.startsWith("10-K")));
          const latest = r.points[0];
          if (latest && Date.parse(latest.end) < Date.now() - 3 * 365 * 86400000) continue; // a tag the company stopped using
          out[name] = { tag: r.tag, unit: r.unit, latest: latest ? { period: latest.period, span: latest.span, value: latest.value, form: latest.form, filedAt: latest.filedAt } : null, lastFullYear: annual ? { period: annual.period, value: annual.value, filedAt: annual.filedAt } : null };
          got++;
          break;
        } catch (e) {
          lastErr = e;
          if (!(e instanceof HttpError)) throw e;
        }
      }
    }
    if (!got) throw lastErr instanceof HttpError ? new HttpError(404, "no_facts", "This company has no standard financial facts on file.") : new Error("no facts");
    return { data: { company: head(c), facts: out } };
  },
};

// ---------- a filing's text, as numbered paragraphs ----------

export function paragraphsOf(html: string, max = 400): string[] {
  const text = html
    .replace(/<(script|style|ix:header|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|tr|li|h\d|table)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;|&#xa0;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#8217;|&rsquo;|&#x2019;/gi, "'")
    .replace(/&#8220;|&#8221;|&ldquo;|&rdquo;|&quot;/gi, '"')
    .replace(/&#8212;|&mdash;|&#8211;|&ndash;/gi, ", ")
    .replace(/&[a-z#0-9]+;/gi, " ");
  const out: string[] = [];
  for (const line of text.split(/\n+/)) {
    const p = line.replace(/\s+/g, " ").trim();
    if (p.length >= 60 && /[a-z]{4}/.test(p)) out.push(p.slice(0, 2000));
    if (out.length >= max) break;
  }
  return out;
}

/** A link that opens the filing at the quoted words (text fragment), so a reader lands on the paragraph. */
export const paragraphLink = (url: string, paragraph: string) => {
  const words = paragraph.split(" ").slice(0, 8).join(" ");
  return `${url}#:~:text=${encodeURIComponent(words)}`;
};

export const summarySource: Source = {
  id: "sec-archive+model",
  async run(ctx, p) {
    const c = await company(ctx, p.ticker);
    const { sub, filings } = await submissions(ctx, c);
    const want = p.form ? [p.form.toUpperCase()] : ["8-K", "10-Q", "10-K"];
    const f = p.accession ? filings.find((x) => x.accession === p.accession) : filings.find((x) => want.includes(x.form) && x.primaryDocument);
    if (!f || !f.primaryDocument) throw new HttpError(404, "no_filing", "No matching filing with a readable document was found.");
    const paragraphs = await kept(ctx, `paras:${f.accession}`, async () => paragraphsOf((await secFetch(ctx, f.url, "text", 6_000_000)) as string));
    if (!paragraphs.length) throw new HttpError(404, "no_text", "This filing has no readable text (it may be exhibits only).");
    const points = await kept(ctx, `summary:${ctx.ai.id}:${f.accession}`, async () => ctx.ai.summarize({ title: `${sub.name} ${f.form} filed ${f.filedAt}`, paragraphs, max: 6 }));
    // Only points that point at a real paragraph are served.
    const checked = points.filter((pt) => Number.isInteger(pt.paragraph) && pt.paragraph >= 0 && pt.paragraph < paragraphs.length);
    return {
      data: {
        company: head(c, sub),
        filing: { form: f.form, filedAt: f.filedAt, accession: f.accession, url: f.url, items: f.items.map((code) => ({ code, meaning: ITEMS_8K[code] ?? "Other" })) },
        model: ctx.ai.id,
        paragraphsRead: paragraphs.length,
        points: checked.map((pt) => ({ text: pt.text, paragraph: pt.paragraph, quote: paragraphs[pt.paragraph].slice(0, 280), link: paragraphLink(f.url, paragraphs[pt.paragraph]) })),
      },
    };
  },
};
