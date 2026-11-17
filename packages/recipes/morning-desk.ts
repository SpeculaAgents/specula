// Morning desk. Once a day, spend a fixed budget on three answers (the price board, the economy snapshot and the
// daily briefing), all at the cheapest freshness, and print one page. Shows how to run an agent on a hard budget.
//   SPECULA_URL=http://localhost:4100 npx tsx morning-desk.ts
import type { Specula } from "@specula/sdk";
import { clientFromEnv, isMain } from "./shared.ts";

export interface Desk { page: string; spent: string; missing: string[] }

export async function run(specula: Specula, watch: string[] = ["NVDA", "TSLA", "AAPL", "SPY", "ETH", "BTC"]): Promise<Desk> {
  const missing: string[] = [];
  const lines: string[] = [`Morning desk, ${new Date().toISOString().slice(0, 10)}`, ""];
  const part = async <T>(name: string, fn: () => Promise<{ data: unknown }>, draw: (d: T) => string[]) => {
    try {
      lines.push(name.toUpperCase(), ...draw((await fn()).data as T), "");
    } catch (e) {
      missing.push(`${name}: ${(e as Error).message}`);
    }
  };
  await part<{ prices: { symbol: string; price: string; resting: boolean }[] }>("prices", () => specula.prices("all", { fresh: "delayed" }), (d) =>
    d.prices.filter((p) => watch.includes(p.symbol)).map((p) => `  ${p.symbol.padEnd(6)} ${Number(p.price).toLocaleString("en-US", { maximumFractionDigits: 2 }).padStart(12)}${p.resting ? "  (resting)" : ""}`),
  );
  await part<{ series: Record<string, { title: string; value: string | null; unit: string; period: string }> }>("economy", () => specula.economy({ fresh: "delayed" }), (d) =>
    ["cpi", "unemployment", "yield_10y", "yield_2y"].filter((k) => d.series[k]?.value != null).map((k) => `  ${d.series[k].title}: ${d.series[k].value} ${d.series[k].unit} (${d.series[k].period})`),
  );
  await part<{ sections: { title: string; lines: { text: string }[] }[] }>("briefing", () => specula.briefing(), (d) => d.sections.flatMap((s) => [`  ${s.title}`, ...s.lines.map((l) => `    ${l.text}`)]));
  return { page: lines.join("\n").trimEnd(), spent: specula.spent, missing };
}

if (isMain(import.meta.url)) {
  const specula = clientFromEnv("0.05"); // five cents a morning is plenty: three answers at the delayed price
  const desk = await run(specula);
  console.log(desk.page);
  for (const m of desk.missing) console.log(`missing ${m}`);
  console.log(`\nspent ${desk.spent} USDG`);
}
