# Architecture

## One answer, end to end

```
agent --> GET /v1/feeds/{id}
            serve.ts     who is asking, what does it cost, how will it be paid
            collect.ts   hot cache, else the feed's sources in order (failover);
                         every attempt is written to the health tables
            sign.ts      keccak256(canonical JSON of feed, params, data, source, time), signed
            pay.ts       settle the signed payment (or debit credits), write a receipt
agent <-- the signed answer
```

The order is deliberate: the payment is verified first, the answer is collected second, and the money moves last. If
no source answers, nothing is settled.

## The engine (`engine/src`)

| File | Job |
|---|---|
| `catalog.ts`, `registry.ts` | The list of feeds: id, parameters, price, how long an answer stays live, sources in order. The site, SDK, MCP server and docs are generated from it. |
| `collect.ts` | Parameter checks, the hot cache (memory and SQLite), failover, in-flight sharing, health per source, uptime per feed. |
| `sign.ts` | Canonical JSON and the engine signature. |
| `serve.ts`, `pay.ts` | The metered request path: free allowance, freshness tiers, bulk levels, x402 verify and settle, credits, budgets, receipts. |
| `chain/` | The chain client (paced `eth_getLogs` that splits on refusal), on-chain price feeds, the incremental index (launches, curve trades, pool swaps, liquidity, holders, burns) and the views the feeds read. |
| `sec/` | The EDGAR client (identified, spaced, backs off) with parsers for filings, 8-K items, Form 4, 13F and XBRL; public statistics from BLS and the Treasury. |
| `ai.ts` | The model interface: summarise, parse a rule, plan a question, write an answer. A built-in rule model, and a hosted one behind a key. Whatever a model returns is checked before it is served. |
| `signals.ts` | Rules, evaluation on the engine's own events, and the one-hour outcome measurement. |
| `ask.ts` | Facts from signed answers, cited answers, the daily briefing. |
| `merkle.ts` | Hourly roots, proofs, optional posting to the anchor contract. |
| `quality.ts`, `indexes.ts` | Quality scores from measured health; indexes and signed oracle reports. |
| `streams.ts`, `server.ts`, `main.ts` | Websocket streams, the HTTP API, and the background jobs. |

## Rules the code keeps

- Money is integers in base units. A decimal string is parsed once, on its digits. Amounts are stored as text.
- Addresses are stored lowercase and compared without regard to case.
- Anything from a stranger (token names, filings, model output) is cleaned or checked before it is stored or served.
- The engine never needs a key to read. Keys are only for signing answers and for submitting payments agents signed.
- The public node caps a log query at 10,000 results and refuses rather than truncates; unfiltered queries may span
  30,000 blocks. The client splits on refusal and spaces its calls.

## The site (`web/`)

Server components read the engine; client components patch that state from one event stream. The browser only talks
to the site's own origin: `/api/v1/*` forwards an explicit list of public engine routes. If the engine is down, pages
show an empty state. Nothing is ever filled in by hand.
