# Mainnet go-live: the commands, in order

Run these yourself from the repo root, in one terminal. Every command reads the key from `.env`, which holds only the
raw key, and never prints it. Nothing here runs without you: each sending step has a dry run first, and it stops at a
banner unless `CONFIRM_MAINNET=yes` is set.

```bash
cd ~/Desktop/aiprojects/exitproof
# k prints the key from .env with a 0x prefix (never echo it; it is only used inside $(k))
k() { local x; x=$(sed -E 's/^DEPLOYER_KEY=//' .env | tr -d ' \r\n'); case "$x" in 0x*) ;; *) x="0x$x";; esac; printf '%s' "$x"; }
cast wallet address --private-key "$(k)"        # must print 0x2ef673b3e40acfc1e378c2e15b9a03756b2cc92c
```

## 0. Balances (read-only)

```bash
ME=$(cast wallet address --private-key "$(k)")
cast balance "$ME" --ether --rpc-url https://rpc.xlayer.tech                                   # need ≥ 0.05 OKB
cast call 0x60e62Efa9405d6873C5deaBD4E6CC91c25363952 'balanceOf(address)(uint256)' "$ME" --rpc-url https://rpc.xlayer.tech   # need ≥ 12000000 (0.12 BEM, 8 decimals)
```

If BEM is short, swap about 0.015 OKB for BEM on the BEM/WOKB pool, or bridge it from BSC through tapeout.net. The
budget is in [docs/COSTS.md](docs/COSTS.md).

## 1. Tape-out (processor + 54 NAND + circuit)

```bash
npm ci && (cd scanner && npm ci) && forge build
DEPLOYER_KEY="$(k)" node scripts/tapeout.mjs                             # dry run: plan, exact BEM/OKB, nothing sent
DEPLOYER_KEY="$(k)" SEND=1 CONFIRM_MAINNET=yes node scripts/tapeout.mjs  # sends; ends with PROCESSOR=… CIRCUIT_ID=…
```

- **Expected spend:** 0.11 BEM + 0.0013 OKB + gas.
- **Expected result:** `✓ eval 2048/2048 ✓`, and `deployments/xlayer.json` is written.
- **If it stops** (an RPC 403 or a timeout): run the same SEND command again. It resumes and never creates a second processor.

## 2. Deploy RiskRegistry + ExitProofRouter

```bash
DEPLOYER_KEY="$(k)" node scripts/deploy.mjs                              # dry run: constructor args + estimated OKB
DEPLOYER_KEY="$(k)" SEND=1 CONFIRM_MAINNET=yes node scripts/deploy.mjs   # sends; ends with ROUTER=… REGISTRY=…
```

This writes the router, the registry, the tx hashes and the constructor args into `deployments/xlayer.json`. It also
fills `networks.xlayer` (router, registry, processor, circuitId) in `web/config.json`.

## 3. Source verification (Sourcify, then OKLink)

`deploy.mjs` prints the exact commands at the end. To print them again (this sends nothing):

```bash
DEPLOYER_KEY="$(k)" node scripts/deploy.mjs | sed -n '/Source verification/,$p'
```

Run the two `forge verify-contract … --verifier sourcify` lines. Then run the same two lines with the OKLink flags
that were printed. Check the results:

- `https://repo.sourcify.dev/196/<router>`
- `https://www.oklink.com/xlayer/address/<router>#code`

## 4. Scanner: first attestation, then the daemon

```bash
REG=$(node -p "require('./deployments/xlayer.json').registry")
# one live token (read-only scan first; pick the token on the day, FUT is the ledger example)
node scanner/src/cli.mjs scan 0xE204E5e33029023AbB90d16d67D774D89802ec64
REGISTRY=$REG ATTESTER_KEY="$(k)" node scanner/src/cli.mjs attest 0xE204E5e33029023AbB90d16d67D774D89802ec64          # dry run
REGISTRY=$REG ATTESTER_KEY="$(k)" SEND=1 node scanner/src/cli.mjs attest 0xE204E5e33029023AbB90d16d67D774D89802ec64   # attests
node cli/exitproof.mjs check 0xE204E5e33029023AbB90d16d67D774D89802ec64 --network xlayer   # expect blocked: reason 5 (balanced), or 1 if trading is off
```

Daemon. Use a second terminal for the local fork the simulator resets; bind it to localhost only:

```bash
anvil --fork-url https://rpc.xlayer.tech --chain-id 196 --host 127.0.0.1 --port 8547 --silent --retries 10
```

Back in the first terminal:

```bash
START=$(cast receipt "$(node -p "require('./deployments/xlayer.json').routerTx")" blockNumber --rpc-url https://rpc.xlayer.tech)
RPC_URL=https://rpc.xlayer.tech REGISTRY=$REG START_BLOCK=$START FORK_RPC=http://127.0.0.1:8547 \
  ATTESTER_KEY="$(k)" node scanner/src/cli.mjs daemon            # dry run first: watch a few pairs, read scanner/reports/
RPC_URL=https://rpc.xlayer.tech REGISTRY=$REG START_BLOCK=$START FORK_RPC=http://127.0.0.1:8547 \
  ATTESTER_KEY="$(k)" SEND=1 node scanner/src/cli.mjs daemon     # live
```

To run it on the Linux server, see [docs/OPERATIONS.md](docs/OPERATIONS.md). A separate low-balance attester key is
better there: `setAttester(<key>, true)` from the deployer.

## 5. Web config check

```bash
node -p "JSON.stringify(require('./web/config.json').networks.xlayer, null, 1)"   # router/registry/processor/circuitId set, buyEnabled true
(cd web && python3 -m http.server 8765)                                          # open http://127.0.0.1:8765/ → network "X Layer"
```

Check a clean token and the FUT token in the browser, then make one small buy (0.01 OKB) through the app. Let the
wallet use its own gas estimate, which must be ≥ 3.5M. Then commit the mainnet artifacts:

```bash
git add deployments/xlayer.json web/config.json && git commit -m "chore: mainnet deployment"
```

## 6. Google Form

1. Open [SUBMISSION.md](SUBMISSION.md) and the README judges table.
2. Replace every `TBD (mainnet pending)` with the values from `deployments/xlayer.json`: `processor`, `circuitId`, `router`, `registry`.
3. Add the access link, the repo URL and, after recording ([docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md)), the video link.
4. Paste each "Form fields" section of SUBMISSION.md into the matching form field.

Deadline: **2026-12-07 23:59 UTC**.
