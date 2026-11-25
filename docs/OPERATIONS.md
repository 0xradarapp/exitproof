# ExitProof operations

This page covers two jobs that happen after the contracts are live: running the scanner daemon on a server, and
publishing the web app to DeWEB/TapeKit (scripts/build-deweb.mjs + scripts/publish-deweb.mjs, rehearsed on a fork). Neither has been run on mainnet yet.

## Scanner daemon on a Linux server

The daemon watches PotatoSwap `PairCreated` events in 100-block windows (the public RPC caps log queries at 100
blocks). For every new token it does four things:

1. runs the static scan;
2. resets a **local** anvil fork to the pair's block and runs the owner-power simulation;
3. ORs the result with what the registry already holds (the daemon never lowers a flag);
4. calls `RiskRegistry.attest`.

Progress is kept in `scanner/state/daemon.json`, so a restart resumes where it stopped.

### Environment

| Var | Meaning |
|---|---|
| `RPC_URL` | X Layer RPC for reads and for sending attestations. Default `https://rpc.xlayer.tech`. It is also the upstream that the fork is reset from. |
| `REGISTRY` | RiskRegistry address, from `deployments/xlayer.json` |
| `ATTESTER_KEY` | Private key of an attester. `deploy.mjs` makes the deployer an attester; a separate low-balance key is better, added with `setAttester(key, true)` from the registry owner. |
| `FORK_RPC` | A **local** anvil node, for example `http://127.0.0.1:8547`. The daemon calls `anvil_reset` on it for every pair, so never point it at a node you use for anything else. Without it, `ownerCanTrap` is not computed. |
| `START_BLOCK` | First block to scan on the first run. Use the router's deploy block, or a recent block. |
| `SEND=1` | Actually send attestations. Without it the daemon is a dry run. |
| `POLL_MS` | Poll interval, default 10000 |
| `STATE_FILE` | Optional override for `scanner/state/daemon.json`. The daemon always writes its reports to `scanner/reports/`. |

### Setup (Ubuntu 24.04)

```bash
# as a dedicated user
sudo useradd -m -s /bin/bash exitproof
sudo -iu exitproof
curl -L https://foundry.paradigm.xyz | bash && ~/.foundry/bin/foundryup   # anvil
# Node >= 22 (e.g. from NodeSource), then:
git clone <repo> exitproof && cd exitproof && npm ci && (cd scanner && npm ci)
mkdir -p scanner/state scanner/reports
```

The two `mkdir` directories must exist before the service starts, because the unit below makes the rest of the
filesystem read-only (`ProtectSystem=strict`).

Keep the secrets in a root-owned file that only the service user can read: `/etc/exitproof/scanner.env`, mode `0640`,
group `exitproof`.

```ini
RPC_URL=https://rpc.xlayer.tech
REGISTRY=0x...            # deployments/xlayer.json → registry
ATTESTER_KEY=0x...        # attester key, low balance (~0.01 OKB covers thousands of attestations)
FORK_RPC=http://127.0.0.1:8547
START_BLOCK=...           # router deploy block
SEND=1
```

`/etc/systemd/system/exitproof-fork.service`. This is the local fork the simulator uses. It is not pinned, because the
daemon resets it per pair.

```ini
[Unit]
Description=ExitProof scanner fork (anvil, local only)
After=network-online.target

[Service]
User=exitproof
ExecStart=/home/exitproof/.foundry/bin/anvil --fork-url https://rpc.xlayer.tech --chain-id 196 \
  --host 127.0.0.1 --port 8547 --silent --retries 10 --fork-retry-backoff 2000
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/exitproof-scanner.service`:

```ini
[Unit]
Description=ExitProof scanner daemon (PotatoSwap PairCreated → RiskRegistry)
After=exitproof-fork.service
Requires=exitproof-fork.service

[Service]
User=exitproof
WorkingDirectory=/home/exitproof/exitproof
EnvironmentFile=/etc/exitproof/scanner.env
ExecStart=/usr/bin/node scanner/src/cli.mjs daemon
Restart=always
RestartSec=15
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=-/home/exitproof/exitproof/scanner/state -/home/exitproof/exitproof/scanner/reports
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now exitproof-fork exitproof-scanner
journalctl -u exitproof-scanner -f
```

