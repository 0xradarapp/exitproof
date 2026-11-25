# ExitProof scanner (v2)

This is the deterministic scanner behind `RiskRegistry`. It is open source so anyone can re-run the scan that set the flags for a codehash.

```
cd scanner && npm ci
node src/cli.mjs scan <token>                         # read-only; RPC_URL (default https://rpc.xlayer.tech)
FORK_RPC=http://127.0.0.1:8545 node src/cli.mjs simulate <token> <pair>   # anvil only
REGISTRY=0x.. ATTESTER_KEY=0x.. [SEND=1] node src/cli.mjs attest <token> [pair] [--force]
RPC_URL=.. REGISTRY=.. START_BLOCK=.. [ATTESTER_KEY=.. SEND=1 FORK_RPC=..] node src/cli.mjs daemon
node --test test/                                     # needs anvil and ../out (forge build)
```

## Flags
- `upgradeable` is set by any of the following:
  - a live DELEGATECALL or CALLCODE whose target is not a literal 0 or precompile;
  - a non-zero EIP-1967 implementation or beacon slot;
  - a non-zero EIP-1822 slot;
  - an upgradeTo, upgradeToAndCall or setImplementation selector.
- `dangerSetter` is set by any of the following:
  - a selector from `src/selectors.mjs` in the dispatcher (token, or the EIP-1967 implementation);
  - a live SELFDESTRUCT;
  - an unrecognized dispatcher (fail-closed).
- `privileged` is set by any of the following:
  - `owner()`/`getOwner()` returns non-zero;
  - AccessControl `hasRole`;
  - a CALLER/ORIGIN value compared (EQ, SUB or XOR) with an SLOAD-derived value. The comparison is tracked through AND, SHR and DIV masks.
  - a live CALL/STATICCALL to a target that is neither a literal precompile nor ADDRESS (`external-call`);
  - `dangerSetter`.
- `ownerCanTrap` comes from `simulate` on an anvil fork. An exception after a successful baseline sell counts as a trap.

`evidence.reasons` lists which rules fired.

The dispatcher is unrecognized when the EQ-form extraction does not find all of `transfer`, `transferFrom`, `approve` and `balanceOf`. For proxies the token and implementation dispatchers are merged before this check.

## Limitations
- **Unknown selectors are not simulated.** `simulate` only calls the listed dangerous setters. An owner setter with an unlisted name (for example `configure(uint256)`) is never exercised. It is caught only indirectly, through `privileged` (owner getter, caller-vs-storage check, external call). Simulating every unknown selector is out of scope.
- **The dangerous list is name based.** A new name needs a list entry and a `scannerVersion` bump.
- **Caller taint is local to one basic block.** The symbolic stack resets at every JUMPDEST and at unmodelled ops. A comparison split across internal-function jumps can be missed, and so can one that is laundered through arithmetic (ADD/MUL), memory (MSTORE/MLOAD) or a mapping lookup (`isAdmin[msg.sender]`, keccak). Immutable owners (`msg.sender == IMMUTABLE`) are not SLOAD-derived, so they are not flagged either. Many of these cases still hit the owner getter, a dangerous selector or `simulate`.
- **The caller check can false-positive.** It also flags `msg.sender == storedPair` style checks when solc inlines them into one block.
- **Every external call counts.** Calls to the router or pair during swap-back, and ETH sends to a stored wallet, mark a token `privileged`. That is conservative.
- **Selector extraction relies on EQ dispatchers.** Selectors hidden from the EQ-form extraction but beside a readable ERC-20 core (for example one `PUSH4 sel PUSH0 OR EQ` case) are invisible. Only the caller-taint and external-call rules can still catch the privilege.
- **`simulate` assumes a pool fee of at most 1%.** Quote tokens without `deposit()` are funded by a pair transfer, not a real buy. If the baseline sell never works, even after unlock calls, `simulate` reports `ownerCanTrap=false` (the router's live probe covers that case).
- **The daemon never lowers a flag.** It ORs flags across instances and with the registry. Only `cli attest --force` can lower one.
