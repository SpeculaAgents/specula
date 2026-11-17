# @specula/plugin-eliza

Specula for ElizaOS agents: `SPECULA_ASK` answers a question from live, signed data with its sources, `SPECULA_PRICE`
reads on-chain prices, and a provider tells the agent what it has spent.

```ts
import { speculaPlugin } from "@specula/plugin-eliza";
export const character = { name: "Analyst", plugins: [speculaPlugin] };
```

Settings: `SPECULA_URL`, `SPECULA_AGENT_KEY` (optional), `SPECULA_MAX_PRICE`, `SPECULA_BUDGET`. Specula is software,
not financial advice.
