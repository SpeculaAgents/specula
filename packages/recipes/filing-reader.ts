// Filing reader. For each company on a watch list: the latest material events in plain words, what insiders did on
// the open market, and the key points of the newest filing with a link to the paragraph each came from.
//   SPECULA_URL=http://localhost:4100 npx tsx filing-reader.ts NVDA TSLA
import type { Specula } from "@specula/sdk";
import { clientFromEnv, isMain } from "./shared.ts";

export interface FilingReport { ticker: string; company: string; events: string[]; insiders: string; points: { text: string; link: string }[]; skipped: string[] }

export async function run(specula: Specula, tickers: string[]): Promise<FilingReport[]> {
  const out: FilingReport[] = [];
  for (const ticker of tickers) {
    const skipped: string[] = [];
    const attempt = async <T>(what: string, fn: () => Promise<{ data: unknown }>): Promise<T | null> => fn().then((a) => a.data as T).catch((e: Error) => (skipped.push(`${what}: ${e.message}`), null));
    const ev = await attempt<{ company: { name: string }; events: { filedAt: string; weight: number; items: { meaning: string }[] }[] }>("events", () => specula.events(ticker, 5));
    const ins = await attempt<{ openMarket: { buys: number; sells: number; boughtUsd: string; soldUsd: string }; filingsRead: number }>("insiders", () => specula.insiders(ticker, 3));
    const sum = await attempt<{ points: { text: string; link: string }[] }>("summary", () => specula.summary(ticker, { form: "8-K" }));
    out.push({
      ticker,
      company: ev?.company.name ?? ticker,
      // Heaviest first: a change of control matters more than an exhibit list.
      events: (ev?.events ?? []).sort((a, b) => b.weight - a.weight).slice(0, 3).map((e) => `${e.filedAt}: ${e.items.map((i) => i.meaning).join("; ") || "exhibits only"}`),
      insiders: ins ? `${ins.openMarket.buys} open-market buys ($${ins.openMarket.boughtUsd}) and ${ins.openMarket.sells} sales ($${ins.openMarket.soldUsd}) in the last ${ins.filingsRead} insider filings` : "not read",
      points: sum?.points ?? [],
      skipped,
    });
  }
  return out;
}

if (isMain(import.meta.url)) {
  const specula = clientFromEnv("0.50");
  const tickers = process.argv.slice(2).length ? process.argv.slice(2) : ["NVDA", "TSLA"];
  for (const r of await run(specula, tickers)) {
    console.log(`\n${r.company} (${r.ticker})\n  events:\n${r.events.map((e) => `    ${e}`).join("\n")}\n  insiders: ${r.insiders}\n  latest filing:`);
    for (const p of r.points) console.log(`    ${p.text}\n      ${p.link}`);
    for (const s of r.skipped) console.log(`  skipped ${s}`);
  }
  console.log(`\nspent ${specula.spent} USDG`);
}
