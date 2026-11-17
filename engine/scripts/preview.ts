// The engine for a local preview with payments switched on: live chain data (read only) and a local test chain for
// the money. A mock dollar token is deployed there and a test agent is funded, so the whole pay-per-request flow can
// be tried without touching a live network.
//   npx tsx scripts/preview.ts --pay
import { privateKeyToAccount } from "viem/accounts";
import { startEngine } from "../src/main.ts";
import { resolve } from "node:path";
import { ENGINE_ROOT, loadConfig } from "../src/config.ts";
import { ANVIL_KEYS, localChain } from "../test/helpers.ts";

const cfg = loadConfig();
const chain = await localChain(4145, privateKeyToAccount(cfg.engineKey).address);
const agent = privateKeyToAccount(ANVIL_KEYS.agent);
await chain.mint(agent.address, 25_000_000n);
// Its own database, so test payments never show up in the ordinary preview.
const e = await startEngine({ port: 4100, dbPath: resolve(ENGINE_ROOT, "data", "preview-pay.sqlite"), payments: true, payRpcUrl: chain.url, payChainId: 31337, payAsset: chain.usdg, payTo: privateKeyToAccount(ANVIL_KEYS.treasury).address, relayerKey: ANVIL_KEYS.relayer, anchor: chain.anchor, oracle: chain.oracle, freeDaily: 5, freeDailyAnon: 3 });
console.log(`
Specula engine ${e.url} with payments ON, settled on a local test chain (${chain.url}).
  mock dollar token  ${chain.usdg}
  test agent key     ${ANVIL_KEYS.agent}   (25 test dollars; a well-known local key, never use it anywhere real)
  free calls a day   5 per wallet, 3 without one, so the 402 shows up quickly

Try:  SPECULA_URL=${e.url} SPECULA_AGENT_KEY=${ANVIL_KEYS.agent} npx tsx ../packages/recipes/morning-desk.ts
`);
const bye = () => void e.stop().then(() => (chain.stop(), process.exit(0)));
process.on("SIGINT", bye);
process.on("SIGTERM", bye);
