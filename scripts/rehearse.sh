#!/usr/bin/env bash
# ExitProof end-to-end rehearsal on a FRESH local anvil fork of X Layer mainnet, from zero. Nothing is sent to mainnet.
#
#   bash scripts/rehearse.sh            (PORT=8549 by default; PORT=8551 bash scripts/rehearse.sh if 8549 is busy)
#
# Steps, each through the same scripts that run on mainnet:
#   1. anvil --fork-block-number 76861306; fund anvil account #2 (0.05 OKB + 1 BEM on the copy only)
#   2. scripts/tapeout.mjs   create the processor, mint 54 NAND, tape out, verify 2048/2048 on the forked processor
#   3. scripts/deploy.mjs    dry run, then SEND=1: RiskRegistry + setAttester + ExitProofRouter
#   4. scripts/demo-fork.mjs six fixture tokens with real PotatoSwap pairs + one allowed buy
#   5. CLI verdicts: clean / blacklist / sellTax99 / secondHop / timebomb (before and after a scanner attestation,
#      simulated on this fork)
#   6. one CLI buy through the router
#   7. cost summary, then "REHEARSAL OK"
#
# It runs in a throw-away copy of the repo (node_modules symlinked), so the committed deployments/fork.json,
# deployments/fork-demo.json and web/config.json are never touched and a concurrent run cannot interfere.
# KEEP=1 copies the fresh fork artifacts back (deployments/fork*.json and only networks.fork of web/config.json).
# anvil is killed on exit.
# Env: PORT (default 8549), FORK_URL (default https://xlayerrpc.okx.com; https://rpc.xlayer.tech also serves the
#      pinned block but returns CloudFront 403s under load), KEEP=1. A full run takes about 7 minutes.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
export PATH="$HOME/.foundry/bin:$PATH"

PORT="${PORT:-8549}"
RPC="http://127.0.0.1:$PORT"
FORK_URL="${FORK_URL:-https://xlayerrpc.okx.com}"
BLOCK=76861306
# anvil default accounts #2 (deployer/attester) and #3 (buyer); #0, #1, #5 and #6 carry EIP-7702 code on X Layer
DEPLOYER_KEY=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a
BUYER_KEY=0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6
BEM=0x60e62Efa9405d6873C5deaBD4E6CC91c25363952
BEM_BALANCE_SLOT=5

step() { printf '\n==== %s\n' "$*"; }
fail() { printf '\nREHEARSAL FAILED: %s\n' "$*" >&2; exit 1; }

if cast chain-id --rpc-url "$RPC" >/dev/null 2>&1; then
  fail "something already listens on port $PORT; stop it or run PORT=<free port> bash scripts/rehearse.sh"
fi
[ -d node_modules ] && [ -d scanner/node_modules ] || fail "run npm ci (repo root) and (cd scanner && npm ci) first"

