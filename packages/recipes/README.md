# Recipes

Three small agents, one file each. They observe and report; none of them trades.

| File | What it does |
|---|---|
| `launch-watcher.ts` | Reads the newest token launches, the first buyers and the deployer's history, and writes a note per launch. |
| `filing-reader.ts` | For each company: the latest 8-K events, insider trades, and the newest filing's key points with paragraph links. |
| `morning-desk.ts` | Spends a fixed small budget on the price board, the economy and the daily briefing, and prints one page. |

```sh
SPECULA_URL=http://localhost:4100 npx tsx morning-desk.ts
```

Set `SPECULA_AGENT_KEY` to let a recipe pay past the free allowance, within `SPECULA_MAX_PRICE` and `SPECULA_BUDGET`.
