#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { privateKeyToAccount } from "viem/accounts";
import { makeServer } from "./server.js";

export { makeServer } from "./server.js";

/** Settings come from the environment. With no key the server works inside the free allowance and never pays. */
export function optionsFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const key = env.SPECULA_AGENT_KEY;
  if (key && !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("SPECULA_AGENT_KEY must be a 0x private key (64 hex characters).");
  return {
    baseUrl: env.SPECULA_URL,
    account: key ? privateKeyToAccount(key as `0x${string}`) : undefined,
    maxPricePerCall: env.SPECULA_MAX_PRICE ?? "0.05",
    budget: env.SPECULA_BUDGET ?? "1.00",
    fresh: (env.SPECULA_FRESH as "live" | "recent" | "delayed" | undefined) ?? "live",
  };
}

if (process.argv[1] && /(index\.(js|ts)|specula-mcp)$/.test(process.argv[1])) {
  const { server } = await makeServer(optionsFromEnv());
  await server.connect(new StdioServerTransport());
}
