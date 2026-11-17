// Code shown on the site. The same calls are exercised by the SDK and package tests.
export const SNIPPETS = {
  sdk: `import { Specula } from "@specula/sdk";
import { privateKeyToAccount } from "viem/accounts";

const specula = new Specula({
  // the agent's own wallet
  account: privateKeyToAccount(process.env.AGENT_KEY),
  // never pay more than this for one answer
  maxPricePerCall: "0.05",
  // stop after this much
  budget: "2.00",
});

const nvda = await specula.price("NVDA");
console.log(nvda.data.price, nvda.source);
console.log(nvda.meta.price.amount);

// 8-K events, decoded
const events = await specula.events("TSLA");
// up to an hour old, a fifth of the price
const cheap = await specula.economy({ fresh: "delayed" });`,
  curl: `# 1. ask
curl -i "https://speculaagents.fun/api/v1/feeds/chain.price?symbol=NVDA"

# 2. inside the free allowance you get the answer right away.
#    after it, the engine answers 402 with the exact amount:
#    { "x402Version": 1, "accepts": [{ "scheme": "exact",
#      "maxAmountRequired": "1000", "asset": "0x5fc5...",
#      "payTo": "0x..." }] }

# 3. sign a one-time transfer of that amount (EIP-3009)
#    and ask again
curl "https://speculaagents.fun/api/v1/feeds/chain.price?symbol=NVDA" \\
  -H "X-PAYMENT: <base64 of the signed authorization>"`,
  mcp: `// claude_desktop_config.json, Cursor, or any MCP client
// SPECULA_AGENT_KEY is optional: it pays past the free allowance
{
  "mcpServers": {
    "specula": {
      "command": "npx",
      "args": ["-y", "@specula/mcp"],
      "env": {
        "SPECULA_AGENT_KEY": "0x...",
        "SPECULA_MAX_PRICE": "0.05",
        "SPECULA_BUDGET": "2.00"
      }
    }
  }
}`,
  aisdk: `import { generateText } from "ai";
import { speculaTools } from "@specula/ai-sdk";

const { text } = await generateText({
  model, // any model the AI SDK supports
  // one tool per feed, priced
  tools: await speculaTools({ account }),
  maxSteps: 6,
  prompt:
    "Did any NVDA insider sell this month, and what is the stock at?",
});`,
  langchain: `import { speculaToolkit } from "@specula/langchain";

const tools = await speculaToolkit({ account, budget: "1.00" });
const agent = createReactAgent({ llm, tools });`,
  stream: `const feed = specula.stream(["prices", "trades", "signals"], (e) => {
  console.log(e.channel, e.data);
});
await feed.ready;`,
  verify: `const answer = await specula.price("ETH");
const check = await specula.verify(answer, { inclusion: true });
// { signature: true, inclusion: true, root: "0x...", anchored: {...} }`,
};
