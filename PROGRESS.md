# Progress

Running notes, newest state first. Updated after every phase so the work survives an interruption.

**State: ready to push. Nothing has been pushed, deployed or sent to a live network.**

## How to run

```sh
./dev.sh          # engine :4100 (live chain, read only) + site :4200, payments off
./dev.sh --pay    # the same with payments on, settled on a local test chain
npm test          # everything: contracts, engine, packages, site
```

## Tests

| Where | Tests | What they cover |
|---|---|---|
| `contracts/` (forge) | 27 | Mock dollar token (EIP-3009), hourly-root anchor, pull oracle, bounty escrow, token price oracle with its attacks (forged signature, replayed update, stale read, thin market) |
| `engine/` | 107 | Token price oracle, answers that agree across sources and chain intelligence 25, core and failover 11, chain index on recorded blocks 15, filings, statistics and the stand-in model 14, pay per request on a local chain 11, API, signals, answers, roots, quality, indexes, oracle 17, marketplace, private feeds, bounties, teams, archive, lab, demand index 14 |
| `packages/` | 27 | SDK 8, MCP server 5, AI SDK tools 3, LangChain tools 3, Eliza plugin 4, recipes 4 |
| `web/` | 30 | Every page's real HTML (the five new feed pages among them), the proxy allowlist, security headers, the embeddable widget, the install manifest, share card |
| **Total** | **191** | |

Screenshots: `shots/` (not committed), desktop 1440x900 and phone 390x844, three scroll stops per page.
Retake with `SHOTS_SITE=http://localhost:4200 npm --prefix web run shots`.

## The site

Redesigned from scratch on 17 Nov: white, gray and black only; one typeface (Instrument Sans) with a monospace for
numbers and code; rounded cards with soft shadows; a radar hero where every dot is a live price feed and a served
request streams into the tower; counters, scroll reveals, hover lifts, page fades. No ticker strip.

## Phases

| # | Phase | State | Notes |
|---|---|---|---|
| 01 | Site | Done | Landing with the radar hero, catalog, feed pages with a live runner, runnable docs, terminal, signals, ask, verify, indexes, market, lab, data index, status, changelog, roadmap, token, own risk |
| 02 | Data engine | Done | Failover, one format, hot cache, signed answers, health per source |
| 03 | Chain market | Done | Prices, trades, liquidity, holders, launches and first buyers, wallets, fees and burns |
| 04 | Companies and economy | Done | Filings, 8-K, Form 4, 13F, XBRL, summaries with paragraph links; BLS and Treasury statistics |
| 05 | Pay per request | Done, tested on a local chain | x402, free allowance, freshness tiers, bulk levels, budgets, credits, receipts, no charge on failure |
| 06 | Agent access | Done, not published | SDK, MCP, AI SDK, LangChain, Eliza, websocket streams, three recipes |
| 07 | Terminal | Done | |
| 08 | Signals | Done | 30 built-in rules, own rules in plain words, measured one-hour record |
| 09 | Ask the data | Done with the stand-in model | Cited answers, daily briefing |
| 10 | Verified data | Done off chain; contract tested locally | Hourly Merkle roots, proofs, anchor contract |
| 11 | Quality scores | Done | |
| 12 | Oracle and indexes | Done off chain; contracts tested locally | Plus a time-weighted token price (`chain.twap`) and its pull oracle `SpeculaTwapOracle`: the engine signs, anyone submits, thin markets carry no price |
| 13 | Marketplace | Done | A seller lists an https endpoint; the buyer pays the seller's wallet directly; ranked by paid usage; no charge when the seller fails |
| 14 | Data bounties | Done off chain; escrow contract tested locally | A bounty shows as funded only when the contract holds the reward |
| 15 | Private feeds | Done | An allow list on a listing; invisible to everyone else |
| 16 | Archive and replay | Done | One copy per feed every few minutes, kept 14 days, original signatures |
| 17 | Strategy testing | Done | Backtest over recorded prices, paper runs on live prices; one symbol, simple entry and exits |
| 18 | Teams | Done | Shared daily budget, per-wallet report |
| 19 | Phone app | Partly | The site installs to the home screen (manifest and icons); no store app |
| 20 | Partners and widgets | Partly | An embeddable live price widget; no partner integrations |
| 21 | Public data index | Done | Ranking of feeds by requests over 7 days |
| 22 | Token | Not started | Not part of this work |

## One light design, black, white and grey (17 Nov, third round)

This replaces the dark desk described below. The whole site is one light style again, and uses no colour at all:
every hex and rgb value in the styles is a neutral grey. A buy is a filled tag and a sell an outlined one, each with
an arrow; a price that rose or fell carries an arrow; "sniped" and "met" are filled tags. Nothing is told by colour.

