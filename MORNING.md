# Mainnet go-live: the commands, in order

Run these yourself, from the repo root, in one terminal. Every code block can be pasted as is into zsh: the blocks
contain no comments, and every explanation is in the text around them.

The key is read from `.env`, which holds only the raw key, and is passed to the scripts through the environment
(`DEPLOYER_KEY=… node …`). It is never printed and never put on a command line.

The only commands that spend money are the ones with `SEND=1`.

- `tapeout.mjs` and `deploy.mjs` also need `CONFIRM_MAINNET=yes`. Without it they stop at a banner that shows exactly what they would send.
- The scanner's `attest` and `daemon` have **no** such gate: on mainnet, `SEND=1` sends attestations right away.

Run every dry run first.

## Setup (once per terminal)

This defines `k`, which prints the key from `.env` with a `0x` prefix. Use it only inside `$(k)`. The second command
derives the address from the key through the environment, and must print
`0x2ef673b3e40acfc1e378c2e15b9a03756b2cc92c`.

```zsh
cd ~/Desktop/aiprojects/exitproof
k() { local x; x=$(sed -E 's/^DEPLOYER_KEY=//' .env | tr -d ' \r\n'); case "$x" in 0x*) ;; *) x="0x$x" ;; esac; printf '%s' "$x"; }
ME=$(DEPLOYER_KEY="$(k)" node --input-type=module -e "import { privateKeyToAccount } from 'viem/accounts'; console.log(privateKeyToAccount(process.env.DEPLOYER_KEY).address)")
echo "$ME"
```

## 0. Balances (read-only)

You need at least 0.05 OKB. You also need at least 0.12 BEM, which is `12000000` in BEM's 8 decimals.

```zsh
cast balance "$ME" --ether --rpc-url https://rpc.xlayer.tech
cast call 0x60e62Efa9405d6873C5deaBD4E6CC91c25363952 'balanceOf(address)(uint256)' "$ME" --rpc-url https://rpc.xlayer.tech
```

If BEM is short, swap about 0.015 OKB for BEM on the BEM/WOKB pool, or bridge it from BSC through tapeout.net. The
budget is in [docs/COSTS.md](docs/COSTS.md).

## 1. Tape-out (processor + 54 NAND + circuit)

Install and build, then run the dry run. It prints the plan and the exact BEM and OKB, and sends nothing.

```zsh
npm ci && (cd scanner && npm ci) && forge build
DEPLOYER_KEY="$(k)" node scripts/tapeout.mjs
```

Then send.

```zsh
DEPLOYER_KEY="$(k)" SEND=1 CONFIRM_MAINNET=yes node scripts/tapeout.mjs
```

- **Expected spend:** 0.11 BEM + 0.0013 OKB + a little gas.
- **Expected result:** `✓ eval 2048/2048 ✓`, then `PROCESSOR=… CIRCUIT_ID=…`, and `deployments/xlayer.json` is written.
- **If it stops** (an RPC 403 or a timeout): run the same send command again. It resumes and never creates a second processor.

## 2. Deploy RiskRegistry + ExitProofRouter

The dry run prints the exact constructor arguments and the estimated OKB.

```zsh
DEPLOYER_KEY="$(k)" node scripts/deploy.mjs
```

Optionally, set `FEE_RECIPIENT` to send the 10 bps fee to an address other than the deployer (see Hardening below).
The send:

```zsh
DEPLOYER_KEY="$(k)" SEND=1 CONFIRM_MAINNET=yes node scripts/deploy.mjs
```

It ends with `ROUTER=… REGISTRY=…`. It writes the addresses, tx hashes and constructor args into
`deployments/xlayer.json`, and fills `networks.xlayer` (router, registry, processor, circuitId) in `web/config.json`.

**If it stops halfway, run the same send command again.** Before each deploy it records the nonce and the predicted
address, and it records the tx hash right after sending. A re-run first checks what actually landed, and it refuses
to send anything while an earlier transaction may still be pending.

## 3. Source verification (Sourcify, then OKLink)

`deploy.mjs` prints the exact commands at the end of a successful run. To print them again, re-run the dry run. It
sends nothing and ends with the "Source verification" lines.

```zsh
DEPLOYER_KEY="$(k)" node scripts/deploy.mjs
```

Copy and run the two `forge verify-contract … --verifier sourcify` lines it prints. Then run the same two lines with
the OKLink flags it prints. Check the results at `https://repo.sourcify.dev/196/<router>` and on OKLink
(`https://www.oklink.com/xlayer/address/<router>`, tab "Contract").

## 4. Scanner: first attestation, then the daemon

First the registry address, then a read-only scan of one live token. FUT is the ledger example; pick the token on the
day.

```zsh
REG=$(node -p "require('./deployments/xlayer.json').registry")
TOKEN=0xE204E5e33029023AbB90d16d67D774D89802ec64
node scanner/src/cli.mjs scan "$TOKEN"
```

