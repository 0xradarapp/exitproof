# ExitProof scanner (v4)

This is the deterministic scanner behind `RiskRegistry`. It is open source so anyone can re-run the scan that set the flags for a codehash.

```
cd scanner && npm ci
node src/cli.mjs scan <token>                         # read-only; RPC_URL (default https://rpc.xlayer.tech)
FORK_RPC=http://127.0.0.1:8545 node src/cli.mjs simulate <token> <pair>   # anvil only
REGISTRY=0x.. ATTESTER_KEY=0x.. [SEND=1] node src/cli.mjs attest <token> [pair] [--force]
RPC_URL=.. REGISTRY=.. START_BLOCK=.. [ATTESTER_KEY=.. SEND=1 FORK_RPC=..] node src/cli.mjs daemon
node --test test/                                     # needs anvil and ../out (forge build)
```

## Strict-mode guarantee (allowlist)
Strict mode only passes tokens whose whole external surface is known-safe. A token is `privileged` (blocked in strict mode) unless **all** of the following hold:

- The dispatcher chain can be followed from offset 0. That means a selector extracted with `CALLDATALOAD(0) >> 224`, compared in an EQ chain, optionally using the solc GT/LT binary split. Every dispatcher selector must be in `SAFE` (`src/selectors.mjs`):
  - the ERC-20 surface, plus `increaseAllowance` and `decreaseAllowance`;
  - EIP-2612 `permit`, `nonces` and `DOMAIN_SEPARATOR`;
  - EIP-5267 `eip712Domain`;
  - ERC-165 `supportsInterface`;
  - `owner`, `getOwner` and `renounceOwnership`;
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

`dangerSetter` (used by balanced mode) is still name based. It is set by any of:
- a selector from the dangerous list (`src/selectors.mjs`);
- a live SELFDESTRUCT;
- an unrecognized dispatcher (fail-closed).
The dangerous list is matched against both the dispatcher chain and a linear PUSH4..EQ scan, which is more conservative.

`upgradeable` is set by any of:
- a live DELEGATECALL or CALLCODE to a target that is not a literal 0 or precompile;
- a non-zero EIP-1967 implementation or beacon slot;
- a non-zero EIP-1822 slot;
- an upgradeTo, upgradeToAndCall or setImplementation selector.

`ownerCanTrap` comes from `simulate` on an anvil fork. It is fail-closed in three cases: an exception after a good baseline sell, a simulation that keeps failing (`simulate-gave-up` after 5 daemon attempts), or a fork rewind failure (the trap result is kept, and the failure is recorded as `restoreError`).

Minimal proxies are resolved. A clone whose runtime is exactly EIP-1167 (`363d3d373d3d3d363d73<impl>5af43d82803e903d91602b57fd5bf3`) or ERC-7511 (`365f5f375f5f365f73<impl>5af43d5f5f3e5f3d91602a57fd5bf3`) is scanned using its implementation's code. Only one level is resolved. If the implementation has no code or is itself a clone, the scan fails closed (`clone-unresolved`).

`evidence.reasons` lists which rules fired.

## Residual risks / limitations
- **Obfuscated caller checks.** Caller checks hidden behind arithmetic or ranges are missed. Examples: `caller * k == x`, `caller > A && caller < A+2`, hashing the caller, or comparing a masked or shifted caller against a computed value.
- **Caller taint lost in a merge.** When a calldata `from` and `msg.sender` flow through the same internal function (`_transfer(msg.sender, …)` vs `transferFrom`'s `from`), the dataflow join turns the value into "unknown", and a check on it inside the shared code is missed.
- **Joined admin literal sets.** A literal joined from several call sites ({set}) is checked per member, but NOT or arithmetic applied after the join is not folded, so the check is missed.
- **Logic inside allowlisted functions.** The allowlist proves the surface, not the behaviour. A `transfer()` whose result depends on `block.number`, `block.timestamp`, gas, or its own state (a counter, a launch timestamp) passes the static rules. The router's live sell probe and `simulate` are the only defence. An allowlisted getter name (for example `pair()`) could also be implemented as a state-changing function.
- **Unrecognized dispatcher forms fail closed** (privileged + dangerSetter). That includes Vyper, jump tables, XOR/SUB/OR compares, and hand-written dispatchers. Honest tokens written that way are blocked in strict and balanced modes.
- **Unknown selectors are not simulated.** `simulate` only calls the dangerous-list setters. Unknown functions only make the token `privileged`.
- **Taint limits.** Caller taint is lost through arithmetic, memory or mapping lookups (`require(_ops[msg.sender])`). Such admin functions are still caught by the allowlist, because the function itself must be unknown, unless the gated logic sits inside an allowlisted function.
- **Dataflow is context-limited.** If any jump target is unresolved, entry stacks are discarded. Constant targets then stop being recognized across blocks; for example, an ecrecover STATICCALL to precompile 0x01 is counted as `external-call`. That is fail-closed.
- **Some honest tokens are blocked in strict mode.** Every external call, including swap-back to a router and ETH sends, makes a token `privileged`, and so does every public getter that is not allowlisted (for example `maxTx()`).
- **`simulate` assumes a pool fee of at most 1%.** Quote tokens without `deposit()` are funded by a pair transfer. If the baseline sell never works, even after unlock calls, `simulate` reports `ownerCanTrap=false` (the router's live probe covers that case).
- **The daemon never lowers a flag.** It ORs flags across instances and with the registry. Only `cli attest --force` can lower one.
