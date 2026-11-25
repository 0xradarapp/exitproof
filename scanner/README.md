# ExitProof scanner (v10)

> **Balanced mode, plainly:** balanced passes only tokens with no unknown caller-gated functions; owner-renounce is not trusted. Any function outside the dangerous-name list (flagged anyway) whose code reads `msg.sender` or `tx.origin`, and any allowlisted function that compares them with storage or an address literal, makes the token `dangerSetter`, whatever `owner()` returns and whatever the simulation found. Only the plain Ownable `transferOwnership` / `renounceOwnership` shapes are exempt. Expect most owned tokens, including honest ones, tax tokens that check `from == pair`, and most launchpad (Flap) tokens, to be held back in balanced once scanned.

This is the deterministic scanner behind `RiskRegistry`. It is open source so anyone can re-run the scan (at the block recorded in the report) that set the flags for a token.

```
cd scanner && npm ci
node src/cli.mjs scan <token>                         # read-only; RPC_URL (default rpc.xlayer.tech, fallback xlayerrpc.okx.com)
FORK_RPC=http://127.0.0.1:8545 node src/cli.mjs simulate <token> <pair>   # anvil only
REGISTRY=0x.. ATTESTER_KEY_FILE=key.txt [SEND=1] node src/cli.mjs attest <token> [pair] [--force]
RPC_URL=.. REGISTRY=.. START_BLOCK=.. [ATTESTER_KEY_FILE=.. SEND=1 FORK_RPC=..] node src/cli.mjs daemon
[LIMIT=30] node src/cli.mjs backfill                  # existing pairs, newest first; dry-run unless SEND=1
node src/publish-reports.mjs                          # reports/ -> dist/reports/ (static index.json + reports)
node --test test/                                     # needs anvil and ../out (forge build)
```

Every send path (`attest`, `daemon`, `backfill` with `SEND=1`) needs `FORK_RPC` (the sell simulation; `attest` also needs the `<pair>`) unless `STATIC_ONLY=1` is set explicitly: a static-only entry for a delayed-sell or sequence trap would be "scanned, privileged", which balanced mode allows. Every send path also detects the network by probing the RPC (`scripts/lib/net.mjs`). On X Layer mainnet it prints a banner and refuses to send without `CONFIRM_MAINNET=yes`. An RPC that claims to be anvil is only trusted as a fork when its URL is loopback. The attester key comes only from the environment: `ATTESTER_KEY`, or `ATTESTER_KEY_FILE` pointing at a file with mode 600 (a group- or world-readable file is refused). A key on the command line is refused.

## Registry entries are per token (F-06)
`RiskRegistry.attest(address token, bytes32 codehash, Flags f, string reportURI)` stores the flags under the token address together with the codehash the scan saw. `flagsOf(token)` returns `(Flags f, bytes32 codehash)`, and the router honours an entry only while the token's current code hash equals it. An attestation of one instance is never reused by another instance of the same bytecode (a template that keeps its trap configuration in storage), and a hostile instance can no longer poison an honest template.

The daemon, `backfill` and `cli attest` share one decision (`decide()` in `src/attest.mjs`):
- no entry, or an entry for another codehash (the code changed): attest the new scan as it is;
- same codehash: never lower a flag (the new scan is ORed with the entry); attest when a flag rises or the entry is from an older scanner version, otherwise skip. Only `cli attest --force` writes a lower flag.

Reports are written to `reports/<token>.json` with `token`, `pair`, `block`, `codehash`, the flags, the decision and the full evidence (including the simulation). `publish-reports.mjs` bundles them into a static directory with an `index.json`. Set `REPORT_BASE_URL` to the published URL when attesting and the on-chain `reportURI` becomes `<base>/<token>.json`; without it, it is `exitproof://scan/v2/<token>/<codehash>`.

## Strict-mode guarantee (allowlist)
Strict mode only passes tokens whose whole external surface is known-safe. A token is `privileged` (blocked in strict mode) unless **all** of the following hold:

