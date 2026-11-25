# ExitProof

**Don't buy what you can't sell.** ExitProof is a buy router on X Layer. It buys a token, sells the whole position back
in the same transaction, and lets a TapeOut circuit decide whether the buy goes through. If the circuit says no, the
transaction reverts: the buy amount and fee are never taken, and only the gas of the reverted transaction is spent.

**English** · [Türkçe özet](#türkçe-özet)

## What one transaction can prove, and what it can't

ExitProof's check runs inside your own buy, so what it proves is narrow and exact: **at the moment of your buy, the
whole position is sellable now, from a fresh address, through the router path**. Concretely:

- the full amount, held by a brand-new address with no code (like a new wallet), is sold back to the same PotatoSwap
  pool by a spender with `approve` + `transferFrom`, the way a DEX router sells for a wallet;
- the buy tax and sell tax are measured into buckets, and the buy tax includes what the hop to your wallet kept;
- the tokens really reached your wallet (`delivered` is measured, and `minOut` is checked on it).

It **cannot** prove anything about a later block, or about a sale that someone else's code treats differently. Those
trap classes are left to the off-chain scanner, whose verdicts reach the router through RiskRegistry:

| Trap | Who catches it |
|---|---|
| Sell only in the block or transaction you received the tokens (block number, timestamp, transient storage), cooldowns | **Scanner only:** delayed sells at +1 block, +60 s, +1 h and +1 d, plus a static `block-context` rule |
| An owner flips a switch after your buy (trading off, fee to 99%, blacklist) | **Scanner only:** dangerous-setter list, owner-power simulation, a sweep of unknown setters; `balanced` and `strict` act on it |
| Seller must not be `tx.origin` (the probe holder never is) | **Scanner only:** its simulated sells use the user as `tx.origin` |
| A sell allowed only as the very next transfer after receipt, kept open by the attacker's own bot | **Nobody.** No on-chain or off-chain design of this kind catches a state-sequenced trap |
| A token that treats ExitProof's router (the probe's spender) or PotatoSwap's router specially | **Nobody on chain.** The scanner fences caller-vs-literal checks statically; its simulator uses its own router stand-in |

