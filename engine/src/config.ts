import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generatePrivateKey } from "viem/accounts";
import type { Address, Hex } from "viem";

export const ENGINE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const VERSION = "0.1.0";
export const ROBINHOOD_CHAIN_ID = 4663;
export const PUBLIC_RPC = "https://rpc.mainnet.chain.robinhood.com";
export const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address;
export const USDG_DECIMALS = 6;

export interface Config {
  port: number;
  publicUrl: string;
  dbPath: string;
  dataDir: string;
  /** Chain the data is read from. */
  rpcUrls: string[];
  chainId: number;
  indexer: boolean;
  backfillBlocks: number;
  indexIntervalMs: number;
  /** Chain the payments settle on. Same chain in production; a local node in tests and previews. */
  payments: boolean;
  payRpcUrl: string;
  payChainId: number;
  payAsset: Address;
  payAssetName: string;
  payAssetVersion: string;
  payTo: Address | null;
  relayerKey: Hex | null;
  freeDaily: number;
  freeDailyAnon: number;
  engineKey: Hex;
  secUserAgent: string;
  secMinGapMs: number;
  aiProvider: "standin" | "anthropic";
  aiKey: string | null;
  aiModel: string;
  /** Anchor contract for hourly Merkle roots, on the payment chain. Null means roots are kept off chain only. */
  anchor: Address | null;
  oracle: Address | null;
  /** The token price oracle (SpeculaTwapOracle), once deployed. Updates are signed for this address. */
  tokenOracle: Address | null;
  /** The project's own token, once it exists. Until then the site shows no burns at all. */
  token: Address | null;
  /** Escrow contract for data bounties, on the payment chain. Null: bounties are listed as pledged, never as funded. */
  bounties: Address | null;
  /** Sellers' endpoints must be public https. Tests and local previews may allow local addresses, on a local chain only. */
  marketAllowLocal: boolean;
  /** Gas the relayer may spend in one day, in gas units, across everything; and the share of one payer or account. Kept in the database. */
  gasDaily: bigint;
  gasDailyPerAccount: bigint;
  /** How many proxies in front of the engine append to X-Forwarded-For. 0: use the socket address only. */
  trustProxy: number;
  archiveDays: number;
  archiveEverySec: number;
  logJson: boolean;
}

function engineKey(env: NodeJS.ProcessEnv, dataDir: string): Hex {
  if (env.SPECULA_ENGINE_KEY) return env.SPECULA_ENGINE_KEY as Hex;
  // Local runs keep a generated signing key in the data folder so signatures stay checkable across restarts.
  const file = resolve(dataDir, "engine-key.json");
  if (existsSync(file)) return (JSON.parse(readFileSync(file, "utf8")) as { key: Hex }).key;
  const key = generatePrivateKey();
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(file, JSON.stringify({ key }), { mode: 0o600 });
  return key;
}

const list = (s: string | undefined) => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Config> = {}): Config {
  const dataDir = overrides.dataDir ?? env.SPECULA_DATA_DIR ?? resolve(ENGINE_ROOT, "data");
  const port = Number(env.SPECULA_PORT ?? env.PORT ?? 4100);
  const rpcUrls = list(env.SPECULA_RPC_URL);
  if (!rpcUrls.length) rpcUrls.push(PUBLIC_RPC);
  const cfg: Config = {
    port,
    publicUrl: env.SPECULA_PUBLIC_URL ?? `http://localhost:${port}`,
    dataDir,
    dbPath: env.SPECULA_DB ?? resolve(dataDir, "specula.sqlite"),
    rpcUrls,
    chainId: Number(env.SPECULA_CHAIN_ID ?? ROBINHOOD_CHAIN_ID),
    indexer: (env.SPECULA_INDEXER ?? "on") !== "off",
    backfillBlocks: Number(env.SPECULA_BACKFILL_BLOCKS ?? 200_000),
    indexIntervalMs: Number(env.SPECULA_INDEX_INTERVAL_MS ?? 6000),
    payments: env.SPECULA_PAYMENTS === "on",
    payRpcUrl: env.SPECULA_PAY_RPC_URL ?? rpcUrls[0],
    payChainId: Number(env.SPECULA_PAY_CHAIN_ID ?? env.SPECULA_CHAIN_ID ?? ROBINHOOD_CHAIN_ID),
    payAsset: (env.SPECULA_PAY_ASSET ?? USDG) as Address,
    payAssetName: env.SPECULA_PAY_ASSET_NAME ?? "Global Dollar",
    payAssetVersion: env.SPECULA_PAY_ASSET_VERSION ?? "1",
    payTo: (env.SPECULA_PAY_TO as Address | undefined) ?? null,
    relayerKey: (env.SPECULA_RELAYER_KEY as Hex | undefined) ?? null,
    freeDaily: Number(env.SPECULA_FREE_DAILY ?? 100),
    freeDailyAnon: Number(env.SPECULA_FREE_DAILY_ANON ?? 25),
    engineKey: (overrides.engineKey as Hex | undefined) ?? engineKey(env, dataDir),
    secUserAgent: env.SEC_USER_AGENT ?? "Specula data engine (contact via speculaagents.fun)",
    secMinGapMs: Number(env.SEC_MIN_GAP_MS ?? 500),
    aiProvider: env.SPECULA_AI === "anthropic" ? "anthropic" : "standin",
    aiKey: env.ANTHROPIC_API_KEY ?? null,
    aiModel: env.SPECULA_AI_MODEL ?? "",
    anchor: (env.SPECULA_ANCHOR as Address | undefined) ?? null,
    oracle: (env.SPECULA_ORACLE as Address | undefined) ?? null,
    tokenOracle: (env.SPECULA_TOKEN_ORACLE as Address | undefined) ?? null,
    token: (env.SPECULA_TOKEN as Address | undefined) ?? null,
    bounties: (env.SPECULA_BOUNTIES as Address | undefined) ?? null,
    marketAllowLocal: env.SPECULA_MARKET_ALLOW_LOCAL === "1",
    gasDaily: BigInt(env.SPECULA_GAS_DAILY ?? 200_000_000),
    gasDailyPerAccount: BigInt(env.SPECULA_GAS_DAILY_PER_ACCOUNT ?? 10_000_000),
    trustProxy: Number(env.SPECULA_TRUST_PROXY ?? 1),
    archiveDays: Number(env.SPECULA_ARCHIVE_DAYS ?? 14),
    archiveEverySec: Number(env.SPECULA_ARCHIVE_EVERY_SEC ?? 300),
    logJson: env.LOG_FORMAT === "json",
  };
  return { ...cfg, ...overrides };
}

const LOCAL_CHAINS = new Set([31337, 1337]);
/** Payments settle on a local test chain (anvil on this machine). Test-only shortcuts are honoured only then. */
export function isLocalChain(cfg: Pick<Config, "payChainId" | "payRpcUrl">): boolean {
  if (!LOCAL_CHAINS.has(cfg.payChainId)) return false;
  try {
    return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(cfg.payRpcUrl).hostname);
  } catch {
    return false;
  }
}
