import { privateKeyToAccount } from "viem/accounts";
import { Specula, SpeculaError, tickersIn } from "@specula/sdk";

// The parts of ElizaOS this plugin touches, written out so the package does not depend on a framework version.
export interface Runtime {
  getSetting(key: string): string | undefined | null;
}
export interface Memory {
  content: { text?: string };
}
export type Callback = (response: { text: string; content?: unknown }) => Promise<unknown> | unknown;
export interface Action {
  name: string;
  similes: string[];
  description: string;
  examples: unknown[];
  validate(runtime: Runtime, message: Memory): Promise<boolean>;
  handler(runtime: Runtime, message: Memory, state?: unknown, options?: unknown, callback?: Callback): Promise<boolean>;
}
export interface Provider {
  name: string;
  get(runtime: Runtime, message: Memory): Promise<{ text: string }>;
}

const clients = new WeakMap<Runtime, Specula>();
export function clientFor(runtime: Runtime): Specula {
  let c = clients.get(runtime);
  if (!c) {
    const key = runtime.getSetting("SPECULA_AGENT_KEY");
    c = new Specula({ client: "eliza", baseUrl: runtime.getSetting("SPECULA_URL") ?? undefined, account: key ? privateKeyToAccount(key as `0x${string}`) : undefined, maxPricePerCall: runtime.getSetting("SPECULA_MAX_PRICE") ?? "0.05", budget: runtime.getSetting("SPECULA_BUDGET") ?? "1.00" });
    clients.set(runtime, c);
  }
  return c;
}

const say = async (cb: Callback | undefined, text: string, content?: unknown) => {
  await cb?.({ text, content });
  return true;
};
const refuse = async (cb: Callback | undefined, e: unknown) => {
  await cb?.({ text: e instanceof SpeculaError ? `Specula did not answer: ${e.message}` : `Specula could not be reached: ${(e as Error).message}` });
  return false;
};

/** Ask the data anything in plain words. The reply carries a citation under every sentence. */
export const askAction: Action = {
  name: "SPECULA_ASK",
  similes: ["ASK_SPECULA", "MARKET_DATA", "CHECK_DATA"],
  description: "Answer a question about prices, companies, tokens or the economy from live data bought per request from Specula.",
  examples: [[{ user: "user", content: { text: "What is NVDA trading at and what did it file last?" } }, { user: "agent", content: { text: "Let me check the data.", action: "SPECULA_ASK" } }]],
  validate: async (_r, m) => (m.content.text ?? "").trim().length > 3,
  async handler(runtime, message, _s, _o, callback) {
    try {
      const a = await clientFor(runtime).ask(message.content.text ?? "");
      const sources = a.data.citations.map((c) => `[${c.id}] ${c.feed}, ${c.source}, collected ${c.collectedAt}`).join("\n");
      return say(callback, a.data.answered ? `${a.data.answer}\n\nSources:\n${sources}` : a.data.answer, a.data);
    } catch (e) {
      return refuse(callback, e);
    }
  },
};

/** The price of every symbol named in the message, from the on-chain price feeds. */
export const priceAction: Action = {
  name: "SPECULA_PRICE",
  similes: ["GET_PRICE", "STOCK_PRICE", "TOKEN_PRICE"],
  description: "Get the latest on-chain reference price for the stock or coin symbols named in the message.",
  examples: [[{ user: "user", content: { text: "Price of TSLA and ETH?" } }, { user: "agent", content: { text: "Checking.", action: "SPECULA_PRICE" } }]],
  validate: async (_r, m) => tickersIn(m.content.text ?? "").length > 0,
  async handler(runtime, message, _s, _o, callback) {
    const lines: string[] = [];
    const data: unknown[] = [];
    for (const symbol of tickersIn(message.content.text ?? "").slice(0, 5)) {
      try {
        const a = await clientFor(runtime).price(symbol);
        const d = a.data as { symbol: string; price: string; quote: string; updatedAt: string; resting: boolean };
        lines.push(`${d.symbol}: ${d.price} ${d.quote}${d.resting ? " (market resting)" : ""}, updated ${d.updatedAt}`);
        data.push(d);
      } catch (e) {
        if (e instanceof SpeculaError && e.status === 404) continue; // a word in capitals that is not a symbol
        return refuse(callback, e);
      }
    }
    return say(callback, lines.length ? lines.join("\n") : "None of those symbols has an on-chain price feed.", data);
  },
};

/** Keeps the agent aware of what it has spent on data in this session. */
export const spendProvider: Provider = {
  name: "specula_spend",
  get: async (runtime) => ({ text: `Specula data spend this session: ${clientFor(runtime).spent} USDG.` }),
};

export const speculaPlugin = {
  name: "specula",
  description: "Live data for agents, bought per request: on-chain prices and trades, company filings and economic statistics, every answer signed.",
  actions: [askAction, priceAction],
  providers: [spendProvider],
};
export default speculaPlugin;
