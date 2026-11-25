# ExitProof operations

This page covers two jobs that happen after the contracts are live: running the scanner daemon on a server, and
publishing the web app to DeWEB/TapeKit. Neither has been run on mainnet yet.

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

TapeOut's DeWEB stores a site **inside a circuit's ERC-6551 container**, and TapeKit gateways serve it at
`https://<circuitId>-2-<processorIndex>.tapekit.org/` under the name `<circuitId>.2.<processorIndex>.tape`. Latch did
this (`2.2.435.tape`, circuit #2 on processor index 435). The flow below comes from reading its
`scripts/publish-deweb.mjs`, `scripts/preflight-deweb.sh` and `scripts/check-onchain.mjs` in `refs/latch/`. ExitProof
does not have a publish script yet. This is the plan, and nothing has been sent.

### Contracts (X Layer mainnet; confirm on chain before using)

| | Address | Used for |
|---|---|---|
| Opener (ERC-6551 container) | `0x536adD8F30f03b69f6fbF29d425A816A0dC50106` | `isOpened(processor, id)`, `accountOf(processor, id)`, `FEE()`, `open(processor, id)` payable |
| SiteRegistry | `0xd6EFb7adCc9c83dC4924Ad56f6a8E4e969b9ADB6` | `putFile(container, path, contentType, sha256, data)`, `appendChunk(container, path, expectIndex, data)`, `setFallback(container, path)`, `fileInfo`, `readRange` |
| DomainBinding | `0x68809Fd2fb343aA57D0aeB7f33Defe477c9666f9` | `monthlyFee()`, `bind(name, container, months)` payable, `isLive(name, container)` |

Read on 2026-11-25: `FEE()` = **0.08 OKB**, `monthlyFee()` = **0**, `cpuCount()` = 453.

### Steps

1. **Build one self-contained HTML file.** TapeKit's "100% on-chain" rule rejects any off-chain URL in `src`/`href`/`srcset`, CSS `url()` or `@import`, and meta refresh (see `refs/latch/scripts/check-onchain.mjs`). For ExitProof that means:
   - bundle ethers into the page instead of loading it from cdnjs, and inline `app.js`, `verdict.js` and `style.css`;
   - inline the Barlow woff2 files as `data:` URIs (latin + latin-ext, about 155 KB as base64), and inline `config.json` with only the `xlayer` network;
   - update the CSP meta tag: inline scripts need a hash or `'unsafe-inline'`, and `connect-src` must list the RPCs the page uses. Latch kept to TapeKit's default X Layer nodes;
   - check that no `127.0.0.1` or `localhost` string is left in the file, and check the file with the static rule.
2. **Find the name.** Look up the processor's index *i* in the TapeOut factory (`cpuAt(i) == processor`). The name is `<circuitId>.2.<i>.tape`. If our processor were created right after block 76,861,306 it would get index 453, but read it from chain.
3. **Holder check:** `processor.ownerOf(circuitId)` must be the publishing wallet. That is the deployer, which holds the circuit NFT after `tapeout.mjs`.
4. **Open the container,** once: `open(processor, circuitId)` with `value = FEE()`. The container address is `accountOf(processor, circuitId)`.
5. **Upload** in 24,000-byte chunks: `putFile(container, "index.html", "text/html; charset=utf-8", sha256(file), chunk0)`, then `appendChunk(container, "index.html", k, chunk_k)` for k = 1… This is resumable, because `fileInfo` gives the stored sha256 and the chunk count.
6. `setFallback(container, "index.html")`.
7. `bind(name, container, months)` with `value = monthlyFee() × months` (currently 0).
8. **Read back** the whole file with `readRange` and compare the sha256. Check `isContainerLive(container)`. Open `https://<id>-2-<i>.tapekit.org/`.
9. **Rehearse first** on an anvil fork with the same script (`RPC_URL=http://127.0.0.1:8549 SEND=1`), as Latch's `preflight-deweb.sh` does, then dry-run against mainnet to print the exact fees.

The cost is about 0.08 OKB for the container plus about 0.01 OKB of storage gas for a file of about 650 KB (see
[COSTS.md](COSTS.md#deweb-optional-see-operationsmd-storage-is-an-estimate)). After publishing, put the `.tape` name and the gateway URL in
the README judges table.

Latch's code is GPL-2.0, and ExitProof is MIT. Write our own publisher from the steps above instead of copying theirs.
