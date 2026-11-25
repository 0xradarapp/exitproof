# ExitProof: submission kit (X Layer TapeOut Accelerate)

Ready-to-paste answers for the Google Form. Fill in the `TBD` values after the mainnet run: `deployments/xlayer.json`
has them once `scripts/tapeout.mjs` and `scripts/deploy.mjs` have run with `SEND=1 CONFIRM_MAINNET=yes`.

## One line

Don't buy what you can't sell: ExitProof buys a token on X Layer, sells the whole position back in the same
transaction, and lets a TapeOut circuit decide whether the buy stands. If the answer is no, the transaction reverts:
the buy amount is never taken, and only the gas of the reverted transaction is spent.

## Form fields

- **Project name:** ExitProof
- **Processor contract address:** `TBD (mainnet pending)`. This is ExitProof's own TapeOut processor "ExitProof Guard" (EXITP) on X Layer, chain 196.
- **Circuit ID:** `TBD (mainnet pending)`. The policy chip: 54 NAND, 11 inputs, 4 outputs (allow + 3-bit reason). All 2048 inputs were verified on the processor after tape-out, and again right before the router was deployed.
- **Other contracts:**
  - ExitProofRouter `TBD (mainnet pending)`
  - RiskRegistry `TBD (mainnet pending)`
  - The router trades on PotatoSwap V2 (factory `0x630DB8E822805c82Ca40a54daE02dd5aC31f7fcF`).
- **Access link:** `TBD (live app URL)`. On DeWEB: `TBD (after mainnet publish: https://<circuitId>-2-<processorIndex>.tapekit.org/)`.
- **Repo:** `TBD (repo URL)`
- **Demo video (≤ 3 min):** `TBD (video link)`

### Product / service

ExitProof is a buy router for X Layer memecoins that blocks any buy whose full exit fails at the moment of purchase.
A single transaction proves exactly this: the whole position is sellable now, from a fresh address, through the router
path. What it cannot prove (a later block, an owner action after the buy) is left to the scanner, and the README says
so on its first screen.

When you buy through ExitProof, the router does five things inside your transaction:

1. It swaps OKB for the token on the real PotatoSwap pair.
2. It sends the tokens to a brand-new address with no code, which approves the router, and the router sells **100%**
   of them back to the same pair with `transferFrom`, the way a DEX router sells for a wallet. This probe is always
   reverted, so it leaves no trace.
3. It delivers the tokens to the buyer and measures what actually arrived.
4. It measures the buy and sell tax (the buy tax includes what the hop to the buyer kept), reads `owner()`, scans the
   bytecode for upgrade or self-destruct paths (EIP-7702 delegations count as upgradeable), and reads the ExitProof
   scanner's registry entry for the token, which counts only while the token's code still matches the code that was
   scanned.
5. It feeds these 11 facts to a 54-gate TapeOut circuit, which answers allow or deny with a reason code.

On deny, the whole transaction reverts with the reason, the delivery included, and only the gas of the reverted
transaction is spent; the buy amount and fee are never taken. On allow, `minOut` is checked on what the buyer
actually received.

Users pick a mode:

- **permissive:** "is it a honeypot?"
- **balanced:** the default. It also blocks upgradeable tokens, and tokens whose active owner holds dangerous switches or hasn't been scanned yet.
- **strict:** allowlisted code only.

The app shows three states: green "you can get out", amber "sells now, but risky" (the sell-back worked, but the mode's
owner, upgrade or scan policy says no), and red "exit blocked". The same check is free as `inspect()`, an `eth_call`
that never buys. The web app (EN/TR/中文, with a second RPC as fallback), the CLI and an OKX Agentic Wallet skill all
use it.

