# Mainnet go-live: the commands, in order

Run these yourself, from the repo root, in one terminal (step 4 also opens a second one). Every code block can be
pasted as is into zsh (also `zsh -f -i`): the blocks contain no comments, and every explanation is in the text around
them.

The key is read from `.env`, which holds only the raw key, and is passed to the scripts through the environment
(`DEPLOYER_KEY=… node …`). It is never printed and never put on a command line.

The only commands that spend money are the ones with `SEND=1`. On mainnet every one of them also needs
`CONFIRM_MAINNET=yes`: `tapeout.mjs`, `deploy.mjs`, `publish-deweb.mjs`, and the scanner's `attest`, `daemon` and
`backfill`. Without it they stop at a banner that shows what they would send.

Run every dry run first.

## Setup (once per terminal)

This makes `.env` readable by you only, and defines `k`, which prints the key from `.env` with a `0x` prefix. Use `k`
only inside `$(k)`. The last two commands derive the address from the key through the environment. It must print
`0x2Ef673B3E40acFc1E378C2E15b9a03756b2CC92C` (the checksummed form of `0x2ef673b3…c92c`; compare it ignoring case).

```zsh
cd ~/Desktop/aiprojects/exitproof
chmod 600 .env
k() { local x; x=$(sed -E 's/^DEPLOYER_KEY=//' .env | tr -d ' \r\n'); case "$x" in 0x*) ;; *) x="0x$x" ;; esac; printf '%s' "$x"; }
ME=$(DEPLOYER_KEY="$(k)" node --input-type=module -e "import { privateKeyToAccount } from 'viem/accounts'; console.log(privateKeyToAccount(process.env.DEPLOYER_KEY).address)")
echo "$ME"
```

`.env` must hold the key as `0x<key>`, `<key>` or `DEPLOYER_KEY=<key>` on one line. A quoted value, an `export`
prefix or a comment line makes `ME` come out empty, and nothing can be sent.

## 0. Balances (read-only)

You need about **0.15 OKB** in total: about 0.05 OKB for the tape-out, the deploy, the attestations and a few demo
buys, about 0.09 OKB for the DeWEB publish in step 2b, and 0.005 OKB of gas money for the backfill shard keys in
step 4b. You also need at least 0.12 BEM, which is `12000000` in
BEM's 8 decimals.

```zsh
cast balance "$ME" --ether --rpc-url https://rpc.xlayer.tech
cast call 0x60e62Efa9405d6873C5deaBD4E6CC91c25363952 'balanceOf(address)(uint256)' "$ME" --rpc-url https://rpc.xlayer.tech
```

If BEM is short, swap about 0.015 OKB for BEM on the BEM/WOKB pool, or bridge it from BSC through tapeout.net. The
budget is in [docs/COSTS.md](docs/COSTS.md). If `rpc.xlayer.tech` answers HTTP 403, use
`https://xlayerrpc.okx.com` in its place, here and in every command below.

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

The fee recipient is fixed forever at deploy time. We recommend a **cold address**: one you control whose key is not
on this machine and never signs anything routine. Type it after `FEE=` and paste the block. Left empty, the fee goes
to the deployer. The dry run prints the exact constructor arguments (check the `feeRecipient` line) and the estimated
OKB. Before it plans anything it re-reads the netlist and re-runs `eval` on all 2048 inputs on the processor.

```zsh
FEE=
DEPLOYER_KEY="$(k)" FEE_RECIPIENT="$FEE" node scripts/deploy.mjs
```

The send, in the same terminal (it reuses `FEE`):

```zsh
DEPLOYER_KEY="$(k)" FEE_RECIPIENT="$FEE" SEND=1 CONFIRM_MAINNET=yes node scripts/deploy.mjs
```

