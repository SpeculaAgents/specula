import type { Ctx } from "./ctx.ts";
import type { Rule } from "./signals.ts";
import { PRICE_FEEDS } from "./chain/prices.ts";

export interface SummaryPoint {
  text: string;
  /** Index of the paragraph in the source document that supports the point. */
  paragraph: number;
}
export interface PlanCall {
  feed: string;
  params: Record<string, string>;
}
export interface Fact {
  id: string;
  text: string;
}

/**
 * Everything the engine asks a language model to do. Each task has a narrow, checkable shape, and the engine checks
 * what comes back (paragraph numbers exist, cited facts exist, rules parse) before anything is served.
 */
export interface AiProvider {
  id: string;
  summarize(input: { title: string; paragraphs: string[]; max: number }): Promise<SummaryPoint[]>;
  parseRule(text: string): Promise<Rule | null>;
  plan(question: string): Promise<PlanCall[]>;
  answer(question: string, facts: Fact[]): Promise<{ text: string; cites: string[] }>;
}

// ---------- the local stand-in: rule-based, deterministic, free ----------

const KEY = /(revenue|net income|net loss|earnings|increase[ds]?|decrease[ds]?|guidance|agreement|acquisition|merger|appoint|resign|dividend|repurchase|offering|impairment|restructur|material|billion|million|percent|%|\$\s?\d)/gi;
const SYMBOLS = new Set(PRICE_FEEDS.map((f) => f.symbol));
const STOP = new Set(["A", "I", "THE", "AND", "OR", "IF", "IS", "IN", "ON", "OF", "TO", "USD", "SEC", "CEO", "CFO", "AI", "ME", "MY", "BY", "AT", "IT", "ETF", "US", "K", "Q", "FOR", "ANY", "ALL", "NEW", "BUY", "SELL", "WHEN", "WHAT", "HOW"]);

const ABBREV = /\b(?:Mr|Mrs|Ms|Dr|Inc|Corp|Co|Ltd|No|Nos|vs|U\.S|St|Jr|Sr|[A-Z])$/;
/** The opening sentence or two of a paragraph, up to a length. Does not stop at an initial or an abbreviation. */
export const firstSentences = (p: string, max = 260) => {
  let end = -1;
  for (const m of p.matchAll(/[.!?](?=\s+[A-Z"(]|$)/g)) {
    const i = m.index! + 1;
    if (i > max) break;
    if (ABBREV.test(p.slice(0, i - 1))) continue;
    end = i;
    if (i >= 60) break;
  }
  if (end > 0) return p.slice(0, end).trim();
  return p.length <= max ? p.trim() : `${p.slice(0, max).replace(/\s+\S*$/, "")}...`;
};

/** Paragraphs every filing carries and nobody needs summarised. */
const BOILER = /forward-looking|safe harbor|incorporated by reference|pursuant to the requirements|check the appropriate box|indicate by check mark|pursuant to (rule|section) \d|17 CFR|commission file number|emerging growth company|exact name of registrant|former name or former address|title of each class|^item \d+\.\d+\.? [A-Z]|^\(?[a-d]\) exhibits|duly authorized|^signatures?$/i;

/** Tickers named in a text: on-chain symbols first, then anything written like $TICKER or in capitals. */
export function tickersIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\$?\b([A-Z]{1,5}(?:\.[A-Z0-9]{1,3})?)\b/g)) {
    const t = m[1];
    if (STOP.has(t)) continue;
    if (SYMBOLS.has(t) || m[0].startsWith("$") || t.length >= 2) out.push(t);
  }
  const lower = text.toLowerCase();
  for (const [word, sym] of [["ethereum", "ETH"], ["ether", "ETH"], ["bitcoin", "BTC"], ["nvidia", "NVDA"], ["tesla", "TSLA"], ["apple", "AAPL"], ["microsoft", "MSFT"], ["amazon", "AMZN"], ["google", "GOOGL"], ["meta", "META"], ["gold", "GLD"]] as const)
    if (new RegExp(`\\b${word}\\b`).test(lower)) out.push(sym);
  return [...new Set(out)];
}

