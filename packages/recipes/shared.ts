import { privateKeyToAccount } from "viem/accounts";
import { Specula } from "@specula/sdk";

/** One client for a recipe, from the environment. With no key the recipe runs inside the free allowance. */
export function clientFromEnv(defaultBudget: string, env: NodeJS.ProcessEnv = process.env): Specula {
  const key = env.SPECULA_AGENT_KEY;
  return new Specula({ baseUrl: env.SPECULA_URL, account: key ? privateKeyToAccount(key as `0x${string}`) : undefined, maxPricePerCall: env.SPECULA_MAX_PRICE ?? "0.05", budget: env.SPECULA_BUDGET ?? defaultBudget, client: "recipe" });
}
export const isMain = (url: string) => !!process.argv[1] && url.endsWith(process.argv[1].split("/").pop()!);