An open-source scanner daemon attests every new PotatoSwap pair at its first liquidity, and a launch-day backfill
covers the existing ones, newest first, in parallel shards. Scanner v6 runs a static allowlist analysis and simulates
on a fork whose coinbase, gas limit and base fee match the forked mainnet block: router-path sells priced like
PotatoSwap's router (correct for Flap tokens that swap their tax back), sells from one block up to 30 days later, a
sell after a third party has traded (sequence traps), the owner's dangerous setters, and a sweep of unknown setters
with magic arguments and two-step pairs that fails closed when it cannot finish. That catches time bombs such as an
owner who can disable trading later, and tokens that only let you sell in the block you bought. Until a token is attested, balanced mode treats it as unscanned: an unscanned token with an
active owner is held back with reason 6.

### Target users

1. **Retail memecoin buyers on X Layer.** PotatoSwap has about 27,500 pairs, but only about 950 have a live WOKB pool. In our census of 800 of those live tokens (block 76,868,206; see `docs/CENSUS.md` for the latest run), 31.1% of the buyable ones could not be sold back, and 38.4% had an active owner holding dangerous switches. Buying through ExitProof costs 0.1% more. It blocks any buy whose full exit fails at the moment of purchase, so the common "bought, can't sell" trap is caught before any money moves. The residuals (later blocks, later owner actions, tokens that single out the router or `tx.origin`) are listed in the README.
2. **AI trading agents** (OKX Agentic Wallet, Onchain OS). An agent can't judge a token by reading its website. ExitProof gives agents a JSON verdict they can read by machine, and enforces the same verdict on chain when they buy. Token names reach the agent only as labelled untrusted text. An agent that was talked into a bad token still can't get past a failing exit check: the buy reverts.
3. **Launchpads and wallets** that want to show "can you sell this?" next to every token, and to badge clean launches.

### Revenue model

- **Router fee:** 10 bps on every routed buy, paid on chain to the fee recipient. The 30 bps hard cap is immutable in the contract, so the fee can't be raised later, and there is no admin over user funds.
- **Paid scanner API and bulk attestations** for launchpads, wallets and bot builders: a verdict and an on-chain attestation for every new pair, a published report per token, plus webhooks.
- **"ExitProof verified" launch badge:** a launch whose code passes strict mode (allowlisted surface, no live owner, not upgradeable) can show a badge that links to the on-chain attestation.

### Why users pay and keep using it