WORK=$(mktemp -d)
ANVIL=""
cleanup() {
  local code=$?
  if [ -n "$ANVIL" ]; then kill "$ANVIL" 2>/dev/null || true; wait "$ANVIL" 2>/dev/null || true; fi
  if [ "${KEEP:-}" = 1 ] && [ "$code" = 0 ]; then
    cp "$WORK/deployments/fork.json" "$WORK/deployments/fork-demo.json" "$ROOT/deployments/"
    node -e 'const fs=require("fs");const [a,b]=process.argv.slice(1);const src=JSON.parse(fs.readFileSync(a));const dst=JSON.parse(fs.readFileSync(b));dst.networks.fork=src.networks.fork;fs.writeFileSync(b,JSON.stringify(dst,null,2)+"\n")' \
      "$WORK/web/config.json" "$ROOT/web/config.json"
    echo "KEEP=1: copied deployments/fork.json, deployments/fork-demo.json and networks.fork of web/config.json back"
  fi
  rm -rf "$WORK"
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# a private copy of the repo; from zero: no tape-out or deployment state for the fork
rsync -a --exclude .git --exclude node_modules --exclude refs --exclude .superpowers --exclude 'scanner/reports' \
  --exclude 'scanner/state' --exclude docs ./ "$WORK/"
ln -s "$ROOT/node_modules" "$WORK/node_modules"
ln -s "$ROOT/scanner/node_modules" "$WORK/scanner/node_modules"
rm -f "$WORK/deployments/fork.json" "$WORK/deployments/fork-demo.json" "$WORK/deployments/xlayer.json"
cd "$WORK"
echo "work copy $WORK"

step "build"
forge build >/dev/null
echo "forge build ok"

step "anvil fork of X Layer at block $BLOCK on $RPC"
anvil --fork-url "$FORK_URL" --fork-block-number "$BLOCK" --chain-id 196 --port "$PORT" --silent \
  --retries 10 --fork-retry-backoff 2000 --compute-units-per-second 200 &
ANVIL=$!
for _ in $(seq 1 60); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 1; done
cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 || fail "anvil did not start"
DEPLOYER=$(cast wallet address --private-key "$DEPLOYER_KEY")
BUYER=$(cast wallet address --private-key "$BUYER_KEY")
cast rpc anvil_setBalance "$DEPLOYER" 0xB1A2BC2EC50000 --rpc-url "$RPC" >/dev/null           # 0.05 OKB (fork only)
SLOT=$(cast index address "$DEPLOYER" "$BEM_BALANCE_SLOT")
cast rpc anvil_setStorageAt "$BEM" "$SLOT" "$(cast to-uint256 100000000)" --rpc-url "$RPC" >/dev/null   # 1 BEM
echo "deployer $DEPLOYER: $(cast balance "$DEPLOYER" --ether --rpc-url "$RPC") OKB, BEM $(cast call "$BEM" 'balanceOf(address)(uint256)' "$DEPLOYER" --rpc-url "$RPC")"

export RPC_URL="$RPC"

step "1/6 tapeout.mjs (SEND=1, fork)"
# resumable; on a cold fork the processor scan can hit the public RPC's rate limit, so retry
ok=0
for i in 1 2 3 4 5; do
  if DEPLOYER_KEY="$DEPLOYER_KEY" SEND=1 node scripts/tapeout.mjs; then ok=1; break; fi
  echo "tapeout.mjs attempt $i stopped; retrying in 60 s (it resumes)"; sleep 60
done
[ "$ok" = 1 ] || fail "tapeout.mjs"

step "2/6 deploy.mjs (dry run, then SEND=1, fork)"
before=$(shasum deployments/fork.json web/config.json)
DEPLOYER_KEY="$DEPLOYER_KEY" node scripts/deploy.mjs
[ "$before" = "$(shasum deployments/fork.json web/config.json)" ] || fail "deploy.mjs dry run wrote files"
echo "dry run wrote nothing ✓"

echo "-- recorded registry tx the node has never seen (lost send): only a positive not-found may clear it"
N0=$(cast nonce "$DEPLOYER" --rpc-url "$RPC")
node -e 'const fs=require("fs");const f="deployments/fork.json";const d=JSON.parse(fs.readFileSync(f));
  d.pending={registry:{nonce:Number(process.argv[1]),address:process.argv[2],tx:"0x"+"de".repeat(32)}};fs.writeFileSync(f,JSON.stringify(d,null,2)+"\n")' \
  "$N0" "$(cast compute-address "$DEPLOYER" --nonce "$N0" | awk '{print $NF}')"
LOST=$(DEPLOYER_KEY="$DEPLOYER_KEY" node scripts/deploy.mjs 2>&1 || true)
grep -E "Resume|not found" <<<"$LOST" || true
grep -q "tx not found on the node and nonce $N0 unused" <<<"$LOST" || fail "a lost registry tx was not recognised as not-found"
echo "   dry run: lost tx recognised, would re-send with exactly nonce $N0 (the record stays until a SEND run) ✓"
echo "-- interrupted deploy: kill deploy.mjs after the RiskRegistry send, before its receipt"
cast rpc evm_setAutomine false --rpc-url "$RPC" >/dev/null
DEPLOYER_KEY="$DEPLOYER_KEY" SEND=1 node scripts/deploy.mjs >"$WORK/deploy-killed.log" 2>&1 &
DPID=$!
# wait for a REAL registry tx: the run first clears the lost-tx record above (positive not-found), then sends
pend() { node -e 'const d=require("./deployments/fork.json");const p=(d.pending||{}).registry;console.log(p&&p.tx&&!/^0x(de)+$/.test(p.tx)?p.address:"")'; }
for _ in $(seq 1 300); do [ -n "$(pend)" ] && break; sleep 1; done
PENDING_REG=$(pend)
[ -n "$PENDING_REG" ] || { cat "$WORK/deploy-killed.log"; fail "deploy.mjs did not record a registry tx"; }
kill "$DPID" 2>/dev/null; wait "$DPID" 2>/dev/null || true
echo "   killed with registry tx recorded and unmined; predicted registry $PENDING_REG (code: $(cast code "$PENDING_REG" --rpc-url "$RPC"))"
echo "-- re-run while that tx is still pending: must refuse and send nothing"
RERUN=$(DEPLOYER_KEY="$DEPLOYER_KEY" SEND=1 node scripts/deploy.mjs 2>&1 || true)
grep -E "Resume|STOPPED" <<<"$RERUN" || true
grep -qE "known to the node but not mined|used or pending|could not look up" <<<"$RERUN" || fail "re-run with a pending registry tx did not refuse"
[ "$(cast rpc txpool_status --rpc-url "$RPC" | node -p 'parseInt(JSON.parse(require("fs").readFileSync(0,"utf8")).pending)')" = 1 ] \
  || fail "a second transaction was sent while the first was pending"
echo "   refused, still exactly 1 pending tx ✓"
cast rpc evm_mine --rpc-url "$RPC" >/dev/null
cast rpc evm_setAutomine true --rpc-url "$RPC" >/dev/null
echo "-- mined it; drop the recorded tx hash so the resume must find the registry by its predicted address + bytecode"
REG_TX=$(node -p 'require("./deployments/fork.json").pending.registry.tx')
node -e 'const fs=require("fs");const f="deployments/fork.json";const d=JSON.parse(fs.readFileSync(f));delete d.pending.registry.tx;fs.writeFileSync(f,JSON.stringify(d,null,2)+"\n")'
DEPLOYER_KEY="$DEPLOYER_KEY" SEND=1 node scripts/deploy.mjs
# bookkeeping for the cost summary only: the resume above found the registry by address, so it never saw the receipt
REG_GAS=$(cast receipt "$REG_TX" gasUsed --rpc-url "$RPC")
node -e 'const fs=require("fs");const f="deployments/fork.json";const d=JSON.parse(fs.readFileSync(f));d.gas["deploy RiskRegistry"]=process.argv[1];fs.writeFileSync(f,JSON.stringify(d,null,2)+"\n")' "$REG_GAS"
REGISTRY=$(node -p "require('./deployments/fork.json').registry")
N1=$(cast nonce "$DEPLOYER" --rpc-url "$RPC")
[ "$(cast to-check-sum-address "$REGISTRY")" = "$(cast to-check-sum-address "$PENDING_REG")" ] || fail "registry $REGISTRY is not the interrupted one $PENDING_REG"
[ "$N1" = $((N0 + 3)) ] || fail "deployer nonce went $N0 -> $N1, expected exactly 3 txs (registry, setAttester, router)"
echo "   resumed: adopted registry $REGISTRY, nonce $N0 -> $N1 (registry + setAttester + router; no second registry) ✓"
AGAIN=$(DEPLOYER_KEY="$DEPLOYER_KEY" SEND=1 node scripts/deploy.mjs)
grep -q "Already deployed" <<<"$AGAIN" || fail "deploy.mjs re-run is not idempotent"
[ "$(cast nonce "$DEPLOYER" --rpc-url "$RPC")" = "$N1" ] || fail "idempotent re-run sent a transaction"
echo "re-run: already deployed, nothing sent ✓"
DEPLOY_BLOCK=$(node -p "require('./deployments/fork.json').deployBlock")
ROUTER_BLOCK=$(cast receipt "$(node -p "require('./deployments/fork.json').routerTx")" blockNumber --rpc-url "$RPC")
[ "$DEPLOY_BLOCK" = "$ROUTER_BLOCK" ] || fail "deployments/fork.json deployBlock $DEPLOY_BLOCK is not the router receipt block $ROUTER_BLOCK"
[ "$(node -p "require('./web/config.json').networks.fork.deployBlock")" = "$DEPLOY_BLOCK" ] || fail "web/config.json networks.fork.deployBlock not written"
echo "deployBlock $DEPLOY_BLOCK (router receipt) in deployments/fork.json and web/config.json ✓"

step "3/6 demo-fork.mjs (fixture tokens + PotatoSwap pairs + one allowed buy)"
# the fixtures need 30 OKB of pool liquidity; top up only now, after tape-out and deploy costs were measured
cast rpc anvil_setBalance "$DEPLOYER" 0x56BC75E2D63100000 --rpc-url "$RPC" >/dev/null   # 100 OKB (fork only)
DEPLOYER_KEY="$DEPLOYER_KEY" BUYER_KEY="$BUYER_KEY" node scripts/demo-fork.mjs
tok() { node -p "require('./deployments/fork-demo.json').tokens['$1'].address"; }

step "4/6 CLI verdicts (node cli/exitproof.mjs check, --network fork)"
CHECKS=0
expect() { # expect <token name> <mode> <allow|blocked> <reason>
  local name=$1 mode=$2 want=$3 reason=$4 out got
  out=$(node cli/exitproof.mjs check "$(tok "$name")" --mode "$mode" --network fork || true)
  got=$(printf '%s' "$out" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log(j.verdict+" "+j.reason+" facts="+j.facts)}catch{console.log("unparseable")}})')
  printf '  %-15s %-10s -> %-28s (want %s %s)\n' "$name" "$mode" "$got" "$want" "$reason"
  [ "${got%% facts=*}" = "$want $reason" ] || { printf '%s\n' "$out"; fail "$name $mode: got '$got', want '$want $reason'"; }
  CHECKS=$((CHECKS + 1))
}
expect CleanToken     permissive allow   0
expect CleanToken     balanced   allow   0
expect BlacklistOnBuy permissive blocked 1
expect SellTax99      permissive blocked 2
expect SecondHopTrap  permissive blocked 1
expect FeeToken       permissive allow   0
expect FeeToken       strict     blocked 2
expect TimeBombToken  balanced   blocked 6
expect TimeBombToken  permissive allow   0

