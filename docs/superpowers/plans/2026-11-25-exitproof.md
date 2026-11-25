# ExitProof Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship ExitProof — an X Layer swap router that buys, proves the full position can be sold back in the same tx, and lets a TapeOut circuit allow/deny — plus registry, scanner, web app, CLI, deploy tooling.

**Architecture:** Foundry contracts (`contracts/`), circuit toolchain in Python + Yosys (`circuit/`), Node/viem scanner + CLI (`scanner/`, `cli/`), static web (`web/`). Everything rehearsed on an anvil fork of X Layer mainnet (TapeOut has no testnet).

**Tech Stack:** Solidity 0.8.24 + Foundry 1.7, Python 3 (stdlib only), Yosys + Icarus Verilog, Node 26 + viem, ethers v6 (CDN) for web.

**Spec:** `docs/superpowers/specs/2026-11-25-exitproof-design.md` (read it fully before any task; its "Circuit interface" table is frozen).

## Global Constraints
- Chain 196, RPC `https://rpc.xlayer.tech`; fork with `anvil --fork-url https://rpc.xlayer.tech --chain-id 196`.
- WOKB `0xe538905cf8410324e03A5A23C1c177a474D59b2b`; PotatoSwap V2 factory `0x630DB8E822805c82Ca40a54daE02dd5aC31f7fcF` (fee 25 bps: `balance*10000 - amountIn*25`); TapeOut factory `0x1f09daefa827f02cbb40967cc91b259763760761`.
- Circuit: 11 inputs, 4 outputs, bit layout and policy exactly as the spec table. `circuit/spec.py::policy(x:int)->(allow:int, reason:int)` is the source of truth.
- Netlist: 7 bytes/gate `00|a(u24)|b(u24)`, wire0=0, wire1=1, wires 2..12 = inputs, outputs = last 4 gates; output byte bit j = output j.
- Router: no owner, no upgrade, no withdraw; `feeBps` immutable and `<= 30`; deployed with 10.
- Never put private keys in the repo. Keys only via env (`DEPLOYER_KEY`) in a git-ignored `.env`.
- No mainnet transaction is sent by any task; mainnet is a separate, user-approved step.

## Review Focus
1. Fee-on-transfer / reflection tokens on the buy leg: router must measure by balance diff, not revert or mis-bucket. → Task 3 test `test_buy_feeOnTransfer_5pct_bucket1`.
2. `owner()` missing, reverting, or returning short/garbage data must give `ownerActive=0` without reverting the buy. → Task 3 test `test_owner_probe_robust`.
3. Probe griefing: token burns all gas or returns a huge revert blob in `transfer` during the probe → probe bounded (gas cap 3M, returndata copy capped), outcome sellOk=0, outer tx reverts cleanly with `Blocked(1,…)`. → Task 3 tests `test_probe_gasBomb_blocked`, `test_probe_returnBomb_blocked`.
4. WOKB as token0 vs token1 and native-OKB dust: router ends every call with zero token and zero native balance. → Task 3 test `test_no_dust_both_orderings`.
5. Fake pair passed by caller / factory not allowlisted → revert `BadPair`. → Task 3 test `test_rejects_fake_pair`.

---

### Task 1: Circuit (spec, synthesis, netlist, exhaustive verification)

**Files:** Create `circuit/spec.py`, `circuit/policy.v`, `circuit/synth.ys`, `circuit/build.py`, `circuit/netlist.json`, `circuit/test_circuit.py`, `circuit/README.md`.

**Interfaces — Produces:** `circuit/netlist.json` = `{"nIn":11,"nOut":4,"gates":N,"netlist":"0x…","sha256":"…"}`; `spec.policy(x)`; `spec.encode(facts:dict)->int`; `build.eval_netlist(hex:str, x:int)->int` (4-bit output).

