import { feedById } from "./registry.ts";
import { collect, normalizeParams, peek, type Datum, type Source } from "./collect.ts";
import type { Ctx } from "./ctx.ts";
import { HttpError, iso, nowSec } from "./util.ts";

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const usd = (v: string | null | undefined) => (v === null || v === undefined ? "an unknown amount" : `$${Number(v).toLocaleString("en-US", { maximumFractionDigits: 2 })}`);
const big = (v: number | string) => {
  const n = Number(v);
  const a = Math.abs(n);
  return a >= 1e12 ? `${(n / 1e12).toFixed(2)} trillion` : a >= 1e9 ? `${(n / 1e9).toFixed(2)} billion` : a >= 1e6 ? `${(n / 1e6).toFixed(2)} million` : n.toLocaleString("en-US", { maximumFractionDigits: 2 });
};
const pct = (bps: number) => `${(bps / 100).toFixed(1)}%`;
const clock = (isoTime: string) => `${isoTime.slice(0, 10)} ${isoTime.slice(11, 16)} UTC`;

/**
 * Plain sentences that state what an answer says. This is the only material a model is given to write from, so an
 * answer can only cite things the engine actually collected and signed.
 */
export function factsOf(d: Datum): string[] {
  const x = d.data as J;
  switch (d.feed) {
    case "chain.price":
      return [`${x.symbol} is ${Number(x.price).toLocaleString("en-US", { maximumFractionDigits: 4 })} ${x.quote} on the on-chain price feed, last updated ${clock(x.updatedAt)}${x.resting ? " (the market is resting, so this is the last session's reading)" : ""}.`];
    case "chain.prices":
      return (x.prices as J[]).slice(0, 10).map((p) => `${p.symbol} is ${Number(p.price).toLocaleString("en-US", { maximumFractionDigits: 4 })} ${p.quote}${p.resting ? " (resting)" : ""}.`);
    case "chain.token":
      return [
        `${x.symbol || x.token} (${x.name || "unnamed"}) is in the ${x.phase} phase${x.price ? `, last traded at ${x.price} ${x.priceAsset}` : ""}${x.marketCapUsd ? `, a market cap of about ${usd(x.marketCapUsd)}` : ""}.`,
        `In the last 24 hours it had ${x.day.buys} buys and ${x.day.sells} sells from ${x.day.traders} traders${x.day.volumeUsd ? `, about ${usd(x.day.volumeUsd)} of volume` : ""}.`,
      ];
    case "chain.holders":
      return [`${x.symbol || x.token} has ${x.holders} holding wallets; the largest holds ${pct(x.concentration.top1Bps)} and the top 10 hold ${pct(x.concentration.top10Bps)} of supply.`];
    case "chain.wallet":
      return [`Wallet ${x.address} made ${x.trades} DEX trades across ${x.tokensTraded} tokens in the indexed window, spending ${x.ethSpent} ETH and receiving ${x.ethReceived} ETH (net ${x.netEth} ETH).`, ...(x.launches.length ? [`It deployed ${x.launches.length} token launches in the window.`] : [])];
    case "chain.fees":
      return [`${x.symbol || x.token}'s curve took ${x.curve.tradingFeesEth} ETH in trading fees and ${x.curve.creatorTaxEth} ETH in creator tax over ${x.curve.trades} trades.`, ...(x.burns.tracked ? [`${x.burns.total} tokens have been burned (${pct(x.burns.shareOfSupplyBps ?? 0)} of supply).`] : [])];
    case "chain.launches":
      return (x.launches as J[]).slice(0, 5).map((l) => `${l.symbol || l.token} (${l.name || "unnamed"}) launched at ${clock(l.launchedAt)} and has had ${l.day.buys} buys and ${l.day.sells} sells since.`);
    case "chain.trades": {
      const t = x.trades as J[];
      if (!t.length) return ["No DEX trades are in the indexed window."];
      return [`The latest ${t.length} DEX trades run from ${clock(t[t.length - 1].time)} to ${clock(t[0].time)}; ${t.filter((r) => r.side === "buy").length} were buys.`, `The most recent was a ${t[0].side} of ${t[0].symbol || t[0].token} worth ${usd(t[0].valueUsd)}.`];
    }
    case "sec.filings":
      return (x.filings as J[]).slice(0, 4).map((f) => `${x.company.name} filed a ${f.form} on ${f.filedAt}${f.title ? ` (${f.title})` : ""}.`);
    case "sec.events":
      return (x.events as J[]).slice(0, 4).map((e) => `${x.company.name} reported an 8-K on ${e.filedAt}: ${(e.items as J[]).filter((i) => i.code !== "9.01").map((i) => i.meaning.toLowerCase()).join("; ") || "exhibits only"}.`);
    case "sec.insiders": {
      const o = x.openMarket;
      const out = [`In ${x.company.name}'s last ${x.filingsRead} insider filings there were ${o.buys} open-market buys (${usd(o.boughtUsd)}) and ${o.sells} open-market sales (${usd(o.soldUsd)}).`];
      for (const t of (x.transactions as J[]).filter((r) => r.side !== "other" && !r.derivative).slice(0, 2)) out.push(`${t.owner} (${t.role}) ${t.side === "buy" ? "bought" : "sold"} ${Number(t.shares).toLocaleString("en-US")} shares at ${usd(t.price)} on ${t.date}.`);
      return out;
    }
    case "sec.holdings":
      return [`${x.manager.name} reported ${x.positions} positions worth ${usd(x.totalValueUsd)} for the period ending ${x.period}.`, ...(x.holdings as J[]).slice(0, 3).map((h) => `Its number ${h.rank} holding is ${h.issuer} at ${pct(h.weightBps)} of the portfolio.`)];
    case "sec.fundamentals": {
      const names: Record<string, string> = { revenue: "revenue", netIncome: "net income", operatingIncome: "operating income", epsDiluted: "diluted earnings per share", assets: "total assets", liabilities: "total liabilities", equity: "shareholders' equity", cash: "cash and equivalents" };
      return Object.entries(x.facts as Record<string, J | null>)
        .filter(([, v]) => v?.latest)
        .map(([k, v]) => `${x.company.name} reported ${names[k] ?? k} of ${k === "epsDiluted" ? v!.latest.value : big(v!.latest.value)} ${v!.unit} for ${v!.latest.period} (${v!.latest.form}, filed ${v!.latest.filedAt}).`);
    }
    case "sec.facts":
      return (x.points as J[]).slice(0, 4).map((p) => `${x.company.name} reported ${x.label} of ${big(p.value)} ${x.unit} for ${p.period}.`);
    case "sec.summary":
      return (x.points as J[]).map((p) => `${x.company.name}'s ${x.filing.form} of ${x.filing.filedAt} says: ${p.text}`);
    case "macro.snapshot":
      return Object.values(x.series as Record<string, J>)
        .filter((s) => s.value !== null)
        .map((s) => `${s.title} was ${s.unit === "dollars" && Number(s.value) > 1e6 ? big(s.value) : s.value} ${s.unit} for ${s.period} (${s.publisher}).`);
    case "macro.series":
      return [`${x.title} was ${x.latest.value} ${x.unit} for ${x.latest.period}${x.previous ? `, after ${x.previous.value} the period before` : ""} (${x.publisher}).`];
    case "signals.recent":
      return (x.fires as J[]).slice(0, 6).map((f) => `Signal "${f.name}" fired for ${f.subject} at ${clock(f.at)}.`);
    case "index.value":
      return [`The ${x.title} stands at ${x.value} (base ${x.base}), computed ${clock(x.at)} from ${x.constituents.length} on-chain price feeds.`];
    default:
      return [];
  }
}

