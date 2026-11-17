#!/bin/sh
# One command to see Specula running on this machine.
#   ./dev.sh         engine on :4100 reading the live chain (read only), site on :4200 built for production (fast clicks), payments off
#   ./dev.sh --dev   the same, but the site in development mode (live edits, each page compiled on its first visit)
#   ./dev.sh --pay   the engine with a local test chain on :4145, a mock dollar token and payments switched on
# Nothing here sends a transaction to a live network. Stop with Ctrl-C.
set -e
cd "$(dirname "$0")"
[ -d engine/node_modules ] || npm --prefix engine install --no-audit --no-fund
[ -d web/node_modules ] || npm --prefix web install --no-audit --no-fund
trap 'kill 0' INT TERM EXIT
if [ "$1" = "--pay" ]; then
  [ -d contracts/out ] || (cd contracts && PATH="$PATH:$HOME/.foundry/bin" forge build)
  (cd engine && caffeinate -i nice npx tsx scripts/preview.ts --pay) &
else
  (cd engine && SPECULA_PORT=4100 caffeinate -i nice npx tsx src/main.ts) &
fi
if [ "$1" = "--dev" ]; then
  (cd web && SPECULA_ENGINE_URL=http://127.0.0.1:4100 nice npx next dev -p 4200) &
else
  (cd web && SPECULA_DIST_DIR=.next-local nice npx next build >/dev/null && SPECULA_DIST_DIR=.next-local SPECULA_ENGINE_URL=http://127.0.0.1:4100 nice npx next start -p 4200) &
fi
echo "engine http://localhost:4100/v1   site http://localhost:4200"
wait