- [ ] Step 1: tests in `circuit/test_circuit.py` (stdlib `unittest`): `test_examples` asserting e.g. clean token all modes allow (x with sellOk=1, rest 0, mode 2/1 → allow; strict needs unscanned=0 → `policy(encode(sellOk=1,mode=0))==(0,6)`), `test_reason_priority` (sellOk=0 & upgradeable → reason 1), `test_mode3_equals_strict` (all 512 sub-inputs), `test_netlist_exhaustive` (all 2048 inputs: `eval_netlist == allow | reason<<1`), `test_netlist_format` (len%7==0, every type byte 00, all wire refs < own index).
- [ ] Step 2: run `python3 -m unittest circuit/test_circuit.py` → FAIL.
- [ ] Step 3: implement `spec.py`; write `policy.v` (combinational, same truth table); `synth.ys` uses `abc -g NAND` (see refs/tapeescrow/README for the ABC 0.33 caveat); `build.py` runs yosys, converts the netlist to TapeOut bytes (NOT = NAND(a,a); constants → wires 0/1; outputs must be the LAST 4 gates in order out0..out3 — append buffer pairs if needed), writes `netlist.json`.
- [ ] Step 4: tests PASS; also `iverilog` RTL testbench vs spec optional.
- [ ] Step 5: commit `feat(circuit): ExitProof policy circuit + exhaustive verification`.

### Task 2: RiskRegistry + BytecodeScan

**Files:** Create `foundry.toml` (src=contracts, test=test, solc 0.8.24, optimizer 200, `evm_version = "cancun"`), `contracts/RiskRegistry.sol`, `contracts/lib/BytecodeScan.sol`, `test/RiskRegistry.t.sol`, `test/BytecodeScan.t.sol`.

**Interfaces — Produces:**
- `RiskRegistry`: `struct Flags { bool scanned; bool privileged; bool upgradeable; bool dangerSetter; bool ownerCanTrap; uint16 scannerVersion; }`; `function flagsOf(bytes32 codehash) view returns (Flags memory)`; `function attest(bytes32 codehash, Flags calldata f, string calldata reportURI)` onlyAttester (sets `scanned=true`); `setAttester(address,bool)` onlyOwner; `transferOwnership`; events `Attested(bytes32 indexed codehash, Flags f, string reportURI, address attester)`, `AttesterSet`.
- `BytecodeScan.scan(address t) internal view returns (bool delegatecall, bool selfdestruct, bool callcode)` — PUSH1..PUSH32 data skipped; stops at code end.

- [ ] Step 1: tests: attest by non-attester reverts; flags round-trip; `scan` true for a contract with real DELEGATECALL (e.g., an OZ-style minimal proxy), false for a contract containing `0xf4` only inside PUSH data (craft via raw bytecode deploy), false for plain ERC20.
- [ ] Step 2: `forge test` → FAIL. Step 3: implement. Step 4: PASS. Step 5: commit `feat(contracts): risk registry and bytecode scan`.

### Task 3: ExitProofRouter + malicious fixtures (local, MockProcessor)

**Files:** Create `contracts/ExitProofRouter.sol`, `contracts/interfaces/{IProcessor,IV2Pair,IV2Factory,IWOKB}.sol`, `test/mocks/MockProcessor.sol` (implements spec policy in Solidity, `eval(uint256,bytes)`), `test/mocks/V2.sol` (minimal Uniswap-V2 pair/factory with configurable fee bps, used for unit tests), `test/fixtures/Tokens.sol`, `test/ExitProofRouter.t.sol`.

**Interfaces — Consumes:** Task 2 `RiskRegistry.flagsOf`, `BytecodeScan.scan`. **Produces:**
```solidity
constructor(address processor, uint256 circuitId, address registry, address wokb, address feeRecipient,
            uint16 feeBps, address[] memory factories, uint16[] memory factoryFeeBps)
function buyETH(address factory, address token, uint256 minOut, uint8 mode, address to, uint256 deadline) payable returns (uint256 out)
function buy(address factory, address tokenIn, uint256 amountIn, address token, uint256 minOut, uint8 mode, address to, uint256 deadline) returns (uint256 out)
function inspect(address factory, address tokenIn, uint256 amountIn, address token, uint8 mode) payable // always reverts Report
function probeSell(address pair, address token, address tokenIn, uint256 amount) external // self-only; always reverts ProbeResult(bool ok, uint256 out)
error Blocked(uint8 reason, uint16 facts); error Report(uint16 facts, bool allow, uint8 reason, uint256 buyOut, uint256 sellOut);
error BadPair(); error Expired(); error TooLittle(); error BadEval();
event Checked(address indexed token, bytes32 indexed codehash, address indexed buyer, uint16 facts, bool allow, uint8 reason, uint256 amountIn, uint256 out);
```
Tax bucket: `taxBps = expected==0 ? 10000 : (expected - min(actual,expected))*10000/expected`; bucket 0 `<500`, 1 `<1500`, 2 `<5000`, 3 otherwise. Expected uses V2 math with the factory's fee bps on actual pair-received input. Probe: sell entire received amount back into the same pair; `sellOk` = call returned ProbeResult with ok && out>0; probe runs `this.probeSell{gas: 3_000_000}`; decode only if returndata length == 68 (selector+2 words), else sellOk=0. Owner probe: `staticcall{gas: 50_000}` `owner()`; ownerActive iff success && returndata.length>=32 && address non-zero; OR registry `privileged`. unscanned = !flags.scanned. Facts packing exactly per spec bits. `eval` input = `abi.encodePacked(uint8(facts), uint8(facts>>8))`; `out[0] & 1` allow; `(out[0]>>1)&7` reason.

