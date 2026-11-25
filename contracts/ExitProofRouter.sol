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
///         measures buy/sell tax, gathers owner/upgradeability facts and lets a TapeOut circuit (`processor.eval`)
///         decide. If the circuit denies, the transaction reverts and the buyer's funds never move.
/// @dev No owner, no admin, no upgrade, no withdraw. The only mutable state is the reentrancy lock and a
///      permissionless per-codehash cache of the on-chain bytecode scan.
///      Known limitation: a token can special-case this router (or tx.origin, or a later block) so that the
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
    error Report(uint16 facts, bool allow, uint8 reason, uint256 buyOut, uint256 sellOut);
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
        uint256 buyOut;
        uint256 sellOut;
        bytes32 codehash;
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
        out = _settle(_run(pair, pairFee, address(wokb), token, mode), token, minOut, to, msg.value);
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
        out = _settle(_run(pair, pairFee, tokenIn, token, mode), token, minOut, to, amountIn);
    }

    /// @notice Free check for eth_call: runs the full buy + probe + eval and always reverts with `Report`.
    /// @dev With msg.value > 0, tokenIn must be WOKB and amountIn == msg.value; otherwise tokenIn is pulled from
    ///      msg.sender (so the eth_call `from` must hold and have approved it).
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
        Result memory r = _run(pair, pairFee, tokenIn, token, mode);
        revert Report(r.facts, r.allow, r.reason, r.buyOut, r.sellOut);
    }

    /// @notice Sell probe: moves `amount` of `token` (held by this router) to a fresh holder, which sells its whole
    ///         balance into `pair`; the `tokenIn` output is paid to this router and measured by balance diff.
    ///         Self-call only; ALWAYS reverts with `ProbeResult(ok, held, out)` so no state survives.
    ///         `held` = the holder's balance after the router -> holder hop (0 if unknown).
    /// @dev Never bubbles foreign revert data: every token/pair interaction is a low-level call whose result is
    ///      reduced to a bool, so a token cannot forge a ProbeResult.
    function probeSell(address pair, address token, address tokenIn, uint256 amount) external {
        if (msg.sender != address(this)) revert NotSelf();
        uint256 fee = _factoryFee[_pairFactory(pair)];
        if (fee == 0) revert ProbeResult(false, 0, 0);
        fee -= 1;
        // reserves BEFORE any token transfer (a hook cannot move the baseline)
        (bool ok, uint256 rTok, uint256 rIn) = _reserves(pair, token, tokenIn);
        if (!ok) revert ProbeResult(false, 0, 0);
        // Mirror the real path (pair -> router -> buyer -> pair): hand the whole position to a freshly CREATE2-deployed
        // holder, which then sells its entire balance. Everything (the holder included) is rolled back by the revert.
        // The salt varies per call so the holder address is not a fixed, whitelistable constant.
        bytes32 salt = keccak256(abi.encode(token, amount, block.number, gasleft()));
        address holder = address(new ProbeHolder{salt: salt}(salt));
        if (!_tryTransfer(token, holder, amount)) revert ProbeResult(false, 0, 0);
        uint256 held;
        (ok, held) = _tryBalanceOf(token, holder);
        if (!ok || held == 0) revert ProbeResult(false, 0, 0);
        // from here on `held` is known and reported even on failure (it feeds the buy-side tax)
        if (!_tryCall(holder, abi.encodeCall(ProbeHolder.sellAll, (token, pair)))) revert ProbeResult(false, held, 0);
        (bool sold, uint256 out) = _probeSwap(pair, token, tokenIn, rTok, rIn, fee);
        revert ProbeResult(sold, held, out);
    }

    /// @dev Second half of the probe: pays out what the pair actually received from the holder. Never reverts.
    function _probeSwap(address pair, address token, address tokenIn, uint256 rTok, uint256 rIn, uint256 fee)
        internal
        returns (bool, uint256)
    {
        (bool ok, uint256 bal) = _tryBalanceOf(token, pair);
        if (!ok || bal <= rTok) return (false, 0);
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

    /// @dev Pair already holds the input. Swaps into this router, probes, builds facts, evals.
    function _run(address pair, uint256 pairFee, address tokenIn, address token, uint8 mode)
        internal
        returns (Result memory r)
    {
        uint256 expected;
        (r.buyOut, expected) = _buyLeg(pair, pairFee, tokenIn, token);
        (bool sellOk, uint256 sellTax, uint256 sellOut, uint256 held) =
            _sellLeg(pair, pairFee, tokenIn, token, r.buyOut);
        r.sellOut = sellOut;
        // buy tax = the whole delivery loss (pair -> router -> holder) when the hop was observed, else pair -> router
        uint256 buyTax = _bucket(expected, held != 0 ? held : r.buyOut);
        r.codehash = token.codehash;
        r.facts = _facts(token, r.codehash, sellOk, sellTax, buyTax, mode);

        // ---- the circuit decides ----
        bytes memory o = processor.eval(circuitId, abi.encodePacked(uint8(r.facts), uint8(r.facts >> 8)));
        if (o.length == 0) revert BadEval();
        uint8 b = uint8(o[0]);
        r.allow = b & 1 == 1;
        r.reason = (b >> 1) & 7;
        if (r.allow == (r.reason != 0)) revert BadEval(); // allow <=> reason == 0
    }

    /// @dev Swaps the pair's surplus input into this router; balance-diff aware on both sides. Returns what the
    ///      router received and the tax-free V2 expectation.
    function _buyLeg(address pair, uint256 pairFee, address tokenIn, address token)
        internal
        returns (uint256 received, uint256 expected)
    {
        (bool ok, uint256 rTok, uint256 rIn) = _reserves(pair, token, tokenIn);
        if (!ok) revert BadPair();
        uint256 inBal = _balanceOf(tokenIn, pair);
        if (inBal <= rIn) revert TooLittle();
        expected = _amountOut(inBal - rIn, rIn, rTok, pairFee);
        if (expected == 0) revert TooLittle();
        uint256 before = _balanceOf(token, address(this));
        (uint256 a0, uint256 a1) = token < tokenIn ? (expected, uint256(0)) : (uint256(0), expected);
        if (!_trySwap(pair, a0, a1)) revert SwapFailed();
        uint256 afterBal = _balanceOf(token, address(this));
        received = afterBal > before ? afterBal - before : 0;
    }

    /// @dev Probes a sale of the WHOLE received position (after a realistic hand-off to a fresh holder).
    ///      Unmeasurable sell tax = bucket 3.
    function _sellLeg(address pair, uint256 pairFee, address tokenIn, address token, uint256 amount)
        internal
        returns (bool sellOk, uint256 sellTax, uint256 sellOut, uint256 held)
    {
        sellTax = 3;
        if (amount == 0) return (false, 3, 0, 0);
        // post-buy reserves: the same baseline probeSell starts from
        (, uint256 rTok, uint256 rIn) = _reserves(pair, token, tokenIn);
        (sellOk, held, sellOut) = _probe(pair, token, tokenIn, amount);
        sellOk = sellOk && sellOut != 0 && held != 0;
        // sell tax: tokens the holder sold vs the token-equivalent of what came back (inverse V2 math removes
        // curve concavity from the measurement)
        if (sellOk) sellTax = _bucket(held, _amountIn(sellOut, rTok, rIn, pairFee));
    }

    /// @dev Packs the circuit input per the frozen spec bit layout.
    function _facts(address token, bytes32 codehash, bool sellOk, uint256 sellTax, uint256 buyTax, uint8 mode)
        internal
        returns (uint16)
    {
        RiskRegistry.Flags memory fl = registry.flagsOf(codehash);
        bool upg;
        bool danger = fl.dangerSetter || fl.ownerCanTrap;
        if (fl.scanned) {
            upg = fl.upgradeable; // reachability-precise off-chain scan is authoritative once attested
        } else {
            uint8 s = _scan(token, codehash);
            upg = s & 5 != 0; // delegatecall | callcode
            danger = danger || s & 2 != 0; // selfdestruct
        }
        bool ownerActive = fl.privileged || _ownerActive(token);
        return uint16(
            (sellOk ? 1 : 0) | (sellTax << 1) | (buyTax << 3) | (ownerActive ? 1 << 5 : 0) | (upg ? 1 << 6 : 0)
                | (danger ? 1 << 7 : 0) | (fl.scanned ? 0 : 1 << 8) | (uint256(mode) << 9)
        );
    }

    function _settle(Result memory r, address token, uint256 minOut, address to, uint256 amountIn)
        internal
        returns (uint256 out)
    {
        if (!r.allow) revert Blocked(r.reason, r.facts);
        uint256 before = _balanceOf(token, to);
        _transfer(token, to, r.buyOut);
        out = _balanceOf(token, to) - before; // what `to` actually received (fee-on-transfer aware)
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
            let success := staticcall(OWNER_GAS, token, 0, 4, 0, 32)
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
            let success := staticcall(gas(), pair, 0, 4, 0, 32) // Yul evaluates args right-to-left
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
            success := call(gas(), pair, 0, add(cd, 32), mload(cd), 0, 0)
        }
    }

    function _tryBalanceOf(address t, address who) internal view returns (bool ok, uint256 bal) {
        assembly ("memory-safe") {
            let p := mload(0x40)
            mstore(p, shl(224, 0x70a08231)) // balanceOf(address)
            mstore(add(p, 4), who)
            ok := staticcall(gas(), t, p, 36, 0, 32) // separate statement: Yul evaluates args right-to-left
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
/// @notice Throwaway holder deployed by ExitProofRouter inside the always-reverting sell probe. It plays the buyer:
///         receives the position over a non-pair hop, then sells its entire balance to the pair. Never persists.
/// @dev The salt is baked into the runtime code (immutable), so each holder has a unique codehash too.
contract ProbeHolder {
    address private immutable router;
    bytes32 private immutable nonce;

    constructor(bytes32 n) {
        router = msg.sender;
        nonce = n;
    }

    /// @notice Transfers this holder's whole `token` balance to `pair`. Returns true on SafeTransfer success; never
    ///         bubbles foreign returndata (at most 32 bytes are copied).
    function sellAll(address token, address pair) external returns (bool ok) {
        if (msg.sender != router) revert();
        bytes32 n = nonce;
        assembly ("memory-safe") {
            pop(n)
            mstore(0, shl(224, 0x70a08231)) // balanceOf(address(this))
            mstore(4, address())
            ok := staticcall(gas(), token, 0, 36, 0, 32)
            ok := and(ok, gt(returndatasize(), 31))
            let bal := mload(0)
            ok := and(ok, gt(bal, 0))
            if ok {
                let p := mload(0x40)
                mstore(p, shl(224, 0xa9059cbb)) // transfer(pair, bal)
                mstore(add(p, 4), pair)
                mstore(add(p, 36), bal)
                ok := call(gas(), token, 0, p, 68, 0, 32)
                let rds := returndatasize()
                ok := and(ok, or(iszero(rds), and(gt(rds, 31), eq(mload(0), 1))))
            }
        }
    }
}
