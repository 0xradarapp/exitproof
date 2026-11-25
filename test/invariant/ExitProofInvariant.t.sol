// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {ExitProofRouter} from "../../contracts/ExitProofRouter.sol";
import {RiskRegistry} from "../../contracts/RiskRegistry.sol";
import {MockProcessor} from "../mocks/MockProcessor.sol";
import {MockWOKB, MockV2Factory, MockV2Pair} from "../mocks/V2.sol";
import {Spec, IERC20X} from "../fuzz/FuzzBase.sol";
import {FuzzTaxToken, HeavyHookToken} from "../fuzz/FuzzTokens.sol";
import "../fixtures/Tokens.sol";

/// @notice Random actors buy (native and WOKB paths) and inspect across clean and malicious tokens while the attester
///         randomly rewrites registry flags, an owner flips a time bomb and blocks advance. Violations are recorded as
///         ghost counters (a handler revert would be swallowed by the invariant runner) and asserted by the suite.
contract ExitProofHandler is Test {
    error SimResult(bool sold);

    bytes32 internal constant CHECKED_SIG = keccak256("Checked(address,bytes32,address,uint16,bool,uint8,uint256,uint256)");
    uint16 internal constant POOL_FEE = 25;

    ExitProofRouter public router;
    RiskRegistry public reg;
    MockWOKB public wokb;
    MockV2Factory public factory;
    address public feeTo;
    address public attester;
    address public deployer;
    TimeBombToken public bomb;

    address[] public tokens;
    address[] public pairs;
    bool[] public alwaysUnsellable;
    address[] public actors;

    // ---- ghosts
    uint256 public ghostFees;
    uint256 public buysOk;
    uint256 public buysDenied;
    uint256 public buysOther; // TooLittle etc.
    uint256 public inspects;
    uint256 public reports;
    uint256 public attests;
    uint256[8] public deniedByReason;
    // ---- violations
    uint256 public vRouterHeld; // (a) checked after every call too
    uint256 public vUnsellableBought; // (b)
    uint256 public vProbeFailBought; // (b)
    uint256 public vBadChecked; // (c)
    uint256 public vBadBlocked; // Blocked payload disagrees with the policy
    uint256 public vFee; // (d) per-call fee delta
    uint256 public vDenyMoved; // (e)
    uint256 public vInspect; // inspect returned or moved state
    string public firstViolation;

    struct Bal {
        uint256 native;
        uint256 w;
        uint256 tok;
        uint256 fee;
    }

    constructor(
        ExitProofRouter r,
        RiskRegistry g,
        MockWOKB w,
        MockV2Factory f,
        address feeTo_,
        address attester_,
        TimeBombToken bomb_
    ) {
        router = r;
        reg = g;
        wokb = w;
        factory = f;
        feeTo = feeTo_;
        attester = attester_;
        deployer = msg.sender;
        bomb = bomb_;
        for (uint256 i = 0; i < 4; i++) {
            address a = makeAddr(string(abi.encodePacked("actor", vm.toString(i))));
            actors.push(a);
            vm.deal(a, 1e24);
        }
    }

    function addToken(address t, address pair, bool unsellable) external {
        require(msg.sender == deployer, "deployer");
        tokens.push(t);
        pairs.push(pair);
        alwaysUnsellable.push(unsellable);
    }

    function tokenCount() external view returns (uint256) {
        return tokens.length;
    }

    function _violate(string memory what) internal {
        if (bytes(firstViolation).length == 0) firstViolation = what;
    }

    function _bal(address a, address t) internal view returns (Bal memory b) {
        b.native = a.balance;
        b.w = wokb.balanceOf(a);
        b.tok = IERC20X(t).balanceOf(a);
        b.fee = wokb.balanceOf(feeTo);
    }

    function _strip(bytes memory err) internal pure returns (bytes4 sel, bytes memory rest) {
        if (err.length < 4) return (bytes4(0), "");
        // forge-lint: disable-next-line(unsafe-typecast)
        sel = bytes4(err);
        rest = new bytes(err.length - 4);
        for (uint256 i = 0; i < rest.length; i++) {
            rest[i] = err[i + 4];
        }
    }

    function _checkRouterEmpty(address t) internal {
        if (
            IERC20X(t).balanceOf(address(router)) != 0 || wokb.balanceOf(address(router)) != 0
                || address(router).balance != 0
        ) {
            vRouterHeld++;
            _violate("router holds a balance");
        }
    }

    // ------------------------------------------------------------------ actions

    struct Ctx {
        address a;
        uint256 i;
        address t;
        uint256 amt;
        uint8 mode;
        uint256 minOut;
        bool erc20;
    }

    function buy(uint256 actorSeed, uint256 tokenSeed, uint256 amt, uint8 modeSeed, uint256 minOutSeed, bool erc20)
        external
    {
        Ctx memory c;
        c.a = actors[actorSeed % actors.length];
        c.i = tokenSeed % tokens.length;
        c.t = tokens[c.i];
        c.amt = bound(amt, 1e12, 30 ether);
        c.mode = modeSeed % 4;
        // minOut: mostly 0, sometimes absurd (must revert TooLittle, never short-change)
        c.minOut = minOutSeed % 8 == 0 ? type(uint128).max : 0;
        c.erc20 = erc20;
        if (erc20) {
            vm.startPrank(c.a);
            wokb.deposit{value: c.amt}();
            wokb.approve(address(router), c.amt);
            vm.stopPrank();
        }
        Bal memory b0 = _bal(c.a, c.t);
        vm.recordLogs();
        (bool ok, bytes memory ret) = _send(c);
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        Bal memory b1 = _bal(c.a, c.t);
        if (ok) _onSuccess(c, abi.decode(ret, (uint256)), b0, b1, logs);
        else _onDeny(c, ret, b0, b1);
        _checkRouterEmpty(c.t);
    }

    function _send(Ctx memory c) internal returns (bool ok, bytes memory ret) {
        vm.prank(c.a);
        (ok, ret) = c.erc20
            ? address(router).call(
                abi.encodeCall(
                    ExitProofRouter.buy,
                    (address(factory), address(wokb), c.amt, c.t, c.minOut, c.mode, c.a, block.timestamp)
                )
            )
            : address(router).call{value: c.amt}(
                abi.encodeCall(ExitProofRouter.buyETH, (address(factory), c.t, c.minOut, c.mode, c.a, block.timestamp))
            );
    }

    function _onSuccess(Ctx memory c, uint256 out, Bal memory b0, Bal memory b1, VmSafe.Log[] memory logs) internal {
        buysOk++;
        uint256 fee = c.amt * router.feeBps() / 10000;
        ghostFees += fee;
        if (b1.fee - b0.fee != fee) {
            vFee++;
            _violate("fee delta");
        }
        if (b1.tok - b0.tok != out || out < c.minOut || out == 0) {
            vBadChecked++;
            _violate("out mismatch");
        }
        _checkChecked(logs, c.a, c.t, c.mode, c.amt, out);
        if (alwaysUnsellable[c.i]) {
            vUnsellableBought++;
            _violate("honeypot bought");
        }
        if (!_canSell(c.a, c.i, out)) {
            vUnsellableBought++;
            _violate("bought but buyer cannot sell");
        }
    }

    function _onDeny(Ctx memory c, bytes memory ret, Bal memory b0, Bal memory b1) internal {
        (bytes4 sel, bytes memory rest) = _strip(ret);
        if (sel == ExitProofRouter.Blocked.selector) {
            buysDenied++;
            (uint8 reason, uint16 facts) = abi.decode(rest, (uint8, uint16));
            (bool allow, uint8 pr) = Spec.policy(facts);
            if (reason < 8) deniedByReason[reason]++;
            if (allow || pr != reason || (facts >> 9) != c.mode) {
                vBadBlocked++;
                _violate("Blocked payload vs policy");
            }
        } else {
            buysOther++;
        }
        if (b1.native != b0.native || b1.w != b0.w || b1.tok != b0.tok || b1.fee != b0.fee) {
            vDenyMoved++;
            _violate("deny moved balances");
        }
    }

    function _checkChecked(VmSafe.Log[] memory logs, address a, address t, uint8 mode, uint256 amt, uint256 out)
        internal
    {
        uint256 seen;
        for (uint256 k = 0; k < logs.length; k++) {
            if (logs[k].emitter != address(router) || logs[k].topics[0] != CHECKED_SIG) continue;
            seen++;
            bool topicsOk = logs[k].topics[1] == bytes32(uint256(uint160(t)))
                && logs[k].topics[2] == t.codehash && logs[k].topics[3] == bytes32(uint256(uint160(a)));
            (bool bad, bool sellOk) = _badChecked(logs[k].data, t, mode, amt, out);
            if (!sellOk) {
                vProbeFailBought++;
                _violate("success with sellOk = 0");
            }
            if (bad || !topicsOk) {
                vBadChecked++;
                _violate("Checked event vs policy/facts");
            }
        }
        if (seen != 1) {
            vBadChecked++;
            _violate("exactly one Checked per buy");
        }
    }

    function _badChecked(bytes memory data, address t, uint8 mode, uint256 amt, uint256 out)
        internal
        view
        returns (bool bad, bool sellOk)
    {
        (uint16 facts, bool allow, uint8 reason, uint256 amountIn, uint256 o) =
            abi.decode(data, (uint16, bool, uint8, uint256, uint256));
        (bool pAllow, uint8 pReason) = Spec.policy(facts);
        bool scanned = reg.flagsOf(t.codehash).scanned;
        sellOk = facts & 1 == 1;
        bad = !allow || reason != 0 || !pAllow || pReason != 0 || !sellOk || (facts >> 9) != mode
            || (((facts >> 8) & 1) == 1) == scanned || amountIn != amt || o != out;
    }

    /// @dev Independent sellability oracle: the buyer itself sells exactly what it received, straight into the pair,
    ///      inside a frame that always reverts (no state survives).
    function _canSell(address a, uint256 i, uint256 amount) internal returns (bool sold) {
        try this.simSell(a, tokens[i], pairs[i], amount) {
            return false;
        } catch (bytes memory err) {
            (bytes4 sel, bytes memory rest) = _strip(err);
            if (sel != SimResult.selector) return false;
            sold = abi.decode(rest, (bool));
        }
    }

    function simSell(address a, address t, address pair, uint256 amount) external {
        require(msg.sender == address(this), "self");
        vm.prank(a);
        (bool ok, bytes memory d) = t.call(abi.encodeWithSelector(IERC20X.transfer.selector, pair, amount));
        if (!ok || (d.length != 0 && !abi.decode(d, (bool)))) revert SimResult(false);
        (bool tIs0, uint256 o) = _sellQuote(t, pair);
        if (o == 0) revert SimResult(false);
        uint256 w0 = wokb.balanceOf(a);
        bytes memory cd = abi.encodeCall(MockV2Pair.swap, (tIs0 ? 0 : o, tIs0 ? o : 0, a, bytes("")));
        (ok,) = pair.call(cd);
        revert SimResult(ok && wokb.balanceOf(a) - w0 == o);
    }

    /// @dev V2 quote for whatever the pair received above its token reserve.
    function _sellQuote(address t, address pair) internal view returns (bool tIs0, uint256 o) {
        (uint112 r0, uint112 r1,) = MockV2Pair(pair).getReserves();
        tIs0 = MockV2Pair(pair).token0() == t;
        (uint256 rT, uint256 rW) = tIs0 ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        uint256 bal = IERC20X(t).balanceOf(pair);
        if (bal > rT) o = Spec.out(bal - rT, rT, rW, POOL_FEE);
    }

    struct World {
        Bal bal;
        uint112 r0;
        uint112 r1;
        uint8 scan;
        bytes32 lock;
    }

    function _world(address a, uint256 i) internal view returns (World memory w) {
        w.bal = _bal(a, tokens[i]);
        (w.r0, w.r1,) = MockV2Pair(pairs[i]).getReserves();
        w.scan = router.scanCache(tokens[i].codehash);
        w.lock = vm.load(address(router), bytes32(uint256(2)));
    }

    function inspect(uint256 actorSeed, uint256 tokenSeed, uint256 amt, uint8 modeSeed) external {
        address a = actors[actorSeed % actors.length];
        uint256 i = tokenSeed % tokens.length;
        amt = bound(amt, 1e12, 30 ether);
        inspects++;
        World memory w0 = _world(a, i);
        vm.prank(a);
        (bool ok, bytes memory ret) = address(router).call{value: amt}(
            abi.encodeCall(ExitProofRouter.inspect, (address(factory), address(wokb), amt, tokens[i], modeSeed % 4))
        );
        World memory w1 = _world(a, i);
        (bytes4 sel,) = _strip(ret);
        if (sel == ExitProofRouter.Report.selector) reports++;
        if (ok || keccak256(abi.encode(w0)) != keccak256(abi.encode(w1))) {
            vInspect++;
            _violate("inspect returned or moved state");
        }
        _checkRouterEmpty(tokens[i]);
    }

    function attest(uint256 tokenSeed, uint8 flags) external {
        address t = tokens[tokenSeed % tokens.length];
        attests++;
        vm.prank(attester);
        reg.attest(
            t.codehash,
            RiskRegistry.Flags(true, flags & 1 != 0, flags & 2 != 0, flags & 4 != 0, flags & 8 != 0, 1),
            "ipfs://inv"
        );
    }

    function setBombFee(uint256 bps) external {
        vm.prank(deployer);
        bomb.setSellFee(bound(bps, 0, 10000));
    }

    function roll(uint256 n) external {
        n = bound(n, 1, 20);
        vm.roll(block.number + n);
        vm.warp(block.timestamp + n * 2);
    }
}

