// An engine that answers from the recorded fixtures, on a port of your choice. The site's tests run against it, so
// they need no network. Prints "ready <url>" when it is up.
//   npx tsx scripts/fixture-engine.ts 4311
import { stepIndexes } from "../src/indexes.ts";
import { startEngine } from "../src/main.ts";
import { collect, normalizeParams } from "../src/collect.ts";
import { FEEDS } from "../src/catalog.ts";
import { exampleOf } from "../src/server.ts";
import { kvSet } from "../src/db.ts";
import { chainScenario, ENGINE_KEY, readJson, replayFetch, replayTransport, type FetchTape, type Tape } from "../test/helpers.ts";

const chain = readJson<{ meta: { from: string; to: string; busy: string; wallet: string }; tape: Tape }>("chain.json");
const e = await startEngine({ port: Number(process.argv[2] ?? 4311), dbPath: ":memory:", engineKey: ENGINE_KEY, payments: false, secMinGapMs: 0 }, { jobs: false, env: {}, transport: replayTransport(chain.tape), fetch: replayFetch(readJson<FetchTape>("docs.json")) });
await chainScenario(e.ctx, BigInt(chain.meta.from), BigInt(chain.meta.to));
kvSet(e.ctx.db, "example_token", chain.meta.busy);
kvSet(e.ctx.db, "example_wallet", chain.meta.wallet);
await stepIndexes(e.ctx);
for (const f of FEEDS) await collect(e.ctx, f, normalizeParams(f, exampleOf(e.ctx, f)), 9999).catch(() => null);
await e.run("briefing");
console.log(`ready ${e.url}`);
process.on("SIGTERM", () => void e.stop().then(() => process.exit(0)));