Fixtures in `Tokens.sol` (each a minimal ERC20): `CleanToken`, `OwnedCleanToken` (Ownable, no setters), `FeeToken(bps)` (buy and sell fee), `BlacklistOnBuy` (receiver from pair gets blacklisted), `SellTax99`, `MaxTxToken` (max 1% supply per transfer), `CooldownToken` (no sell in same block as buy), `TradingDisabled` (owner must enable; sells revert), `TimeBombToken` (owner `setSellFee` up to 100%, starts 0), `ProxyToken` (ERC1967-style proxy delegating to an ERC20 impl), `GasBombToken`, `ReturnBombToken`, `TxOriginTrap` (blocks sells where tx.origin is a recorded buyer — expected to PASS the probe; documents limitation).

- [ ] Step 1: tests (mode noted): `test_clean_permissive_allows`; `test_clean_strict_blocks_unscanned` (reason 6) then after `attest` → allows; `test_blacklist_blocked_reason1`; `test_sellTax99_blocked_reason2`; `test_maxTx_blocked_reason1` (buy > 1% supply); `test_cooldown_blocked_reason1`; `test_timeBomb_balanced` (scanned with dangerSetter + owner → reason 5; permissive allows); `test_proxy_balanced_reason4` (opcode scan, unscanned); `test_buy_feeOnTransfer_5pct_bucket1` (FeeToken(500): permissive allows, strict reason 3); plus the 5 Review Focus tests; `test_inspect_reports_without_state_change`; `test_fee_taken_10bps`; `test_minOut_enforced`; `test_deadline`; `test_txOriginTrap_known_limitation` (asserts allow==true, comment explains).
- [ ] Step 2: FAIL. Step 3: implement router (ReentrancyGuard inline, no OZ dependency needed; use low-level calls with SafeTransfer semantics). Step 4: `forge test -vv` PASS. Step 5: commit `feat(contracts): ExitProofRouter with full-exit probe`.

### Task 4: Fork integration with real TapeOut + PotatoSwap

**Files:** Create `script/lib/TapeOut.sol` helpers, `test/fork/ExitProofFork.t.sol`, `scripts/tapeout.mjs` (viem; dry-run by default, `SEND=1`; resumable state file; supports `--rpc` for anvil), `deployments/` (fork artifacts only).

**Interfaces — Consumes:** `circuit/netlist.json`, Task 3 router. **Produces:** `scripts/tapeout.mjs` creating our own processor (discover `createCPU` signature/fees from `refs/latch` & `refs/lathe` evidence + on-chain), minting NAND (OKB or BEM fee path — handle both like refs/latch/keeper/tapeout2.mjs), `tapeout(netlist, 11, 4)`, verify `netlist()`/`circuitInfo()` and all 2048 evals against `spec.py` output (export truth table to `circuit/truth.json` in Task 1 build if needed).

- [ ] Step 1: fork test (`vm.createSelectFork(vm.envString("XLAYER_RPC"))`): deal OKB, create processor + tape out netlist via cheatcodes/real calls, deploy registry+router with real PotatoSwap factory; for each fixture create a real PotatoSwap pair (factory.createPair, transfer + `mint`), run `buyETH` and assert same verdicts as Task 3; assert real eval equals spec for all 2048 inputs (loop, `--gas-limit` high).
- [ ] Step 2: run `XLAYER_RPC=https://rpc.xlayer.tech forge test --match-path test/fork/* -vv` → PASS after implementing helpers.
- [ ] Step 3: `scripts/tapeout.mjs` rehearsal on local anvil fork: `anvil --fork-url … --port 8549` + `RPC_URL=http://127.0.0.1:8549 SEND=1 node scripts/tapeout.mjs` with an anvil test key → prints processor address + circuit id + "2048/2048 ✓". Record OKB/BEM cost.
- [ ] Step 4: commit `test(fork): real TapeOut + PotatoSwap integration`.