contract ExitProofInvariantTest is StdInvariant, Test {
    uint256 constant SUPPLY = 1_000_000_000e18;
    uint256 constant LIQ_TOKEN = 1_000_000e18;
    uint256 constant LIQ_WOKB = 1000e18;

    MockProcessor proc;
    RiskRegistry reg;
    MockWOKB wokb;
    MockV2Factory factory;
    ExitProofRouter router;
    ExitProofHandler handler;
    address feeTo = makeAddr("feeTo");
    address attester = makeAddr("attester");

    function setUp() public {
        proc = new MockProcessor();
        reg = new RiskRegistry();
        reg.setAttester(attester, true);
        wokb = new MockWOKB();
        factory = new MockV2Factory(25);
        address[] memory fs = new address[](1);
        fs[0] = address(factory);
        uint16[] memory fb = new uint16[](1);
        fb[0] = 25;
        router = new ExitProofRouter(address(proc), 7, address(reg), address(wokb), feeTo, 10, fs, fb);
        vm.deal(address(this), 1e30);

        TimeBombToken bomb = new TimeBombToken(SUPPLY);
        handler = new ExitProofHandler(router, reg, wokb, factory, feeTo, attester, bomb);

        // clean-ish (sellable) tokens
        _add(address(new FuzzTaxToken(SUPPLY)), true, false);
        _add(address(new CleanToken(SUPPLY)), false, false);
        _add(address(new OwnedCleanToken(SUPPLY)), false, false);
        _add(address(new FeeToken(SUPPLY, 300)), false, false);
        _add(address(bomb), true, false);
        _add(address(new ScanFalsePositiveToken(SUPPLY)), false, false);
        ProxyImpl impl = new ProxyImpl();
        _add(
            address(new ProxyToken(address(impl), abi.encodeCall(ProxyImpl.initialize, (SUPPLY, address(this))))),
            false,
            false
        );
        HeavyHookToken heavy = new HeavyHookToken(SUPPLY);
        heavy.setIters(3);
        _add(address(heavy), false, false);
        FuzzTaxToken taxed = new FuzzTaxToken(SUPPLY);
        taxed.setTax(700, 700, 0);
        _add(address(taxed), true, false);
        _add(address(new MaxTxToken(2_000_000e18)), true, false); // sellable below 20k tokens only (big buys exceed it)
        _add(address(new SellTax99(SUPPLY)), true, false); // sellable, but 99% taxed
        _add(address(new LyingBalanceToken(SUPPLY)), true, false);
        ReentrantToken re = new ReentrantToken(SUPPLY);
        _add(address(re), true, false);
        re.setTarget(address(router), address(factory));
        // never sellable by a fresh buyer in the same block
        _add(address(new BlacklistOnBuy(SUPPLY)), true, true);
        _add(address(new CooldownToken(SUPPLY)), true, true);
        _add(address(new TradingDisabled(SUPPLY)), true, true);
        _add(address(new GasBombToken(SUPPLY)), true, true);
        _add(address(new ReturnBombToken(SUPPLY)), true, true);
        _add(address(new ForgedProbeToken(SUPPLY)), true, true);
        _add(address(new SecondHopTrap(SUPPLY)), true, true);
        FuzzTaxToken blocked = new FuzzTaxToken(SUPPLY);
        blocked.setSellBlocked(true);
        _add(address(blocked), true, true);

        targetContract(address(handler));
        bytes4[] memory sels = new bytes4[](6);
        sels[0] = ExitProofHandler.buy.selector;
        sels[1] = ExitProofHandler.inspect.selector;
        sels[2] = ExitProofHandler.attest.selector;
        sels[3] = ExitProofHandler.setBombFee.selector;
        sels[4] = ExitProofHandler.roll.selector;
        sels[5] = ExitProofHandler.buy.selector; // weight buys x2
        targetSelector(FuzzSelector({addr: address(handler), selectors: sels}));
    }

    function _add(address t, bool pairAware, bool unsellable) internal {
        address pair = factory.createPair(t, address(wokb));
        if (pairAware) {
            (bool ok,) = t.call(abi.encodeWithSignature("initPair(address)", pair));
            require(ok, "initPair");
        }
        require(IERC20X(t).transfer(pair, LIQ_TOKEN), "seed");
        wokb.deposit{value: LIQ_WOKB}();
        require(wokb.transfer(pair, LIQ_WOKB), "seed w");
        MockV2Pair(pair).mint(address(this));
        handler.addToken(t, pair, unsellable);
    }

    /// forge-config: default.invariant.runs = 256
    /// forge-config: default.invariant.depth = 60
    function invariant_a_routerNeverHoldsBalance() public view {
        assertEq(address(router).balance, 0, "native");
        assertEq(wokb.balanceOf(address(router)), 0, "wokb");
        uint256 n = handler.tokenCount();
        for (uint256 i = 0; i < n; i++) {
            assertEq(IERC20X(handler.tokens(i)).balanceOf(address(router)), 0, "token");
        }
        assertEq(handler.vRouterHeld(), 0, "router held a balance after some call");
        assertEq(uint256(vm.load(address(router), bytes32(uint256(2)))), 1, "lock");
    }

    /// forge-config: default.invariant.runs = 256
    /// forge-config: default.invariant.depth = 60
    function invariant_b_noUnsellableBuySucceeds() public view {
        assertEq(handler.vUnsellableBought(), 0, handler.firstViolation());
        assertEq(handler.vProbeFailBought(), 0, handler.firstViolation());
    }

    /// forge-config: default.invariant.runs = 256
    /// forge-config: default.invariant.depth = 60
    function invariant_c_checkedEventMatchesPolicy() public view {
        assertEq(handler.vBadChecked(), 0, handler.firstViolation());
        assertEq(handler.vBadBlocked(), 0, handler.firstViolation());
    }

    /// forge-config: default.invariant.runs = 256
    /// forge-config: default.invariant.depth = 60
    function invariant_d_feeRecipientEqualsSumOfFees() public view {
        assertEq(wokb.balanceOf(feeTo), handler.ghostFees(), "feeTo != sum of fees");
        assertEq(feeTo.balance, 0, "feeTo native");
        assertEq(handler.vFee(), 0, handler.firstViolation());
    }

    /// forge-config: default.invariant.runs = 256
    /// forge-config: default.invariant.depth = 60
    function invariant_e_denyLeavesBuyerUnchanged() public view {
        assertEq(handler.vDenyMoved(), 0, handler.firstViolation());
        assertEq(handler.vInspect(), 0, handler.firstViolation());
    }

    /// @notice Handler sanity / positive control: one permissive buy per token, both paths. Every sellable fixture
    ///         is bought, every always-unsellable one is denied, and no violation is recorded.
    function test_handler_sanity_every_token() public {
        uint256 n = handler.tokenCount();
        uint256 sellable;
        for (uint256 i = 0; i < n; i++) {
            if (!handler.alwaysUnsellable(i)) sellable++;
            handler.buy(i, i, 1 ether, 2, 1, i % 2 == 0);
            handler.inspect(i, i, 1 ether, 2);
        }
        emit log_named_uint("buys ok", handler.buysOk());
        emit log_named_uint("buys denied", handler.buysDenied());
        emit log_named_uint("buys other", handler.buysOther());
        for (uint256 r = 1; r < 8; r++) {
            emit log_named_uint(string(abi.encodePacked("denied reason ", vm.toString(r))), handler.deniedByReason(r));
        }
        assertEq(handler.firstViolation(), "", "violation");
        // SellTax99 (reason 2) and LyingBalance (reason 2) are sellable-but-denied; the rest of the sellable set buys
        assertEq(handler.buysOk(), sellable - 2, "sellable fixtures bought");
        assertEq(handler.buysDenied(), n - sellable + 2, "denied");
        assertEq(handler.reports(), n, "every inspect reports");
    }

    /// @notice Pseudo-random replay of the handler mix (fixed seed) to show the verdict distribution, which the
    ///         invariant runner only prints for its last run.
    function test_handler_randomReplay_distribution() public {
        for (uint256 k = 0; k < 400; k++) {
            uint256 r = uint256(keccak256(abi.encode(k)));
            uint256 op = r % 8;
            // forge-lint: disable-next-line(unsafe-typecast)
            uint8 b = uint8(r >> 32); // truncation intended: a random byte
            if (op < 4) handler.buy(r >> 8, r >> 16, r >> 24, b, r >> 40, (r >> 48) & 1 == 1);
            else if (op == 4) handler.inspect(r >> 8, r >> 16, r >> 24, b);
            else if (op == 5) handler.attest(r >> 8, b);
            else if (op == 6) handler.setBombFee(r >> 8);
            else handler.roll(r >> 8);
        }
        emit log_named_uint("buys ok", handler.buysOk());
        emit log_named_uint("buys denied", handler.buysDenied());
        emit log_named_uint("buys other", handler.buysOther());
        for (uint256 r = 1; r < 8; r++) {
            emit log_named_uint(string(abi.encodePacked("denied reason ", vm.toString(r))), handler.deniedByReason(r));
        }
        assertEq(handler.firstViolation(), "", "violation");
        assertGt(handler.buysOk(), 0, "some buys succeed");
    }

    function afterInvariant() external {
        emit log_named_uint("buys ok", handler.buysOk());
        emit log_named_uint("buys denied", handler.buysDenied());
        emit log_named_uint("buys other revert", handler.buysOther());
        emit log_named_uint("inspects", handler.inspects());
        emit log_named_uint("reports", handler.reports());
        emit log_named_uint("attests", handler.attests());
        for (uint256 r = 1; r < 8; r++) {
            emit log_named_uint(string(abi.encodePacked("denied reason ", vm.toString(r))), handler.deniedByReason(r));
        }
    }
}