echo "  scanner attest TimeBombToken (scanner/src/cli.mjs attest, SEND=1, attester = deployer, simulation on this fork)"
# The scanner refuses to send without the sell simulation (FORK_RPC + pair). It runs on this same anvil: simulate
# works between evm_snapshot / evm_revert and always rewinds the node, so the later steps see the same state.
TB_PAIR=$(node -p "require('./deployments/fork-demo.json').tokens.TimeBombToken.pair")
REGISTRY="$REGISTRY" ATTESTER_KEY="$DEPLOYER_KEY" FORK_RPC="$RPC" SEND=1 REPORTS_DIR="$WORK/reports" \
  node scanner/src/cli.mjs attest "$(tok TimeBombToken)" "$TB_PAIR" >"$WORK/attest.json" 2>"$WORK/attest.err" \
  || { cat "$WORK/attest.err"; fail "scanner attest"; }
grep -E "attested .* status success" "$WORK/attest.err" >/dev/null || { cat "$WORK/attest.err"; fail "attest tx not successful"; }
node -e 'const j=require(process.argv[1]);console.log("  flags: privileged="+j.privileged+" upgradeable="+j.upgradeable+" dangerSetter="+j.dangerSetter+" ownerCanTrap="+j.ownerCanTrap)' "$WORK/attest.json"
expect TimeBombToken  balanced   blocked 5