- The dispatcher chain can be followed from offset 0. That means a selector extracted with `CALLDATALOAD(0) >> 224`, compared in an EQ chain, optionally using the solc GT/LT binary split. Every dispatcher selector must be in `SAFE` (`src/selectors.mjs`):
  - the ERC-20 surface, plus `increaseAllowance` and `decreaseAllowance`;
  - EIP-2612 `permit`, `nonces` and `DOMAIN_SEPARATOR`;
  - EIP-5267 `eip712Domain`;
  - ERC-165 `supportsInterface`;
  - `owner` and `getOwner` (v9: `renounceOwnership` is no longer allowlisted; see the ownership-plumbing rule);
  - `burn` and `burnFrom` (v10, OpenZeppelin ERC20Burnable);
  - the getters `pair`, `uniswapV2Pair`, `uniswapV2Router`, `router` and `deployer`.
  Any other selector is listed in `evidence.unknownSelectors`.
- The no-match and no-selector paths only REVERT or STOP (or accept value). Anything else is `fallback-logic`. The prologue before the selector may only set the free memory pointer and do callvalue or calldatasize checks.
- `owner()`/`getOwner()` returns zero or reverts, and there is no AccessControl `hasRole`.
- No CALLER/ORIGIN value is compared (EQ, SUB, XOR or ADD) with an SLOAD-derived value (`caller-vs-storage`), or with a literal L where L or -L mod 2^256 is a non-zero 20-byte value (`caller-vs-literal`). That covers immutable and `address constant` admins: solc -O lowers `msg.sender == C` to `add(caller, not(C-1))`.
- No live CALL/STATICCALL goes to a target that is not a literal precompile or ADDRESS (`external-call`).
- No live read of external state (`external-state`):
  - BALANCE of anything other than a precompile, which includes `msg.sender.balance` and `address(this).balance`;
  - SELFBALANCE;
  - EXTCODESIZE, EXTCODEHASH or EXTCODECOPY of a target that is not ADDRESS, CALLER or a precompile.
  `evidence.externalState.balance` counts the balance reads. **Forced ETH makes balance-dependent logic writable by anyone**: SELFDESTRUCT can send wei to the token, the router or a holder, so a balance check is a kill switch the owner (or anyone) can flip.
  EXTCODE* reads of CALLER (`msg.sender.code.length` anti-bot checks) are recorded in `evidence.callerCodeChecks` and do **not** set `privileged`.
- No dangerous setter or live SELFDESTRUCT (`dangerSetter`), and the dispatcher is recognized.

`dangerSetter` (used by balanced mode) is set by any of:
- **v8 structural rule (`caller-gated-unknown`):** a dispatcher selector that is neither in SAFE nor on the dangerous list, whose statically reachable code (the context-sensitive dataflow from its entry; whole-code liveness when a jump cannot be resolved) reads CALLER or ORIGIN. `evidence.callerGatedUnknown` lists them;
- **v9/v10, inside SAFE selectors (`caller-gated-safe`):** (1) CALLER/ORIGIN may only be a mapping key (hashed into a slot) or the `from`/owner side of the accounting: any EQ/SUB/XOR/ADD comparison of CALLER or ORIGIN with a storage value or an address-like literal on a path reachable from an allowlisted selector makes it caller-gated. (2) v10 write rule: an allowlisted function may SSTORE only into keccak-derived (mapping) slots (balances, allowances, nonces) or into the one slot `totalSupply()` reads (traced statically; the mint/burn branches of a shared `_update`). Any other write (a fee, a flag, a counter) makes it caller-gated, with or without CALLER (an admin branch in `approve`, a permit whose signer is an admin, a sequence counter in `transfer`). `evidence.callerGatedSafe` lists the selectors. Real OpenZeppelin 5.5.0 ERC20 / ERC20Permit / ERC20Burnable / Ownable / Ownable2Step bodies stay clean (tested);
- **ownership plumbing exemption (v9, v10):** `transferOwnership(address)`, `renounceOwnership()` and `acceptOwnership()` are exempt (`evidence.ownershipPlumbing`) only in these exact shapes, with no external call, every write to a literal slot, and values exact (solc's read-modify-write merge into the slot's other bits allowed). Ownable: transfer writes only owner := `and(calldataload(4), 2^160-1)`, renounce writes only owner := 0, the written slot being the one compared with CALLER. Ownable2Step: transfer writes only pending := masked calldata (the owner slot, the one `owner()` reads, is the one compared with CALLER); accept writes pending := 0 and owner := CALLER with CALLER compared to pending; renounce writes pending := 0 and owner := 0. (d) For every slot written, on the `transfer`/`transferFrom` paths it is unread or only EQ-compared with a value traced to calldata (`from`/`to`) or CALLER; an unknown operand (for example routed through memory), a literal, arithmetic, a shift, ISZERO or a jump condition disqualifies it. Otherwise the function is caller-gated;
- a selector from the dangerous list (`src/selectors.mjs`);
- a live SELFDESTRUCT;
- an unrecognized dispatcher (fail-closed).
The dangerous list is matched against both the dispatcher chain and a linear PUSH4..EQ scan, which is more conservative.