So read a green verdict as "you can get out right now", not as "this token is safe forever". The full list is in
[Honest limitations](#honest-limitations).

## For judges (X Layer TapeOut Accelerate)

| | |
|---|---|
| **Live app** | `TBD (mainnet pending)`. Until then, the same static app runs against a local mainnet fork (`web/`, see [Run it yourself](#run-it-yourself)); screenshots are in [docs/screenshots/](docs/screenshots/) |
| **On DeWEB** | DeWEB-ready (pending publish): ethers and fonts vendored, zero external hosts, publish script rehearsed on a fork. Gateway URL `TBD (after mainnet publish)`: `https://<circuitId>-2-<processorIndex>.tapekit.org/` (`<circuitId>.2.<processorIndex>.tape`). See [docs/OPERATIONS.md](docs/OPERATIONS.md#publishing-web-to-deweb--tapekit) |
| **Demo video (≤ 3 min)** | `TBD (video link)`; the script is [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md) |
| **TapeOut processor** | `TBD (mainnet pending)`: ExitProof's own processor "ExitProof Guard" (EXITP), created by `scripts/tapeout.mjs` |
| **Circuit ID** | `TBD (mainnet pending)`: the policy chip. 54 NAND, 11 inputs, 4 outputs. It decides allow/deny and a reason code on every guarded buy. |
| **Contracts** | ExitProofRouter `TBD (mainnet pending)` · RiskRegistry `TBD (mainnet pending)` · trades on PotatoSwap V2 (factory [`0x630D…7fcF`](https://www.oklink.com/xlayer/address/0x630DB8E822805c82Ca40a54daE02dd5aC31f7fcF), 25 bps) with WOKB `0xe538…9b2b` |
| **TapeOut features used** | **Circuits / `eval` in every buy:** every `buyETH`, `buy` and `inspect` call runs `processor.eval(circuitId, facts)` inside the transaction. The router has no other allow/deny logic; Solidity only adds money checks (minOut, deadline, fee cap) and a backstop that can turn an allow into a revert, never a deny into an allow. **Live circuit explorer:** the web app has 11 bit toggles that call `processor.eval` on chain and compare it with the reference model in the browser. **Own processor + tape-out:** createCPU, NAND mint and tapeout, all scripted and rehearsed (`scripts/tapeout.mjs`); `deploy.mjs` re-runs all 2048 evals before it deploys. **DeWEB/TapeKit (pending publish):** `scripts/build-deweb.mjs` vendors ethers and the fonts (zero external hosts; TapeKit's "100% on-chain" rule checked), and `scripts/publish-deweb.mjs` stores the site in the circuit's ERC-6551 container and binds the `.tape` name; rehearsed on a fork ([docs/OPERATIONS.md](docs/OPERATIONS.md)). |
| **Business** | 10 bps on routed buys, with an immutable cap of 30 bps. Paid scanner API and bulk attestations for launchpads and wallets. An "ExitProof verified" launch badge. See [Revenue](#revenue) and [SUBMISSION.md](SUBMISSION.md). |
| **Usage** | The app shows totals since the deploy block: tokens scanned, flagged, guarded buys and OKB routed, from the router's `Checked` and the registry's `Attested` events (`node cli/exitproof.mjs stats` prints the same). Blocked buys revert, so they never show up as events, and we don't claim on-chain "blocked" counts. |
| **Census** | ExitProof measured live PotatoSwap tokens on a mainnet fork; see [docs/CENSUS.md](docs/CENSUS.md) for the latest run and [Token Safety Census](#token-safety-census) below. |
| **Verified source** | `TBD (mainnet pending)`. `scripts/deploy.mjs` prints the exact `forge verify-contract … --verifier sourcify --chain 196` and OKLink commands after deploying. |
| **Assurance** | Circuit checked on all 2048 inputs off chain and again on a real TapeOut processor (fork of mainnet) · test counts at commit `2ed1b9f`: 119 offline Foundry tests (unit, fuzz, invariant, gas, audit regressions), 35 fork tests on real PotatoSwap pairs and the real processor (including a 37-step stress run and 10 real Flap and honeypot tokens), 110 scanner tests, 12 CLI/web-logic tests · adversarial reviews after every task plus two independent final audits, with every bypass they found fixed ([Security review history](#security-review-history)) · one-command fork rehearsal of the whole mainnet flow (`scripts/rehearse.sh`) |
| **AI agents** | [`agent/SKILL.md`](agent/SKILL.md): an OKX Agentic Wallet skill. `cli/exitproof.mjs check` gives a JSON verdict (green / amber / red); `tx` prepares a `buyETH` call for `onchainos wallet contract-call`. Agents get a check they can read by machine, and the same check is enforced on chain when they buy. Token names are passed to agents only as labelled untrusted data. |
| **Built during the event** | All of it. First commit 2026-11-25. |

## What it does

A honeypot lets you buy and then stops you selling. It might blacklist you, charge a 99% sell tax, cap your sell
size, or wait until the owner flips a switch. ExitProof does the sell attempt for you, with the real pool, inside your
own buy, before the buy is allowed to stand.

### One guarded buy

```
you: buyETH(PotatoSwap, token, minOut, mode, to, deadline) + OKB
 └─ router: take 10 bps fee, wrap OKB, check pair == factory.getPair(token, WOKB) and to != pair
 └─ BUY      swap WOKB → token on the real pair; buyOut = what the router really received
 └─ PROBE    try this.probeSell(...)                          ← always reverts, so none of this survives
       ├─ send the tokens to a fresh CREATE2 address that has no code (like a new wallet)
       ├─ deploy a constructor-only holder there: approve(router, max), and it leaves no code behind
       ├─ the router sells 100% with transferFrom(holder → pair), as a DEX router does for a wallet;
       │  the swap reads the pair after the transfer, so tokens that swap their collected tax on a sell work
       └─ revert ProbeResult(ok, held, out)                   → sellOk, sell tax (priced on the honest post-buy reserves)
 └─ DELIVER  transfer the tokens to `to` and measure what arrived (`delivered`)
 └─ FACTS    sellOk · sellTax · buyTax (worst of the probe hop and the delivery) · owner() active · upgradeable
             · danger · unscanned · mode   (owner() staticcall, on-chain bytecode scan, RiskRegistry flags)
 └─ EVAL     processor.eval(circuitId, 11 bits) → 1 byte: allow | reason << 1
             backstop: an allow with sellOk = 0 or a tax of 15% or more reverts BadEval
 └─ allow    minOut checked on `delivered` → event Checked(..., out = delivered)
    deny     revert Blocked(reason, facts)  → the whole tx unwinds, delivery included; only its gas is spent
```

`inspect(...)` runs the same path through `eth_call`, delivering to the caller, and always reverts with
`Report(facts, allow, reason, buyOut, sellOut, delivered)`. That makes it a free check for the web app, the CLI and
agents. `delivered` is what a buyer would actually receive; `buyOut` is what the router got from the pair.

### Modes

| Mode | Allows when | Who it is for |
|---|---|---|
| **permissive** | the full sell-back works and both taxes are under 15% | "just tell me if it's a honeypot" |
| **balanced** (default) | permissive, plus: not upgradeable, and if the owner is still active, the token must be scanned and have no dangerous setter | everyday buys of fresh launches |
| **strict** | balanced, plus: both taxes under 5%, no active owner, scanned, and the scanner's allowlist passes | only allowlisted surfaces; blocks most launch tokens, by design |

Mode 3 is treated as strict. The web app, CLI and agent skill all default to balanced. "Active owner" includes
`privileged` from the scanner, and every scanner simulation signal (a delayed-sell trap, a `transferFrom` trap, an
unknown setter that traps) sets `privileged` as well as a danger flag, so balanced blocks those tokens even when
`owner()` is zero. A dangerous setter the scanner does not recognise and its sweep does not trigger still passes
balanced; see the limitations.

The app and the CLI show three states:

- **green** "You can get out": allowed;
- **amber** "Sells now, but risky": blocked by reasons 4–7 (the sell-back worked, but the mode's owner, upgrade or
  scan policy says no), with a note whether permissive would allow it;
- **red** "Exit blocked": reasons 1–3, or the token cannot be bought at all.

### Facts (circuit inputs) and reason codes (circuit outputs)

| bit | fact | source |
|---|---|---|
| 0 | `sellOk`: the full position was sold back from the code-less holder through `transferFrom` | probe |
| 1-2 | `sellTax` bucket: 0 under 5%, 1 5–15%, 2 15–50%, 3 50% or more, or not measurable | probe |
| 3-4 | `buyTax` bucket (same buckets; the worst of the hop to the holder and the delivery to your wallet) | buy leg + probe + delivery |
| 5 | `ownerActive`: `owner()` is non-zero, or the registry says `privileged` | staticcall + registry |
| 6 | `upgradeable`: the on-chain scan finds DELEGATECALL/CALLCODE or an EIP-7702 delegation (unscanned tokens), or the registry says `upgradeable` | BytecodeScan + registry |
| 7 | `danger`: the registry says `dangerSetter` or `ownerCanTrap` | registry |
| 8 | `unscanned`: no registry entry for this token whose recorded codehash equals the token's current code | registry |
| 9-10 | mode: 0 strict, 1 balanced, 2 permissive, 3 strict | caller |

| reason | meaning |
|---|---|
| 0 | allowed |
| 1 | you could buy, but you could not sell all of it back |
| 2 | sell tax too high for this mode |
| 3 | buy tax too high for this mode (including what the hop to your wallet kept) |
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
  - After the tape-out it reads the netlist back from the processor (byte-identical, 378 bytes), checks `circuitInfo == (11, 4, 0, 54)`, and calls `eval` on all 2048 inputs through Multicall3. `scripts/deploy.mjs` repeats the netlist, `circuitInfo` and 2048-eval checks on chain right before it deploys the router.
  - Fork result: `2048/2048`. The Foundry fork test `test_fork_eval_matches_truth_all_2048` checks the same thing from Solidity, at about 137k gas per `eval`. The web app's circuit explorer lets anyone call `eval` live on any of the 2048 inputs.

## Three defence layers

1. **On chain, at swap time:** the sell-back probe from a code-less holder through `transferFrom`, buy and sell tax
   buckets, the measured delivery to the buyer, an `owner()` staticcall, and a PUSH-aware bytecode scan for
   DELEGATECALL/CALLCODE/SELFDESTRUCT that also treats an EIP-7702 delegation designator (`0xef0100…`) as
   upgradeable. The scan result is cached per codehash, so only the first buyer of a codehash pays for it.
2. **RiskRegistry:** flags **keyed by token address**, each entry recording the codehash the scanner saw. The router
   honours an entry only while that codehash equals the token's current `EXTCODEHASH`; otherwise the token counts as
   unscanned and the on-chain scan applies. So an attestation of one instance is never reused by another instance of
   the same bytecode, and one that changed its code loses its entry. Written by an attester running the open-source
   deterministic scanner (`scanner/`). For a scanned token, the registry's `upgradeable` replaces the on-chain scan,
   because the scanner checks reachability and the on-chain scan is a linear heuristic. Ownership moves in two steps
   (`transferOwnership`, then `acceptOwnership` by the new owner).
3. **Simulation on a fork:** the scanner buys and sells through a router stand-in (approve + `transferFrom`, the user
   as `tx.origin`), sells again at +1 block, +60 s, +1 h and +1 d, impersonates the owner and calls every dangerous
   setter with worst-case arguments, and calls every unknown setter with six argument patterns, retrying the sell
   after each. Any trap sets `ownerCanTrap` or `dangerSetter`, plus `privileged`.

## Scanner model (allowlist)

`scanner/` (v5) follows the dispatcher chain from offset 0 and checks every external selector against a SAFE list:
the ERC-20 surface, permit/EIP-712, ERC-165, `owner`/`getOwner`/`renounceOwnership`, and a few pair/router getters.
Any other selector, a non-trivial fallback, caller-vs-storage or caller-vs-literal comparisons (hidden or constant
admins), live calls to non-literal targets, BALANCE/SELFBALANCE/EXTCODE* reads of foreign state, NUMBER, TIMESTAMP,
ORIGIN or TLOAD on a transfer path (`block-context`), or a live owner makes the token `privileged`. Strict mode
therefore has an allowlist guarantee. Balanced mode uses `dangerSetter`, which comes from a list of dangerous
selectors, live SELFDESTRUCT and the simulation signals above. A dispatcher the scanner does not recognize fails
closed. EIP-1167 and ERC-7511 clones are resolved to their implementation. Every report records the token, pair,
block, codehash, flags and evidence, and can be published as static files. Details and residual risks are in
[scanner/README.md](scanner/README.md).

The daemon (`node scanner/src/cli.mjs daemon`) watches PotatoSwap `PairCreated` in 100-block windows and attests each
new token at its first liquidity; a pair created before its token has code is kept pending, never dropped.
`backfill` attests the pairs that already exist, newest first, and refuses to send without the fork simulation.
Every send path (`attest`, `daemon`, `backfill`) refuses mainnet without `CONFIRM_MAINNET=yes` and takes the key only
from the environment or a `chmod 600` file. That is how strict and balanced modes work for fresh launches.

## Token Safety Census

[docs/CENSUS.md](docs/CENSUS.md) applies ExitProof itself (the real router's `inspect` with the real taped-out circuit,
on a fork of mainnet, plus the static scanner) to a sample of live PotatoSwap WOKB pools, and cross-checks every
"cannot sell" and "cannot buy" result with a plain wallet. See it for the latest run; the file states the block, the
sample and the method. The run at block 76,868,206 found:

- 953 live WOKB pools out of 26,996 WOKB pairs; 96.5% of the pairs hold less than 0.01 OKB (never funded, drained or rugged);
- of 740 buyable tokens in an 800-token sample, **31.1% could not be sold back** (reason 1; a plain wallet confirmed 225 of those 230 and sold 3 of them fine);
- **38.4%** have an active owner holding dangerous switches;
- ExitProof would allow 68% in permissive, 49.6% in balanced and 11.4% in strict mode;
- 60 more tokens could not be bought through ExitProof at all (50 of 58 checked could not be bought by a plain wallet either).

## Security review history

Each task went through an adversarial review before it was accepted, and then two independent final audits looked at
the whole system before mainnet: a security audit (1 critical, 2 high, 6 medium and 5 low findings) and a functional
end-to-end audit on 26 live tokens (one false-positive bug on real launchpad tokens, plus RPC and first-run issues).
Every finding that needed a code change was fixed before mainnet, each with a regression test. The rest are
operational or documented under the limitations: role separation for the deployer key, a check-only consumer that
can be told apart from a real buy, and flag monotonicity, which the scanner enforces rather than the registry. These
are the real bypasses the reviews found:

| Found | Fix |
|---|---|
| **Forged CBOR trailer:** a fake solc metadata trailer, padded with JUMPDEST bytes, hid a DELEGATECALL from the on-chain scan | The trailer is only skipped when the scan lands on it at an instruction boundary, and only for the exact ipfs layout |
| **PUSH-overrun fall-through:** a PUSH whose data runs into the "skipped" trailer made live code invisible | Boundary-aligned trailer skip; the skip that only checked solc version bytes was removed |
| **Second-hop blacklist trap:** a token that blocks only the router → wallet transfer passed a probe that sold from the router | The probe hands the tokens to a fresh holder, which sells from there |
| **Hidden owner / selector evasion:** an admin check on a storage slot behind a selector name that is not on any list | CALLER/ORIGIN-vs-SLOAD taint, then a switch from a blocklist to an allowlist of selectors |
| **Fee-oracle / external state:** tax read from another contract | Live CALL/STATICCALL to non-literal targets and EXTCODE* of foreign addresses make the token `privileged` |
| **Balance kill switch:** logic keyed on `address(this).balance` or `msg.sender.balance`, which anyone can flip with forced ETH | BALANCE/SELFBALANCE reads make the token `privileged` |
| **Constant admin:** `msg.sender == CONSTANT`, which solc -O lowers to `add(caller, not(C-1))` | ADD/SUB/XOR compares against a 20-byte literal (or its negation) are caught |
| **Owner-probe dirty word, bucket saturation, simulate throw blocking attestation, flag downgrade** | Fail closed: owner dirty word = active, tax buckets saturate, static flags always attested and a simulate error ⇒ `ownerCanTrap`, the scanner never lowers a flag of the same codehash |
| **Web/CLI: a fork router with a mainnet wallet** (same chain id 196) | `buyEnabled` per network, plus `getCode(router)` and chainId on the wallet's own provider before every send |
| **Final audit F-01 (critical): the delivery hop was not measured.** A token that skims only the router → buyer transfer passed strict with both taxes at 0, and the front-ends took `minOut` from that same skimmed transfer | The router delivers before it asks the circuit, measures `delivered` at the recipient, folds the loss into the buy-tax bucket and checks `minOut` on it. `Report` carries `delivered` as a sixth field |
| **Final audit F-02 (high): the probe sold with `transfer`, real sells use `approve` + `transferFrom`.** A token whose `transferFrom` into the pair fails passed everything | The holder is a code-less CREATE2 address that approves the router in its constructor; the router sells with `transferFrom`, like a DEX router. The scanner sells through a router stand-in the same way |
| **Final audit F-03 (high): "sell only in the block you received" passes a same-transaction probe,** and the simulator discarded the failed later sell | Not fixable on chain. The scanner now sells at +1 block, +60 s, +1 h and +1 d, flags `delayed-sell-trap` (danger + privileged, so balanced blocks it without an owner), and fences NUMBER/TIMESTAMP/ORIGIN/TLOAD on transfer paths statically |
| **Final functional audit: Flap launchpad tokens read as honeypots.** Tokens that swap their collected tax inside a sell moved the reserves, and the probe priced its swap on stale reserves (`Potato: K`), so 3 of 26 live tokens were false "reason 1" | The probe swap mirrors PotatoSwap's fee-on-transfer router: it reads the pair after the transfer. The tax stays priced on reserves computed before any token code runs, so a token cannot game its bucket down. Fork test on the 10 real tokens: the 3 Flap tokens are allowed and really sellable, the 4 true honeypots stay blocked |
| **Final audit F-06 (medium): attestations keyed by codehash** were reused by every instance of a template and could be poisoned by a hostile instance | The registry is keyed by token address and records the codehash; the router ignores an entry whose codehash differs from the token's current code. Two-step ownership |
| **Final audit F-07 (medium): an EIP-7702 delegated account as a token** has 23 bytes of code, scanned clean, and can be re-delegated after the buy | `0xef0100` + 20 bytes ⇒ upgradeable (reason 4 in balanced and strict when unscanned) |
| **Final audit F-10 (low): no backstop if TapeOut's upgradeable `eval` misbehaves** | An allow with `sellOk = 0` or a tax bucket of 15% or more reverts `BadEval`. It can only turn an allow into a revert |
| **Final audit F-04, F-05, F-08, F-13, F-14** (unlisted setters in balanced; a pair created before its token has code was never scanned; token symbols reached agents verbatim; no mainnet gate on attestations; the gate trusted an "anvil" answer from any URL) | Unknown-setter sweep in the simulator; pending tokens scanned at first liquidity; symbols sanitized and labelled untrusted; `CONFIRM_MAINNET=yes` on every scanner send; "fork" only for loopback RPC URLs |

The review diffs and reports live in the build workspace. Most fixes have a named test in `test/` (the final-audit
PoCs are in `test/AuditRegression.t.sol` and `test/fork/FlapFork.t.sol`) or `scanner/test/` (`audit.test.mjs`); the
web/CLI wallet gates were checked by hand in a browser and on the fork CLI.

## Honest limitations

- **Later blocks.** A same-transaction probe cannot prove that a sale works in any later block. Tokens that allow a sale only in the receiving block or transaction, or that refuse a `tx.origin` recorded on the buy in a later block (pinned in `test_txOriginTrap_known_limitation`), pass the probe. The scanner's delayed sells and its static `block-context` rule are the only defence, so for an unscanned token in permissive mode there is none.
- **State-sequenced traps.** A token that allows a sale only as the next transfer after receipt, and keeps that condition armed with the attacker's own bot, defeats both the probe and the simulation. No part of this design catches it.
- **The seller is not `tx.origin`, and the spender is ExitProof's router.** The holder has no code before, during and after the sale (like an EOA), but it is never `tx.origin`, and the sale is initiated by ExitProof's router, not PotatoSwap's. A token that keys on either can behave differently for the probe. The holder approves the maximum allowance, as many wallets do.
- **Gas-window fingerprint.** The probe runs with a recognizable amount of remaining gas, so a token can behave differently inside it.
- **Owner actions after the buy.** ExitProof checks the token at the moment you buy. An owner who later flips a switch is covered only by the danger/owner facts (registry + simulation), not by the probe. The unknown-setter sweep is bounded (40 selectors, six argument patterns, 180 s); a sweep that runs out fails closed, but a setter that only traps with an argument combination outside those patterns is missed. X Layer has no public mempool, so there is no front-run exit either.
- **Logic inside allowlisted functions.** The allowlist proves which functions a token exposes, not what they do. A `transfer()` whose behaviour depends on gas or its own counters passes the static rules; the simulation catches only what it triggers.
- **Swap-back price impact counts.** A token that liquidates its collected tax during a sell moves the price in front of the seller. The probe counts that as sell loss, so a large pending liquidation relative to pool depth can raise the sell-tax bucket at that moment (on the real Flap tokens it is about 0.1%).
- **Non-solc dispatchers fail closed.** Vyper, jump tables and hand-written dispatchers are marked `privileged` + `dangerSetter`, so honest tokens written that way are blocked in balanced and strict modes.
- **Launch-pending tokens stay flagged.** A token that cannot be sold during the scan (trading not open yet) is attested `baseline-sell-failed`, and the same-codehash entry is never lowered automatically; it needs a manual `attest --force` after trading opens.
- **Attester and key trust.** Registry flags are as good as the attester and the scanner version. The scanner is open source and deterministic, so anyone can re-run it on a token at the block in its report. The registry owner can add or remove attesters; this affects flags, never funds. By default the deployer key is registry owner, attester and the holder of the circuit NFT, and the NFT's container hosts the DeWEB site, so that key also decides what the site serves. MORNING.md shows how to move the registry roles and set a separate fee recipient.
- **A check alone is not binding.** `inspect` through `eth_call` runs from a fixed public address, so a token can behave well for that caller only. A buy through the router is safe from this, because the probe runs again inside the buy. A consumer that checks here and buys elsewhere is not.
- **TapeOut itself.** SnipeShield's README notes that TapeOut's factory "isn't sealed yet": its owner can still upgrade how circuits are evaluated. We know of no public audit of TapeOut. An upgrade that changes `eval` changes ExitProof's verdicts. The router rejects malformed output (`allow ⇔ reason == 0`) and any allow with a failed sell-back or a tax of 15% or more, but it cannot tell a dishonest "allow" on the owner, upgrade or strict-mode facts from an honest one.
- **False "upgradeable" on unscanned tokens.** The on-chain scan is linear. About 4% of honest tokens have metadata hash bytes that look like a JUMPDEST next to a DELEGATECALL/CALLCODE/SELFDESTRUCT byte, and every proxy or clone (including the Flap launchpad's tokens) has a real DELEGATECALL, so they read as upgradeable. Until the scanner attests them, balanced mode shows them amber with reason 4. For a scanned token the registry replaces the on-chain result.
- **Off-chain scanner and CBOR metadata.** The scanner can decode the solc metadata trailer as code. In rare cases this gives a strict-mode false positive, which fails closed.
- **The simulation can be evaded.** Its holder is derived from the block hash and it sells at several horizons, but it assumes a pool fee of at most 1%, and its router stand-in has its own address. A token that keys on PotatoSwap's real router, or on a horizon it does not try, can hide a trap from it.
- **Tax rounding.** On the sell leg, a tax 1 bps under a bucket line (499, 1499 or 4999 bps) is reported one bucket higher. Rounding goes the conservative way, and the buy leg is exact.
- **Donated tokens stay in the router.** Tokens sent to the router directly are stuck, by design: there is no admin and no sweep function.
- **The browser-wallet buy path has not been tested with a real wallet.** The same calldata, minOut and gas logic were exercised through the CLI on the fork, and the web check path was tested in Chrome.
- **Gas of large and blocked tokens.** The on-chain scan costs about 100–180 gas per byte. The first buy of a token near the 24 KB size limit costs about 4.74M gas offline (about 4.9M with the real eval, estimated), and the worst blocked case measured is 7.69M (a 24 KB token that also burns the probe's gas cap). This is paid once per codehash. A blocked token that burns the probe's 3M cap uses about 3.56M with the real eval; a wallet that sends it with the app's 3.5M minimum gets an out-of-gas revert instead of `Blocked(1)`. Either way nothing but gas is spent.
- **No pool-depth warning.** `check` with a large amount on a shallow pool can say allow without warning about price impact; `minOut` protects the buy.
- **Scope.** PotatoSwap V2 only, a single hop, OKB/WOKB as the quote asset. No V3, no price oracle, no MEV protection beyond `minOut`.

## Gas

Measured at commit `2ed1b9f`.

| | gas |
|---|---|
| Fork rehearsal, real processor + PotatoSwap: first buy of a small fixture token (with the scan) | 699,388 |
| Fork rehearsal: later buy, scan cached | 446,126 |
| Fork stress, real eval, all accounts cold: first buy / cached buy of a clean token | 741,351 / 505,421 |
| Real token on a fork of block 76,876,829, first buy with the scan: 羊屎蛋 `0x7e97…7777` (Flap launchpad, 3% tax), CLI, permissive | 555,642 |
| Fixture token that swaps its tax back on every sell, first buy (fork stress, real eval) | 960,743 |
| A buy of the real honeypot OKS `0xfDd1…d2a5`, sent on purpose past the CLI (fork of block 76,876,829): reverted `Blocked(1)` | 2,445,681 |
| First buy of a ~24 KB token (worst-case fill), offline / with the real eval (estimate) | 4.74M / ≈4.9M |
| Worst blocked case: 24 KB token that burns the probe cap | 7.69M |
| One `processor.eval` from a contract | ≈137k |

**Don't cap the wallet's gas limit.** The probe needs about 3.1M gas *available* (its sub-call gets 63/64 of what is
left), even though a typical buy only *uses* 0.45–1M. So a typical buy needs a limit of at least 3.5M, and the first
buy of a near-24 KB token needs up to about 5M. Leave about 8M of headroom: the web app and CLI use `estimateGas × 1.2`,
and fall back to 8M when the estimate fails without a revert reason. With a lower hard-coded limit, the probe runs out
of gas and the buy is denied, which fails closed. The X Layer block gas limit is 210M.

## Costs

Measured on the fork, at the fork's gas price of about 1 gwei. Mainnet gas was 0.02 gwei on 2026-11-26.

| | OKB | BEM |
|---|---|---|
| Tape-out (createCPU, mint 54 NAND, tapeout) | 0.00293 (fee 0.0013 + gas) | 0.11 |
| Deploy RiskRegistry + setAttester + ExitProofRouter (2.83M gas) | 0.00285 on the fork; ≈0.00006 at mainnet gas | – |
| Backfill of ≈950 live pairs (80k gas each, estimate) | ≈0.0015 | – |

Full breakdown and a mainnet budget: [docs/COSTS.md](docs/COSTS.md).

## Revenue

- **Router fee:** 10 bps of every routed buy, sent to `feeRecipient`. The fee is set at deploy time and capped at 30 bps by an immutable constant. Nobody can raise it, and there is no admin over user funds.
- **Scanner API and bulk attestations** for launchpads, wallets and bots that want a verdict for every new pair.
- **"ExitProof verified" badge** for launches whose code passes strict mode.

## Repo layout

| Path | What |
|---|---|
| `circuit/` | `spec.py` (policy), `policy.v`, `synth.ys`, `build.py`, `netlist.json`, `truth.json`, tests |
| `contracts/` | `ExitProofRouter.sol`, `RiskRegistry.sol`, `lib/BytecodeScan.sol` |
| `test/` | Foundry unit tests, malicious token fixtures (`fixtures/Tokens.sol`, `fixtures/AuditTokens.sol`), audit regressions, fork tests (`fork/`) |
| `scanner/` | Deterministic scanner, simulator, attester, daemon and backfill (Node + viem) |
| `scripts/` | `tapeout.mjs`, `deploy.mjs` (canonical deployer), `rehearse.sh`, `demo-fork.mjs`, `build-deweb.mjs`, `publish-deweb.mjs`; `deploy-fork.mjs` is the older fork-only deployer, kept for reference |
| `deployments/` | `constants.json` (X Layer addresses), `fork.json` / `fork-demo.json` (rehearsal artifacts); `xlayer.json` appears after the mainnet run |
| `web/` | Static app, no build: three-state checker, buy, totals since deploy, circuit explorer, new PotatoSwap pairs, EN/TR/中文, RPC fallback, self-hosted fonts, CSP |
| `cli/`, `agent/` | `exitproof.mjs check|buy|tx|stats`, OKX Agentic Wallet skill |
| `docs/` | Design spec, [CENSUS](docs/CENSUS.md), [COSTS](docs/COSTS.md), [OPERATIONS](docs/OPERATIONS.md), [DEMO_SCRIPT](docs/DEMO_SCRIPT.md), screenshots |

## Run it yourself

Requirements: Foundry (forge, anvil, cast), Node ≥ 22, and Python 3 (Yosys only if you want to rebuild the circuit).

Test counts below were measured at commit `2ed1b9f`.

```bash
npm ci && (cd scanner && npm ci)
forge test
XLAYER_RPC=https://xlayerrpc.okx.com forge test --match-path 'test/fork/*'
python3 -m unittest circuit/test_circuit.py
node --test scanner/test
node --test cli/test
bash scripts/rehearse.sh
```

1. `forge test`: 119 offline tests pass. The 3 fork suites skip themselves when `XLAYER_RPC` is unset.
2. The fork suites: 35 tests, at the pinned blocks 76,861,306 (including the 37-step stress run) and 76,871,779 (10 real Flap and honeypot tokens against PotatoSwap's own router as ground truth). The first run fetches state and takes a minute or two.
3. The circuit test: 8 tests, all 2048 inputs against `spec.py`.
4. The scanner: 110 tests. It needs anvil and `forge build`.
5. The CLI and the web logic: 12 tests.
6. `scripts/rehearse.sh`: the whole mainnet flow on a fresh fork, ending in `REHEARSAL OK`. It takes about 7 minutes.

`scripts/rehearse.sh` works in a throw-away copy of the repo, so it never changes your files. It starts anvil on a
fork of mainnet block 76,861,306 (from `https://xlayerrpc.okx.com`; set `FORK_URL=` to use another RPC) and runs every
step in order:

1. funds anvil account #2 (accounts #0, #1, #5 and #6 have EIP-7702 code on X Layer)
2. `tapeout.mjs`: create the processor, mint NAND, tape out, verify 2048/2048
3. `deploy.mjs`:
   - a dry run that must write nothing;
   - a lost send: a recorded registry tx the node has never seen is cleared only on a positive "not found";
   - an interrupted send: it is killed after the registry tx is sent and before it is mined, and a re-run while that tx is pending must refuse;
   - the resume, which adopts that registry and must not deploy a second one;
   - an idempotent re-run, and `deployBlock` recorded from the router's receipt.
4. `demo-fork.mjs`: fixture tokens with real PotatoSwap pairs
5. CLI verdicts for the clean, blacklist, 99% sell tax, second-hop trap, fee and time-bomb tokens; the time bomb is checked before and after a scanner attestation
6. one CLI buy, and one refused buy

It prints a cost summary and `REHEARSAL OK`, then kills anvil. With `KEEP=1` it copies the fresh fork artifacts back
into the repo. Set `PORT=` if 8549 is busy.

**Web app against the fork.** The rehearsal stops anvil when it exits, so run a fork yourself. In one terminal:

```bash
anvil --fork-url https://xlayerrpc.okx.com --fork-block-number 76861306 --chain-id 196 --port 8549
```

In a second terminal, at the repo root. The key is anvil's public test key for account #2, so use it only on a fork.

```bash
cast rpc anvil_setBalance 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC 0x56BC75E2D63100000 --rpc-url http://127.0.0.1:8549
cast rpc anvil_setStorageAt 0x60e62Efa9405d6873C5deaBD4E6CC91c25363952 "$(cast index address 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC 5)" "$(cast to-uint256 100000000)" --rpc-url http://127.0.0.1:8549
export RPC_URL=http://127.0.0.1:8549 DEPLOYER_KEY=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a BUYER_KEY=0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6
SEND=1 node scripts/tapeout.mjs && SEND=1 node scripts/deploy.mjs && node scripts/demo-fork.mjs
cd web && python3 -m http.server 8765
```

Then open **`http://127.0.0.1:8765/?network=fork`** (add `&token=<address>&mode=balanced&check=1` to run a check
straight away). The demo tokens are listed on the page. On a loopback origin the app also picks the running fork by
itself when mainnet has no deployment yet. This writes the fork addresses into `deployments/fork*.json` and
`web/config.json`; `git checkout deployments web/config.json` restores them.

CLI: `node cli/exitproof.mjs check <token> --mode balanced --network fork` (exit code 0 = allow, 1 = blocked).
The CLI's default network is `xlayer` (mainnet); `--network fork` is only for local demos. On the fork, `buy` works only
through a loopback RPC, and `tx` (the agent path) is refused because the fork has `buyEnabled: false`.

### Mainnet (operator)

The step-by-step go-live, with the key read from `.env`, is in [MORNING.md](MORNING.md). In short: run
`scripts/tapeout.mjs` as a dry run, then with `SEND=1 CONFIRM_MAINNET=yes`. That writes `deployments/xlayer.json`. Then
do the same with `scripts/deploy.mjs`, which re-checks the circuit on chain, deploys the router and registry, and
updates `web/config.json` (including `deployBlock`).

Both scripts detect the network by probing the node, never from a flag. They refuse wallets with EIP-7702 code,
simulate every transaction before sending it, write nothing in a dry run, and stop at a banner unless
`CONFIRM_MAINNET=yes`. Running the scanner daemon, the backfill and publishing to DeWEB:
[docs/OPERATIONS.md](docs/OPERATIONS.md).

## License

MIT, see [LICENSE](LICENSE).

---

## Türkçe özet

**ExitProof: satamayacağın token'ı alma.** X Layer üzerinde bir alım router'ı. Token'ı PotatoSwap'ten alır, aynı
işlemin içinde pozisyonun tamamını kodu olmayan yepyeni bir adresten, bir DEX router'ının yaptığı gibi
`approve` + `transferFrom` ile havuza geri satmayı dener (bu deneme her zaman geri alınır), token'ların cüzdanına
gerçekten ulaştığını ölçer, alım/satım vergisini ölçer, owner ve yükseltilebilirlik bilgilerini toplar ve kararı 54
NAND kapılı bir TapeOut devresine bırakır. Devre "hayır" derse işlemin tamamı geri alınır: alım tutarı ve ücret
alınmaz, yalnızca geri alınan işlemin gas'ı harcanır.

- **Neyi kanıtlar:** alım anında pozisyonun tamamı yeni bir adresten, router yolundan şimdi satılabiliyor. **Neyi kanıtlayamaz:** sonraki bir blokta satış (yalnızca scanner'ın gecikmeli satışları yakalar), alımdan sonra owner'ın bir anahtarı çevirmesi (scanner), sıralı durum tuzakları (hiçbir parça yakalayamaz).
- **Modlar:** permissive (sadece honeypot kontrolü), **balanced** (varsayılan), strict (yalnızca izin listesindeki yüzey; çoğu yeni token'ı engeller). Uygulama üç durum gösterir: yeşil (çıkabilirsin), sarı (şimdi satılıyor ama riskli, sebep 4–7), kırmızı (çıkış yok, sebep 1–3).
- **Devre:** Yosys ile 54 NAND'a sentezlendi. 2048 girdinin tamamı hem çevrimdışı hem de gerçek bir TapeOut işlemcisi üzerinde (mainnet fork) doğrulandı; uygulamadaki devre gezgini `eval`'i canlı çağırır.
- **Üç savunma katmanı:** zincir üstü satış denemesi ve bytecode taraması (EIP-7702 dahil); token adresine göre tutulan ve codehash'i kontrol edilen RiskRegistry; fork üzerinde router yolu ve gecikmeli satış simülasyonu, owner yetkileri ve bilinmeyen setter taraması.
- **Güvenlik:** her görev çekişmeli bir incelemeden geçti; iki bağımsız son denetim (güvenlik + işlevsellik) mainnet öncesi yapıldı. Bulunan atlatma yolları (teslimat adımında kesinti, `transferFrom` tuzağı, aynı blokta satış, Flap token'larında yanlış honeypot, codehash'e göre kayıt, EIP-7702, sahte CBOR trailer, ikinci adım kara listesi, gizli owner, sabit admin) düzeltildi ve testle doğrulandı.
- **Sınırlar:** sonraki bloklar ve sıralı durum tuzakları, tx.origin'e veya router'a özel davranan token'lar, gas penceresi izi, alım sonrası owner işlemleri, taranmamış proxy'lerde sahte "upgradeable" (sebep 4), attester ve anahtar güveni, gerçek bir tarayıcı cüzdanıyla test edilmemiş alım yolu, TapeOut factory'sinin henüz mühürlenmemiş olması.
- **Gas:** fork üzerinde ilk alım ≈0,7M, önbellekli ≈0,45M. 24 KB'lık bir token'ın ilk alımı ≈5M'a çıkabilir. Cüzdanın gas limitini düşürme (≈8M pay bırak).
- **Gelir:** yönlendirilen alımlardan 10 bps (değiştirilemez üst sınır 30 bps), launchpad ve cüzdanlar için ücretli scanner API'si ve toplu attestation, "ExitProof verified" rozeti.
- **Çalıştırma:** `forge test`, `bash scripts/rehearse.sh` (sonunda `REHEARSAL OK`, yaklaşık 7 dakika). Web uygulaması: `http://127.0.0.1:8765/?network=fork`.
