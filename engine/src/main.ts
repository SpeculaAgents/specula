import { serve as nodeServe } from "@hono/node-server";
import type { Server } from "node:http";
import { existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBriefing } from "./ask.ts";
import { buybackConfig, buybackRun, initBuyback } from "./buyback.ts";
import { FEEDS, feedById } from "./catalog.ts";
import { collect, normalizeParams } from "./collect.ts";
import { loadConfig, type Config } from "./config.ts";
import { makeCtx, type Ctx, type CtxOptions } from "./ctx.ts";
import { kvGet, kvSet } from "./db.ts";
import { registerIndexes, stepIndexes } from "./indexes.ts";
import { pruneArchive, registerArchive } from "./archive.ts";
import { registerLab, watchPaper } from "./lab.ts";
import { registerMarket } from "./market.ts";
import { budgetHooks } from "./pay.ts";
import { checkTeamBudget, registerTeams } from "./teams.ts";
import { registerVerify, sealHours } from "./merkle.ts";
import { crossCheckPrices, registerQuality } from "./quality.ts";
import { exampleOf, makeApp } from "./server.ts";
import { pollSignals, registerSignals, seedSignals, settleOutcomes, watchSignals } from "./signals.ts";
import { attachStreams } from "./streams.ts";
import { indexBackTick, indexTick, prune } from "./chain/indexer.ts";
import { rememberPrices, type PricePoint } from "./chain/prices.ts";
import { nowSec, ZERO } from "./util.ts";

interface Job {
  runs: number;
  fails: number;
  lastMs: number;
  lastAt: number;
  lastError: string | null;
}

export interface Engine {
  ctx: Ctx;
  server: Server;
  url: string;
  stop(): Promise<void>;
  /** Run one named job now. Tests use this instead of waiting for timers. */
  run(name: string): Promise<void>;
}

/** Pick a token and a wallet that really trade, so every catalog example shows live data. */
function pickExamples(ctx: Ctx) {
  const t = nowSec();
  const tok = ctx.db.prepare("SELECT t.token, COUNT(*) n FROM trades t JOIN tokens k ON k.address = t.token JOIN holder_progress h ON h.token = t.token WHERE t.time >= ? GROUP BY t.token ORDER BY n DESC LIMIT 1").get(t - 86400) as { token: string } | undefined;
  const any = tok ?? (ctx.db.prepare("SELECT t.token, COUNT(*) n FROM trades t JOIN tokens k ON k.address = t.token GROUP BY t.token ORDER BY n DESC LIMIT 1").get() as { token: string } | undefined);
  if (any) kvSet(ctx.db, "example_token", any.token);
  const w = ctx.db.prepare("SELECT trader, COUNT(*) n FROM trades WHERE time >= ? AND venue = 'curve' GROUP BY trader ORDER BY n DESC LIMIT 1").get(t - 86400) as { trader: string } | undefined;
  if (w) kvSet(ctx.db, "example_wallet", w.trader);
  // A launch the index saw from its first block, and a wallet that has launched more than once.
  const l = ctx.db.prepare("SELECT k.address, COUNT(*) n FROM tokens k JOIN trades t ON t.token = k.address WHERE k.launch_seen = 1 GROUP BY k.address ORDER BY n DESC LIMIT 1").get() as { address: string } | undefined;
  if (l) kvSet(ctx.db, "example_launch", l.address);
  const d = ctx.db.prepare("SELECT deployer, COUNT(*) n FROM tokens WHERE launch_seen = 1 GROUP BY deployer ORDER BY n DESC LIMIT 1").get() as { deployer: string } | undefined;
  if (d) kvSet(ctx.db, "example_deployer", d.deployer);
}