export interface Citation {
  id: string;
  text: string;
  feed: string;
  params: Record<string, string>;
  source: string;
  collectedAt: string;
  digest: string;
}

async function gather(ctx: Ctx, calls: { feed: string; params: Record<string, string> }[]) {
  const cites: Citation[] = [];
  const failed: { feed: string; error: string }[] = [];
  for (const call of calls.slice(0, 5)) {
    const feed = feedById(call.feed);
    // Only the engine's own public feeds: never a seller's (that is paid to the seller) and never a private one.
    if (!feed || feed.group === "answers" || feed.group === "market" || feed.payTo || feed.allow) {
      failed.push({ feed: String(call.feed).slice(0, 60), error: "unknown_feed" });
      continue;
    }
    try {
      const d = await collect(ctx, feed, normalizeParams(feed, call.params ?? {}), Math.max(feed.ttl, 60));
      for (const text of factsOf(d)) cites.push({ id: `f${cites.length + 1}`, text, feed: d.feed, params: d.params, source: d.source, collectedAt: iso(d.collectedAt), digest: d.digest });
    } catch (e) {
      failed.push({ feed: call.feed, error: e instanceof HttpError ? e.code : "unavailable" });
    }
  }
  return { cites, failed };
}

export const askSource: Source = {
  id: "engine+model",
  async run(ctx, p) {
    const question = p.q.trim();
    if (question.length < 3) throw new HttpError(400, "bad_param", "Ask a question.");
    const calls = await ctx.ai.plan(question);
    const { cites, failed } = await gather(ctx, calls);
    const known = new Set(cites.map((c) => c.id));
    const out = cites.length ? await ctx.ai.answer(question, cites.map((c) => ({ id: c.id, text: c.text }))) : { text: "", cites: [] };
    // Keep only citations that exist, and only show the sources the answer leans on.
    const used = [...new Set([...(out.cites ?? []), ...[...out.text.matchAll(/\[(f\d+)\]/g)].map((m) => m[1])])].filter((c) => known.has(c));
    const text = out.text.replace(/\[(f\d+)\]/g, (m, c) => (known.has(c) ? m : "")).trim();
    return {
      data: {
        question,
        answered: used.length > 0,
        answer: used.length ? text : "The data that is live right now does not answer this question. Try naming a symbol, a company, a token address or an economic series.",
        citations: cites.filter((c) => used.includes(c.id)),
        looked: calls.map((c) => c.feed),
        unavailable: failed,
        model: ctx.ai.id,
      },
    };
  },
};