- **It works like insurance for 0.1%.** One honeypot costs the whole position; ExitProof costs 10 bps per buy, and on a deny it costs only gas (about 0.00005 OKB for a blocked honeypot buy at today's gas price).
- **The proof is the real exit.** ExitProof doesn't rely on a risk score from someone else's database. It runs a full sell-back on the real pool, in the user's own transaction, at the moment of purchase, and measures what the user really receives.
- **Agents need a check they can verify by machine.** An agent can call `inspect`, read the reason code and the facts, and buy through the same router knowing the chain enforces the answer. Every agent buy is a routed buy.
- **It gets better with use.** Every attested token, with its published report, is one more token the next buyer doesn't have to guess about. The app shows the totals since launch (tokens scanned, flagged, guarded buys, OKB routed) and the newest PotatoSwap pairs with their scanner status, which gives people a reason to open it every day. Launchpads that badge their tokens bring their buyers to the router.
- **No lock-in.** It is a router, not custody. Users stay because it is cheaper than one bad buy.

### TapeOut ecosystem integration (TapeOut features used)

- **Circuits / `eval` in every buy.**
  - `buyETH`, `buy` and `inspect` call `processor.eval(circuitId, facts)` inside the transaction, and the router acts on the answer.
  - Solidity adds only the money checks (minOut, deadline, fee cap) and a backstop that can turn an allow into a revert but never a deny into an allow. The circuit isn't there for decoration; deny means revert.
- **The live explorer calls `eval`.** The web app's circuit explorer has 11 fact toggles; each change calls `processor.eval` on chain and shows it next to the reference model running in the browser ("✓ matches"), with the reason. "Replay these facts" loads the facts of any check.
- **Own processor and taped-out circuit.**
  - ExitProof created its own processor ("ExitProof Guard"), minted 54 NAND transistors and taped out the policy circuit, all scripted in `scripts/tapeout.mjs`.
  - The netlist was synthesized with Yosys (`abc -g NAND`).
  - It was verified on all 2048 inputs off chain, and again on the processor after tape-out: the netlist bytes read back identical, `circuitInfo` matched, and 2048/2048 evals agreed. `scripts/deploy.mjs` repeats those checks on chain before it deploys.
- **DeWEB / TapeKit (pending publish).** ethers and the fonts are vendored, so the page loads from zero external hosts and passes TapeKit's "100% on-chain" rule; its CSP allows only the two X Layer RPC hosts. `scripts/publish-deweb.mjs` stores it in the circuit's own ERC-6551 container and binds `<circuitId>.2.<processorIndex>.tape`; the publish was rehearsed on a fork (38 txs, ≈0.083 OKB estimated on mainnet). Gateway URL `TBD` after the mainnet publish.
- **OKX Agentic Wallet:** `agent/SKILL.md`. The CLI prepares the `buyETH` call, and the agent signs it with `onchainos wallet contract-call` after the user confirms.

### What was built during the event

All of it. First commit 2026-11-25.

- The circuit: spec, RTL, Yosys synthesis, exhaustive verification.
- RiskRegistry (keyed by token address, with a codehash check and two-step ownership), the BytecodeScan library and
  ExitProofRouter, with the full-exit probe from a code-less holder through `transferFrom` and a measured delivery.
- Foundry tests, counted at commit `2ed1b9f`:
  - 119 offline tests: unit, fuzz, invariant, gas and the final-audit regressions;
  - 35 fork tests against the real PotatoSwap and a real TapeOut processor on a fork of mainnet, including a 37-step
    stress run and 10 real launchpad and honeypot tokens checked against PotatoSwap's own router.
- The deterministic scanner (v6: allowlist model, mainnet-matched fork environment, Flap-correct router-path sells,
  delayed sells up to +30 d, sequence-trap and tax-jump signals, a fail-closed unknown-setter sweep, sharded backfill,
  mainnet send gate), covered by 124 tests (at commit `f475f0c`).
- The static web app (three-state verdict, circuit explorer, new-pairs list, totals since launch, EN/TR/中文, RPC
  fallback), the CLI and the agent skill, with 12 tests.
- The mainnet-gated tape-out, deploy and DeWEB scripts, and a one-command fork rehearsal of the whole flow
  (`scripts/rehearse.sh`).
- A Token Safety Census of live PotatoSwap tokens, measured by ExitProof itself on a fork (`docs/CENSUS.md`).
- Adversarial reviews of each component, then two independent final audits (security and functional) before mainnet.
  They found real bypasses (a forged CBOR trailer, a PUSH overrun, a second-hop blacklist, hidden or constant admins,
  a balance kill switch, a skimmed delivery hop, a `transferFrom` trap, a same-block sell trap, codehash-keyed
  attestations, EIP-7702 tokens) and a false "honeypot" verdict on real launchpad tokens. Each one was fixed and
  covered by a test.

### Honest limits (short form)

One transaction proves the exit at the moment of purchase, from a fresh address, through the router path. It cannot
prove a sale in a later block: tokens that allow a sale only in the receiving block are caught by the scanner's
delayed sells (up to +30 d), the naive sequence trap by its third-party trade, and a sequence trap that reacts only to
chosen counterparties or amounts, kept open by the attacker's own bot, by nothing in this design. The simulation's
fork still differs from mainnet in `prevrandao`, fork block hashes and gas price, and its sweep misses some hidden
admins and argument combinations. An
owner action after the buy is stopped only if the scanner flagged that power. A token that treats the router or
`tx.origin` differently can still pass the probe. Unscanned proxies (including launchpad clones) are read as
upgradeable until scanned. The first buy of a very large token can cost up to about 5M gas. TapeOut's factory isn't
sealed yet, so its owner can still change how circuits are evaluated. The full list is in the README.