export async function startEngine(overrides: Partial<Config> = {}, opts: CtxOptions & { jobs?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<Engine> {
  const cfg = loadConfig(opts.env ?? process.env, overrides);
  const ctx = makeCtx(cfg, opts);
  seedSignals(ctx);
  watchSignals(ctx);
  watchPaper(ctx);
  if (!budgetHooks.includes(checkTeamBudget)) budgetHooks.push(checkTeamBudget);
  const app = makeApp(ctx, [registerSignals, registerVerify, registerQuality, registerIndexes, registerMarket, registerArchive, registerLab, registerTeams]);
  const server = await new Promise<Server>((res) => {
    const s = nodeServe({ fetch: app.fetch, port: cfg.port, hostname: process.env.SPECULA_HOST ?? "::" }, () => res(s as unknown as Server));
  });
  const streams = attachStreams(ctx, server);
  const port = (server.address() as { port: number }).port;

  const jobs = new Map<string, Job>();
  ctx.mem.set("jobs", jobs);
  const defs = new Map<string, () => Promise<unknown>>();
  const timers: NodeJS.Timeout[] = [];
  const busy = new Set<string>();
  const run = async (name: string) => {
    const fn = defs.get(name);
    if (!fn || busy.has(name)) return;
    busy.add(name);
    const j = jobs.get(name) ?? { runs: 0, fails: 0, lastMs: 0, lastAt: 0, lastError: null };
    const t0 = Date.now();
    try {
      await fn();
      j.lastError = null;
    } catch (e) {
      j.fails++;
      j.lastError = String((e as Error).message ?? e).replace(/https?:\/\/\S+/g, "[url]").slice(0, 160);
      if (cfg.logJson) console.log(JSON.stringify({ level: "warn", job: name, error: j.lastError }));
      else console.warn(`[job ${name}] ${j.lastError}`);
    }
    j.runs++;
    j.lastMs = Date.now() - t0;
    j.lastAt = nowSec();
    jobs.set(name, j);
    busy.delete(name);
  };
  const every = (name: string, ms: number, fn: () => Promise<unknown>, firstAfter = 0) => {
    defs.set(name, fn);
    if (opts.jobs === false) return;
    timers.push(setTimeout(() => void run(name), firstAfter));
    timers.push(setInterval(() => void run(name), ms));
  };

  every("prices", 15_000, async () => {
    const d = await collect(ctx, feedById("chain.prices")!, { kind: "all" }, 10);
    rememberPrices(ctx, (d.data as { prices: PricePoint[] }).prices);
  });
  if (cfg.indexer)
    every("index", cfg.indexIntervalMs, async () => {
      // Catch up in a few chunks per tick, then idle until the next one.
      let inStep = false;
      for (let i = 0; i < 4; i++) {
        const r = await indexTick(ctx);
        if (!r || r.behind === 0n) { inStep = true; break; }
      }
      // in step with the head: read one chunk of older history, if the window asks for more than is indexed
      if (inStep) await indexBackTick(ctx);
      if (kvGet(ctx.db, "example_token") === null || nowSec() % 600 < 10) pickExamples(ctx);
    }, 500);
  every("signals-chain", 30_000, () => pollSignals(ctx, "chain"), 20_000);
  every("signals-filings", 600_000, () => pollSignals(ctx, "filings"), 45_000);
  every("outcomes", 60_000, async () => settleOutcomes(ctx), 30_000);
  every("indexes", 300_000, () => stepIndexes(ctx), 8_000);
  every("roots", 300_000, () => sealHours(ctx), 12_000);
  const bb = buybackConfig(opts.env ?? process.env);
  initBuyback(ctx, bb);
  if (bb.on) every("buyback", bb.everyMs, async () => { const note = await buybackRun(ctx, bb); console.log(`[buyback] ${note}`); }, 60_000);
  every("quality", 3_600_000, () => crossCheckPrices(ctx), 15_000);
  every("briefing", 1_800_000, () => buildBriefing(ctx), 240_000);
  every("prune", 6 * 3_600_000, async () => (prune(ctx), pruneArchive(ctx)), 60_000);
  /** Keep every feed's example answer warm, one feed at a time, so the catalog always has a real answer to show. */
  let warmAt = 0;
  every("warm", 20_000, async () => {
    for (let i = 0; i < FEEDS.length; i++) {
      const f = FEEDS[(warmAt + i) % FEEDS.length];
      const ex = exampleOf(ctx, f);
      if (Object.values(ex).includes(ZERO) || f.id === "answers.ask") continue;
      const params = normalizeParams(f, ex);
      const before = ctx.counters.get("collected") ?? 0;
      await collect(ctx, f, params, Math.max(f.ttl, 900)).catch(() => {});
      if ((ctx.counters.get("collected") ?? 0) !== before || (ctx.counters.get("collect_failed") ?? 0) > 0) {
        warmAt = (warmAt + i + 1) % FEEDS.length;
        return; // one upstream call per round is enough
      }
    }
    warmAt = 0;
  }, 25_000);
  every("snapshot", 3_600_000, async () => {
    if (cfg.dbPath === ":memory:") return;
    const dir = resolve(dirname(cfg.dbPath), "snapshots");
    mkdirSync(dir, { recursive: true });
    ctx.db.exec(`VACUUM INTO '${resolve(dir, `specula-${Date.now()}.sqlite`).replace(/'/g, "''")}'`);
    const files = readdirSync(dir).filter((f) => f.endsWith(".sqlite")).sort();
    for (const f of files.slice(0, Math.max(0, files.length - 24))) unlinkSync(resolve(dir, f));
  }, 3_600_000);

  return {
    ctx,
    server,
    url: `http://127.0.0.1:${port}`,
    run,
    async stop() {
      for (const t of timers) clearTimeout(t);
      streams.close();
      await new Promise<void>((r) => server.close(() => r()));
      (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      ctx.db.close();
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const e = await startEngine();
  const c = e.ctx.cfg;
  console.log(`Specula engine ${e.url}  signer ${e.ctx.signer.address}  payments ${c.payments ? `on (${c.payChainId})` : "off"}  model ${e.ctx.ai.id}  db ${existsSync(c.dbPath) ? c.dbPath : "new"}`);
  const bye = () => void e.stop().then(() => process.exit(0));
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
}
