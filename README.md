# ExitProof

**Don't buy what you can't sell.** ExitProof is a buy router on X Layer. It buys a token, sells the whole position back
in the same transaction, and lets a TapeOut circuit decide whether the buy goes through. If the circuit says no, the
transaction reverts and your OKB stays where it was.

**English** · [Türkçe özet](#türkçe-özet)

## For judges (X Layer TapeOut Accelerate)

| | |
|---|---|
| **Live app** | `TBD (mainnet pending)`. Until then, the same static app runs against a local mainnet fork (`web/`, see [Run it yourself](#run-it-yourself)); screenshots are in [docs/screenshots/](docs/screenshots/) |
| **On DeWEB** | `TBD (mainnet pending)`: `<circuit>.2.<processor index>.tape` on TapeKit; the plan is in [docs/OPERATIONS.md](docs/OPERATIONS.md#publishing-web-to-deweb--tapekit) |
| **Demo video (≤ 3 min)** | `TBD (video link)`; the script is [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md) |
| **TapeOut processor** | `TBD (mainnet pending)`: ExitProof's own processor "ExitProof Guard" (EXITP), created by `scripts/tapeout.mjs` |
| **Circuit ID** | `TBD (mainnet pending)`: the policy chip. 54 NAND, 11 inputs, 4 outputs. It decides allow/deny and a reason code on every guarded buy. |
| **Contracts** | ExitProofRouter `TBD (mainnet pending)` · RiskRegistry `TBD (mainnet pending)` · trades on PotatoSwap V2 (factory [`0x630D…7fcF`](https://www.oklink.com/xlayer/address/0x630DB8E822805c82Ca40a54daE02dd5aC31f7fcF), 25 bps) with WOKB `0xe538…9b2b` |
| **TapeOut features used** | **Circuits:** every `buyETH`, `buy` and `inspect` call runs `processor.eval(circuitId, facts)` inside the transaction. The router has no other allow/deny logic, and Solidity only adds money checks (minOut, deadline, fee cap). **Own processor + tape-out:** createCPU, NAND mint and tapeout, all scripted and rehearsed (`scripts/tapeout.mjs`). **DeWEB/TapeKit:** the app is static with no build step; the on-chain DeWEB publish is pending (ethers gets vendored first, see [docs/OPERATIONS.md](docs/OPERATIONS.md)). |
| **Business** | 10 bps on routed buys, with an immutable cap of 30 bps. Paid scanner API and bulk attestations for launchpads and wallets. An "ExitProof verified" launch badge. See [Revenue](#revenue) and [SUBMISSION.md](SUBMISSION.md). |
| **Usage** | Allowed buys emit `Checked`; scanner verdicts emit `Attested`. The web feed reads both from chain. Blocked buys revert, so they never show up as events, and we don't claim on-chain "blocked" counts. |
| **Verified source** | `TBD (mainnet pending)`. `scripts/deploy.mjs` prints the exact `forge verify-contract … --verifier sourcify --chain 196` and OKLink commands after deploying. |
| **Assurance** | Circuit checked on all 2048 inputs off chain and again on a real TapeOut processor (fork of mainnet) · test counts at commit `5fb8343`: 92 offline Foundry tests (unit, fuzz, invariant, gas), 30 fork tests on real PotatoSwap pairs and the real processor (including a 32-buy fork stress run), 81 scanner tests, 2 CLI tests · adversarial reviews after every task, with the bypasses they found fixed ([Security review history](#security-review-history)) · one-command fork rehearsal of the whole mainnet flow (`scripts/rehearse.sh`) |
| **AI agents** | [`agent/SKILL.md`](agent/SKILL.md): an OKX Agentic Wallet skill. `cli/exitproof.mjs check` gives a JSON verdict; `tx` prepares a `buyETH` call for `onchainos wallet contract-call`. Agents get a check they can read by machine, and the same check is enforced on chain when they buy. |
| **Built during the event** | All of it. First commit 2026-11-25. |

## What it does

A honeypot lets you buy and then stops you selling. It might blacklist you, charge a 99% sell tax, cap your sell
size, or wait until the owner flips a switch. ExitProof does the sell attempt for you, with the real pool, inside your
own buy, before the buy is allowed to stand.

### One guarded buy

```
you: buyETH(PotatoSwap, token, minOut, mode, to, deadline) + OKB
 └─ router: take 10 bps fee, wrap OKB, check the pair == factory.getPair(token, WOKB)
 └─ BUY      swap WOKB → token on the real pair (balance-diff aware: measures the buy tax)
 └─ PROBE    try this.probeSell(...)                         ← always reverts, so none of this survives
       ├─ deploy a fresh ProbeHolder (CREATE2), hand it the tokens (the same hop your wallet will get)
       ├─ the holder sells 100% back to the pair
       └─ revert ProbeResult(ok, held, out)                  → sellOk, sell tax, hop loss
 └─ FACTS    sellOk · sellTax bucket · buyTax bucket · owner() active · upgradeable · danger · unscanned · mode
             (owner() staticcall, on-chain bytecode scan cached per codehash, RiskRegistry flags)
 └─ EVAL     processor.eval(circuitId, 11 bits) → 1 byte: allow | reason << 1
 └─ allow    send the tokens to `to` (minOut checked on what actually arrived) → event Checked(...)
    deny     revert Blocked(reason, facts)  → the whole transaction unwinds, the OKB never left your wallet
```

`inspect(...)` runs the same path through `eth_call` and always reverts with `Report(facts, allow, reason, buyOut, sellOut)`.
That makes it a free check for the web app, the CLI and agents.

### Modes

| Mode | Allows when | Who it is for |
|---|---|---|
| **permissive** | the full sell-back works and both taxes are under 15% | "just tell me if it's a honeypot" |
| **balanced** (default) | permissive, plus: not upgradeable, and if the owner is still active, the token must be scanned and have no dangerous setter | everyday buys of fresh launches |
| **strict** | balanced, plus: both taxes under 5%, no active owner, scanned, and the scanner's allowlist passes | only allowlisted surfaces; blocks most launch tokens, by design |

Mode 3 is treated as strict. The web app, CLI and agent skill all default to balanced.

### Facts (circuit inputs) and reason codes (circuit outputs)

| bit | fact | source |
|---|---|---|
| 0 | `sellOk`: the full position was sold back | probe |
| 1-2 | `sellTax` bucket: 0 under 5%, 1 5–15%, 2 15–50%, 3 50% or more, or not measurable | probe |
| 3-4 | `buyTax` bucket (same buckets, including the hop to the holder) | buy leg + probe |
| 5 | `ownerActive`: `owner()` is non-zero, or the registry says `privileged` | staticcall + registry |
| 6 | `upgradeable`: the on-chain scan finds DELEGATECALL/CALLCODE (unscanned tokens), or the registry says `upgradeable` | BytecodeScan + registry |
| 7 | `danger`: the registry says `dangerSetter` or `ownerCanTrap` | registry |
| 8 | `unscanned`: no registry entry for the token's codehash | registry |
| 9-10 | mode: 0 strict, 1 balanced, 2 permissive, 3 strict | caller |

| reason | meaning |
|---|---|
| 0 | allowed |
| 1 | you could buy, but you could not sell all of it back |
| 2 | sell tax too high for this mode |
| 3 | buy tax too high for this mode |
| 4 | upgradeable: the code can be swapped after you buy |
| 5 | dangerous owner powers (balanced: an active owner with a dangerous setter; strict: any dangerous setter) |
| 6 | not scanned yet (balanced: only when the owner is active; strict: always) |
| 7 | the owner is still active (strict only) |

The reason is the first check that fails, in this order. The reference model is [`circuit/spec.py`](circuit/spec.py).

## The circuit

- **Source:** `circuit/policy.v` (combinational RTL). It mirrors `circuit/spec.py`, which is the single source of truth.
- **Synthesis:** Yosys (`circuit/synth.ys`: `synth`, `abc`, then `abc -g NAND`). `circuit/build.py` turns the result into TapeOut's netlist format (7 bytes per gate, `[0x00][a:u24][b:u24]`): 54 NAND, 33 two-input NANDs and 21 inverters. sha256 is `a3d81e06…d983b`.
- **Verification:**
  - Off chain, `build.py` and `circuit/test_circuit.py` evaluate the netlist on all 2048 inputs and compare against `spec.py`. That produces `circuit/truth.json`.
  - Before any spending, `scripts/tapeout.mjs` re-runs the 2048-input check locally.
  - After the tape-out it reads the netlist back from the processor (byte-identical, 378 bytes), checks `circuitInfo == (11, 4, 0, 54)`, and calls `eval` on all 2048 inputs through Multicall3.
  - Fork result: `2048/2048`. The Foundry fork test `test_fork_eval_matches_truth_all_2048` checks the same thing from Solidity, at about 137k gas per `eval`.

## Three defence layers

1. **On chain, at swap time:** the real sell-back probe through a fresh holder, buy and sell tax buckets, an `owner()` staticcall, and a PUSH-aware bytecode scan for DELEGATECALL/CALLCODE/SELFDESTRUCT. The scan result is cached per codehash, so only the first buyer of a codehash pays for it.
2. **RiskRegistry:** flags keyed by `EXTCODEHASH`, written by an attester running the open-source deterministic scanner (`scanner/`). For a scanned token, the registry's `upgradeable` replaces the on-chain scan, because the scanner checks reachability and the on-chain scan is a linear heuristic.
3. **Owner-power simulation (`ownerCanTrap`):** on a local anvil fork, the scanner impersonates the owner, calls every dangerous setter with worst-case arguments, and retries the sell. If any setter can trap a holder, the token gets `ownerCanTrap`.

## Scanner model (allowlist)

`scanner/` (v4) follows the dispatcher chain from offset 0 and checks every external selector against a SAFE list:
the ERC-20 surface, permit/EIP-712, ERC-165, `owner`/`getOwner`/`renounceOwnership`, and a few pair/router getters.
Any other selector, a non-trivial fallback, caller-vs-storage or caller-vs-literal comparisons (hidden or constant
admins), live calls to non-literal targets, BALANCE/SELFBALANCE/EXTCODE* reads of foreign state, or a live owner makes
the token `privileged`. Strict mode therefore has an allowlist guarantee. Balanced mode uses `dangerSetter`, which is
based on a list of dangerous selectors, plus live SELFDESTRUCT. A dispatcher the scanner does not recognize fails
closed. EIP-1167 and ERC-7511 clones are resolved to their implementation. Details and residual risks are in
[scanner/README.md](scanner/README.md). A scan census of live PotatoSwap tokens is in [docs/CENSUS.md](docs/CENSUS.md).

The daemon (`node scanner/src/cli.mjs daemon`) watches PotatoSwap `PairCreated` in 100-block windows and attests each
new token. That is how strict and balanced modes work for fresh launches.

## Security review history

Each task went through an adversarial review before it was accepted. These are the real bypasses the reviews found,
and every one of them was fixed and covered by a test or a recorded manual check:

| Found | Fix |
|---|---|
| **Forged CBOR trailer:** a fake solc metadata trailer, padded with JUMPDEST bytes, hid a DELEGATECALL from the on-chain scan | The trailer is only skipped when the scan lands on it at an instruction boundary, and only for the exact ipfs layout |
| **PUSH-overrun fall-through:** a PUSH whose data runs into the "skipped" trailer made live code invisible | Boundary-aligned trailer skip; the skip that only checked solc version bytes was removed |
| **Second-hop blacklist trap:** a token that blocks only the router → wallet transfer passed a probe that sold from the router | The probe hands the tokens to a fresh CREATE2 ProbeHolder (the same hop a buyer gets), which sells from there. Hop loss counts toward the buy tax |
| **Hidden owner / selector evasion:** an admin check on a storage slot behind a selector name that is not on any list | CALLER/ORIGIN-vs-SLOAD taint, then a switch from a blocklist to an allowlist of selectors |
| **Fee-oracle / external state:** tax read from another contract | Live CALL/STATICCALL to non-literal targets and EXTCODE* of foreign addresses make the token `privileged` |
| **Balance kill switch:** logic keyed on `address(this).balance` or `msg.sender.balance`, which anyone can flip with forced ETH | BALANCE/SELFBALANCE reads make the token `privileged` |
| **Constant admin:** `msg.sender == CONSTANT`, which solc -O lowers to `add(caller, not(C-1))` | ADD/SUB/XOR compares against a 20-byte literal (or its negation) are caught |
| **Owner-probe dirty word, bucket saturation, simulate throw blocking attestation, flag downgrade** | Fail closed: owner dirty word = active, tax buckets saturate, static flags always attested and a simulate error ⇒ `ownerCanTrap`, the daemon never lowers a flag |
| **Web/CLI: a fork router with a mainnet wallet** (same chain id 196) | `buyEnabled` per network, plus `getCode(router)` and chainId on the wallet's own provider before every send; minOut is taken from the simulated delivered amount |

The review diffs and reports live in the build workspace. Most fixes have a named test in `test/` or `scanner/test/`; the web/CLI wallet gates were checked by hand in a browser and on the fork CLI.

## Honest limitations

- **tx.origin and router special-casing.** A token can treat the router, or `tx.origin`, differently from everyone else. One example is a token that records `tx.origin` on a buy and refuses that origin's sells in a **later** block. The same-transaction probe passes, so ExitProof allows the buy. This case is pinned as a known limitation in `test_txOriginTrap_known_limitation`.
- **The ProbeHolder can be identified.** It is a contract (`extcodesize > 0`) created in the same transaction. A token that lets contracts sell and blocks EOAs, or the reverse, can tell the probe apart from a buyer.
- **Gas-window fingerprint.** The probe runs with a recognizable amount of remaining gas, so a token can behave differently inside it.
- **Owner actions after the buy.** ExitProof checks the token at the moment you buy. An owner who later flips a switch is covered only by the danger/owner facts (registry + simulation), not by the probe. X Layer has no public mempool, so there is no front-run exit either.
- **Logic inside allowlisted functions.** The allowlist proves which functions a token exposes, not what they do. A `transfer()` that changes behaviour by block number, timestamp or an internal counter passes the static rules; only the live probe and the simulation catch what is visible at that moment.
- **Non-solc dispatchers fail closed.** Vyper, jump tables and hand-written dispatchers are marked `privileged` + `dangerSetter`, so honest tokens written that way are blocked in balanced and strict modes.
- **Attester trust.** Registry flags are as good as the attester and the scanner version. The scanner is open source and deterministic, so anyone can re-run it on a codehash. The registry owner can add or remove attesters (this only affects flags, never funds; ownership transfer is single-step).
- **TapeOut itself.** SnipeShield's README notes that TapeOut's factory "isn't sealed yet": its owner can still upgrade how circuits are evaluated. We know of no public audit of TapeOut. An upgrade that changes `eval` changes ExitProof's verdicts. The router rejects malformed output (`BadEval` unless `allow ⇔ reason == 0`), but it cannot tell a dishonest "allow" from an honest one.
- **False "upgradeable" on unscanned tokens.** The on-chain scan is linear. About 4% of honest tokens have metadata hash bytes that look like a JUMPDEST next to a DELEGATECALL/CALLCODE/SELFDESTRUCT byte, so they read as upgradeable. Until the scanner attests them, balanced mode blocks them with reason 4. For a scanned token the registry replaces the on-chain result.
- **Off-chain scanner and CBOR metadata.** The scanner can decode the solc metadata trailer as code. In rare cases this gives a strict-mode false positive, which fails closed.
- **The simulation can be evaded.** `simulate` uses a fixed holder address, jumps the clock by 3600 s and assumes a pool fee of at most 1%. A token that keys on any of those can hide an owner trap from it.
- **Tax rounding.** On the sell leg, a tax 1 bps under a bucket line (499, 1499 or 4999 bps) is reported one bucket higher. Rounding goes the conservative way, and the buy leg is exact (stress report, finding F2).
- **Donated tokens stay in the router.** Tokens sent to the router directly are stuck, by design: there is no admin and no sweep function.
- **The browser-wallet buy path has not been tested with a real wallet.** The same calldata, minOut and gas logic were exercised through the CLI on the fork, and the web check path was tested in Chrome.
- **First buy of a large token.** The on-chain scan costs about 100–180 gas per byte. The first buy of a token near the 24 KB size limit can cost up to about 4.8M gas offline (about 5M with the real eval). The worst blocked case measured is 7.62M (a 24 KB probe-cap token). This is paid once per codehash; later buys use the cache.
- **Scope.** PotatoSwap V2 only, a single hop, OKB/WOKB as the quote asset. No V3, no price oracle, no MEV protection beyond `minOut`.

## Gas

| | gas |
|---|---|
| Fork rehearsal, real processor + PotatoSwap: first buy of a small token (with the scan) | 755,825 |
| Fork rehearsal: later buy, scan cached | 502,678 |
| First buy of a ~24 KB token (worst-case fill), offline / with the real eval (estimate) | 4.82M / ≈4.99M |
| Worst blocked case: 24 KB probe-cap token | 7.62M |
| One `processor.eval` from a contract | ≈137k |

**Don't cap the wallet's gas limit.** The probe needs about 3.1M gas *available* (its sub-call gets 63/64 of what is
left), even though a typical buy only *uses* 0.5–0.8M. So a typical buy needs a limit of at least 3.5M, and the first
buy of a near-24 KB token needs up to about 5M. Leave about 8M of headroom: the web app and CLI use `estimateGas × 1.2`,
and fall back to 8M when the estimate fails without a revert reason. With a lower hard-coded limit, the probe runs out
of gas and the buy is denied, which fails closed. Measurements are in the build workspace's stress report (commit
`2cd45cf`); the X Layer block gas limit is 210M.

## Costs

Measured on the fork, at the fork's gas price of about 1 gwei. Mainnet gas was about 0.02 gwei on 2026-11-25.

| | OKB | BEM |
|---|---|---|
| Tape-out (createCPU, mint 54 NAND, tapeout) | 0.00293 (fee 0.0013 + gas) | 0.11 |
| Deploy RiskRegistry + setAttester + ExitProofRouter | 0.00262 | – |

Full breakdown and a mainnet budget: [docs/COSTS.md](docs/COSTS.md).

## Revenue

- **Router fee:** 10 bps of every routed buy, sent to `feeRecipient`. The fee is set at deploy time and capped at 30 bps by an immutable constant. Nobody can raise it, and there is no admin over user funds.
- **Scanner API and bulk attestations** for launchpads, wallets and bots that want a verdict for every new pair.
- **"ExitProof verified" badge** for launches whose codehash passes strict mode.

## Repo layout

| Path | What |
|---|---|
| `circuit/` | `spec.py` (policy), `policy.v`, `synth.ys`, `build.py`, `netlist.json`, `truth.json`, tests |
| `contracts/` | `ExitProofRouter.sol`, `RiskRegistry.sol`, `lib/BytecodeScan.sol` |
| `test/` | Foundry unit tests, malicious token fixtures (`fixtures/Tokens.sol`), fork tests (`fork/`) |
| `scanner/` | Deterministic scanner, simulator, attester and daemon (Node + viem) |
| `scripts/` | `tapeout.mjs`, `deploy.mjs` (canonical deployer), `rehearse.sh`, `demo-fork.mjs`; `deploy-fork.mjs` is the older fork-only deployer, kept for reference |
| `deployments/` | `constants.json` (X Layer addresses), `fork.json` / `fork-demo.json` (rehearsal artifacts); `xlayer.json` appears after the mainnet run |
| `web/` | Static app, no build: checker, buy, feed, EN/TR, self-hosted fonts, CSP |
| `cli/`, `agent/` | `exitproof.mjs check|buy|tx`, OKX Agentic Wallet skill |
| `docs/` | Design spec, [COSTS](docs/COSTS.md), [OPERATIONS](docs/OPERATIONS.md), [DEMO_SCRIPT](docs/DEMO_SCRIPT.md), screenshots |

## Run it yourself

Requirements: Foundry (forge, anvil, cast), Node ≥ 22, and Python 3 (Yosys only if you want to rebuild the circuit).

Test counts below were measured at commit `5fb8343`.

```bash
npm ci && (cd scanner && npm ci)
forge test
XLAYER_RPC=https://rpc.xlayer.tech forge test --match-path 'test/fork/*'
python3 -m unittest circuit/test_circuit.py
node --test scanner/test
node --test cli/test
bash scripts/rehearse.sh
```

1. `forge test`: 92 offline tests pass. The 2 fork suites skip themselves when `XLAYER_RPC` is unset.
2. The fork suites: 30 tests at the pinned block 76,861,306, including the 32-buy stress run.
3. The circuit test: all 2048 inputs against `spec.py`.
4. The scanner: 81 tests. It needs anvil and `forge build`.
5. The CLI: 2 tests.
6. `scripts/rehearse.sh`: the whole mainnet flow on a fresh fork, ending in `REHEARSAL OK`.

`scripts/rehearse.sh` works in a throw-away copy of the repo, so it never changes your files. It starts anvil on a
fork of mainnet block 76,861,306 and runs every step in order:

1. funds anvil account #2 (accounts #0, #1 and #5 have EIP-7702 code on X Layer)
2. `tapeout.mjs`: create the processor, mint NAND, tape out, verify 2048/2048
3. `deploy.mjs`:
   - a dry run that must write nothing;
   - an interrupted send: it is killed after the registry tx is sent and before it is mined, and a re-run while that tx is pending must refuse;
   - the resume, which adopts that registry and must not deploy a second one;
   - an idempotent re-run.
4. `demo-fork.mjs`: fixture tokens with real PotatoSwap pairs
5. CLI verdicts for the clean, blacklist, 99% sell tax, second-hop trap, fee and time-bomb tokens; the time bomb is checked before and after a scanner attestation
6. one CLI buy, and one refused buy

It prints a cost summary and `REHEARSAL OK`, then kills anvil. With `KEEP=1` it copies the fresh fork artifacts back
into the repo. Set `PORT=` if 8549 is busy. Set `FORK_URL=https://xlayerrpc.okx.com` if rpc.xlayer.tech rate-limits you.

Web app against the fork: the rehearsal stops anvil when it exits, so start anvil yourself on port 8549 (`anvil
--fork-url https://rpc.xlayer.tech --fork-block-number 76861306 --chain-id 196 --port 8549`). Then run `tapeout.mjs`,
`deploy.mjs` and `demo-fork.mjs` with `RPC_URL=http://127.0.0.1:8549 SEND=1` and `DEPLOYER_KEY` set to anvil account
#2. Serve the app with `cd web && python3 -m http.server 8765` and open
`http://127.0.0.1:8765/?token=<address>&mode=balanced&check=1`.

CLI: `node cli/exitproof.mjs check <token> --mode balanced --network fork` (exit code 0 = allow, 1 = blocked).
The CLI's default network is `xlayer` (mainnet); `--network fork` is only for local demos. On the fork, `buy` works only
through a loopback RPC, and `tx` (the agent path) is refused because the fork has `buyEnabled: false`.

### Mainnet (operator)

The step-by-step go-live, with the key read from `.env`, is in [MORNING.md](MORNING.md). In short: run
`scripts/tapeout.mjs` as a dry run, then with `SEND=1 CONFIRM_MAINNET=yes`. That writes `deployments/xlayer.json`. Then
do the same with `scripts/deploy.mjs`, which deploys the router and registry and updates `web/config.json`.

Both scripts detect the network by probing the node, never from a flag. They refuse wallets with EIP-7702 code,
simulate every transaction before sending it, write nothing in a dry run, and stop at a banner unless
`CONFIRM_MAINNET=yes`. Running the scanner daemon and publishing to DeWEB: [docs/OPERATIONS.md](docs/OPERATIONS.md).

## License

MIT, see [LICENSE](LICENSE).

---

## Türkçe özet

**ExitProof: satamayacağın token'ı alma.** X Layer üzerinde bir alım router'ı. Token'ı PotatoSwap'ten alır, aynı
işlemin içinde pozisyonun tamamını yeni bir cüzdan üzerinden havuza geri satmayı dener (bu deneme her zaman geri
alınır), alım/satım vergisini ölçer, owner ve yükseltilebilirlik bilgilerini toplar ve kararı 54 NAND kapılı bir
TapeOut devresine bırakır. Devre "hayır" derse işlemin tamamı geri alınır, OKB'n cüzdanından hiç çıkmaz.

- **Modlar:** permissive (sadece honeypot kontrolü), **balanced** (varsayılan), strict (yalnızca izin listesindeki yüzey; çoğu yeni token'ı engeller).
- **Devre:** Yosys ile 54 NAND'a sentezlendi. 2048 girdinin tamamı hem çevrimdışı hem de gerçek bir TapeOut işlemcisi üzerinde (mainnet fork) doğrulandı.
- **Üç savunma katmanı:** zincir üstü satış denemesi ve bytecode taraması; scanner'ın codehash'e göre yazdığı RiskRegistry; fork üzerinde owner yetkilerinin simülasyonu (`ownerCanTrap`).
- **Güvenlik:** her görev çekişmeli bir incelemeden geçti. Bulunan atlatma yolları (sahte CBOR trailer, PUSH taşması, ikinci adım kara listesi, gizli owner, bakiye kill-switch'i, sabit admin) düzeltildi ve testle sabitlendi.
- **Sınırlar:** taranmamış dürüst token'ların ≈%4'ünde sahte "upgradeable" (sebep 4), tx.origin'e veya router'a özel davranan token'lar, ProbeHolder'ın kontrat olarak tanınabilmesi, gas penceresi izi, alım sonrası owner işlemleri, izinli fonksiyonların içindeki mantık, attester güveni, simülasyonun atlatılabilmesi, gerçek bir tarayıcı cüzdanıyla test edilmemiş alım yolu, TapeOut factory'sinin henüz mühürlenmemiş olması.
- **Gas:** fork üzerinde ilk alım ≈756k, önbellekli ≈503k. 24 KB'lık bir token'ın ilk alımı ≈5M'a çıkabilir. Cüzdanın gas limitini düşürme (≈8M pay bırak).
- **Gelir:** yönlendirilen alımlardan 10 bps (değiştirilemez üst sınır 30 bps), launchpad ve cüzdanlar için ücretli scanner API'si ve toplu attestation, "ExitProof verified" rozeti.
- **Çalıştırma:** `forge test`, `bash scripts/rehearse.sh` (sonunda `REHEARSAL OK`).
