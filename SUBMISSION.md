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
- **Circuit ID:** `TBD (mainnet pending)`. The policy chip: 54 NAND, 11 inputs, 4 outputs (allow + 3-bit reason). All 2048 inputs were verified on the processor.
- **Other contracts:**
  - ExitProofRouter `TBD (mainnet pending)`
  - RiskRegistry `TBD (mainnet pending)`
  - The router trades on PotatoSwap V2 (factory `0x630DB8E822805c82Ca40a54daE02dd5aC31f7fcF`).
- **Access link:** `TBD (live app URL)`. On DeWEB: `TBD (after mainnet publish: https://<circuitId>-2-<processorIndex>.tapekit.org/)`.
- **Repo:** `TBD (repo URL)`
- **Demo video (≤ 3 min):** `TBD (video link)`

### Product / service

ExitProof is a buy router for X Layer memecoins that blocks any buy whose full exit fails at the moment of purchase. The known residuals are listed in the README.

When you buy through ExitProof, the router does four things inside your transaction:

1. It swaps OKB for the token on the real PotatoSwap pair.
2. It hands the tokens to a fresh holder contract, which sells **100%** of them back to the same pair. This probe is always reverted, so it leaves no trace.
3. It measures the buy and sell tax, reads `owner()`, scans the bytecode for upgrade or self-destruct paths, and reads the ExitProof scanner's registry flags for the token's codehash.
4. It feeds these 11 facts to a 54-gate TapeOut circuit, which answers allow or deny with a reason code.

On deny, the whole transaction reverts with the reason, and only the gas of the reverted transaction is spent; the buy amount and fee are never taken. On allow, the tokens go to the
buyer, and `minOut` is checked on what actually arrived.

Users pick a mode:

- **permissive:** "is it a honeypot?"
- **balanced:** the default. It also blocks upgradeable tokens, and tokens whose active owner holds dangerous switches or hasn't been scanned yet.
- **strict:** allowlisted code only.

The same check is free as `inspect()`, an `eth_call` that never buys. The web app, the CLI and an OKX Agentic Wallet
skill all use it.

An open-source scanner daemon attests every new PotatoSwap pair. It runs a static allowlist analysis and simulates the
owner's powers on a fork, which catches "time bombs" such as an owner who can disable trading later. A fresh launch
is attested a few polls after its pair is created. Until then, balanced mode treats it as unscanned: an unscanned token
with an active owner is blocked with reason 6.

### Target users

1. **Retail memecoin buyers on X Layer.** PotatoSwap has about 27,500 pairs, and many new launches are honeypots or carry owner switches. Buying through ExitProof costs 0.1% more. It blocks any buy whose full exit fails at the moment of purchase, so the common "bought, can't sell" trap is caught before any money moves. The residuals (later owner actions, tokens that single out the router or `tx.origin`) are listed in the README.
2. **AI trading agents** (OKX Agentic Wallet, Onchain OS). An agent can't judge a token by reading its website. ExitProof gives agents a JSON verdict they can read by machine, and enforces the same verdict on chain when they buy. An agent that was talked into a bad token still can't get past a failing exit check: the buy reverts.
3. **Launchpads and wallets** that want to show "can you sell this?" next to every token, and to badge clean launches.

### Revenue model

- **Router fee:** 10 bps on every routed buy, paid on chain to the fee recipient. The 30 bps hard cap is immutable in the contract, so the fee can't be raised later, and there is no admin over user funds.
- **Paid scanner API and bulk attestations** for launchpads, wallets and bot builders: a verdict and an on-chain attestation for every new pair, plus webhooks.
- **"ExitProof verified" launch badge:** a launch whose codehash passes strict mode (allowlisted surface, no live owner, not upgradeable) can show a badge that links to the on-chain attestation.

### Why users pay and keep using it

- **It works like insurance for 0.1%.** One honeypot costs the whole position; ExitProof costs 10 bps per buy, and on a deny it costs only gas.
- **The proof is the real exit.** ExitProof doesn't rely on a risk score from someone else's database. It runs a full sell-back on the real pool, in the user's own transaction, at the moment of purchase.
- **Agents need a check they can verify by machine.** An agent can call `inspect`, read the reason code and the facts, and buy through the same router knowing the chain enforces the answer. Every agent buy is a routed buy.
- **It gets better with use.** An attestation is keyed by codehash, so it covers every byte-identical deployment of a launch template, and the on-chain scan result is cached per codehash too. Launchpads that badge their tokens bring their buyers to the router.
- **No lock-in.** It is a router, not custody. Users stay because it is cheaper than one bad buy.

### TapeOut ecosystem integration

- **Own processor and taped-out circuit.**
  - ExitProof created its own processor ("ExitProof Guard"), minted 54 NAND transistors and taped out the policy circuit, all scripted in `scripts/tapeout.mjs`.
  - The netlist was synthesized with Yosys (`abc -g NAND`).
  - It was verified on all 2048 inputs off chain, and again on the processor after tape-out: the netlist bytes read back identical, `circuitInfo` matched, and 2048/2048 evals agreed.
- **The circuit decides every trade.**
  - `buyETH`, `buy` and `inspect` call `processor.eval(circuitId, facts)` inside the transaction, and the router acts on the answer.
  - Solidity adds only the money checks: minOut, deadline and the fee cap. The circuit isn't there for decoration; deny means revert.
- **DeWEB / TapeKit:** DeWEB-ready. ethers and the fonts are vendored, so the page loads from zero external hosts and passes TapeKit's "100% on-chain" rule. `scripts/publish-deweb.mjs` stores it in the circuit's own ERC-6551 container and binds `<circuitId>.2.<processorIndex>.tape`; the publish was rehearsed on a fork (38 txs, ≈0.0831 OKB estimated on mainnet). Gateway URL `TBD` after the mainnet publish.
- **OKX Agentic Wallet:** `agent/SKILL.md`. The CLI prepares the `buyETH` call, and the agent signs it with `onchainos wallet contract-call` after the user confirms.

### What was built during the event

All of it. First commit 2026-11-25.

- The circuit: spec, RTL, Yosys synthesis, exhaustive verification.
- RiskRegistry, the BytecodeScan library and ExitProofRouter, with the full-exit probe through a fresh holder.
- Foundry tests, counted at commit `5fb8343`:
  - 92 offline tests: unit, fuzz, invariant and gas;
  - 30 fork tests against the real PotatoSwap and a real TapeOut processor on a fork of mainnet, including a 32-buy stress run.
- The deterministic scanner (v4 allowlist model) with fork simulation, attestation and a PotatoSwap pair daemon, covered by 81 tests (at `5fb8343`).
- The static web app (EN/TR), the CLI and the agent skill.
- The mainnet-gated tape-out and deploy scripts, and a one-command fork rehearsal of the whole flow (`scripts/rehearse.sh`).
- Adversarial reviews of each component. They found real bypasses (a forged CBOR trailer, a PUSH overrun, a second-hop blacklist, hidden or constant admins, a balance kill switch), and each one was fixed and covered by a test or a recorded manual check.

### Honest limits (short form)

ExitProof proves the exit at the moment of purchase. It does not stop an owner action that comes later, unless the
scanner flagged that power. A token that treats the router, `tx.origin` or contracts differently can still pass the
probe. About 4% of honest unscanned tokens are falsely read as upgradeable until scanned. The first buy of a very
large token can cost up to about 5M gas. TapeOut's factory isn't sealed yet, so its owner can still change how
circuits are evaluated. The full list is in the README.
