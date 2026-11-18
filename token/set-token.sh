#!/bin/zsh
# After the launch: names $SPECULA in the splitter (once, from the buyback wallet). The splitter itself refuses any
# token that Pons does not record with its fees paid to the splitter, an ETH pair, the 3% tax and buyback off.
#   token/set-token.sh <token address>              dry run
#   token/set-token.sh <token address> --broadcast  the real transaction
set -e
export PATH="$HOME/.foundry/bin:$PATH"
cd "$(dirname "$0")"
RPC=${RPC_URL:-https://rpc.mainnet.chain.robinhood.com}
T=$1; . broadcast/specula-token.env
echo "splitter $SPECULA_SPLITTER, token $T"
cast call $SPECULA_SPLITTER "setToken(address)" $T --from 0xF9E50b701EC0e0FFe64B1E993177eC22Ba834588 --rpc-url $RPC >/dev/null && echo "the splitter accepts this token"
[ "$2" = "--broadcast" ] || { echo "dry run only"; exit 0; }
cast send $SPECULA_SPLITTER "setToken(address)" $T --private-key $(cat ~/.specula-fomo-key) --rpc-url $RPC >/dev/null
echo "token set: $(cast call $SPECULA_SPLITTER 'token()(address)' --rpc-url $RPC)"