Notes:

- **Bind anvil to 127.0.0.1 only.** Its RPC can impersonate any account and reset state.
- **Do a dry run first.** Run once without `SEND=1` and read the reports in `scanner/reports/`, then enable sending.
- **One-off attestations:** `REGISTRY=… ATTESTER_KEY=… SEND=1 node scanner/src/cli.mjs attest <token> [pair]`. With `FORK_RPC` set and a pair given, the attestation includes the simulation. `--force` is the only way to lower a flag.
- **Known daemon limits** (scanner/README.md): no confirmation depth (X Layer has a central sequencer), and when several clones share a codehash, the last scanned one overwrites the report file. A simulation that keeps failing is attested as `ownerCanTrap` after 5 attempts, so it fails closed.
- **Spend:** one attestation is about 50–80k gas, a fraction of a cent at X Layer gas prices. Watch the attester's balance.

## Publishing web/ to DeWEB / TapeKit

DeWEB stores the site in our circuit NFT's ERC-6551 container (SiteRegistry). The name `<circuitId>.2.<processorIndex>.tape`
is activated in DomainBinding, and TapeKit gateways serve it at `https://<circuitId>-2-<processorIndex>.tapekit.org/`. Latch's
site, for example, is `2.2.435.tape`. The gateway's service worker reads every file from chain and checks its SHA-256.
It refuses to serve if SiteRegistry or DomainBinding run an implementation other than the pinned ones. Nothing has been
published on mainnet yet.

Contracts (X Layer; `publish-deweb.mjs` checks how they are wired and which implementation each runs):

| | Address |
|---|---|
| Opener | `0x536adD8F30f03b69f6fbF29d425A816A0dC50106` |
| SiteRegistry | `0xd6EFb7adCc9c83dC4924Ad56f6a8E4e969b9ADB6` |
| DomainBinding | `0x68809Fd2fb343aA57D0aeB7f33Defe477c9666f9` |

On 2026-11-25: `FEE()` = 0.08 OKB, `monthlyFee()` = 0, gas price 0.02 gwei, and no BEM is involved.

**1. Build.** This writes `dist/deweb/` and prints each file, its size, its sha256 and the total. The output has 12 files
and 673,977 bytes. `index.html` has the CSS, `verdict.js` + `app.js` and the mainnet config inlined, and its CSP is
hash-based. `vendor/ethers.min.js` is ethers 6.13.4, byte-identical to the npm tarball (sha384 checked). The 8 woff2
fonts and the two license files are also in the output. The build fails on any off-chain `src`/`href`/`url()` (TapeKit's
"100% on-chain" rule), on any unresolved or absolute reference, and on a loopback RPC. The config comes from
`deployments/xlayer.json` when that file exists. Otherwise the page shows its "mainnet deployment pending" state, so
**rebuild after `deploy.mjs`**. The build also writes `dist/deweb.manifest.json` with the config hash, the
router/registry/processor/circuitId it embedded, and each file's sha256. `publish-deweb.mjs` refuses a build whose
embedded values are empty or differ from `deployments/<network>.json`, and any file changed after the build.

```zsh
node scripts/build-deweb.mjs
```

**2. Dry run.** This needs `deployments/xlayer.json` from `tapeout.mjs`. It prints the name, the URL, the container, the
plan and the exact OKB, and sends nothing.

```zsh
DEPLOYER_KEY="$(k)" node scripts/publish-deweb.mjs
```

**3. Send.** The script stops at a banner unless `CONFIRM_MAINNET=yes` is set. It runs these steps in order:

1. open the container, paying the on-chain `FEE()`;
2. check that the wallet can edit the container (the NFT holder is the owner, so no grant is needed);
3. upload with `putFile`/`appendChunk` in 24,000-byte chunks, assets first and `index.html` last, reading every file
   back and comparing its SHA-256;
4. `setFallback("index.html")`;
5. `bind(name, container, MONTHS)`. MONTHS defaults to 1, the protocol minimum. With `monthlyFee()` at 0, renewing is
   free: run again with `MONTHS=n`. Watch `paidUntil` so the name stays live through judging;
6. resolve the name the way the TapeKit kernel does.

