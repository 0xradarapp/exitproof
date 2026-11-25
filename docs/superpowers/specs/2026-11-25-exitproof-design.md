# ExitProof — design

**Hackathon:** OKX X Layer "TapeOut Accelerate" (Build X series). Deadline 2026-12-07 23:59 UTC.
**One line:** Don't buy what you can't sell. A swap router on X Layer that buys a token, proves in the same
transaction that the whole position can be sold back, and lets a TapeOut circuit decide whether the trade stands.

## Why
Honeypot tokens (can buy, can't sell; 90%+ sell tax; blacklist; owner "time bombs" that flip later) are the most
common retail scam by count. On X Layer the memecoin market lives on PotatoSwap V2 (27.5k pairs, 0.25% fee,
factory `0x630DB8E822805c82Ca40a54daE02dd5aC31f7fcF`). No TapeOut Accelerate entry covers this
(BBBFi TapeGuard explicitly says it cannot detect scams/token admins). Users: retail traders and AI agents
(OKX Agentic Wallet) buying fresh tokens.

## Goals
- G1 `ExitProofRouter`: atomic buy → full-position sell probe (reverted) → facts → `processor.eval` → allow or revert.
  The user's money never leaves if the circuit says no.
- G2 Time-bomb defence: facts about owner power and upgradeability, three-layer:
  - L1 on-chain at swap time: `owner()` staticcall; bytecode opcode scan (DELEGATECALL/CALLCODE/SELFDESTRUCT,
    PUSH-data aware) of the token.
  - L2 `RiskRegistry` keyed by `EXTCODEHASH`, written by an attester from an open-source deterministic scanner
    (privileged-setter selectors, EIP-1967/1822/beacon slots, hidden owner patterns, external fee-oracle calls).
  - L3 (bonus) owner-power simulation on an anvil fork: impersonate owner/privileged roles, call every candidate
    setter with worst-case args, retry the sell → `ownerCanTrap` flag.
- G3 User-chosen strictness mode (strict / balanced / permissive) fed to the circuit.
- G4 Free `inspect()` (revert-with-result, used via eth_call) so anyone/any agent can check a token without buying.
- G5 Scanner daemon auto-attests every new PotatoSwap pair → strict mode works for fresh launches.
- G6 Static web app (DeWEB-ready) + CLI/agent skill. Live on X Layer mainnet with verified sources.

## Non-goals
Protecting after purchase (X Layer has a central sequencer and no public mempool: no front-run exit).
Multi-hop routing, V3 pools (stretch), price oracles, MEV protection beyond `minOut`.

## Anti-goals (failure even if it "works")
- Router custody/admin over user funds, upgradeable router, owner-changeable fee above the immutable cap.
- A circuit that is decorative (Solidity silently overriding it). Solidity only adds hard money checks (minOut, fee
  cap); the allow/deny decision comes from `eval`.
- Unverified claims in README. Every claim backed by a test or a tx hash.

## Constraints
X Layer chain 196, RPC `https://rpc.xlayer.tech` (log queries capped at 100 blocks). OKB gas. WOKB
`0xe538905cf8410324e03A5A23C1c177a474D59b2b`. TapeOut factory `0x1f09daefa827f02cbb40967cc91b259763760761`
(`isCPU`), processors expose `eval(uint256,bytes) view returns (bytes)`, `tapeout(bytes nl,uint32 nIn,uint32 nOut)`,
transistors ERC-1155 `mint(0, n)`. TapeOut has no testnet → everything rehearsed on an anvil fork of mainnet.
Netlist format: 7 bytes per gate `[type=0x00 NAND][a:uint24][b:uint24]`; wire 0 = const 0, wire 1 = const 1,
wires 2..2+nIn-1 = inputs (bit i of inputs = byte[i/8] >> (i%8)), then gates in order; outputs = last nOut gates,
packed the same way. (Confirmed against Latch's tapeout2.mjs; re-verify on fork.)

## Circuit interface (frozen — contracts and circuit agents both build to this)
11 inputs, 4 outputs. Input bit layout (bit 0 = LSB of byte 0):

| bit | name | meaning |
|---|---|---|
| 0 | sellOk | full-position sell probe succeeded |
| 1-2 | sellTax | bucket: 0 <5%, 1 5–15%, 2 15–50%, 3 ≥50% or unmeasurable |
| 3-4 | buyTax | same buckets, measured on the buy |
| 5 | ownerActive | `owner()` non-zero OR registry `privileged` |
| 6 | upgradeable | on-chain opcode scan hit OR registry `upgradeable` |
| 7 | danger | registry `dangerSetter` OR `ownerCanTrap` |
| 8 | unscanned | no registry entry for the token's codehash |
| 9-10 | mode | 0 strict, 1 balanced, 2 permissive, 3 = strict |

Outputs: bit 0 `allow`; bits 1-3 `reason` (0 when allow).
Policy (`base = sellOk & sellTax<=1 & buyTax<=1`):
- permissive: allow = base
- balanced: allow = base & !upgradeable & !(ownerActive & danger) & !(ownerActive & unscanned)
- strict: allow = base & sellTax==0 & buyTax==0 & !upgradeable & !ownerActive & !danger & !unscanned
Reason = first failing check in order: 1 cannot sell; 2 sell tax too high (for mode); 3 buy tax too high (for mode);
4 upgradeable; 5 dangerous owner powers (balanced: ownerActive&danger; strict: danger); 6 unscanned
(balanced: with ownerActive; strict: any); 7 owner still active (strict only).
Reference model in `circuit/spec.py` is the single source of truth; netlist verified on all 2048 inputs off-chain
and on the fork processor.

## Contracts (Foundry, solc 0.8.24, no admin over funds)
- `ExitProofRouter` (immutable: processor, circuitId, registry, WOKB, feeRecipient, feeBps ≤ 30 hard cap,
  allowlisted V2 factories with their fee bps — PotatoSwap 25).
  - `buyETH(factory, token, minOut, mode, to, deadline) payable` and `buy(factory, tokenIn, amountIn, token, minOut,
    mode, to, deadline)`. Pair must equal `factory.getPair`. Takes fee, swaps directly on the pair (balance-diff aware),
    measures buy tax, then `try this.probeSell(...)` which sells the FULL received amount back on the pair and always
    reverts with `(bool ok, uint256 out)`; computes sell tax; builds facts; `eval`; reverts `Blocked(reason, facts)` or
    forwards tokens to `to` and emits `Checked(token, codehash, facts, allow, reason)`.
  - `inspect(factory, tokenIn, amountIn, token, mode)` — non-view, always reverts with `Report(facts, allow, reason,
    buyOut, sellOut)`; for eth_call.
  - Reentrancy guard; exact approvals; nothing left in the router after a call.
- `RiskRegistry` — `codehash => {scanned, privileged, upgradeable, dangerSetter, ownerCanTrap, scannerVersion,
  reportURI}`; attester set managed by owner (only affects flags, never funds); events for every attestation.
- `BytecodeScan` library — PUSH-aware opcode scan of `extcodecopy`.
- Tests: unit + fork tests against real PotatoSwap and a real TapeOut processor (create CPU + tape out on the fork).
  Malicious fixtures: blacklist-on-buy, 99% sell tax, maxTx/maxWallet, cooldown, trading-disabled, owner setFee
  (time bomb), UUPS proxy token, tx.origin trap, fee-oracle external call; plus a clean token.

## Scanner (Node + viem, `scanner/`)
`scan(token)` → flags JSON (deterministic, versioned): selector match against a dangerous-setter list (4byte
signatures), opcode scan, proxy slots (EIP-1967 impl/beacon/admin, EIP-1822), `owner()`/`getOwner()`/AccessControl
roles. L3 `simulate(token)` on anvil fork with impersonation. `daemon` watches PotatoSwap `PairCreated` (100-block
log windows) and attests. `attest` writes to `RiskRegistry`.

## Web + agent
Static `web/index.html` (ethers v6 via CDN, no build) — paste token → free check (eth_call `inspect`) with human
explanations of each fact → connect wallet → buy through ExitProof; live feed of `Checked`/`Attested` events
("honeypots blocked"). DeWEB-ready. `cli/exitproof.mjs check|buy` + OKX Agentic Wallet skill doc.

## Revenue
10 bps on routed buys (immutable cap 30 bps); paid scanner API / bulk attestations for launchpads and wallets;
"ExitProof verified" badge for clean launches.

## Approaches considered
A (picked by user): enforcing swap router + circuit. B: certificate registry only (no enforcement, stale) — kept as
a by-product (registry + events). C: off-chain dashboard — duplicates OKX Wallet/GoPlus, circuit decorative.

## Left to the builder
Exact tax-bucket math, gas tuning, UI copy, scanner selector list, fixture details.

## Needs the user (end of build)
Funded deployer key on X Layer (≈0.05 OKB est.), demo video recording/voice, Google-form submission, X posts.
