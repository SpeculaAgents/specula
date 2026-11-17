# Deploy plan

Nothing in this repository has been deployed. This is the plan for when it is.

## Shape

Two services in one Railway project, both in **EU West (Amsterdam)**.

| Service | Build | Notes |
|---|---|---|
| `engine` | `engine/Dockerfile`, build context the repository root | A volume mounted at `/data` for the database, snapshots and nothing else. Set `RAILWAY_RUN_UID=0`: Railway volumes are owned by root. No public domain needed. |
| `web` | `web/Dockerfile`, build context `web/` | The only service with a public domain. `speculaagents.fun` and `www` point here. |

The engine gets no subdomain. The site reaches it over the private network (`SPECULA_ENGINE_URL=http://engine.railway.internal:4100`),
and agents reach it through the site at `https://speculaagents.fun/api/v1/...`.

## Order

1. Create the project and the two services, EU West, engine volume at `/data`.
2. Engine variables from `.env.example`. Generate `SPECULA_ENGINE_KEY` once (`cast wallet new`) and keep it safe:
   agents pin its address. Leave `SPECULA_PAYMENTS=off`.
3. Deploy the engine. Watch `/v1/status` until the index is at the chain head and the feeds have answered.
4. Deploy the site. Check every page against the live engine, desktop and phone.
5. Point the domain. Root and `www`.
6. Payments, when wanted: create the wallet that receives payments and a separate relayer wallet with a little gas.
   Read both addresses back before setting them. Set `SPECULA_PAY_TO`, `SPECULA_RELAYER_KEY`, `SPECULA_PAYMENTS=on`.
   Make one paid request with a test wallet and check the receipt and the transaction.
7. Later, each on its own: a hosted model key, the anchor contract, the oracle contract, the npm packages.

## A node of our own

The public node works and is the default. From a host it sometimes answers bursts with a challenge page for minutes.
`SPECULA_RPC_URL` takes a comma-separated list: put a paid node first and keep the public one as the fallback.

## Rollback switches

| Variable | Effect |
|---|---|
| `SPECULA_PAYMENTS=off` | Every answer is free again. Nothing else changes. |
| `SPECULA_INDEXER=off` | The chain index stops reading; chain feeds keep serving what is indexed. |
| `SPECULA_AI=standin` | Summaries and answers go back to the built-in rule model. |
| unset `SPECULA_ANCHOR` | Roots are sealed and kept, not posted on chain. |

## Contracts

`contracts/` holds the anchor and the oracle, tested locally. Deploying them is a separate, deliberate step: simulate
the cost first, read every address back, and deploy from the wallet that should own them. `MockUSDG` is for local
chains only and must never be deployed to a live network. `SpeculaTwapOracle` takes its averaging window at deployment
(1800 for the 30 minute window) and refuses updates for any other window.