const num = (s: string) => Number(s.replace(/[, $]/g, ""));
const money = (text: string): number | null => {
  const m = text.match(/\$\s?([\d,.]+)\s*(k|m|million|thousand)?/i) ?? text.match(/([\d,.]+)\s*(k|m|million|thousand)?\s*(usd|dollars)/i);
  if (!m) return null;
  const mult = /^(k|thousand)$/i.test(m[2] ?? "") ? 1e3 : /^(m|million)$/i.test(m[2] ?? "") ? 1e6 : 1;
  return Math.round(num(m[1]) * mult);
};

export function standinParseRule(text: string): Rule | null {
  const t = text.trim();
  const low = t.toLowerCase();
  const addr = t.match(/0x[0-9a-fA-F]{40}/)?.[0]?.toLowerCase();
  const syms = tickersIn(t);
  const sym = syms.find((s) => SYMBOLS.has(s)) ?? syms[0];
  const pct = low.match(/(\d+(?:\.\d+)?)\s*(%|percent)/);
  const win = low.match(/(?:in|within|over|per)\s+(?:the\s+last\s+|an?\s+)?(\d+)?\s*(minute|min|hour|day)/);
  const windowMin = win ? Math.max(1, Number(win[1] ?? 1)) * (win[2].startsWith("h") ? 60 : win[2].startsWith("d") ? 1440 : 1) : 60;
  if (/insider/.test(low) && sym) return { kind: "insider", ticker: sym, side: /\bsell|sold|sale/.test(low) ? "sell" : /\bbuy|bought|purchase/.test(low) ? "buy" : "any" };
  if (/(files?|filing|8-?k|10-?k|10-?q)/.test(low) && sym) {
    const form = low.match(/\b(8-?k|10-?k|10-?q|13f|form 4)\b/)?.[1]?.toUpperCase().replace(/^(\d+)-?([KQ])$/, "$1-$2");
    return { kind: "filing", ticker: sym, form: form === "FORM 4" ? "4" : form };
  }
  if (/graduat/.test(low)) return { kind: "graduation" };
  if (/(new )?(token )?launch/.test(low) && !pct) return { kind: "launch" };
  if (/\bburn/.test(low) && addr) return { kind: "burn", token: addr };
  if (/(top ?10|concentrat|holders? (own|hold))/.test(low) && addr && pct) return { kind: "concentration", token: addr, top10Bps: Math.round(Number(pct[1]) * 100) };
  if (/(whale|large|big|over|above|more than|at least)/.test(low) && /(trade|buy|sell|swap|purchase)/.test(low) && money(t) !== null && !(sym && SYMBOLS.has(sym) && /price|crosses|trades? (above|below)/.test(low)))
    return { kind: "whale_trade", token: addr, side: /\bsells?\b|\bsold\b/.test(low) ? "sell" : /\bbuys?\b|\bbought\b|purchase/.test(low) ? "buy" : "any", minUsd: money(t)! };
  if (sym && pct) {
    const direction = /(drop|fall|down|lose|decline|dip|crash)/.test(low) ? "down" : /(rise|up|gain|jump|rally|pump|climb)/.test(low) ? "up" : "any";
    return { kind: "price_move", symbol: sym, direction, bps: Math.round(Number(pct[1]) * 100), windowMin };
  }
  const level = low.match(/(above|over|below|under|crosses|reaches|hits)\s+\$?\s?([\d,]+(?:\.\d+)?)/);
  if (sym && level) return { kind: "price_cross", symbol: sym, direction: /below|under/.test(level[1]) ? "below" : "above", level: String(num(level[2])) };
  return null;
}