const WATCH = ["NVDA", "TSLA", "AAPL", "MSFT", "AMZN", "META", "GOOGL", "COIN"];

/** The daily briefing: what moved, what launched, what fired, what companies reported. Every line carries its source. */
export async function buildBriefing(ctx: Ctx) {
  const t = nowSec();
  const day = new Date(t * 1000).toISOString().slice(0, 10);
  const sections: { title: string; lines: { text: string; feed: string; digest: string | null }[] }[] = [];

  const board = await collect(ctx, feedById("chain.prices")!, { kind: "all" }, 120).catch(() => null);
  if (board) {
    const movers: { symbol: string; bps: number; price: string }[] = [];
    for (const p of (board.data as J).prices as J[]) {
      if (p.kind === "rate") continue;
      const ref = ctx.db.prepare("SELECT answer FROM price_ticks WHERE symbol = ? AND time <= ? ORDER BY time DESC LIMIT 1").get(p.symbol, t - 86400) as { answer: string } | undefined;
      if (!ref || BigInt(ref.answer) <= 0n) continue;
      movers.push({ symbol: p.symbol, price: p.price, bps: Number(((BigInt(p.raw) - BigInt(ref.answer)) * 10000n) / BigInt(ref.answer)) });
    }
    movers.sort((a, b) => Math.abs(b.bps) - Math.abs(a.bps));
    const lines = movers.slice(0, 6).filter((m) => m.bps !== 0).map((m) => ({ text: `${m.symbol} is ${m.bps > 0 ? "up" : "down"} ${pct(Math.abs(m.bps))} over 24 hours, at ${Number(m.price).toLocaleString("en-US", { maximumFractionDigits: 2 })}.`, feed: "chain.prices", digest: board.digest }));
    if (lines.length) sections.push({ title: "Prices", lines });
  }

  const n = (sql: string, ...a: unknown[]) => (ctx.db.prepare(sql).get(...a) as { n: number }).n;
  const launches = n("SELECT COUNT(*) n FROM tokens WHERE launch_seen = 1 AND launch_time >= ?", t - 86400);
  const trades = n("SELECT COUNT(*) n FROM trades WHERE time >= ?", t - 86400);
  const grads = n("SELECT COUNT(*) n FROM tokens WHERE graduated_at >= ?", t - 86400);
  if (trades || launches) {
    const tr = await collect(ctx, feedById("chain.trades")!, { limit: "50" }, 120).catch(() => null);
    const busiest = ctx.db.prepare("SELECT k.symbol, COUNT(*) n FROM trades t JOIN tokens k ON k.address = t.token WHERE t.time >= ? GROUP BY t.token ORDER BY n DESC LIMIT 1").get(t - 86400) as { symbol: string; n: number } | undefined;
    sections.push({
      title: "The chain",
      lines: [
        { text: `${launches} tokens launched, ${grads} graduated to a pool and ${trades.toLocaleString("en-US")} DEX trades were indexed in the last 24 hours.`, feed: "chain.trades", digest: tr?.digest ?? null },
        ...(busiest ? [{ text: `The most traded token was ${busiest.symbol || "unnamed"} with ${busiest.n.toLocaleString("en-US")} trades.`, feed: "chain.trades", digest: tr?.digest ?? null }] : []),
      ],
    });
  }

  const fires = ctx.db.prepare("SELECT r.name, f.subject, COUNT(*) n FROM signal_fires f JOIN signal_rules r ON r.id = f.rule_id WHERE f.at >= ? AND r.builtin = 1 GROUP BY r.id ORDER BY n DESC LIMIT 5").all(t - 86400) as { name: string; subject: string; n: number }[];
  if (fires.length) sections.push({ title: "Signals", lines: fires.map((f) => ({ text: `"${f.name}" fired ${f.n} time${f.n === 1 ? "" : "s"}.`, feed: "signals.recent", digest: null })) });

  const events: { text: string; feed: string; digest: string | null; at: string }[] = [];
  for (const tk of WATCH) {
    // Only what is already collected: the briefing never spends requests at the SEC on its own.
    const d = peek(ctx, feedById("sec.filings")!, { ticker: tk, form: "8-K", limit: "5" }) ?? peek(ctx, feedById("sec.events")!, { ticker: tk, limit: "4" });
    const list = ((d?.data as J)?.filings ?? (d?.data as J)?.events ?? []) as J[];
    for (const f of list) if (Date.parse(f.filedAt) >= (t - 3 * 86400) * 1000) events.push({ text: `${(d!.data as J).company.name} filed an 8-K on ${f.filedAt}.`, feed: d!.feed, digest: d!.digest, at: f.filedAt });
  }
  if (events.length) sections.push({ title: "Companies", lines: events.sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 6) });

  const macro = peek(ctx, feedById("macro.snapshot")!, {});
  if (macro) {
    const s = (macro.data as J).series as Record<string, J>;
    const lines = ["cpi", "unemployment", "yield_10y"].filter((k) => s[k]?.value != null).map((k) => ({ text: `${s[k].title}: ${s[k].value} ${s[k].unit} (${s[k].period}).`, feed: "macro.snapshot", digest: macro.digest }));
    if (lines.length) sections.push({ title: "The economy", lines });
  }

  const body = { day, at: iso(t), sections };
  ctx.db.prepare("INSERT INTO briefings (day, at, body) VALUES (?, ?, ?) ON CONFLICT(day) DO UPDATE SET at = excluded.at, body = excluded.body").run(day, t, JSON.stringify(body));
  return body;
}

export const briefingSource: Source = {
  id: "engine",
  async run(ctx, p) {
    const day = p.day ?? new Date().toISOString().slice(0, 10);
    const row = ctx.db.prepare("SELECT body, at FROM briefings WHERE day = ?").get(day) as { body: string; at: number } | undefined;
    if (row && (p.day || nowSec() - row.at < 3600)) return { data: JSON.parse(row.body), collectedAt: row.at };
    if (p.day && !row) throw new HttpError(404, "no_briefing", "There is no briefing for that day.");
    return { data: await buildBriefing(ctx) };
  },
};