If it stops, run the same command again. It skips verified files and continues a half-uploaded file at the next chunk.
It records a nonce for every tx before broadcasting it. Before doing anything else, it settles any tx an earlier run left
unmined: it records the receipt if the tx landed, waits if the tx is pending, and decides by the account nonce if the
node does not know the tx. A lock file stops two runs from overlapping.

**Fee caps.** Before anything is sent, and again right before each payment, the script checks:
- the open fee is at most 0.1 OKB;
- the name fee (`monthlyFee × MONTHS`) is at most 0.05 OKB;
- all fees together are at most 0.15 OKB.

If a cap is exceeded it stops without sending anything. `FEE_CAP_OKB=<n>` replaces all three caps with `n`. The
Opener's runtime code hash is pinned (it is not a proxy), and the banner shows the hash and its ERC-1967 slot.

```zsh
DEPLOYER_KEY="$(k)" SEND=1 CONFIRM_MAINNET=yes node scripts/publish-deweb.mjs
```

Progress and every tx are recorded in `deployments/deweb-xlayer.json`. The script ends with
`DONE https://<id>-2-<index>.tapekit.org/`. Put that URL and the `.tape` name in the README judges table.

**Rehearsal on a fork** (run in a scratch copy of the repo, as `scripts/rehearse.sh` does, so the committed
`deployments/fork.json` is not touched). The key below is anvil's **public test key** for account #2 (anyone can derive
it), so use it only on a fork. Pick a free port that you own.
`DEPLOYMENT=fork` makes the build embed `deployments/fork.json`, for the rehearsal only.

```zsh
anvil --fork-url https://xlayerrpc.okx.com --chain-id 196 --port 8573 --silent &
cast rpc anvil_setBalance 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC 0xDE0B6B3A7640000 --rpc-url http://127.0.0.1:8573
cast rpc anvil_setStorageAt 0x60e62Efa9405d6873C5deaBD4E6CC91c25363952 "$(cast index address 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC 5)" "$(cast to-uint256 12000000)" --rpc-url http://127.0.0.1:8573
export RPC_URL=http://127.0.0.1:8573 DEPLOYER_KEY=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a
SEND=1 node scripts/tapeout.mjs && SEND=1 node scripts/deploy.mjs && DEPLOYMENT=fork node scripts/build-deweb.mjs && node scripts/publish-deweb.mjs && SEND=1 node scripts/publish-deweb.mjs
```

Measured on a fork of block 76,869,339 (2026-11-25):

- 38 txs: open 167,256 gas; 35 upload txs (a full 24,000-byte chunk is 5,366,591 gas, about 224 gas/byte); `setFallback` 114,238; `bind` 185,482.
- Total: **154,038,564 gas**. At 0.02 gwei that is 0.00308 OKB, so the whole publish costs **≈0.0831 OKB** (0.08 open fee + gas) and 0 BEM.
- The name came out as `1.2.453.tape` → `https://1-2-453.tapekit.org/` (processor index 453 on that fork).
- A run killed during the ethers upload resumed at chunk 7/22. A third run sent nothing.
- Fix round, fresh fork of block 76,870,299 (DEPLOYMENT=fork build, 674,096 bytes): 38 txs, 154,064,406 gas.
  - These were refused, with nothing sent: a pending build, a build for the wrong network, a stale router, a file edited after the build, and `FEE_CAP_OKB=0.01` (the nonce did not change).
  - A run killed after ethers chunk 9/22 resumed at 10/22 and took over its stale lock.
  - An injected lost tx was cleared after 6 nonce polls.
  - A tx whose result had been removed from the state file was found again from its receipt.
  - 31 days later the 1-month name had expired (`isLive` false), and a re-run re-bound it (134k gas). `bind` with 0 months reverts.

On mainnet the processor index is whatever `cpuAt` gives for our processor at tape-out time.

**Limits.** An *update* to a file that is already published is not atomic. From its `putFile` until its last chunk, the
gateway refuses that file (its hash does not match), so a re-publish of `index.html` takes the page down for about 3
blocks. `MONTHS` can be at most 120 (`MAX_AHEAD`). A separate upload key would need
`setOperator(container, uploader, ttl ≤ 30 days)` from the holder. The script always publishes from the holder, so it
never sends that.