`upgradeable` is set by any of:
- a live DELEGATECALL or CALLCODE to a target that is not a literal 0 or precompile;
- a non-zero EIP-1967 implementation or beacon slot;
- a non-zero EIP-1822 slot;
- an upgradeTo, upgradeToAndCall or setImplementation selector.

`ownerCanTrap` (and, for a delayed-sell trap, `dangerSetter`) comes from `simulate` on an anvil fork; see Simulation below. A fork rewind failure keeps the trap result and records `restoreError`.

Minimal proxies are resolved. A clone whose runtime is exactly EIP-1167 (`363d3d373d3d3d363d73<impl>5af43d82803e903d91602b57fd5bf3`) or ERC-7511 (`365f5f375f5f365f73<impl>5af43d5f5f3e5f3d91602a57fd5bf3`) is scanned using its implementation's code. Only one level is resolved. If the implementation has no code or is itself a clone, the scan fails closed (`clone-unresolved`).

solc's CBOR metadata trailer (a map with an `ipfs`/`bzzr`/`solc` key, length in the last two bytes) is treated as data, so a 0x5b byte in its hash does not make random bytes count as opcodes. That happens only when the dataflow resolved every jump and **no executed instruction lies inside it** (`metadataSkipped` in the analysis): a fake trailer reached by fall-through or by a PUSH whose immediate runs into it is analysed as code.

`evidence.reasons` lists which rules fired.

## Simulation (v5, v6)
`simulate` runs on an anvil node only and always rewinds it. The holder and the router stand-in are derived from the fork block hash and the token (`holder = keccak(blockHash ++ token)[12:]`), recorded in the evidence, reproducible given the block, and unknown before it, so a token cannot whitelist the simulator. `SimRouter` (`src/sim/SimRouter.sol`, compiled runtime in `src/sim/sim-router.json`, installed with `anvil_setCode`) sells the way a wallet user sells through PotatoSwap's router: `approve`, then `transferFrom(user, pair, amount)` and `swap`, with the user as `tx.origin`.

Every sell (SimRouter and the transfer path) is **priced on the reserves read after the token transfer** (amountIn = pair balance minus the post-transfer reserve), as ExitProofRouter does: Flap-style tokens swap their collected tax into the pair inside the seller's transfer, which moves the reserves. The tax is still measured against the pre-sell reserves.

Sells measured, each in its own snapshot (a sell "passes" when it executes and returns at least 50% of the no-tax V2 output):

| Sell | When |
|---|---|
| immediate | `roundTrip`: buy and sell back in one transaction (same block as receipt) |
| delayed | router sell of the whole position after +1 block, +60 s, +1 h, +1 d, +7 d, +30 d |
| transfer | `transfer(pair)` + `swap` after +1 h |
| interleaved (v6) | after +1 h a third (random, block-derived) address buys a little through the router, then the holder sells |

Signals. Each one also sets `privileged`, because balanced mode only denies `ownerActive & danger` and the router computes `ownerActive = fl.privileged || owner() != 0`:

| Signal | Condition | Flag |
|---|---|---|
| `delayed-sell-trap` (F-03) | the immediate sell passes and any delayed sell fails | `dangerSetter` |
| `delayed-tax-jump` (v6, N-05) | the immediate sell passes and a later one lands in a higher router tax bucket (5 / 15 / 50%) | `dangerSetter` |
| `sequence-trap` (v6, N-03) | the +1 h sell passes alone and fails after the third-party trade | `dangerSetter` |
| `transferFrom-trap` (F-02) | the transfer sell passes and the router (transferFrom) sell fails; also covers a no-op `approve` | `ownerCanTrap` |
| `baseline-sell-failed` | no sell passes at all, even after the owner unlock calls (enableTrading, ...) | `ownerCanTrap` |
| `unknown-setter-trap:<selector>` (F-04) | a selector outside SAFE and the dangerous list, called by a privileged caller, makes the sell fail or lose more than 50% | `ownerCanTrap` |
| `sweep-incomplete` (v6, N-01) | the sweep is not complete (an unknown selector that no identity could execute without revert, more than 40 selectors, or the 180 s budget) and the token has an active `owner()`, AccessControl, a caller-vs-literal check or a caller-vs-storage check (v8: no renounce exemption). An unexercised `transferOwnership` that passed the plumbing check is recorded in `plumbingUnexercised` and does not make the sweep incomplete. Since v8 the sweep no longer decides caller-gated functions (the static rule does); it adds evidence and catches traps that are not caller-gated | `dangerSetter` |
| `dangerous-setter-trap` | a dangerous-list setter with typed worst-case arguments traps the sell | `ownerCanTrap` |
| `simulate-error` / `simulate-gave-up` | an exception after a good baseline, or 5 failed daemon attempts | `ownerCanTrap` |

Why `delayed-sell-trap` sets `dangerSetter` (+ `privileged`): the router's probe sells in the same transaction as the buy, so a token that only lets a position be sold in the block (or transaction, via transient storage) it was received in passes the probe every time. Only the registry can carry this verdict. Strict blocks `danger`. Balanced blocks `ownerActive & danger`, and because the signal also sets `privileged`, balanced blocks it **even when the token has no owner**. That is the rule we recommend and implement: a token whose sale demonstrably closes after the buy has no honest reading, and an absent owner does not reopen it (the trap is in the code, not in an owner action). Permissive ignores the registry, as before.

Unknown-selector sweep (F-04, v6 N-01): every dispatcher selector that is not in SAFE or on the dangerous list is called ABI-less with four 32-byte words, for each of `0`, `max`, `1`, `10000`, `[holder,1,1,1]` and `[pair,1,1,1]`, plus, for each constant K (up to 8) that the selector's own code paths compare with EQ/XOR (`evidence.selectorHints`: magic arguments such as `require(key == 0x1234)`), K in each of the four argument positions over a `10000` or `max` background (at most 32 patterns per selector). Each call runs from the privileged callers in a snapshot and is followed by a router sell. Then **two-step pairs**: every call that changed the token's storage (prestateTracer diff) is followed by each other unknown selector with `10000`, `max` and the magic patterns (at most 120 pairs; `pairsTruncated` is recorded but does not fail closed). At most 40 selectors, within a 180 s budget. `complete` is true only when every unknown selector was exercised by at least one identity (`unknownSweep.exercised` / `unexercised`): executed without revert, and, for a selector with compared constants, with a change to the token's storage (prestateTracer diff), because `if (key != K) return;` succeeds without doing anything.

Callers: `owner()`, `deployer()`, the EIP-1967 admin slot, the PairCreated transaction sender (daemon), every address the code compares with CALLER (`evidence.callerLiterals`: immutable and constant admins), the token's creator (`ots_getContractCreator`, else the creation block found by bisecting `eth_getCode`, whose transaction senders are taken) and the recipients of its first mint, and up to 8 address-shaped values from storage: slots 0..15 and every slot the constructor wrote (prestateTracer diff of the creation transaction, when the node can trace it), each word read as a plain address, its low 160 bits, or an address packed as the highest variable after any 1..12-byte value. A mapping admin is almost always the creator.

### Fork vs mainnet environment (N-02)
A token can tell the simulator apart from X Layer by reading the block environment. Before any measurement the simulator copies the forked block's values onto the fork (`evidence.env`):

| Difference | Status |
|---|---|
| `block.coinbase` (anvil mines with 0x0; X Layer uses 0x4200…0011) | neutralized: `anvil_setCoinbase` to the forked block's miner |
| block gas limit | neutralized: `evm_setBlockGasLimit` |
| `block.basefee` | neutralized for the next block (`anvil_setNextBlockBaseFeePerGas`); later blocks drift with anvil's empty-block fee update |
| `block.chainid` | same as the fork upstream (anvil keeps it) |
| `block.timestamp` / `block.number` | real values at the fork block, then advanced by the simulator's own delays (that is what it measures) |
| `block.prevrandao` | **remains**: anvil cannot set it |
| `blockhash(n)` of blocks mined on the fork, `tx.gasprice`, `msg.sender.code` of the stand-in router (it has code, a wallet does not), `tx.origin` patterns, the router address | **remain** |