step "5/6 CLI buy (EXITPROOF_KEY = anvil #3, CleanToken 0.01 OKB, balanced, --yes)"
BUY=$(EXITPROOF_KEY="$BUYER_KEY" node cli/exitproof.mjs buy "$(tok CleanToken)" --amount 0.01 --mode balanced --network fork --yes) || { printf '%s\n' "$BUY"; fail "CLI buy"; }
printf '%s' "$BUY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(!j.sent||j.status!=="success"){console.log(s);process.exit(1)}console.log("  sent "+j.tx+" · status "+j.status+" · gasUsed "+j.gasUsed+" · received "+j.receivedFormatted+" "+(j.check.symbol||""))})' \
  || fail "CLI buy did not succeed"
BUY_GAS=$(printf '%s' "$BUY" | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).gasUsed')
echo "  blocked buy refused before sending:"
NOBUY=$(EXITPROOF_KEY="$BUYER_KEY" node cli/exitproof.mjs buy "$(tok BlacklistOnBuy)" --amount 0.01 --mode permissive --network fork --yes || true)
case "$NOBUY" in *'"sent": false'*) ;; *) false ;; esac || { printf '%s\n' "$NOBUY"; fail "BlacklistOnBuy buy was not refused"; }
echo "  BlacklistOnBuy: sent=false ✓"

step "6/6 cost summary"
BUY_GAS="$BUY_GAS" CHECKS="$CHECKS" node -e '
const d = require("./deployments/fork.json"), demo = require("./deployments/fork-demo.json");
const g = d.gas || {};
const row = (k) => "  " + k.padEnd(28) + String(g[k] ?? "-").padStart(10);
console.log("Processor        " + d.processor + "  circuit #" + d.circuitId + "  (" + d.verified.evals + " evals on chain)");
console.log("Registry         " + d.registry);
console.log("Router           " + d.router);
console.log("Tape-out spend   " + Number(d.spent.okb).toFixed(6) + " OKB + " + d.spent.bem + " BEM");
console.log("Deploy spend     " + Number(d.deploySpentOkb).toFixed(6) + " OKB");
console.log("Total            " + (Number(d.spent.okb) + Number(d.deploySpentOkb)).toFixed(6) + " OKB + " + d.spent.bem + " BEM");
console.log("Gas per tx");
for (const k of Object.keys(g)) console.log(row(k));
console.log("  " + "demo buy (first, scan)".padEnd(28) + demo.demoBuy.gas.padStart(10));
console.log("  " + "CLI buy (cached scan)".padEnd(28) + process.env.BUY_GAS.padStart(10));
console.log("CLI verdicts     " + process.env.CHECKS + "/" + process.env.CHECKS + " as expected");
'
echo
echo "REHEARSAL OK"
