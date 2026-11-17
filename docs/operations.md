# Operations

## Is it healthy

- `GET /v1/status` is the whole picture: feed uptime, every source's state and last error, the index position and how
  far behind the chain it is, the background jobs with their last run and last problem.
- `GET /v1/metrics` is the same as counters, for a metrics scraper. It is on the engine only; the site does not forward it.
- `GET /healthz` answers `ok` when the process is up.

## Things that happen

**A source is down.** The feed fails over to its next source and the status page says which one failed and why. Nothing
to do unless it stays down; then check the source itself.

**The index falls behind.** `index.behindBlocks` grows. Usually the public node is throttling. The index catches up by
itself in chunks. If it keeps happening, put a paid node first in `SPECULA_RPC_URL`.

**The SEC answers 429 or 403.** The client holds all SEC requests for ten seconds and carries on. Keep
`SEC_MIN_GAP_MS` at 500 or more and the `SEC_USER_AGENT` descriptive.

**A payment did not settle.** The request got a `402 settlement_failed` and nothing was charged. Check the relayer
wallet has gas. The agent can simply ask again.

**A payment is refused with `relayer_share_used` or `relayer_daily_gas_used`.** The relayer's gas for the day is
booked in `gas_spend`: one pot (`SPECULA_GAS_DAILY`) and a share per paying wallet (`SPECULA_GAS_DAILY_PER_ACCOUNT`).
A heavy agent should top up credits once and pay from them; that needs no gas per call. Raise the numbers if real
traffic needs it. A call whose estimate is above the ceiling for its kind (`engine/src/gas.ts`) is never sent.

**A wallet says it was charged for nothing.** It was not, if the reply was an error: the engine settles after the
answer is ready. Look the wallet up in `receipts`; every charge has a signed receipt with its transaction.

## Data

- One SQLite file at `SPECULA_DB`, in WAL mode. A snapshot (`VACUUM INTO`) is taken every hour into `snapshots/` next
  to it, and the last 24 are kept.
- The chain index can be rebuilt from the chain at any time: stop the engine, move the database away, start again. The
  window it reads back is `SPECULA_BACKFILL_BLOCKS`.
- What cannot be rebuilt: receipts, credits, budgets, agents' own signal rules, signal fires with their outcomes,
  sealed roots. Keep the snapshots.

## Keys

| Key | What it can do | If it leaks |
|---|---|---|
| `SPECULA_ENGINE_KEY` | Sign answers, receipts, roots and oracle reports | Someone can forge answers. Rotate it, announce the new address, and set the oracle's signer. |
| `SPECULA_RELAYER_KEY` | Submit payments agents already signed, post roots | It holds only gas. Replace it. It cannot move agents' money: a signature fixes the amount and the recipient. |
| `ANTHROPIC_API_KEY` | Spend on the model provider | Revoke it there. The engine falls back to the built-in model by itself. |

## Fixtures

The tests replay recorded chain data and documents. When the indexer's queries change, run
`npm --prefix engine run record` (it only reads) and commit the new fixtures.