Statically, a COINBASE, PREVRANDAO, BASEFEE, BLOBBASEFEE, BLOCKHASH or GASPRICE read on a path reachable from `transfer`/`transferFrom` is reason `env-fingerprint` and sets `dangerSetter` (no honest ERC-20 needs them there), on top of `privileged` from `block-context`.

Static fence (F-03): a NUMBER, TIMESTAMP, ORIGIN or TLOAD reachable from `transfer` or `transferFrom` (context-sensitive reachability from the dispatcher entries; whole-code liveness if a jump cannot be resolved) is recorded in `evidence.blockContext` (reason `block-context`) and makes the token `privileged`, so strict blocks it. It does not set `dangerSetter`: EIP-2612 `permit` and honest launch logic read TIMESTAMP, so time traps are left to the simulator for balanced mode.

## Daemon coverage (F-05)
- A token is never dropped because it has no code yet (`PotatoFactory.createPair` accepts any address) or no liquidity yet. It goes to the `pending` set in the state file and is scanned when its pair emits `Sync` (first Mint), or when the periodic direct re-check (every 600 blocks) sees code and reserves. Scanning at first liquidity also means the simulation sees the launch configuration.
- A scan or simulation that keeps failing is retried. After 5 attempts it is attested fail closed (`simulate-gave-up`: `ownerCanTrap`; `scan-gave-up`: every flag).
- The PairCreated transaction sender is passed to the simulation as a privileged caller.

## Backfill
The daemon only follows new pairs, so every token listed before it started would stay `unscanned`, and balanced mode blocks those whenever an owner looks active. `backfill` scans and attests the existing PotatoSwap pairs:
- newest first, from `factory.allPairs` (multicall at one pinned block). A pair qualifies when exactly one side is WOKB or USD₮0 and that reserve is at least `DUST_OKB` (0.01) or `DUST_USDT` (1);
- dry-run by default. It writes the reports and prints one line per token, a summary and the OKB cost of attesting (measured at 79,041 gas for a first attestation; `ESTIMATE_PAIRS`, 950 by default; `COUNT_ALL=1` counts every live pair);
- resumable: `STATE_FILE` (default `state/backfill-<dry|send>.json`) pins the block and records the finished tokens. `RESET=1` starts over, and `LIMIT` bounds a run;
- rate-limit aware: a viem fallback transport over `RPC_URLS` (default `https://rpc.xlayer.tech`, then `https://xlayerrpc.okx.com`; the first one answers HTTP 403 when rate-limited), exponential backoff per token, and `RATE_MS` (250) between tokens;
- sharded: `SHARD=i/N` (0 <= i < N) takes only the pairs whose factory index is i mod N, with its own state file (`state/backfill-<mode>-shard<i>of<N>.json`; `STATE_DIR` moves the directory), so N processes (each with its own fork) split the backfill without overlap;
- `SWEEP_BUDGET_S` (default 180, also read by the daemon) is the wall-clock budget of one token's simulation. A sweep cut short by it is incomplete and fails closed (`sweep-incomplete`) when the token has an owner or a caller check, so raise it on a slow or cold fork rather than accept the false positives;
- `SEND=1` attests through the same decision as the daemon, behind the mainnet gate. It requires `FORK_RPC` (an anvil fork; `FORK_UPSTREAM` re-pins it to the block) unless `STATIC_ONLY=1` (the old `ALLOW_STATIC_ONLY=1` still works). A static-only "clean" attestation would turn strict mode's `unscanned` block into an allow without the sell simulation.