export function standinPlan(question: string): PlanCall[] {
  const low = question.toLowerCase();
  const calls: PlanCall[] = [];
  const addr = question.match(/0x[0-9a-fA-F]{40}/)?.[0]?.toLowerCase();
  const syms = tickersIn(question);
  const company = /(fil(e|ed|es|ing)\b|filings|8-?k|10-?k|10-?q|insider|revenue|income|profit|earnings|assets|fundamental|report|event|holdings?|13f|cash|debt of|liabilit)/.test(low);
  for (const s of syms.slice(0, 3)) {
    if (SYMBOLS.has(s) && (!company || /price|trading at|worth|quote/.test(low))) calls.push({ feed: "chain.price", params: { symbol: s } });
    if (company && /^[A-Z]{1,5}$/.test(s)) {
      if (/insider/.test(low)) calls.push({ feed: "sec.insiders", params: { ticker: s } });
      if (/(revenue|income|profit|earnings|assets|fundamental|cash|liabilit)/.test(low)) calls.push({ feed: "sec.fundamentals", params: { ticker: s } });
      if (/(8-?k|event)/.test(low)) calls.push({ feed: "sec.events", params: { ticker: s } });
      else if (/(fil(e|ed|es|ing|ings)\b|10-?k|10-?q|report)/.test(low)) calls.push({ feed: "sec.filings", params: { ticker: s } });
    }
  }
  if (/(inflation|cpi|unemployment|jobs|payroll|yield|treasur|interest rate|national debt|public debt|economy|macro)/.test(low)) calls.push({ feed: "macro.snapshot", params: {} });
  if (addr && /(hold|concentrat|\bown)/.test(low)) calls.push({ feed: "chain.holders", params: { token: addr } });
  else if (addr && /(wallet|trader|address|who is)/.test(low)) calls.push({ feed: "chain.wallet", params: { address: addr } });
  else if (addr && /(fee|burn)/.test(low)) calls.push({ feed: "chain.fees", params: { token: addr } });
  else if (addr) calls.push({ feed: "chain.token", params: { token: addr } });
  if (/(launch|new token|new coin|just launched)/.test(low)) calls.push({ feed: "chain.launches", params: { limit: "5" } });
  if (/(trade|trading activity|volume|swap|buying|selling)/.test(low) && !addr && !syms.length) calls.push({ feed: "chain.trades", params: { limit: "10" } });
  if (/(signal|alert|fired)/.test(low)) calls.push({ feed: "signals.recent", params: { limit: "10" } });
  if (/(index|indexes)/.test(low)) calls.push({ feed: "index.value", params: { index: "agents" } });
  if (!calls.length && /(market|prices|stocks|equit|crypto)/.test(low)) calls.push({ feed: "chain.prices", params: { kind: /crypto/.test(low) ? "crypto" : /stock|equit/.test(low) ? "equity" : "all" } });
  return calls.slice(0, 5);
}

