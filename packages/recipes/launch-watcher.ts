// Launch watcher. Reads the newest token launches, looks at who bought first and what the deployer has done before,
// and writes one short note per launch. It observes; it never trades.
//   SPECULA_URL=http://localhost:4100 npx tsx launch-watcher.ts
import type { Specula } from "@specula/sdk";
import { clientFromEnv, isMain } from "./shared.ts";

interface Launch { token: string; name: string; symbol: string; deployer: string; launchedAt: string; day: { buys: number; sells: number; traders: number; volumeUsd: string | null }; firstBuyers: { trader: string; quote: string; secondsAfterLaunch: number }[] }
export interface LaunchNote { token: string; symbol: string; note: string; flags: string[] }

export async function run(specula: Specula, opts: { limit?: number } = {}): Promise<LaunchNote[]> {
  const launches = (await specula.launches({ limit: opts.limit ?? 5, buyers: 10 })).data as { launches: Launch[] };
  const notes: LaunchNote[] = [];
  for (const l of launches.launches) {
    const flags: string[] = [];
    const fast = l.firstBuyers.filter((b) => b.secondsAfterLaunch <= 3);
    if (fast.length >= 3) flags.push(`${fast.length} buys in the first 3 seconds`);
    if (l.firstBuyers.some((b) => b.trader === l.deployer)) flags.push("the deployer is among the first buyers");
    if (new Set(l.firstBuyers.map((b) => b.trader)).size < l.firstBuyers.length) flags.push("one wallet bought more than once at the start");
    // The deployer's history costs one more call; skip it quietly if the budget says no.
    const dev = await specula.wallet(l.deployer, { fresh: "recent" }).then((a) => a.data as { launches: unknown[]; trades: number }).catch(() => null);
    if (dev && dev.launches.length > 3) flags.push(`the deployer launched ${dev.launches.length} tokens in the indexed window`);
    notes.push({
      token: l.token,
      symbol: l.symbol,
      flags,
      note: `${l.symbol || "unnamed"} (${l.name || "no name"}) launched ${l.launchedAt}. ${l.day.buys} buys and ${l.day.sells} sells from ${l.day.traders} traders so far${Number(l.day.volumeUsd) >= 1 ? `, about $${Math.round(Number(l.day.volumeUsd)).toLocaleString("en-US")} of volume` : ""}. ${flags.length ? `Worth knowing: ${flags.join("; ")}.` : "Nothing unusual in the first buys."}`,
    });
  }
  return notes;
}

if (isMain(import.meta.url)) {
  const specula = clientFromEnv("0.25");
  for (const n of await run(specula)) console.log(`\n${n.note}\n  ${n.token}`);
  console.log(`\nspent ${specula.spent} USDG`);
}