It ends with `ROUTER=… REGISTRY=… DEPLOY_BLOCK=…`. It writes the addresses, tx hashes, constructor args and
`deployBlock` (the block of the router's deploy receipt) into `deployments/xlayer.json`, and fills `networks.xlayer`
(router, registry, processor, circuitId, deployBlock) in `web/config.json`.

**If it stops halfway, run the same send command again.** Before each deploy it records the nonce and the predicted
address, and it records the tx hash right after sending. A re-run first checks what actually landed, and it refuses
to send anything while an earlier transaction may still be pending.

## 2b. Publish the app to DeWEB (TapeKit)

Do this **after** step 2. The DeWEB build reads the router and registry from `deployments/xlayer.json`. The publish
script refuses a stale build, or one still in the "mainnet deployment pending" state, so run `build-deweb.mjs` after
`deploy.mjs`.

First write the usage totals snapshot into `web/config.json`, so a fresh browser starts from it instead of counting
every block since the deploy. Then build. The build writes only `dist/deweb/` (12 files, about 720 KB), allows both
RPC hosts (`rpc.xlayer.tech` and the fallback `xlayerrpc.okx.com`) in the CSP, and checks TapeKit's "100% on-chain"
rule.

```zsh
node cli/exitproof.mjs stats --network xlayer --write
node scripts/build-deweb.mjs
```

The dry run prints the `.tape` name, the gateway URL, the container, the plan and the exact OKB, and sends nothing.
`MONTHS=3` binds the name for three months, because a one-month binding (the script's default) expires after 30 days
and judging may take longer. The monthly fee is currently 0. Running the same send command later with `MONTHS=n`
renews the binding. The script hard-caps its fees (open ≤ 0.1 OKB, bind ≤ 0.05 OKB, total ≤ 0.15 OKB) and stops if
the chain asks for more.

```zsh
DEPLOYER_KEY="$(k)" MONTHS=3 node scripts/publish-deweb.mjs
```

Then send. Expect about 0.0831 OKB: the one-time container fee of 0.08 OKB plus about 154M gas. If it stops halfway,
run the same command again; it resumes and skips the files it has already verified.

```zsh
DEPLOYER_KEY="$(k)" MONTHS=3 SEND=1 CONFIRM_MAINNET=yes node scripts/publish-deweb.mjs
```

It ends with `DONE https://<id>-2-<index>.tapekit.org/`. Print the name and the URL again from the progress file,
open the URL in a browser, and check one token on the page.

```zsh
node -p "require('./deployments/deweb-xlayer.json').name + '  ' + require('./deployments/deweb-xlayer.json').url"
```

Put that URL and the `.tape` name in the README judges table (the "On DeWEB" row) and in SUBMISSION.md (the
"Access link" field), replacing their `TBD`. Commit `deployments/deweb-xlayer.json` together with the other mainnet
artifacts in step 5. If you rebuild the site later, run the `stats … --write` line again first.

## 3. Source verification (Sourcify, then OKLink)

`deploy.mjs` prints the exact commands at the end of a successful run. To print them again, re-run the dry run. It
sends nothing and ends with the "Source verification" lines.

```zsh
DEPLOYER_KEY="$(k)" FEE_RECIPIENT="$FEE" node scripts/deploy.mjs
```

Copy and run the two `forge verify-contract … --verifier sourcify` lines it prints. Then run the same two lines with
the OKLink flags it prints. Check the results at `https://repo.sourcify.dev/196/<router>` and on OKLink
(`https://www.oklink.com/xlayer/address/<router>`, tab "Contract").

## 4. Scanner: first attestations, the backfill, then the daemon

Every scanner send runs **with `FORK_RPC`**, a local anvil fork the simulator uses for the sell and owner-power
simulation. Without it an attestation is static only, and a static "clean" entry can turn strict mode's "not scanned"
block into an allow for a token whose trap only the simulation sees.

Start the fork in a **second terminal**. It listens on localhost only. Leave it running.

```zsh
anvil --fork-url https://xlayerrpc.okx.com --chain-id 196 --host 127.0.0.1 --port 8547 --silent --retries 10
```

Back in the first terminal: the registry address, two live example tokens and their PotatoSwap pairs, and a
read-only check of each through the new router. Both were checked against the final router on a fork of block
76,876,829: `RED` (OKS) is a honeypot that nobody can sell (reason 1 in every mode; a buy sent anyway reverted with
`Blocked(1)`), and `AMBER` (羊屎蛋) is a Flap launchpad token that sells fine but is a proxy. The default mode is
permissive (the exit proof), so `AMBER` is allowed, and the owner-risk advisory shows balanced and strict holding it
back (reason 4) until it is scanned. Re-check both on the day; tokens change.

```zsh
REG=$(node -p "require('./deployments/xlayer.json').registry")
RED=0xfDd1f2103f566fc4aAb4a8d95b29dEeEc45eD2a5
AMBER=0x7e97D98e5103dA0F28C03E92A545dDFFED277777
RED_PAIR=$(cast call 0x630DB8E822805c82Ca40a54daE02dd5aC31f7fcF 'getPair(address,address)(address)' "$RED" 0xe538905cf8410324e03A5A23C1c177a474D59b2b --rpc-url https://xlayerrpc.okx.com)
AMBER_PAIR=$(cast call 0x630DB8E822805c82Ca40a54daE02dd5aC31f7fcF 'getPair(address,address)(address)' "$AMBER" 0xe538905cf8410324e03A5A23C1c177a474D59b2b --rpc-url https://xlayerrpc.okx.com)
node cli/exitproof.mjs check "$RED" --network xlayer
node cli/exitproof.mjs check "$AMBER" --network xlayer
```

Expect `RED`: `"state": "red"`, reason 1, and `"ownerRisk": null`. `AMBER`: `"state": "green"` (permissive), and
`ownerRisk` lists balanced and strict with reason 4. The per-mode verdicts are under `modes`.

Attest `AMBER` as a dry run first, with the simulation; it prints what it would write and takes a minute or two.

```zsh
REGISTRY="$REG" FORK_RPC=http://127.0.0.1:8547 ATTESTER_KEY="$(k)" node scanner/src/cli.mjs attest "$AMBER" "$AMBER_PAIR"
```

Then send it, and check the token again through the router. The scanner resolves the Flap clone to its
implementation, so the entry replaces the on-chain "upgradeable" guess: permissive stays green, and the advisory now
shows reason 5 for balanced and strict (the scanner flags its owner powers). Reason 4 is gone: the verdict comes from
the attestation.

```zsh
REGISTRY="$REG" FORK_RPC=http://127.0.0.1:8547 ATTESTER_KEY="$(k)" SEND=1 CONFIRM_MAINNET=yes node scanner/src/cli.mjs attest "$AMBER" "$AMBER_PAIR"
node cli/exitproof.mjs check "$AMBER" --network xlayer
```

### 4b. Launch-day backfill of the existing pairs

The daemon only follows pairs created after it starts, so without a backfill every token already listed stays "not
scanned". The backfill scans and attests the existing PotatoSwap pairs (about 950 with a live pool), **newest first**,
at one pinned block, and records every finished token in a state file, so a stopped run resumes where it stopped.

Time is the limit, not money: 950 attestations cost about 0.0015 OKB, but the simulation takes about 69 s per token
on a cold fork, about 18 hours on one fork. So run it on the Linux home server (Tailscale `<server-ip>`) in
**shards**: `SHARD=i/N` takes only the pairs whose factory index is `i` mod `N`, with its own state file, and each
shard gets its own anvil fork. With `N=5` that is about 190 tokens per shard, roughly 4–6 hours. Use `N=4` if the
fork logs show HTTP 403/429 from the RPC, `N=6` if the server is idle. `SWEEP_BUDGET_S=600` gives each token 10
minutes of simulation instead of 3: on a cold fork a sweep cut short by the budget is attested fail-closed
(`sweep-incomplete`), which is safe but blocks honest tokens. Partial coverage is fine: the newest pairs come first in
every shard.

Each shard sends with **its own attester key**, created on the server, so the shards never race for a nonce and your
main key never leaves this machine. Type your server login after `SRV=` (for example `you@<server-ip>`) and the
shard count after `N=`, and paste the block. It copies the repo (without `.env` and `node_modules`), installs the
dependencies, and creates one key per shard, `~/.exitproof-shard0.key` to `~/.exitproof-shard<N-1>.key`, with its
address next to it in `~/.exitproof-shard<i>.addr`, both readable by you only (mode 600). The key and address are
written once, from the output of `cast wallet new`; an existing key is kept, so the block is safe to run again. No key
ever appears on a command line. The server needs Node ≥ 22 and
Foundry, as in [docs/OPERATIONS.md](docs/OPERATIONS.md).

```zsh
SRV=
N=5
[ -n "$SRV" ] || { echo "set SRV=user@<server-ip> first"; false; } && rsync -a --exclude .git --exclude node_modules --exclude .env --exclude refs --exclude .superpowers --exclude scanner/state --exclude scanner/reports ./ "${SRV}:exitproof/" && ssh "$SRV" 'cd ~/exitproof && npm ci && cd scanner && npm ci' && ssh "$SRV" "set -o pipefail; umask 077 && cd ~/exitproof && for i in \$(seq 0 $((N-1))); do f=\$HOME/.exitproof-shard\$i.key; a=\$HOME/.exitproof-shard\$i.addr; if [ ! -s \$f ]; then ~/.foundry/bin/cast wallet new 2>&1 | awk -v k=\$f -v a=\$a '/^Address/{print \$2 > a} /^Private key/{print \$3 > k}' || exit 1; elif [ ! -s \$a ]; then chmod 600 \$f && node scripts/key-address.mjs \$f > \$a || exit 1; fi; [ -s \$f ] && [ -s \$a ] || { echo shard \$i: key or address file empty; exit 1; }; chmod 600 \$f \$a; done"
```

Read the shard addresses into `ATT`. The server reads each `.addr` file and checks it against its key file with
`scripts/key-address.mjs`, which reads the key inside node and prints only the address. The second line checks that
there are exactly `N` addresses and prints them, or clears `ATT`. The third line must print `600` for every key and
address file.

```zsh
ATT=$(ssh "$SRV" "set -o pipefail; cd ~/exitproof && for i in \$(seq 0 $((N-1))); do a=\$(cat \$HOME/.exitproof-shard\$i.addr) && [ -n \"\$a\" ] && [ \"\$a\" = \"\$(node scripts/key-address.mjs \$HOME/.exitproof-shard\$i.key)\" ] || { echo shard \$i: address file missing or does not match its key >&2; exit 1; }; echo \$a; done | paste -sd, -")
[ "$(printf '%s' "$ATT" | tr ',' '\n' | grep -c '^0x')" = "$N" ] && echo "$ATT" || { echo "expected $N shard addresses, got: $ATT"; ATT=; }
ssh "$SRV" "for i in \$(seq 0 $((N-1))); do stat -c '%a %n' \$HOME/.exitproof-shard\$i.key \$HOME/.exitproof-shard\$i.addr; done"
```

Register those addresses as attesters and give each 0.001 OKB for gas (a shard of 190 tokens needs about 0.0003),
sent from your deployer, the registry owner. Dry run first; it prints the plan, the total and the deployer's balance,
and sends nothing. The script caps funding at 0.01 OKB per address and 0.05 OKB in total, refuses the zero address,
the registry, the router and your own deployer, and skips anything already done. To register again without sending
any more OKB (for example after a re-run), put `FUND_OKB=0` in front.

```zsh
ATTESTERS="$ATT" DEPLOYER_KEY="$(k)" node scripts/add-attesters.mjs
```

```zsh
ATTESTERS="$ATT" DEPLOYER_KEY="$(k)" SEND=1 CONFIRM_MAINNET=yes node scripts/add-attesters.mjs
```

Start one fork per shard on the server, in the background (they stay up when you log out), on ports 8551 and up, and
pin every shard to the same block. The second line waits until every fork answers (it gives up after about two
minutes per fork). Then a dry run of the 3 newest pairs of shard 0; it sends nothing and prints one line per token and
the cost estimate.

```zsh
ssh "$SRV" "for i in \$(seq 0 $((N-1))); do nohup ~/.foundry/bin/anvil --fork-url https://xlayerrpc.okx.com --chain-id 196 --host 127.0.0.1 --port \$((8551+i)) --silent --retries 10 > ~/anvil-shard\$i.log 2>&1 < /dev/null & done"
ssh "$SRV" "for i in \$(seq 0 $((N-1))); do n=0; until ~/.foundry/bin/cast chain-id --rpc-url http://127.0.0.1:\$((8551+i)) >/dev/null 2>&1; do n=\$((n+1)); [ \$n -ge 60 ] && { echo fork \$i did not start; exit 1; }; sleep 2; done; done; echo forks up"
BLK=$(cast block-number --rpc-url https://xlayerrpc.okx.com)
ssh "$SRV" "cd ~/exitproof && LIMIT=3 SHARD=0/$N BLOCK=$BLK SWEEP_BUDGET_S=600 FORK_RPC=http://127.0.0.1:8551 FORK_UPSTREAM=https://xlayerrpc.okx.com REGISTRY=$REG node scanner/src/cli.mjs backfill"
```

Then all shards live, in the background on the server, started 30 s apart. Each one shows the mainnet banner in its
log and sends one attestation per token whose entry is new or changed, with its own key.

```zsh
ssh "$SRV" "cd ~/exitproof && for i in \$(seq 0 $((N-1))); do nohup env SHARD=\$i/$N BLOCK=$BLK SWEEP_BUDGET_S=600 FORK_RPC=http://127.0.0.1:\$((8551+i)) FORK_UPSTREAM=https://xlayerrpc.okx.com REGISTRY=$REG ATTESTER_KEY_FILE=\$HOME/.exitproof-shard\$i.key SEND=1 CONFIRM_MAINNET=yes node scanner/src/cli.mjs backfill > backfill-shard\$i.log 2>&1 < /dev/null & sleep 30; done"
```

Check progress with the first line below (the last lines of each shard's log) and how many shards are still running
with the second. When none is running, run the live block again once: every finished token is skipped (each state
file pins the block), so only tokens that ended in an RPC error are retried. Then stop the forks with the last line.

```zsh
ssh "$SRV" 'tail -n 2 ~/exitproof/backfill-shard*.log'
ssh "$SRV" 'pgrep -fc "[c]li.mjs backfill" || true'
ssh "$SRV" 'pkill -f "[a]nvil.*--port 85[5-9][0-9]" || true'
```

### 4c. The daemon (new pairs)

The daemon sends with your deployer key, and the backfill shards with their own keys, so they can run at the same
time. The daemon begins at the router's deploy block, so it catches up on every pair created in the meantime. It reads
`SWEEP_BUDGET_S` too. First a dry run, **without** `SEND=1`: it scans, simulates and
writes reports to `scanner/reports/`, but sends nothing. When a few pairs have been processed and the reports look
right, stop it with **Ctrl-C**.

```zsh
START=$(node -p "require('./deployments/xlayer.json').deployBlock")
REGISTRY="$REG" START_BLOCK="$START" SWEEP_BUDGET_S=600 FORK_RPC=http://127.0.0.1:8547 ATTESTER_KEY="$(k)" node scanner/src/cli.mjs daemon
```

Then run it live. This sends an attestation for every new pair; stop it with Ctrl-C. To run it permanently on the
Linux server, see [docs/OPERATIONS.md](docs/OPERATIONS.md).

```zsh
REGISTRY="$REG" START_BLOCK="$START" SWEEP_BUDGET_S=600 FORK_RPC=http://127.0.0.1:8547 ATTESTER_KEY="$(k)" SEND=1 CONFIRM_MAINNET=yes node scanner/src/cli.mjs daemon
```

## 5. Web config check

`networks.xlayer` must show `router`, `registry`, `processor`, `circuitId` and `deployBlock` set, and `buyEnabled`
true.

```zsh
node -p "JSON.stringify(require('./web/config.json').networks.xlayer, null, 1)"
```

Serve the app and open `http://127.0.0.1:8765/?network=xlayer`. Stop the server with Ctrl-C when you are done.

```zsh
cd web && python3 -m http.server 8765
```

Back at the repo root (`cd ..`), check `RED` and `AMBER` in the browser (red and amber plates), and a token that is
green in balanced. Then make one small buy (0.01 OKB) of a green token through the app, and let the wallet use its
own gas estimate. Then commit the mainnet artifacts:

```zsh
git add deployments/xlayer.json deployments/deweb-xlayer.json web/config.json README.md SUBMISSION.md && git commit -m "chore: mainnet deployment"
```

## 6. Google Form

1. Open [SUBMISSION.md](SUBMISSION.md) and the README judges table.
2. Replace every `TBD (mainnet pending)` with the values from `deployments/xlayer.json`: `processor`, `circuitId`, `router`, `registry`.
3. Add the access link, the repo URL and, after recording ([docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md)), the video link.
4. Paste each "Form fields" section of SUBMISSION.md into the matching form field.

Deadline: **2026-12-07 23:59 UTC**.

## Optional: hardening after the deploy

None of this is required. It separates the roles that the deployer holds by default (registry owner and attester).
The fee recipient is set in step 2.

Registry ownership moves in two steps: the owner nominates a new owner with `transferOwnership`, and the new owner
takes over by calling `acceptOwnership()` from its own key. Until then the old owner stays in charge, so a typo
cannot lock the registry.

**If you ran the backfill, revoke the shard attesters first**, while your deployer is still the registry owner
(after the ownership transfer only the new owner's key could do it). In the same terminal, with `SRV` and `N` set as
in step 4b, run the step 4b block that reads `ATT` again (it re-reads the addresses from the server), then the dry
run and the send below.

```zsh
REMOVE=1 ATTESTERS="$ATT" DEPLOYER_KEY="$(k)" node scripts/add-attesters.mjs
```

```zsh
REMOVE=1 ATTESTERS="$ATT" DEPLOYER_KEY="$(k)" SEND=1 CONFIRM_MAINNET=yes node scripts/add-attesters.mjs
```

`cast` has no environment variable for a raw private key. To keep the key off the command line, import it once into
an encrypted cast keystore. The `--interactive` flag asks you to paste the key, and then asks for a password.

```zsh
cast wallet import exitproof-deployer --interactive
```

Then type the two addresses after `NEW_ATTESTER=` and `NEW_OWNER=` and run the block. If either is left empty, the
block prints a message and sends nothing. The three transactions run one after another, each asks for the keystore
password, and the chain stops at the first failure.

```zsh
NEW_ATTESTER=
NEW_OWNER=
[ -n "$NEW_ATTESTER" ] && [ -n "$NEW_OWNER" ] && [ -n "$REG" ] && [ -n "$ME" ] || { echo "set NEW_ATTESTER, NEW_OWNER (and run the Setup and step 4 blocks for ME and REG) first"; false; } && cast send "$REG" 'setAttester(address,bool)' "$NEW_ATTESTER" true --account exitproof-deployer --rpc-url https://rpc.xlayer.tech && cast send "$REG" 'setAttester(address,bool)' "$ME" false --account exitproof-deployer --rpc-url https://rpc.xlayer.tech && cast send "$REG" 'transferOwnership(address)' "$NEW_OWNER" --account exitproof-deployer --rpc-url https://rpc.xlayer.tech
```

Then, from the new owner's wallet, call `acceptOwnership()` on the registry, and check `owner()`:

```zsh
cast call "$REG" 'owner()(address)' --rpc-url https://rpc.xlayer.tech
cast call "$REG" 'pendingOwner()(address)' --rpc-url https://rpc.xlayer.tech
```

After this, `attest` and the daemon need the new attester's key as `ATTESTER_KEY`.
