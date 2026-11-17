import { EventEmitter } from "node:events";
import { createPublicClient, createWalletClient, defineChain, fallback, http, type PublicClient, type Transport, type WalletClient } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { Config } from "./config.ts";
import { openDb, type DB } from "./db.ts";
import type { AiProvider } from "./ai.ts";
import { makeAi } from "./ai.ts";

export interface Pace {
  gapMs: number;
  last: number;
  backoffMs: number;
}

export interface Ctx {
  cfg: Config;
  db: DB;
  /** Reads the data chain. */
  pub: PublicClient;
  /** Reads and settles on the payment chain. */
  payPub: PublicClient;
  relayer: WalletClient | null;
  signer: PrivateKeyAccount;
  bus: EventEmitter;
  fetch: typeof fetch;
  ai: AiProvider;
  pace: Pace;
  mem: Map<string, unknown>;
  counters: Map<string, number>;
  startedAt: number;
}

const chainOf = (id: number, url: string) =>
  defineChain({
    id,
    name: id === 4663 ? "Robinhood Chain" : `chain ${id}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [url] } },
    contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
  });

const httpOpts = { batch: { batchSize: 20, wait: 10 }, retryCount: 2, retryDelay: 800, timeout: 20_000, fetchOptions: { headers: { "User-Agent": "specula-engine/0.1" } } } as const;

export interface CtxOptions {
  transport?: Transport;
  payTransport?: Transport;
  fetch?: typeof fetch;
  ai?: AiProvider;
}

export function makeCtx(cfg: Config, opts: CtxOptions = {}): Ctx {
  const db = openDb(cfg.dbPath);
  const transport = opts.transport ?? fallback(cfg.rpcUrls.map((u) => http(u, httpOpts)), { rank: false });
  const pub = createPublicClient({ chain: chainOf(cfg.chainId, cfg.rpcUrls[0]), transport, pollingInterval: 250 }) as PublicClient;
  const samePay = cfg.payRpcUrl === cfg.rpcUrls[0] && cfg.payChainId === cfg.chainId && !opts.payTransport;
  const payChain = chainOf(cfg.payChainId, cfg.payRpcUrl);
  const payTransport = opts.payTransport ?? http(cfg.payRpcUrl, httpOpts);
  const payPub = samePay ? pub : (createPublicClient({ chain: payChain, transport: payTransport, pollingInterval: 250 }) as PublicClient);
  const relayer = cfg.relayerKey ? createWalletClient({ account: privateKeyToAccount(cfg.relayerKey), chain: payChain, transport: payTransport }) : null;
  const bus = new EventEmitter();
  bus.setMaxListeners(0);
  const ctx: Ctx = {
    cfg,
    db,
    pub,
    payPub,
    relayer,
    signer: privateKeyToAccount(cfg.engineKey),
    bus,
    fetch: opts.fetch ?? fetch,
    ai: undefined as unknown as AiProvider,
    pace: { gapMs: 150, last: 0, backoffMs: 4000 },
    mem: new Map(),
    counters: new Map(),
    startedAt: Date.now(),
  };
  ctx.ai = opts.ai ?? makeAi(ctx);
  return ctx;
}

export const count = (ctx: Ctx, name: string, by = 1) => ctx.counters.set(name, (ctx.counters.get(name) ?? 0) + by);
