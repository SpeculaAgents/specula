import type { Specula } from "./index.ts";

export interface JsonSchema {
  type: "object";
  properties: Record<string, { type: string; description: string; enum?: string[] }>;
  required: string[];
  additionalProperties: false;
}

/** One feed as a tool a model can call: a name, a description that states the price, a schema, and a function. */
export interface FeedTool {
  name: string;
  feed: string;
  description: string;
  schema: JsonSchema;
  /** Calls the feed and returns a compact, model-friendly result: the data plus where it came from and what it cost. */
  run(args: Record<string, unknown>): Promise<{ data: unknown; source: string; collectedAt: string; paid: string; verified: boolean }>;
}

export interface ToolOptions {
  /** Only these feeds (ids or prefixes like "chain."). Default: every feed. */
  only?: string[];
  /** Freshness to ask for. "recent" and "delayed" cost less. */
  fresh?: "live" | "recent" | "delayed";
}

export const toolName = (feed: string) => `specula_${feed.replace(/\./g, "_")}`;

/** Build one tool per feed from the live catalog, so tools, prices and parameters are never out of step with the engine. */
export async function feedTools(specula: Specula, opts: ToolOptions = {}): Promise<FeedTool[]> {
  const cat = await specula.catalog();
  const tier = opts.fresh ?? "live";
  return cat.feeds
    .filter((f) => !opts.only || opts.only.some((o) => f.id === o || f.id.startsWith(o)))
    .map((f) => ({
      name: toolName(f.id),
      feed: f.id,
      description: `${f.title}. ${f.summary} Costs ${f.price[tier]?.amount ?? f.price.live.amount} USDG per call after the free daily allowance.`,
      schema: {
        type: "object" as const,
        properties: Object.fromEntries(f.params.map((p) => [p.name, { type: p.type === "int" ? "integer" : "string", description: p.doc, ...(p.values ? { enum: p.values } : {}) }])),
        required: f.params.filter((p) => p.required).map((p) => p.name),
        additionalProperties: false as const,
      },
      async run(args) {
        const params: Record<string, string> = {};
        for (const [k, v] of Object.entries(args ?? {})) if (v !== undefined && v !== null && v !== "") params[k] = String(v);
        const a = await specula.get(f.id, params, { fresh: tier });
        return { data: a.data, source: a.source, collectedAt: a.meta.collectedAtIso, paid: a.meta.paidBy === "free" ? "free allowance" : `${a.meta.price.amount} USDG`, verified: true };
      },
    }));
}

/** Symbols written in a text like NVDA or $ETH. A light helper for plugins that route a message to a price lookup. */
export function tickersIn(text: string): string[] {
  const stop = new Set(["A", "I", "THE", "AND", "OR", "IF", "IS", "IN", "ON", "OF", "TO", "USD", "SEC", "CEO", "AI", "ME", "MY", "BY", "AT", "IT", "US", "FOR", "ANY", "ALL", "NEW", "BUY", "SELL", "WHAT", "HOW", "WHEN", "PRICE"]);
  const out: string[] = [];
  for (const m of text.matchAll(/\$?\b([A-Z]{2,5}(?:\.[A-Z0-9]{1,3})?)\b/g)) if (!stop.has(m[1])) out.push(m[1]);
  return [...new Set(out)];
}
