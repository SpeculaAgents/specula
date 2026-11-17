import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, custom, http, type Abi, type Address, type Hex, type Transport } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { loadConfig, type Config } from "../src/config.ts";
import { makeCtx, type Ctx, type CtxOptions } from "../src/ctx.ts";
import { FEEDS } from "../src/catalog.ts";
import { collect } from "../src/collect.ts";
import { indexRange } from "../src/chain/indexer.ts";
import { rememberPrices, type PricePoint } from "../src/chain/prices.ts";
import { kvSet } from "../src/db.ts";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const FIX = resolve(HERE, "fixtures");
export const ENGINE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
void FEEDS;

export type Tape = Record<string, unknown>;
const keyOf = (method: string, params: unknown) => `${method} ${JSON.stringify(params ?? [])}`;

/** A transport that answers from a recorded tape. A request that was never recorded is a test failure, not a call. */
export const replayTransport = (tape: Tape): Transport =>
  custom({
    async request({ method, params }) {
      const k = keyOf(method, params);
      if (!(k in tape)) throw new Error(`not on the tape: ${k.slice(0, 160)}`);
      return structuredClone(tape[k]);
    },
  });

/** A transport that calls the real node and writes every exchange onto the tape. */
export const recordTransport = (url: string, tape: Tape): Transport =>
  custom({
    async request({ method, params }) {
      for (let i = 0; ; i++) {
        const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "User-Agent": "specula-engine/0.1" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
        const body = (await res.json()) as { result?: unknown; error?: { message: string; code: number } };
        if (body.error) {
          if (/exceeds limit|narrow the block range/.test(body.error.message) || i >= 3) throw Object.assign(new Error(body.error.message), { details: body.error.message });
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }
        let result = body.result;
        if (method === "eth_getTransactionByHash" && result) result = { ...(result as object), input: "0x" };
        tape[keyOf(method, params)] = result;
        return result;
      }
    },
  });

export interface FetchTape {
  [url: string]: { status: number; body: string };
}
export const replayFetch = (tape: FetchTape, overrides: Record<string, { status: number; body: string }> = {}): typeof fetch =>
  (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const hit = overrides[url] ?? tape[url];
    if (!hit) return new Response("not on the tape", { status: 599 });
    return new Response(hit.body, { status: hit.status });
  }) as typeof fetch;

export function testCtx(overrides: Partial<Config> = {}, opts: CtxOptions = {}): Ctx {
  const cfg = loadConfig({}, { dbPath: ":memory:", engineKey: ENGINE_KEY, secMinGapMs: 0, dataDir: resolve(HERE, ".tmp"), ...overrides });
  const ctx = makeCtx(cfg, opts);
  ctx.pace.gapMs = 0;
  ctx.pace.backoffMs = 1;
  return ctx;
}

/** The chain scenario both the recorder and the tests run: read the price board, then index one range of blocks. */
export async function chainScenario(ctx: Ctx, from: bigint, to: bigint) {
  const board = await collect(ctx, FEEDS.find((f) => f.id === "chain.prices")!, { kind: "all" }, 0);
  rememberPrices(ctx, (board.data as { prices: PricePoint[] }).prices);
  kvSet(ctx.db, "index_start", from.toString());
  const res = await indexRange(ctx, from, to);
  kvSet(ctx.db, "index_block", to.toString());
  kvSet(ctx.db, "index_head", to.toString());
  return { board, res };
}

export const readJson = <T>(name: string): T => JSON.parse(readFileSync(resolve(FIX, name), "utf8")) as T;

// ---------- a local chain for payment tests ----------

export const ANVIL_KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  relayer: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  agent: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  agent2: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  treasury: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
} as const satisfies Record<string, Hex>;

const artifact = (name: string) => JSON.parse(readFileSync(resolve(HERE, "../../contracts/out", `${name}.sol`, `${name}.json`), "utf8")) as { abi: Abi; bytecode: { object: Hex } };

export interface LocalChain {
  url: string;
  port: number;
  usdg: Address;
  anchor: Address;
  oracle: Address;
  bounties: Address;
  proc: ChildProcess;
  mint(to: Address, amount: bigint): Promise<void>;
  balance(of: Address): Promise<bigint>;
  warp(seconds: number): Promise<void>;
  stop(): void;
}

export async function localChain(port: number, engine: Address): Promise<LocalChain> {
  const bin = [resolve(homedir(), ".foundry/bin/anvil"), "anvil"].find((p) => p === "anvil" || existsSync(p))!;
  const proc = spawn(bin, ["--port", String(port), "--chain-id", "31337", "--silent"], { stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  const pub = createPublicClient({ chain: foundry, transport: http(url), pollingInterval: 50 });
  for (let i = 0; ; i++) {
    try {
      await pub.getBlockNumber();
      break;
    } catch {
      if (i > 100) throw new Error("the local chain did not start");
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const deployer = createWalletClient({ account: privateKeyToAccount(ANVIL_KEYS.deployer), chain: foundry, transport: http(url) });
  const deploy = async (name: string, args: unknown[] = []) => {
    const a = artifact(name);
    const hash = await deployer.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args });
    return (await pub.waitForTransactionReceipt({ hash })).contractAddress!;
  };
  const usdg = await deploy("MockUSDG");
  const relayer = privateKeyToAccount(ANVIL_KEYS.relayer).address;
  const anchor = await deploy("SpeculaAnchor", [relayer]);
  const oracle = await deploy("SpeculaOracle", [engine]);
  const bounties = await deploy("SpeculaBounties", [usdg]);
  const usdgAbi = artifact("MockUSDG").abi;
  return {
    url,
    port,
    usdg,
    anchor,
    oracle,
    bounties,
    proc,
    async mint(to, amount) {
      const hash = await deployer.writeContract({ address: usdg, abi: usdgAbi, functionName: "mint", args: [to, amount] });
      await pub.waitForTransactionReceipt({ hash });
    },
    balance: (of) => pub.readContract({ address: usdg, abi: usdgAbi, functionName: "balanceOf", args: [of] }) as Promise<bigint>,
    async warp(seconds) {
      await pub.request({ method: "evm_increaseTime" as never, params: [seconds] as never });
      await pub.request({ method: "evm_mine" as never, params: [] as never });
    },
    stop: () => void proc.kill("SIGTERM"),
  };
}