## Residual risks / limitations
- **Obfuscated caller checks.** Caller checks hidden behind arithmetic or ranges are missed. Examples: `caller * k == x`, `caller > A && caller < A+2`, hashing the caller, or comparing a masked or shifted caller against a computed value.
- **Caller taint lost in a merge.** When a calldata `from` and `msg.sender` flow through the same internal function (`_transfer(msg.sender, …)` vs `transferFrom`'s `from`), the dataflow join turns the value into "unknown", and a check on it inside the shared code is missed.
- **Joined admin literal sets.** A literal joined from several call sites ({set}) is checked per member, but NOT or arithmetic applied after the join is not folded, so the check is missed.
- **Logic inside allowlisted functions.** The allowlist proves the surface, not the behaviour. Block context on the transfer paths is now fenced statically (`block-context`). A `transfer()` whose result depends on gas or on its own state (a counter, "no other transfer since you received") still passes the static rules; `simulate` is the defence. **A same-transaction probe cannot prove sellability in any later block**: for that class the scanner (delayed sells) is the only defence, and a state-sequenced trap that the attacker's own bot keeps open during the simulation is not caught by any part of this design. An allowlisted getter name (for example `pair()`) could also be implemented as a state-changing function.
- **Unrecognized dispatcher forms fail closed** (privileged + dangerSetter). That includes Vyper, jump tables, XOR/SUB/OR compares, and hand-written dispatchers. Honest tokens written that way are blocked in strict and balanced modes.
- **Unknown selectors are simulated ABI-less.** One-word patterns plus compared constants cannot express every argument combination (for example a setter that only traps with `(holder, 5000, true)`), three-step setter chains are not tried, and a selector whose effect only shows after a delay is not caught. A hidden admin that is none of the caller sources above is never impersonated; if every call of its setter reverts the sweep is incomplete and fails closed when an owner or a caller check is visible, but **a mapping admin on a token with no `owner()` and no detectable caller check, whose creator is not that admin, is still missed**. The fail-closed rule also blocks honest owned tokens in balanced mode when one of their functions reverts for every identity (one-shot `init`, already-called `initialize`, functions that need value or a balance).
- **What remains (v10).** (1) Obfuscated caller use outside the EQ/SUB/XOR/ADD forms inside an allowlisted function (comparisons hidden in arithmetic or ranges, the caller hashed into a non-mapping value), and storage writes the write rule accepts: a value packed into the `totalSupply` slot, or a trap kept in a mapping entry (`_cfg[0]`, a keccak slot) written by an allowlisted function. (2) Traps that do not involve the caller or a scalar write at all and only trigger on values outside the sweep's patterns (an ungated, transformed magic argument; a state sequence the interleaved trade does not reproduce). (3) Behaviour of allowlisted getters beyond these rules. Caller taint is lost through memory and mapping lookups; SLOAD taint survives XOR/ADD/SUB/NOT/MUL.
- **Honest tokens held back in balanced (v8–v10).** Every token with a custom admin function (fee setters, `initPair`, `setPair`, `excludeFromFee` with a non-list name), an owner / pair / fee-exemption compare against `msg.sender` inside `transfer`/`approve`, or any scalar state written by `transfer` (swap-back flags, fee accumulators, launch counters) is `dangerSetter`, renounced or not. Only the plain Ownable / Ownable2Step shapes and the OpenZeppelin ERC20 / Permit / Burnable bodies pass.
- **Dataflow is context-limited.** If any jump target is unresolved, entry stacks are discarded. Constant targets then stop being recognized across blocks; for example, an ecrecover STATICCALL to precompile 0x01 is counted as `external-call`. That is fail-closed.
- **Some honest tokens are blocked in strict mode.** Every external call, including swap-back to a router and ETH sends, makes a token `privileged`, and so does every public getter that is not allowlisted (for example `maxTx()`).
- **`simulate` assumes a pool fee of at most 1%.** Quote tokens without `deposit()` are funded by a pair transfer. If no sell ever passes, even after unlock calls, the token is attested `baseline-sell-failed` (`ownerCanTrap`). A launch-pending token whose unlock call is not on the list stays flagged after trading opens, because the same-codehash entry is never lowered automatically: re-run `cli attest --force` after a manual check.
- **The router stand-in is not PotatoSwap's router.** `SimRouter` has its own (per-scan) address, so a token that special-cases PotatoSwap's router address can behave differently for real users.
- **Flags are never lowered automatically** for the same codehash. Only `cli attest --force` can lower one.
- **State-sequence traps (N-03)** are caught in their naive form (any other trade between receipt and sale). A trap that only reacts to specific counterparties, amounts or a trade count above one still passes.
- **Delays.** Sells are tried up to +30 d. A window longer than that passes.
- **Timing.** The unknown-selector sweep is wall-clock bounded, so a slow fork can turn a complete sweep into an incomplete (fail-closed) one; the evidence records `unknownSweep.truncatedBy` and `simulationTiming`.