const standin: AiProvider = {
  id: "standin",
  async summarize({ paragraphs, max }) {
    const scored = paragraphs
      .map((p, i) => ({ i, p, score: p.length < 80 || p.length > 1800 ? 0 : (p.match(KEY)?.length ?? 0) + (/\d/.test(p) ? 1 : 0) - (BOILER.test(p) ? 50 : 0) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .slice(0, max)
      .sort((a, b) => a.i - b.i);
    return scored.map((x) => ({ text: firstSentences(x.p), paragraph: x.i }));
  },
  async parseRule(text) {
    return standinParseRule(text);
  },
  async plan(question) {
    return standinPlan(question);
  },
  async answer(_q, facts) {
    const used = facts.slice(0, 8);
    if (!used.length) return { text: "The data that is live right now does not answer this question.", cites: [] };
    return { text: used.map((f) => `${f.text} [${f.id}]`).join(" "), cites: used.map((f) => f.id) };
  },
};

// ---------- a hosted model, used only when a key is configured ----------

function hosted(ctx: Ctx): AiProvider {
  const model = ctx.cfg.aiModel || "claude-opus-5-5";
  let clientP: Promise<{ beta: { messages: { create(args: unknown): Promise<{ stop_reason: string | null; content: { type: string; text?: string }[] }> } } }> | null = null;
  const client = () => (clientP ??= import("@anthropic-ai/sdk").then((m) => new m.default({ apiKey: ctx.cfg.aiKey ?? undefined }) as never));
  /** One JSON-only call. Throws on a refusal or on text that is not the JSON asked for; the caller falls back. */
  async function json<T>(system: string, user: string): Promise<T> {
    const c = await client();
    const res = await c.beta.messages.create({
      model,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low" },
      system: `${system}\nReply with one JSON value and nothing else.`,
      messages: [{ role: "user", content: user }],
    });
    if (res.stop_reason === "refusal") throw new Error("model declined");
    const text = res.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
    const start = text.search(/[[{]/);
    if (start < 0) throw new Error("no JSON in the reply");
    return JSON.parse(text.slice(start, Math.max(text.lastIndexOf("}"), text.lastIndexOf("]")) + 1)) as T;
  }
  /** Never a hard stop: if the hosted model fails for any reason, the stand-in answers instead. */
  const or = async <T>(what: string, run: () => Promise<T>, fallback: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (e) {
      console.warn(`[ai] ${what} fell back to the stand-in: ${String((e as Error).message).slice(0, 120)}`);
      return fallback();
    }
  };
  return {
    id: `anthropic:${model}`,
    summarize: (input) =>
      or(
        "summarize",
        async () => {
          const doc = input.paragraphs.map((p, i) => `[${i}] ${p}`).join("\n");
          const out = await json<SummaryPoint[]>(
            `You summarize a company filing for a trading agent. Give at most ${input.max} points, most important first. Each point is one plain sentence stating a fact from the filing, with the number of the paragraph that supports it. Shape: [{"text": string, "paragraph": number}]. Use only what the paragraphs say.`,
            `Filing: ${input.title}\n\n${doc}`,
          );
          return out.filter((p) => typeof p?.text === "string" && Number.isInteger(p.paragraph)).slice(0, input.max);
        },
        () => standin.summarize(input),
      ),
    parseRule: (text) =>
      or(
        "parseRule",
        () =>
          json<Rule | null>(
            `Turn a plain-language alert into one rule object, or null if it fits none. Rule shapes:
{"kind":"price_move","symbol":string,"direction":"up"|"down"|"any","bps":number,"windowMin":number}
{"kind":"price_cross","symbol":string,"direction":"above"|"below","level":string}
{"kind":"whale_trade","token"?:address,"side":"buy"|"sell"|"any","minUsd":number}
{"kind":"launch"} {"kind":"graduation"} {"kind":"burn","token":address}
{"kind":"concentration","token":address,"top10Bps":number}
{"kind":"filing","ticker":string,"form"?:string} {"kind":"insider","ticker":string,"side":"buy"|"sell"|"any"}
Symbols with a price feed: ${[...SYMBOLS].join(", ")}.`,
            text,
          ),
        () => standin.parseRule(text),
      ),
    plan: (question) =>
      or(
        "plan",
        () =>
          json<PlanCall[]>(
            `Choose up to 5 data feeds that answer the question. Shape: [{"feed": string, "params": object of strings}]. Feeds: chain.price{symbol}, chain.prices{kind}, chain.trades{token?,limit}, chain.launches{limit}, chain.token{token}, chain.holders{token}, chain.wallet{address}, chain.fees{token}, sec.filings{ticker,form?}, sec.events{ticker}, sec.insiders{ticker}, sec.holdings{manager}, sec.fundamentals{ticker}, macro.snapshot{}, macro.series{series}, signals.recent{limit}, index.value{index}.`,
            question,
          ),
        () => standin.plan(question),
      ),
    answer: (question, facts) =>
      or(
        "answer",
        () =>
          json<{ text: string; cites: string[] }>(
            `Answer the question in two to five plain sentences using only the numbered facts. After each claim put the fact id in square brackets, like [f2]. If the facts do not answer it, say so. Shape: {"text": string, "cites": string[]}.`,
            `Question: ${question}\n\nFacts:\n${facts.map((f) => `[${f.id}] ${f.text}`).join("\n")}`,
          ),
        () => standin.answer(question, facts),
      ),
  };
}

export function makeAi(ctx: Ctx): AiProvider {
  return ctx.cfg.aiProvider === "anthropic" && ctx.cfg.aiKey ? hosted(ctx) : standin;
}
export { standin };
