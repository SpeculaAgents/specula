#!/bin/zsh
# Deploys SpeculaSplitter and SpeculaSwap from the buyback wallet, then reads them back and checks every wire.
#   token/deploy.sh               dry run: shows the wallet, the cost and where both contracts will land; sends nothing
#   token/deploy.sh --broadcast   the real deploy (two transactions from the buyback wallet)
# The key is read from ~/.specula-fomo-key for this one run and never shown.
set -e
export PATH="$HOME/.foundry/bin:$PATH"
cd "$(dirname "$0")"
RPC=${RPC_URL:-https://rpc.mainnet.chain.robinhood.com}
FACTORY=0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e
TEAM=0x4b9D2eFb9878504a060fE147bF558014FE010EBe
BUYBACK=0xF9E50b701EC0e0FFe64B1E993177eC22Ba834588
KEYFILE=~/.specula-fomo-key
[ "$(cast chain-id --rpc-url $RPC)" = "4663" ] || { echo "not Robinhood Chain"; exit 1; }
[ "$(cast wallet address --private-key $(cat $KEYFILE))" = "$BUYBACK" ] || { echo "the key is not the buyback wallet's"; exit 1; }
for w in $TEAM $BUYBACK; do [ "$(cast code $w --rpc-url $RPC)" = "0x" ] || { echo "$w has code on it"; exit 1; }; done
NONCE=$(cast nonce $BUYBACK --rpc-url $RPC)
BAL=$(cast balance $BUYBACK --rpc-url $RPC -e)
S_AT=$(cast compute-address $BUYBACK --nonce $NONCE | awk '{print $NF}')
W_AT=$(cast compute-address $BUYBACK --nonce $((NONCE + 1)) | awk '{print $NF}')
echo "team wallet     $TEAM  (70%)"
echo "buyback wallet  $BUYBACK  (30%, deployer, holds $BAL ETH, nonce $NONCE)"
echo "splitter will be $S_AT   <- the \"Wallet\" field in the launch"
echo "swap will be     $W_AT"
forge build -q
if [ "$1" != "--broadcast" ]; then echo "dry run only: nothing sent. Run with --broadcast to deploy."; exit 0; fi
S=$(forge create src/SpeculaSplitter.sol:SpeculaSplitter --rpc-url $RPC --private-key $(cat $KEYFILE) --broadcast --constructor-args $TEAM $BUYBACK $FACTORY | awk '/Deployed to/{print $3}')
W=$(forge create src/SpeculaSwap.sol:SpeculaSwap --rpc-url $RPC --private-key $(cat $KEYFILE) --broadcast --constructor-args $FACTORY | awk '/Deployed to/{print $3}')
[ "$S" = "$S_AT" ] && [ "$W" = "$W_AT" ] || { echo "landed at $S / $W, expected $S_AT / $W_AT"; exit 1; }
[ "$(cast call $S 'team()(address)' --rpc-url $RPC)" = "$TEAM" ] || { echo "team wire wrong"; exit 1; }
[ "$(cast call $S 'buyback()(address)' --rpc-url $RPC)" = "$BUYBACK" ] || { echo "buyback wire wrong"; exit 1; }
[ "$(cast call $S 'setter()(address)' --rpc-url $RPC)" = "$BUYBACK" ] || { echo "setter wrong"; exit 1; }
[ "$(cast call $S 'factory()(address)' --rpc-url $RPC)" = "$FACTORY" ] || { echo "factory wrong"; exit 1; }
[ "$(cast call $W 'factory()(address)' --rpc-url $RPC)" = "$FACTORY" ] || { echo "swap factory wrong"; exit 1; }
mkdir -p broadcast
printf 'SPECULA_SPLITTER=%s\nSPECULA_SWAP=%s\n' $S $W > broadcast/specula-token.env
echo "deployed and checked. splitter $S, swap $W (written to token/broadcast/specula-token.env)"