### Task 5: Scanner, attestation, daemon, owner-power simulation

**Files:** Create `scanner/package.json` (viem only), `scanner/src/{scan.mjs,selectors.mjs,proxy.mjs,simulate.mjs,attest.mjs,daemon.mjs,cli.mjs}`, `scanner/test/*.test.mjs` (node:test).

**Interfaces — Consumes:** RiskRegistry ABI (Task 2). **Produces:** `scan(client, token) -> {codehash, privileged, upgradeable, dangerSetter, ownerCanTrap:false, scannerVersion:1, evidence:{selectors:[…], proxySlots:{…}, owner, opcodes:{…}}}` deterministic; `simulate(forkRpc, token, pair) -> {ownerCanTrap:boolean, evidence}` (anvil `anvil_impersonateAccount` owner; call each matched setter with worst-case args: max fee uint, blacklist(pair or buyer), pause/disable trading, set maxTx 0; then try a sell via pair from a funded holder); `attest(walletClient, registry, result)`; daemon polls PotatoSwap `PairCreated` in ≤100-block windows, scans the non-WOKB/stable token, attests.
- dangerous selectors list (by 4-byte, with names): fee/tax setters, blacklist/bot functions, maxTx/maxWallet setters, pause/unpause, enableTrading/openTrading/setTradingEnabled, setRouter/setPair/excludeFromFee, mint, upgradeTo/upgradeToAndCall, setImplementation — plus a generic pattern: owner-guarded `set*` found via 4byte-unknown fallback is not counted (determinism).
- [ ] Step 1: tests against anvil (spawned in test) with fixtures from Task 3 compiled `out/` artifacts: CleanToken → all false; TimeBombToken → privileged+dangerSetter, simulate → ownerCanTrap true; ProxyToken → upgradeable; TradingDisabled → dangerSetter. Step 2: FAIL. Step 3: implement. Step 4: `node --test scanner/test` PASS. Step 5: commit `feat(scanner): deterministic token scanner + fork owner simulation + daemon`.

### Task 6: Web app + CLI/agent skill

**Files:** Create `web/index.html`, `web/app.js`, `web/style.css`, `web/config.json`, `cli/exitproof.mjs`, `agent/SKILL.md`.

**Interfaces — Consumes:** router/registry ABIs + `deployments/*.json`.
- Web: paste token → choose mode → "Check (free)" calls `inspect` via `eth_call`, decodes `Report`, shows verdict + each fact in plain English (EN primary, TR toggle) → "Buy safely" (`buyETH`) → feed of last `Checked` events (≤100-block windows). No build step; works served from DeWEB/TapeKit (relative paths only).
- CLI: `node cli/exitproof.mjs check <token> [--mode strict|balanced|permissive] [--amount 0.01]` prints JSON verdict; `buy` uses `DEPLOYER_KEY`-style env `EXITPROOF_KEY`.
- `agent/SKILL.md`: how an OKX Agentic Wallet agent calls `inspect` then `buyETH` (`onchainos wallet contract-call` pattern from refs/latch/plugin).
- [ ] Verify against local anvil fork deployment from Task 4: check CleanToken (allow) and BlacklistOnBuy (blocked reason 1) through the CLI and through the web page (open in Chrome, screenshot). Commit `feat(web,cli): checker UI, CLI and agent skill`.

### Task 7: Deploy tooling, fork rehearsal, judge docs

**Files:** Create `scripts/deploy.mjs` (dry run default; deploys Registry → Router with real processor/circuit ids from state; verifies on OKLink/Sourcify instructions), `scripts/rehearse.sh` (anvil fork: tapeout → deploy → fixture tokens + pairs → CLI checks → summary), `README.md` (judges table like refs/latch README: live app, processor, circuit id, contracts, TapeOut features used, revenue, assurance, limitations incl. tx.origin + post-buy owner action), `SUBMISSION.md` (Google-form answers: product, users, revenue model, why they pay/keep using), `docs/DEMO_SCRIPT.md` (≤3 min video script), `docs/COSTS.md`.
- [ ] `bash scripts/rehearse.sh` ends with `REHEARSAL OK` and cost summary. Commit `chore: deploy tooling, rehearsal, judge docs`.

### Task 8 (user-gated): Mainnet
Needs user-funded key. Run `scripts/tapeout.mjs` then `scripts/deploy.mjs` with `SEND=1`, verify sources, start daemon on Linux home server, publish web to DeWEB, fill README addresses. Not executed without explicit user go.
