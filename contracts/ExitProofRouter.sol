// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {RiskRegistry} from "./RiskRegistry.sol";
import {BytecodeScan} from "./lib/BytecodeScan.sol";
import {IProcessor} from "./interfaces/IProcessor.sol";
import {IV2Pair} from "./interfaces/IV2Pair.sol";
import {IV2Factory} from "./interfaces/IV2Factory.sol";
import {IWOKB} from "./interfaces/IWOKB.sol";

/// @title ExitProofRouter
/// @notice Don't buy what you can't sell. Buys `token` on an allowlisted Uniswap-V2-style pair, then in the same
///         transaction proves the WHOLE received position can be sold back (a self-call that always reverts),
///         delivers the position to the buyer and measures what actually arrived, measures buy/sell tax, gathers
///         owner/upgradeability facts and lets a TapeOut circuit (`processor.eval`) decide. If the circuit denies, the
///         transaction reverts and the buyer's funds never move (only the gas of the reverted transaction is spent).
/// @dev No owner, no admin, no upgrade, no withdraw. The only mutable state is the reentrancy lock and a
///      permissionless per-codehash cache of the on-chain bytecode scan.
///      The probe mirrors a wallet selling through a V2 router: the position goes router -> a code-less holder
///      address, the holder approves this router, and this router sells with `transferFrom(holder, pair, held)`, then
///      prices the swap from the pair's reserves read AFTER that transfer (as `swapExactTokensFor...
///      SupportingFeeOnTransferTokens` does).
///      Known limitation: a token can special-case this router (as spender), tx.origin or a later block so that the
///      probe passes while later sells fail. ExitProof proves "sellable now, by this router".
contract ExitProofRouter {
    // ------------------------------------------------------------------ constants
    uint16 public constant MAX_FEE_BPS = 30;
    uint256 public constant PROBE_GAS = 3_000_000;
    uint256 public constant OWNER_GAS = 50_000;
    /// @dev gasleft() required right before the probe so the 63/64 rule cannot starve it, plus a small margin.
    uint256 public constant PROBE_MIN_GASLEFT = PROBE_GAS + PROBE_GAS / 63 + 50_000;
    uint256 internal constant BPS = 10_000;

    // ------------------------------------------------------------------ immutables
    IProcessor public immutable processor;
    uint256 public immutable circuitId;
    RiskRegistry public immutable registry;
    IWOKB public immutable wokb;
    address public immutable feeRecipient;
    uint16 public immutable feeBps;

    /// @dev factory => (fee bps + 1); 0 = not allowlisted. Written only in the constructor.
    mapping(address => uint256) internal _factoryFee;
    /// @notice codehash => 0x80 | delegatecall | selfdestruct << 1 | callcode << 2 (0 = not scanned yet).
    mapping(bytes32 => uint8) public scanCache;
    uint256 private _lock = 1;

    // ------------------------------------------------------------------ errors / events
    error Blocked(uint8 reason, uint16 facts);
    /// @dev buyOut = what this router received from the pair; delivered = what `to` (inspect: msg.sender) actually
    ///      received, measured by balance diff BEFORE the circuit decided. A real buy returns / emits `delivered`.
    error Report(uint16 facts, bool allow, uint8 reason, uint256 buyOut, uint256 sellOut, uint256 delivered);
    error ProbeResult(bool ok, uint256 held, uint256 out);
    error BadPair();
    error Expired();
    error TooLittle();
    error BadEval();
    error BadConfig();
    error BadMode();
    error BadTo();
    error BadAmount();
    error NotSelf();
    error LowGas();
    error Locked();
    error TransferFailed();
    error SwapFailed();

    event Checked(
        address indexed token,
        bytes32 indexed codehash,
        address indexed buyer,
        uint16 facts,
        bool allow,
        uint8 reason,
        uint256 amountIn,
        uint256 out
    );

    struct Result {
        uint16 facts;
        bool allow;
        uint8 reason;
        uint256 buyOut; // pair -> router
        uint256 sellOut;
        uint256 delivered; // router -> to, measured at `to` before the circuit decides
        bytes32 codehash;
    }

    /// @dev Buy-leg measurements shared with the sell leg (memory: keeps the stack shallow).
    struct Baseline {
        uint256 expected; // tax-free V2 output of the buy
        uint256 rTok; // honest post-buy reserves (pre-transfer baseline for the sell tax)
        uint256 rIn;
    }

    modifier nonReentrant() {
        if (_lock != 1) revert Locked();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(
        address processor_,
        uint256 circuitId_,
        address registry_,
        address wokb_,
        address feeRecipient_,
        uint16 feeBps_,
        address[] memory factories,
        uint16[] memory factoryFeeBps
    ) {
        if (
            processor_ == address(0) || registry_ == address(0) || wokb_ == address(0) || feeRecipient_ == address(0)
                || feeBps_ > MAX_FEE_BPS || factories.length != factoryFeeBps.length
        ) revert BadConfig();
        processor = IProcessor(processor_);
        circuitId = circuitId_;
        registry = RiskRegistry(registry_);
        wokb = IWOKB(wokb_);
        feeRecipient = feeRecipient_;
        feeBps = feeBps_;
        for (uint256 i = 0; i < factories.length; i++) {
            if (factories[i] == address(0) || factoryFeeBps[i] >= 1000 || _factoryFee[factories[i]] != 0) {
                revert BadConfig();
            }
            _factoryFee[factories[i]] = uint256(factoryFeeBps[i]) + 1;
        }
    }

    // ------------------------------------------------------------------ entry points

    /// @notice Buy `token` with native OKB (wrapped to WOKB). Reverts `Blocked` if the circuit denies.
    function buyETH(address factory, address token, uint256 minOut, uint8 mode, address to, uint256 deadline)
        external
        payable
        nonReentrant
        returns (uint256 out)
    {
        _checkArgs(mode, to, deadline);
        (address pair, uint256 pairFee) = _pairOf(factory, address(wokb), token);
        uint256 fee = msg.value * feeBps / BPS;
        wokb.deposit{value: msg.value}();
        if (fee != 0) _transfer(address(wokb), feeRecipient, fee);
        _transfer(address(wokb), pair, msg.value - fee);
        out = _settle(_run(pair, pairFee, address(wokb), token, mode, to), token, minOut, msg.value);
    }

    /// @notice Buy `token` with `amountIn` of ERC20 `tokenIn` (pulled from msg.sender).
    function buy(
        address factory,
        address tokenIn,
        uint256 amountIn,
        address token,
        uint256 minOut,
        uint8 mode,
        address to,
        uint256 deadline
    ) external nonReentrant returns (uint256 out) {
        _checkArgs(mode, to, deadline);
        (address pair, uint256 pairFee) = _pairOf(factory, tokenIn, token);
        _pull(tokenIn, amountIn, pair);
        out = _settle(_run(pair, pairFee, tokenIn, token, mode, to), token, minOut, amountIn);
    }

    /// @notice Free check for eth_call: runs the full buy + probe + delivery + eval and always reverts with `Report`.
    /// @dev With msg.value > 0, tokenIn must be WOKB and amountIn == msg.value; otherwise tokenIn is pulled from
    ///      msg.sender (so the eth_call `from` must hold and have approved it). The position is delivered to
    ///      msg.sender, exactly as a buy with `to = msg.sender` would, so `Report.delivered` is what that buyer gets.
    function inspect(address factory, address tokenIn, uint256 amountIn, address token, uint8 mode) external payable {
        // inline lock: this function always reverts, which also releases the lock
        if (_lock != 1) revert Locked();
        _lock = 2;
        if (mode > 3) revert BadMode();
        (address pair, uint256 pairFee) = _pairOf(factory, tokenIn, token);
        if (msg.value != 0) {
            if (tokenIn != address(wokb) || amountIn != msg.value) revert BadAmount();
            uint256 fee = msg.value * feeBps / BPS;
            wokb.deposit{value: msg.value}();
            if (fee != 0) _transfer(address(wokb), feeRecipient, fee);
            _transfer(address(wokb), pair, msg.value - fee);
        } else {
            _pull(tokenIn, amountIn, pair);
        }
        Result memory r = _run(pair, pairFee, tokenIn, token, mode, msg.sender);
        revert Report(r.facts, r.allow, r.reason, r.buyOut, r.sellOut, r.delivered);
    }

    /// @notice Sell probe: moves `amount` of `token` (held by this router) to a fresh code-less holder address,
    ///         which approves this router; this router then sells the holder's whole balance into `pair` with
    ///         `transferFrom` (a spender-initiated sale, like any DEX-router sell). The `tokenIn` output is paid to
    ///         this router and measured by balance diff.
    ///         Self-call only; ALWAYS reverts with `ProbeResult(ok, held, out)` so no state survives.
    ///         `held` = the holder's balance after the router -> holder hop (0 if unknown).
    /// @dev Never bubbles foreign revert data: every token/pair interaction is a low-level call whose result is
    ///      reduced to a bool, so a token cannot forge a ProbeResult.
    function probeSell(address pair, address token, address tokenIn, uint256 amount) external {
        if (msg.sender != address(this)) revert NotSelf();
        uint256 fee = _factoryFee[_pairFactory(pair)];
        if (fee == 0) revert ProbeResult(false, 0, 0);
        fee -= 1;
        (bool moved, uint256 held) = _holderSell(token, pair, amount);
        // from the hand-off on, `held` is known and reported even on failure (it feeds the buy-side tax)
        if (!moved) revert ProbeResult(false, held, 0);
        (bool sold, uint256 out) = _probeSwap(pair, token, tokenIn, fee);
        revert ProbeResult(sold, held, out);
    }

    /// @dev Hands the position to a holder that looks like an EOA, then sells it as its spender:
    ///      1. predict the CREATE2 address of a ProbeHolder (no code, nonce 0) and transfer `amount` there;
    ///      2. deploy it: the constructor approves this router and returns EMPTY runtime code, so the holder has no
    ///         code before, during and after the sale (EXTCODESIZE 0);
    ///      3. `transferFrom(holder, pair, held)` from this router, exactly what a V2 router does for a wallet.
    ///      The salt varies per call, so the holder address is not a fixed, whitelistable constant. Never reverts.
    function _holderSell(address token, address pair, uint256 amount) internal returns (bool moved, uint256 held) {
        bytes32 salt = keccak256(abi.encode(token, amount, block.number, gasleft()));
        bytes memory init = abi.encodePacked(type(ProbeHolder).creationCode, abi.encode(token));
        address holder =
            address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, keccak256(init))))));
        if (!_tryTransfer(token, holder, amount)) return (false, 0);
        bool ok;
        (ok, held) = _tryBalanceOf(token, holder);
        if (!ok || held == 0) return (false, 0);
        address deployed;
        assembly ("memory-safe") {
            deployed := create2(0, add(init, 32), mload(init), salt)
        }
        if (deployed != holder) return (false, held);
        moved = _tryCall(token, abi.encodeWithSelector(0x23b872dd, holder, pair, held));
    }

    /// @dev Second half of the probe, after the holder's tokens reached the pair. Mirrors
    ///      `swapExactTokensForTokensSupportingFeeOnTransferTokens`: reserves are read NOW (a token may legitimately
    ///      swap its collected tax inside the transfer, which moves them), amountIn = balance - reserve, amountOut from
    ///      those same post-transfer reserves. The sell TAX is not derived from these reserves (see _sellLeg).
    ///      Never reverts.
    function _probeSwap(address pair, address token, address tokenIn, uint256 fee) internal returns (bool, uint256) {
        (bool ok, uint256 rTok, uint256 rIn) = _reserves(pair, token, tokenIn);
        if (!ok) return (false, 0);
        uint256 bal;
        (ok, bal) = _tryBalanceOf(token, pair);
        // a V2 pair cannot hold more than uint112 (its _update reverts): mirror that, and never overflow _amountOut
        if (!ok || bal <= rTok || bal > type(uint112).max) return (false, 0);
        uint256 requested = _amountOut(bal - rTok, rTok, rIn, fee);
        if (requested == 0) return (false, 0);
        uint256 before;
        (ok, before) = _tryBalanceOf(tokenIn, address(this));
        if (!ok) return (false, 0);
        (uint256 a0, uint256 a1) = tokenIn < token ? (requested, uint256(0)) : (uint256(0), requested);
        if (!_trySwap(pair, a0, a1)) return (false, 0);
        uint256 afterBal;
        (ok, afterBal) = _tryBalanceOf(tokenIn, address(this));
        if (!ok || afterBal <= before) return (false, 0);
        uint256 got = afterBal - before;
        // donations to the router during the probe cannot inflate the result
        return (true, got < requested ? got : requested);
    }

    // ------------------------------------------------------------------ core

    /// @dev Pair already holds the input. Swaps into this router, probes, delivers to `to`, builds facts, evals.
    ///      Delivering before the decision costs nothing: a deny reverts the whole transaction, delivery included.
    function _run(address pair, uint256 pairFee, address tokenIn, address token, uint8 mode, address to)
        internal
        returns (Result memory r)
    {
        if (to == pair) revert BadTo();
        Baseline memory bl;
        r.buyOut = _buyLeg(pair, pairFee, tokenIn, token, bl);
        (bool sellOk, uint256 sellTax, uint256 sellOut, uint256 held) =
            _sellLeg(pair, pairFee, tokenIn, token, r.buyOut, bl);
        r.sellOut = sellOut;
        r.delivered = _deliver(token, to, r.buyOut);
        // buy tax = the worst observed delivery loss: pair -> router -> holder (probe) and pair -> router -> `to`
        uint256 got = held != 0 ? held : r.buyOut;
        if (r.delivered < got) got = r.delivered;
        uint256 buyTax = _bucket(bl.expected, got);
        r.codehash = token.codehash;
        r.facts = _facts(token, r.codehash, sellOk, sellTax, buyTax, mode);

        // ---- the circuit decides ----
        bytes memory o = processor.eval(circuitId, abi.encodePacked(uint8(r.facts), uint8(r.facts >> 8)));
        if (o.length == 0) revert BadEval();
        uint8 b = uint8(o[0]);
        r.allow = b & 1 == 1;
        r.reason = (b >> 1) & 7;
        if (r.allow == (r.reason != 0)) revert BadEval(); // allow <=> reason == 0
        // Backstop (every mode of the frozen policy requires this for allow). Can only turn an allow into a revert,
        // never a deny into an allow: a misbehaving `eval` can deny service but never let a failed sell through.
        if (r.allow && (!sellOk || sellTax > 1 || buyTax > 1)) revert BadEval();
    }

    /// @dev Swaps the pair's surplus input into this router; balance-diff aware on both sides. Returns what the
    ///      router received; fills `bl` with the tax-free V2 expectation and the HONEST post-buy reserves, computed
    ///      from the pre-buy reserves (read before any code of `token` runs in this transaction) and the swap amounts:
    ///      the pair paid out exactly `expected` and holds `inBal` of tokenIn. They are deliberately not re-read from
    ///      the pair: a token could donate itself into the pair during the buy hop (the pair's own sync would then
    ///      bake a crashed price into the re-read reserves and hide that loss from the sell tax).
    function _buyLeg(address pair, uint256 pairFee, address tokenIn, address token, Baseline memory bl)
        internal
        returns (uint256 received)
    {
        (bool ok, uint256 rTok, uint256 rIn) = _reserves(pair, token, tokenIn);
        if (!ok) revert BadPair();
        uint256 inBal = _balanceOf(tokenIn, pair);
        if (inBal <= rIn) revert TooLittle();
        uint256 expected = _amountOut(inBal - rIn, rIn, rTok, pairFee);
        if (expected == 0) revert TooLittle();
        bl.expected = expected;
        bl.rTok = rTok - expected; // _amountOut < rTok always
        bl.rIn = inBal;
        uint256 before = _balanceOf(token, address(this));
        (uint256 a0, uint256 a1) = token < tokenIn ? (expected, uint256(0)) : (uint256(0), expected);
        if (!_trySwap(pair, a0, a1)) revert SwapFailed();
        uint256 afterBal = _balanceOf(token, address(this));
        received = afterBal > before ? afterBal - before : 0;
    }

    /// @dev Probes a sale of the WHOLE received position (after a realistic hand-off to a code-less holder).
    ///      Unmeasurable sell tax = bucket 3.
    ///      Sell tax = tokens the holder sold (`held`) vs the token-equivalent of the `tokenIn` that came back, priced
    ///      on the honest post-buy baseline `bl` (pre-transfer: fixed before any token code of this transaction ran).
    ///      The swap itself is priced on the post-transfer reserves (_probeSwap), the tax on this baseline, so
    ///      everything the token does to the pool during the buy hop or the sale (a transfer tax, a swap-back of its
    ///      collected tax, a mint-and-sync, a skim) can only lower `sellOut` relative to the baseline and therefore
    ///      only raise the bucket. A low bucket means: the probe seller really received at least ~95% (bucket 0) /
    ///      ~85% (bucket 1) of what a tax-free sale at the honest post-buy price pays. A token can lower the bucket
    ///      only by paying the seller real tokenIn. Inverse V2 math removes curve concavity (token-equivalent loss
    ///      >= tokenIn loss, so the bucket never under-reports the tokenIn shortfall).
    function _sellLeg(address pair, uint256 pairFee, address tokenIn, address token, uint256 amount, Baseline memory bl)
        internal
        returns (bool sellOk, uint256 sellTax, uint256 sellOut, uint256 held)
    {
        sellTax = 3;
        if (amount == 0) return (false, 3, 0, 0);
        (sellOk, held, sellOut) = _probe(pair, token, tokenIn, amount);
        sellOk = sellOk && sellOut != 0 && held != 0;
        if (sellOk) sellTax = _bucket(held, _amountIn(sellOut, bl.rTok, bl.rIn, pairFee));
    }

    /// @dev Packs the circuit input per the frozen spec bit layout.
    function _facts(address token, bytes32 codehash, bool sellOk, uint256 sellTax, uint256 buyTax, uint8 mode)
        internal
        returns (uint16)
    {
        return uint16(
            (sellOk ? 1 : 0) | (sellTax << 1) | (buyTax << 3) | _riskBits(token, codehash) | (uint256(mode) << 9)
        );
    }

    /// @dev Bits 5..8: ownerActive, upgradeable, danger, unscanned. An attestation counts only for this token address
    ///      AND the code it had when scanned (F-06); otherwise the token is unscanned and the on-chain scan is used.
    function _riskBits(address token, bytes32 codehash) internal returns (uint256) {
        (RiskRegistry.Flags memory fl, bytes32 attestedHash) = registry.flagsOf(token);
        bool scanned = fl.scanned && attestedHash == codehash;
        bool upg;
        bool danger;
        if (scanned) {
            upg = fl.upgradeable; // reachability-precise off-chain scan is authoritative once attested
            danger = fl.dangerSetter || fl.ownerCanTrap;
        } else {
            uint8 s = _scan(token, codehash);
            upg = s & 5 != 0; // delegatecall | callcode (an EIP-7702 delegation designator counts as delegatecall)
            danger = s & 2 != 0; // selfdestruct
        }
        bool ownerActive = (scanned && fl.privileged) || _ownerActive(token);
        return (ownerActive ? 1 << 5 : 0) | (upg ? 1 << 6 : 0) | (danger ? 1 << 7 : 0) | (scanned ? 0 : 1 << 8);
    }

    /// @dev Router -> `to`, measured by balance diff at `to`. A failed transfer or unreadable balance counts as 0
    ///      delivered (buy-tax bucket 3, so every mode denies and the whole transaction reverts). Never reverts.
    function _deliver(address token, address to, uint256 amount) internal returns (uint256 delivered) {
        if (amount == 0) return 0;
        (bool ok0, uint256 b0) = _tryBalanceOf(token, to);
        bool sent = _tryTransfer(token, to, amount);
        (bool ok1, uint256 b1) = _tryBalanceOf(token, to);
        if (ok0 && sent && ok1 && b1 > b0) delivered = b1 - b0;
    }

    /// @dev The position is already at `to`; minOut is checked on what actually arrived there.
    function _settle(Result memory r, address token, uint256 minOut, uint256 amountIn) internal returns (uint256 out) {
        if (!r.allow) revert Blocked(r.reason, r.facts);
        out = r.delivered;
        if (out < minOut || out == 0) revert TooLittle();
        emit Checked(token, r.codehash, msg.sender, r.facts, true, 0, amountIn, out);
    }

    /// @dev Runs probeSell with a hard gas cap; decodes only an exact 100-byte ProbeResult and copies at most
    ///      100 bytes of returndata.
    function _probe(address pair, address token, address tokenIn, uint256 amount)
        internal
        returns (bool ok, uint256 held, uint256 out)
    {
        bytes memory cd = abi.encodeCall(this.probeSell, (pair, token, tokenIn, amount));
        bytes4 sel = ProbeResult.selector;
        // Do not let caller-supplied gas decide the verdict: refuse to probe rather than report sellOk = 0.
        if (gasleft() < PROBE_MIN_GASLEFT) revert LowGas();
        uint256 okWord;
        assembly ("memory-safe") {
            let success := call(PROBE_GAS, address(), 0, add(cd, 32), mload(cd), 0, 0)
            if and(iszero(success), eq(returndatasize(), 100)) {
                let p := mload(0x40)
                returndatacopy(p, 0, 100)
                if eq(shr(224, mload(p)), shr(224, sel)) {
                    okWord := mload(add(p, 4))
                    held := mload(add(p, 36))
                    out := mload(add(p, 68))
                }
            }
        }
        if (okWord > 1) held = 0; // malformed: trust nothing
        ok = okWord == 1;
        if (!ok) out = 0;
    }

    function _scan(address token, bytes32 codehash) internal returns (uint8 s) {
        s = scanCache[codehash];
        if (s == 0) {
            (bool dc, bool sd, bool cc) = BytecodeScan.scan(token);
            s = 0x80 | (dc ? 1 : 0) | (sd ? 2 : 0) | (cc ? 4 : 0);
            scanCache[codehash] = s;
        }
    }

    /// @dev owner() with a 50k gas cap. Active iff the call succeeds and returns >= 32 bytes whose first word != 0.
    function _ownerActive(address token) internal view returns (bool active) {
        // a starved owner() call would read as "no owner": refuse instead (fail closed)
        if (gasleft() < OWNER_GAS + OWNER_GAS / 63 + 5_000) revert LowGas();
        assembly ("memory-safe") {
            mstore(0, shl(224, 0x8da5cb5b)) // owner()
            let success := staticcall(OWNER_GAS, and(token, 0xffffffffffffffffffffffffffffffffffffffff), 0, 4, 0, 32)
            // fail closed: ANY non-zero word (even a dirty, non-address one) counts as an active owner
            if and(success, gt(returndatasize(), 31)) { active := iszero(iszero(mload(0))) }
        }
    }

    // ------------------------------------------------------------------ helpers

    function _checkArgs(uint8 mode, address to, uint256 deadline) internal view {
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > deadline) revert Expired();
        if (mode > 3) revert BadMode();
        if (to == address(0) || to == address(this)) revert BadTo();
    }

    /// @dev The pair is never caller-supplied: it must be `factory.getPair` of an allowlisted factory.
    function _pairOf(address factory, address tokenIn, address token)
        internal
        view
        returns (address pair, uint256 fee)
    {
        fee = _factoryFee[factory];
        if (fee == 0 || tokenIn == token || token.code.length == 0 || tokenIn.code.length == 0) revert BadPair();
        fee -= 1;
        pair = IV2Factory(factory).getPair(tokenIn, token);
        if (pair == address(0)) revert BadPair();
    }

    function _pull(address tokenIn, uint256 amountIn, address pair) internal {
        uint256 fee = amountIn * feeBps / BPS;
        if (fee != 0) _transferFrom(tokenIn, msg.sender, feeRecipient, fee);
        _transferFrom(tokenIn, msg.sender, pair, amountIn - fee);
    }

    function _bucket(uint256 expected, uint256 actual) internal pure returns (uint256) {
        if (expected == 0) return 3;
        if (actual >= expected) return 0;
        uint256 diff = expected - actual;
        // saturate instead of overflowing on token-controlled huge values: scale both into 128 bits
        if (expected > type(uint128).max) {
            uint256 d = (expected >> 128) + 1;
            diff /= d;
            expected /= d;
        }
        // round UP: a token taking exactly 5% (floored) must not land under the 5% line
        uint256 bps = (diff * BPS + expected - 1) / expected;
        return bps < 500 ? 0 : bps < 1500 ? 1 : bps < 5000 ? 2 : 3;
    }

    function _amountOut(uint256 amountIn, uint256 rIn, uint256 rOut, uint256 fee) internal pure returns (uint256) {
        if (rIn == 0 || rOut == 0) return 0;
        uint256 inWithFee = amountIn * (BPS - fee);
        return inWithFee * rOut / (rIn * BPS + inWithFee);
    }

    /// @dev Inverse of _amountOut (rounded up). Returns 0 (= maximal tax) if `out` is not reachable.
    function _amountIn(uint256 out, uint256 rIn, uint256 rOut, uint256 fee) internal pure returns (uint256) {
        if (out >= rOut || rIn == 0) return 0;
        return rIn * out * BPS / ((rOut - out) * (BPS - fee)) + 1;
    }

    function _pairFactory(address pair) internal view returns (address f) {
        assembly ("memory-safe") {
            mstore(0, shl(224, 0xc45a0155)) // factory()
            // Yul evaluates args right-to-left
            let success := staticcall(gas(), and(pair, 0xffffffffffffffffffffffffffffffffffffffff), 0, 4, 0, 32)
            if and(success, gt(returndatasize(), 31)) { f := mload(0) }
        }
    }

    /// @dev Reserves ordered as (token, tokenIn). The pair is trusted: it came from an allowlisted factory.
    function _reserves(address pair, address token, address tokenIn)
        internal
        view
        returns (bool ok, uint256 rTok, uint256 rIn)
    {
        (bool s, bytes memory d) = pair.staticcall(abi.encodeCall(IV2Pair.getReserves, ()));
        if (!s || d.length < 64) return (false, 0, 0);
        (uint256 r0, uint256 r1) = abi.decode(d, (uint256, uint256));
        (rTok, rIn) = token < tokenIn ? (r0, r1) : (r1, r0);
        ok = true;
    }

    function _trySwap(address pair, uint256 a0, uint256 a1) internal returns (bool success) {
        bytes memory cd = abi.encodeCall(IV2Pair.swap, (a0, a1, address(this), ""));
        assembly ("memory-safe") {
            success := call(
                gas(),
                and(pair, 0xffffffffffffffffffffffffffffffffffffffff),
                0,
                add(cd, 32),
                mload(cd),
                0,
                0
            )
        }
    }

    function _tryBalanceOf(address t, address who) internal view returns (bool ok, uint256 bal) {
        assembly ("memory-safe") {
            let p := mload(0x40)
            mstore(p, shl(224, 0x70a08231)) // balanceOf(address)
            // I-01: clean the address arguments (a caller may pass dirty upper bits)
            mstore(add(p, 4), and(who, 0xffffffffffffffffffffffffffffffffffffffff))
            // separate statement: Yul evaluates args right-to-left
            ok := staticcall(gas(), and(t, 0xffffffffffffffffffffffffffffffffffffffff), p, 36, 0, 32)
            ok := and(ok, gt(returndatasize(), 31))
            if ok { bal := mload(0) }
        }
    }

    function _balanceOf(address t, address who) internal view returns (uint256 bal) {
        bool ok;
        (ok, bal) = _tryBalanceOf(t, who);
        if (!ok) revert TransferFailed();
    }

    /// @dev SafeTransfer semantics: success, and either no returndata (contract target) or a 32-byte `true`.
    ///      Copies at most 32 bytes of returndata.
    function _tryCall(address t, bytes memory cd) internal returns (bool ok) {
        assembly ("memory-safe") {
            t := and(t, 0xffffffffffffffffffffffffffffffffffffffff)
            ok := call(gas(), t, 0, add(cd, 32), mload(cd), 0, 32)
            let rds := returndatasize()
            ok := and(ok, or(and(iszero(rds), gt(extcodesize(t), 0)), and(gt(rds, 31), eq(mload(0), 1))))
        }
    }

    function _tryTransfer(address t, address to, uint256 amount) internal returns (bool) {
        return _tryCall(t, abi.encodeWithSelector(0xa9059cbb, to, amount));
    }

    function _transfer(address t, address to, uint256 amount) internal {
        if (!_tryTransfer(t, to, amount)) revert TransferFailed();
    }

    function _transferFrom(address t, address from, address to, uint256 amount) internal {
        if (!_tryCall(t, abi.encodeWithSelector(0x23b872dd, from, to, amount))) revert TransferFailed();
    }
}

/// @title ProbeHolder
/// @notice Throwaway holder created by ExitProofRouter inside the always-reverting sell probe. Constructor only: it
///         approves the deploying router for `token` (max allowance, as wallets commonly do) and returns EMPTY runtime
///         code, so the holder is code-less before, during and after the sale, like an EOA. Never persists.
/// @dev The approve result is ignored on purpose: a broken `approve` makes the router's `transferFrom` fail, which
///      the probe reports as unsellable.
contract ProbeHolder {
    constructor(address token) {
        assembly {
            mstore(0, shl(224, 0x095ea7b3)) // approve(router, type(uint256).max)
            mstore(4, caller())
            mstore(36, not(0))
            pop(call(gas(), token, 0, 0, 68, 0, 0))
            return(0, 0)
        }
    }
}