- **Homepage** (`web/src/app/page.tsx`, `home.css`): calm. A hero with one live card of Robinhood Chain (launches,
  trades, signals, a few rows that update), a six-feed catalog teaser, how it works with the signed request, the
  developers block, a closing line. No counters of Specula's own usage.
- **Terminal**: the same cards and type as the rest of the site, denser because it is a tool (`web/src/app/desk.css`).
- **Answers are panels, not JSON** (`web/src/components/answer/Answer.tsx`): in the terminal, in every "try it"
  runner and for "the last real answer" on feed pages. Snipers, deployer history, clusters, wallets early in tokens
  that rose, the time-weighted price, one price and the price board have their own layouts; every other feed goes
  through one generic layout (labelled values and tables). The untouched JSON is under a collapsed "Raw".
- `/market` hides what a listing earned and its buyers behind the same `USAGE_MIN_PAID_ANSWERS`.

## Added on 17 Nov (second round)

- **The dark desk.** The homepage and the terminal are dark and dense (`web/src/app/desk.css`, `components/desk/Desk.tsx`);
  the header and footer follow through `html:has(.tm-page)` in `globals.css`. The homepage leads with Robinhood Chain:
  launches, trades and signals live, then prices, the catalog and the rest.
- **Usage counters are hidden** until the engine reports 1,000 paid answers: one constant, `web/src/lib/usage.ts`
  (`USAGE_MIN_PAID_ANSWERS`), read from the new `stats.paidAnswers`.
- **Token price oracle.** `engine/src/chain/twap.ts`: one price per block, outlier blocks trimmed, each price weighted by
  how long it stood (capped at a quarter of the window), floors on trades, wallets, volume and liquidity, and "thin
  market" with reasons instead of a price. Signed updates at `/v1/oracle/token:<address>` for
  `contracts/src/SpeculaTwapOracle.sol`. Not deployed anywhere.
- **Answers that agree.** `engine/src/agree.ts`: `chain.price` and `chain.prices` ask both sources every time. The answer
  carries `agreement` (sources, agreed, spread, dropped, unreachable). A stale, frozen or out-of-line source is dropped
  and named; when too few agree the answer is a 503 `sources_disagree` and nobody is charged. Tolerance:
  `PRICE_TOLERANCE_BPS` in `chain/prices.ts`.
- **Chain intelligence**, four feeds from the index (`engine/src/chain/intel.ts`): `chain.snipers`, `chain.deployer`,
  `chain.clusters`, `chain.smartmoney`. Each answer names its transactions and blocks and describes what happened.
  The terminal has a command for each, and clicking a launch or a trade asks about it.

## What needs a person

- A GitHub login for the SpeculaAgents organisation, then push.
- The domain pointed at the site once it is hosted.
- For payments: the wallet that receives payments and a relayer wallet with a little gas.
- Optional: a model key for summaries and answers, a paid node URL.
- Logo: done (web/public/logo.png, favicon src/app/icon.png, phone icons).

## Left to do, in order

1. Publish the packages to npm under the project's own npm user.
2. Deploy (docs/deploy.md), payments off first.
3. Record fixtures again whenever the indexer's queries change (`npm --prefix engine run record`).
4. Deploy the anchor, oracle and bounty escrow contracts when wanted (each is a deliberate, separate step).
5. The token (phase 22).

## Known limits, said plainly

- The stand-in model understands a fixed set of question and rule shapes. It never invents: with nothing to cite it says so.
- Pool-phase fees are not in the swap events and are not estimated; the fees feed says so.
- Holder clusters link wallets through transfers of the token itself and through buying together. Plain ETH sent
  between wallets is not in the index, so "funded from one source" means funded with the token. Token transfers are
  kept from the moment this version starts; a database from before has none until new ones arrive.
- With two price sources, a disagreement cannot be pinned on either one, so there is no answer. With one source
  unreachable the other still answers and says it was not checked.
- The token price oracle's liquidity floor is the curve's quote reserve on a curve; in a pool it only checks that the
  liquidity the index saw added was not all removed.
- Holders are complete for tokens launched inside the indexed window. For an older token the first request starts a
  background read of its history and answers 409 until it is done.
- Swap traders are looked up from the transaction, at most 300 per indexed range; beyond that the router address is kept.
- A marketplace answer is signed as "what the seller's endpoint returned", not as true. Sellers are not vetted.
- Backtests have no fees or slippage and only cover prices recorded since the engine first ran.
- The filing list falls back to the SEC's search index; the other company feeds have one source each.