Run the attestation as a dry run first; it prints what it would write.

```zsh
REGISTRY="$REG" ATTESTER_KEY="$(k)" node scanner/src/cli.mjs attest "$TOKEN"
```

Then send it. There is no CONFIRM gate: this sends one attestation transaction right away. After that, check the
token through the router. Expect `blocked`: reason 5 in balanced mode, or reason 1 if trading is already off.

```zsh
REGISTRY="$REG" ATTESTER_KEY="$(k)" SEND=1 node scanner/src/cli.mjs attest "$TOKEN"
node cli/exitproof.mjs check "$TOKEN" --network xlayer
```

The daemon needs a local fork, which the simulator resets for every pair. Start it in a **second terminal**. It
listens on localhost only. Leave it running.

```zsh
anvil --fork-url https://rpc.xlayer.tech --chain-id 196 --host 127.0.0.1 --port 8547 --silent --retries 10
```

Back in the first terminal, find the block to start from (the router's deploy block), then start the daemon **without**
`SEND=1`. It scans and simulates, and writes reports to `scanner/reports/`, but sends nothing. When a few pairs have
been processed and the reports look right, stop it with **Ctrl-C**.

```zsh
START=$(cast receipt "$(node -p "require('./deployments/xlayer.json').routerTx")" blockNumber --rpc-url https://rpc.xlayer.tech)
RPC_URL=https://rpc.xlayer.tech REGISTRY="$REG" START_BLOCK="$START" FORK_RPC=http://127.0.0.1:8547 ATTESTER_KEY="$(k)" node scanner/src/cli.mjs daemon
```

Then run it live. This sends an attestation for every new pair; stop it with Ctrl-C. To run it permanently on the
Linux server, see [docs/OPERATIONS.md](docs/OPERATIONS.md).

```zsh
RPC_URL=https://rpc.xlayer.tech REGISTRY="$REG" START_BLOCK="$START" FORK_RPC=http://127.0.0.1:8547 ATTESTER_KEY="$(k)" SEND=1 node scanner/src/cli.mjs daemon
```

## 5. Web config check

`networks.xlayer` must show `router`, `registry`, `processor` and `circuitId` set, and `buyEnabled` true.

```zsh
node -p "JSON.stringify(require('./web/config.json').networks.xlayer, null, 1)"
```

Serve the app and open `http://127.0.0.1:8765/`, then choose the network "X Layer". Stop the server with Ctrl-C when
you are done.

```zsh
cd web && python3 -m http.server 8765
```

Back at the repo root (`cd ..`), check a clean token and the FUT token in the browser. Then make one small buy
(0.01 OKB) through the app, and let the wallet use its own gas estimate. Then commit the mainnet artifacts:

```zsh
git add deployments/xlayer.json web/config.json && git commit -m "chore: mainnet deployment"
```

## 6. Google Form

1. Open [SUBMISSION.md](SUBMISSION.md) and the README judges table.
2. Replace every `TBD (mainnet pending)` with the values from `deployments/xlayer.json`: `processor`, `circuitId`, `router`, `registry`.
3. Add the access link, the repo URL and, after recording ([docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md)), the video link.
4. Paste each "Form fields" section of SUBMISSION.md into the matching form field.

Deadline: **2026-12-07 23:59 UTC**.

## Optional: hardening after the deploy

None of this is required. It separates the roles that the deployer holds by default.

- **Fee recipient.** The fee recipient is fixed at deploy time. To use another address you control, add `FEE_RECIPIENT=0x…` to both `deploy.mjs` commands in step 2, before the first send.
- **Registry roles.** After the deploy you can add a separate attester, remove the deployer as attester, and hand the registry ownership to another address. Ownership transfer is single-step, so double-check the new owner address.

`cast` has no environment variable for a raw private key. To keep the key off the command line, import it once into
an encrypted cast keystore. The `--interactive` flag asks you to paste the key, and then asks for a password.

```zsh
cast wallet import exitproof-deployer --interactive
```

Then fill in the two addresses and send the three transactions. Each one asks for the keystore password.

```zsh
NEW_ATTESTER=0x0000000000000000000000000000000000000000
NEW_OWNER=0x0000000000000000000000000000000000000000
cast send "$REG" 'setAttester(address,bool)' "$NEW_ATTESTER" true --account exitproof-deployer --rpc-url https://rpc.xlayer.tech
cast send "$REG" 'setAttester(address,bool)' "$ME" false --account exitproof-deployer --rpc-url https://rpc.xlayer.tech
cast send "$REG" 'transferOwnership(address)' "$NEW_OWNER" --account exitproof-deployer --rpc-url https://rpc.xlayer.tech
```

After this, the scanner and the daemon need the new attester's key as `ATTESTER_KEY`.
