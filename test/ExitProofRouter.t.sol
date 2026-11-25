// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ExitProofRouter} from "../contracts/ExitProofRouter.sol";
import {RiskRegistry} from "../contracts/RiskRegistry.sol";
import {MockProcessor, FixedProcessor} from "./mocks/MockProcessor.sol";
import {MockWOKB, MockV2Factory, MockV2Pair} from "./mocks/V2.sol";
import "./fixtures/Tokens.sol";

interface IERC20T {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}

contract ExitProofRouterTest is Test {
    uint256 constant SUPPLY = 1_000_000e18;
    uint256 constant LIQ_TOKEN = 100_000e18;
    uint256 constant LIQ_WOKB = 100e18;
    uint8 constant STRICT = 0;
    uint8 constant BALANCED = 1;
    uint8 constant PERMISSIVE = 2;

    MockProcessor proc;
    RiskRegistry reg;
    MockWOKB wokb;
    MockV2Factory factory;
    ExitProofRouter router;
    address feeTo = makeAddr("feeTo");
    address user = makeAddr("user");

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

    struct Rep {
        uint16 facts;
        bool allow;
        uint8 reason;
        uint256 buyOut;
        uint256 sellOut;
        uint256 delivered;
    }

    function setUp() public {
        proc = new MockProcessor();
        reg = new RiskRegistry();
        reg.setAttester(address(this), true);
        wokb = new MockWOKB();
        factory = new MockV2Factory(25);
        router = _router(address(proc), 10);
        vm.deal(user, 1000 ether);
        vm.deal(address(this), 1000 ether);
    }

    // ------------------------------------------------------------------ helpers

    function _router(address processor, uint16 feeBps) internal returns (ExitProofRouter) {
        address[] memory fs = new address[](1);
        fs[0] = address(factory);
        uint16[] memory fb = new uint16[](1);
        fb[0] = 25;
        return new ExitProofRouter(processor, 7, address(reg), address(wokb), feeTo, feeBps, fs, fb);
    }

    function _list(address t, bool pairAware) internal returns (address pair) {
        pair = factory.createPair(t, address(wokb));
        if (pairAware) PairAware(t).initPair(pair);
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        IERC20T(t).transfer(pair, LIQ_TOKEN);
        wokb.deposit{value: LIQ_WOKB}();
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        wokb.transfer(pair, LIQ_WOKB);
        MockV2Pair(pair).mint(address(this));
    }

    function _f(uint16 facts, uint256 shift, uint256 width) internal pure returns (uint256) {
        // forge-lint: disable-next-line(incorrect-shift)
        return (uint256(facts) >> shift) & ((1 << width) - 1);
    }

    function _strip(bytes memory err) internal pure returns (bytes4 sel, bytes memory rest) {
        require(err.length >= 4, "short err");
        // forge-lint: disable-next-line(unsafe-typecast)
        sel = bytes4(err);
        rest = new bytes(err.length - 4);
        for (uint256 i = 0; i < rest.length; i++) {
            rest[i] = err[i + 4];
        }
    }

    function _inspect(address t, uint256 amt, uint8 mode) internal returns (Rep memory r) {
        vm.prank(user);
        try router.inspect{value: amt}(address(factory), address(wokb), amt, t, mode) {
            revert("inspect returned");
        } catch (bytes memory err) {
            (bytes4 sel, bytes memory rest) = _strip(err);
            assertTrue(sel == ExitProofRouter.Report.selector, "not Report");
            (r.facts, r.allow, r.reason, r.buyOut, r.sellOut, r.delivered) =
                abi.decode(rest, (uint16, bool, uint8, uint256, uint256, uint256));
        }
    }

    function _buy(address t, uint256 amt, uint8 mode) internal returns (uint256 out) {
        vm.prank(user);
        out = router.buyETH{value: amt}(address(factory), t, 0, mode, user, block.timestamp);
    }

    function _blocked(address t, uint256 amt, uint8 mode) internal returns (uint8 reason, uint16 facts) {
        vm.prank(user);
        try router.buyETH{value: amt}(address(factory), t, 0, mode, user, block.timestamp) {
            revert("buy not blocked");
        } catch (bytes memory err) {
            (bytes4 sel, bytes memory rest) = _strip(err);
            assertTrue(sel == ExitProofRouter.Blocked.selector, "not Blocked");
            (reason, facts) = abi.decode(rest, (uint8, uint16));
        }
    }

    function _attest(address t, bool privileged, bool upg, bool danger) internal {
        reg.attest(t, t.codehash, RiskRegistry.Flags(true, privileged, upg, danger, false, 1), "ipfs://r");
    }

    function _assertNoDust(address t) internal view {
        assertEq(IERC20T(t).balanceOf(address(router)), 0, "token dust");
        assertEq(wokb.balanceOf(address(router)), 0, "wokb dust");
        assertEq(address(router).balance, 0, "native dust");
    }

    // ------------------------------------------------------------------ circuit model

    function test_mockProcessor_matches_truth() public view {
        uint256[] memory truth = abi.decode(vm.parseJson(vm.readFile("circuit/truth.json")), (uint256[]));
        assertEq(truth.length, 2048);
        for (uint256 x = 0; x < 2048; x++) {
            // forge-lint: disable-next-line(unsafe-typecast)
            bytes memory o = proc.eval(7, abi.encodePacked(uint8(x), uint8(x >> 8)));
            assertEq(o.length, 1);
            assertEq(uint256(uint8(o[0])), truth[x], "policy mismatch");
        }
    }

    // ------------------------------------------------------------------ verdicts

    function test_clean_permissive_allows() public {
        CleanToken t = new CleanToken(SUPPLY);
        _list(address(t), false);
        vm.expectEmit(true, true, true, false, address(router));
        emit Checked(address(t), address(t).codehash, user, 0, true, 0, 0, 0);
        uint256 out = _buy(address(t), 1 ether, PERMISSIVE);
        assertGt(out, 0);
        assertEq(t.balanceOf(user), out);
        Rep memory r = _inspect(address(t), 1 ether, PERMISSIVE);
        assertTrue(r.allow);
        assertEq(_f(r.facts, 0, 1), 1, "sellOk");
        assertEq(_f(r.facts, 1, 2), 0, "sellTax");
        assertEq(_f(r.facts, 3, 2), 0, "buyTax");
        assertEq(_f(r.facts, 5, 1), 0, "owner");
        assertEq(_f(r.facts, 8, 1), 1, "unscanned");
        assertEq(_f(r.facts, 9, 2), PERMISSIVE, "mode");
        _assertNoDust(address(t));
    }

    function test_clean_strict_blocks_unscanned() public {
        CleanToken t = new CleanToken(SUPPLY);
        _list(address(t), false);
        (uint8 reason,) = _blocked(address(t), 1 ether, STRICT);
        assertEq(reason, 6);
        _attest(address(t), false, false, false);
        assertGt(_buy(address(t), 1 ether, STRICT), 0);
        _assertNoDust(address(t));
    }

    function test_blacklist_blocked_reason1() public {
        BlacklistOnBuy t = new BlacklistOnBuy(SUPPLY);
        _list(address(t), true);
        (uint8 reason, uint16 facts) = _blocked(address(t), 1 ether, PERMISSIVE);
        assertEq(reason, 1);
        assertEq(_f(facts, 0, 1), 0);
        assertEq(_f(facts, 1, 2), 3, "unmeasurable sell tax = bucket 3");
        assertEq(user.balance, 1000 ether, "money never moved");
    }

    function test_sellTax99_blocked_reason2() public {
        SellTax99 t = new SellTax99(SUPPLY);
        _list(address(t), true);
        (uint8 reason, uint16 facts) = _blocked(address(t), 1 ether, PERMISSIVE);
        assertEq(reason, 2);
        assertEq(_f(facts, 0, 1), 1, "sell technically works");
        assertEq(_f(facts, 1, 2), 3, "sellTax bucket");
        assertEq(_f(facts, 3, 2), 0, "buyTax bucket");
    }

    function test_maxTx_blocked_reason1() public {
        MaxTxToken t = new MaxTxToken(SUPPLY);
        _list(address(t), true);
        // a small buy (< 1% of supply) can be sold back
        assertTrue(_inspect(address(t), 1 ether, PERMISSIVE).allow);
        // 20 OKB buys ~16.6k tokens > 1% of supply (10k): the full position cannot be sold
        Rep memory r = _inspect(address(t), 20 ether, PERMISSIVE);
        assertGt(r.buyOut, SUPPLY / 100);
        (uint8 reason,) = _blocked(address(t), 20 ether, PERMISSIVE);
        assertEq(reason, 1);
    }

    function test_cooldown_blocked_reason1() public {
        CooldownToken t = new CooldownToken(SUPPLY);
        _list(address(t), true);
        (uint8 reason,) = _blocked(address(t), 1 ether, PERMISSIVE);
        assertEq(reason, 1);
    }

    function test_tradingDisabled_blocked_reason1() public {
        TradingDisabled t = new TradingDisabled(SUPPLY);
        _list(address(t), true);
        (uint8 reason, uint16 facts) = _blocked(address(t), 1 ether, PERMISSIVE);
        assertEq(reason, 1);
        assertEq(_f(facts, 5, 1), 1, "owner active");
        t.enableTrading();
        assertGt(_buy(address(t), 1 ether, PERMISSIVE), 0);
    }

    function test_timeBomb_balanced() public {
        TimeBombToken t = new TimeBombToken(SUPPLY);
        _list(address(t), true);
        // unscanned with a live owner -> reason 6 in balanced
        (uint8 reason,) = _blocked(address(t), 1 ether, BALANCED);
        assertEq(reason, 6);
        _attest(address(t), true, false, true);
        uint16 facts;
        (reason, facts) = _blocked(address(t), 1 ether, BALANCED);
        assertEq(reason, 5);
        assertEq(_f(facts, 5, 1), 1, "owner");
        assertEq(_f(facts, 7, 1), 1, "danger");
        assertEq(_f(facts, 8, 1), 0, "scanned");
        // sell fee is 0 today: permissive lets it through
        assertGt(_buy(address(t), 1 ether, PERMISSIVE), 0);
    }

    function test_proxy_balanced_reason4() public {
        ProxyImpl impl = new ProxyImpl();
        ProxyToken p = new ProxyToken(address(impl), abi.encodeCall(ProxyImpl.initialize, (SUPPLY, address(this))));
        _list(address(p), false);
        (uint8 reason, uint16 facts) = _blocked(address(p), 1 ether, BALANCED);
        assertEq(reason, 4);
        assertEq(_f(facts, 6, 1), 1, "upgradeable");
        assertEq(_f(facts, 8, 1), 1, "unscanned");
        assertEq(_f(facts, 7, 1), 0, "no selfdestruct");
    }

    function test_scan_falsePositive_cleared_by_registry() public {
        ScanFalsePositiveToken t = new ScanFalsePositiveToken(SUPPLY);
        _list(address(t), false);
        (uint8 reason, uint16 facts) = _blocked(address(t), 1 ether, BALANCED);
        assertEq(reason, 4, "on-chain scan flags DELEGATECALL");
        assertEq(_f(facts, 6, 1), 1);
        // reachability-precise attestation says not upgradeable: registry is authoritative once scanned
        _attest(address(t), false, false, false);
        assertGt(_buy(address(t), 1 ether, BALANCED), 0);
        assertTrue(_inspect(address(t), 1 ether, STRICT).allow);
    }

    function test_registry_upgradeable_authoritative() public {
        CleanToken t = new CleanToken(SUPPLY);
        _list(address(t), false);
        _attest(address(t), false, true, false);
        (uint8 reason, uint16 facts) = _blocked(address(t), 1 ether, BALANCED);
        assertEq(reason, 4);
        assertEq(_f(facts, 6, 1), 1);
    }

    function test_buy_feeOnTransfer_5pct_bucket1() public {
        // FeeToken(500) burns 5% of EVERY transfer. Buy side = delivery loss over two hops (pair -> router ->
        // holder/buyer): 1 - 0.95^2 = 9.75% -> bucket 1. Sell side = holder -> pair: 5% -> bucket 1.
        FeeToken t = new FeeToken(SUPPLY, 500);
        _list(address(t), false);
        Rep memory r = _inspect(address(t), 1 ether, PERMISSIVE);
        assertTrue(r.allow);
        assertEq(_f(r.facts, 3, 2), 1, "buyTax bucket 1");
        assertEq(_f(r.facts, 1, 2), 1, "sellTax bucket 1");
        uint256 out = _buy(address(t), 1 ether, PERMISSIVE);
        // forwarding router -> user is itself taxed 5%: out is what the user actually received, and inspect said so
        assertEq(t.balanceOf(user), out);
        assertApproxEqRel(out, r.buyOut * 95 / 100, 1e12);
        assertEq(out, r.delivered, "Report.delivered == what the buy delivers");
        _assertNoDust(address(t));
        // strict: sell tax is checked before buy tax (spec reason order) -> 2
        (uint8 reason,) = _blocked(address(t), 1 ether, STRICT);
        assertEq(reason, 2);
    }

    function test_feeOnTransfer_8pct_buy_crosses_15pct() public {
        // FeeToken(800): buy side 1 - 0.92^2 = 15.36% (two delivery hops) -> bucket 2; sell side 8% -> bucket 1.
        // The buyer really loses >15% receiving the token, so permissive blocks on the BUY tax (reason 3), while
        // the sell leg alone would have passed.
        FeeToken t = new FeeToken(SUPPLY, 800);
        _list(address(t), false);
        Rep memory r = _inspect(address(t), 1 ether, PERMISSIVE);
        assertEq(_f(r.facts, 0, 1), 1, "sellOk");
        assertEq(_f(r.facts, 3, 2), 2, "buyTax bucket 2");
        assertEq(_f(r.facts, 1, 2), 1, "sellTax bucket 1");
        (uint8 reason,) = _blocked(address(t), 1 ether, PERMISSIVE);
        assertEq(reason, 3);
    }

    function test_txOriginTrap_known_limitation() public {
        // KNOWN LIMITATION: the trap keys on tx.origin and only bites in a LATER block, so the same-tx
        // probe sells fine and ExitProof allows the buy. Any token can also special-case the router
        // address. ExitProof proves "sellable now, by this router", not "sellable forever".
        TxOriginTrap t = new TxOriginTrap(SUPPLY);
        address pair = _list(address(t), true);
        vm.startPrank(user, user);
        Rep memory r = _inspectAsOrigin(address(t));
        assertTrue(r.allow, "probe passes: limitation");
        uint256 out = router.buyETH{value: 1 ether}(address(factory), address(t), 0, PERMISSIVE, user, block.timestamp);
        assertGt(out, 0);
        vm.roll(block.number + 1);
        vm.expectRevert(bytes("trapped"));
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        t.transfer(pair, out);
        vm.stopPrank();
    }

    function _inspectAsOrigin(address t) internal returns (Rep memory r) {
        try router.inspect{value: 1 ether}(address(factory), address(wokb), 1 ether, t, PERMISSIVE) {
            revert("inspect returned");
        } catch (bytes memory err) {
            (, bytes memory rest) = _strip(err);
            (r.facts, r.allow, r.reason, r.buyOut, r.sellOut, r.delivered) =
                abi.decode(rest, (uint16, bool, uint8, uint256, uint256, uint256));
        }
    }

    // ------------------------------------------------------------------ review focus

    function test_owner_probe_robust() public {
        address[4] memory ts = [
            address(new CleanToken(SUPPLY)),
            address(new OwnerRevertsToken(SUPPLY)),
            address(new OwnerShortToken(SUPPLY)),
            address(new OwnerGasHogToken(SUPPLY))
        ];
        for (uint256 i = 0; i < ts.length; i++) {
            _list(ts[i], false);
            Rep memory r = _inspect(ts[i], 1 ether, PERMISSIVE);
            assertTrue(r.allow);
            assertEq(_f(r.facts, 5, 1), 0, "ownerActive must be 0");
            assertGt(_buy(ts[i], 1 ether, PERMISSIVE), 0);
        }
        // fail closed: any non-zero 32-byte word from a successful owner() counts as an active owner
        OwnerGarbageToken g = new OwnerGarbageToken(SUPPLY);
        _list(address(g), false);
        assertEq(_f(_inspect(address(g), 1 ether, PERMISSIVE).facts, 5, 1), 1, "dirty word = owner");
        OwnedCleanToken o = new OwnedCleanToken(SUPPLY);
        _list(address(o), false);
        assertEq(_f(_inspect(address(o), 1 ether, PERMISSIVE).facts, 5, 1), 1, "real owner");
        o.renounceOwnership();
        assertEq(_f(_inspect(address(o), 1 ether, PERMISSIVE).facts, 5, 1), 0, "renounced");
        // registry `privileged` also sets ownerActive
        _attest(address(o), true, false, false);
        assertEq(_f(_inspect(address(o), 1 ether, PERMISSIVE).facts, 5, 1), 1, "privileged");
    }

    function test_probe_gasBomb_blocked() public {
        GasBombToken t = new GasBombToken(SUPPLY);
        _list(address(t), true);
        (uint8 reason, uint16 facts) = _blocked(address(t), 1 ether, PERMISSIVE);
        assertEq(reason, 1);
        assertEq(_f(facts, 0, 1), 0);
    }

    function test_probe_returnBomb_blocked() public {
        ReturnBombToken t = new ReturnBombToken(SUPPLY);
        _list(address(t), true);
        uint256 g = gasleft();
        (uint8 reason, uint16 facts) = _blocked(address(t), 1 ether, PERMISSIVE);
        assertLt(g - gasleft(), 5_000_000, "bounded");
        assertEq(reason, 1);
        assertEq(_f(facts, 0, 1), 0);
    }

    function test_probe_cannot_be_forged_by_token() public {
        ForgedProbeToken t = new ForgedProbeToken(SUPPLY);
        _list(address(t), true);
        (uint8 reason, uint16 facts) = _blocked(address(t), 1 ether, PERMISSIVE);
        assertEq(reason, 1);
        assertEq(_f(facts, 0, 1), 0);
    }

    function test_secondHopTrap_blocked_reason1() public {
        // Reviewer PoC: the trap ignores pair hops and blacklists the receiver of any other transfer, so a probe
        // that sells straight from the router passes and the buyer is trapped by the router -> buyer forward.
        // The probe mirrors the real path: router -> fresh code-less holder -> (transferFrom by the router) -> pair.
        SecondHopTrap t = new SecondHopTrap(SUPPLY);
        _list(address(t), true);
        (uint8 reason, uint16 facts) = _blocked(address(t), 1 ether, PERMISSIVE);
        assertEq(reason, 1);
        assertEq(_f(facts, 0, 1), 0);
        // RESIDUAL LIMITATION (documented): the probe holder has no code (like an EOA), but it is never tx.origin and
        // the spender is this router, so a token that keys on tx.origin, the spender address, the remaining gas window
        // or a later block can still pass the probe and trap the buyer afterwards.
    }

    function test_lyingBalance_saturates_not_panics() public {
        LyingBalanceToken t = new LyingBalanceToken(SUPPLY);
        _list(address(t), true);
        (uint8 reason, uint16 facts) = _blocked(address(t), 1 ether, PERMISSIVE);
        assertEq(reason, 2, "sell tax bucket 3, not a panic");
        assertEq(_f(facts, 1, 2), 3);
    }

    function test_probe_gas_codeless_holder() public {
        CleanToken t = new CleanToken(SUPPLY);
        address pair = _list(address(t), false);
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        t.transfer(address(router), 1000e18);
        vm.prank(address(router));
        uint256 g = gasleft();
        try router.probeSell(pair, address(t), address(wokb), 1000e18) {
            revert("probe returned");
        } catch (bytes memory err) {
            uint256 used = g - gasleft();
            (bytes4 sel, bytes memory rest) = _strip(err);
            assertTrue(sel == ExitProofRouter.ProbeResult.selector);
            (bool ok, uint256 held, uint256 out) = abi.decode(rest, (bool, uint256, uint256));
            assertTrue(ok);
            assertEq(held, 1000e18, "clean hop loses nothing");
            assertGt(out, 0);
            emit log_named_uint("probeSell gas (code-less CREATE2 holder, transferFrom sale)", used);
            assertLt(used, router.PROBE_GAS());
        }
        assertEq(t.balanceOf(address(router)), 1000e18, "probe rolled back");
    }

    function test_no_dust_both_orderings() public {
        address lo = address(uint160(address(wokb)) - 0x1000);
        address hi = address(uint160(address(wokb)) + 0x1000);
        deployCodeTo("Tokens.sol:CleanToken", abi.encode(SUPPLY), lo);
        deployCodeTo("Tokens.sol:CleanToken", abi.encode(SUPPLY), hi);
        address[2] memory ts = [lo, hi];
        for (uint256 i = 0; i < 2; i++) {
            address t = ts[i];
            address pair = _list(t, false);
            assertEq(MockV2Pair(pair).token0() == t, i == 0, "ordering");
            uint256 fee0 = wokb.balanceOf(feeTo);
            // native path, with odd wei amount
            assertGt(_buy(t, 1 ether + 7, PERMISSIVE), 0);
            _assertNoDust(t);
            assertEq(wokb.balanceOf(feeTo) - fee0, uint256(1 ether + 7) * 10 / 10000);
            // ERC20 path with WOKB as tokenIn
            vm.startPrank(user);
            wokb.deposit{value: 2 ether}();
            wokb.approve(address(router), 2 ether);
            uint256 out = router.buy(address(factory), address(wokb), 2 ether, t, 0, PERMISSIVE, user, block.timestamp);
            vm.stopPrank();
            assertGt(out, 0);
            assertEq(wokb.balanceOf(user), 0);
            _assertNoDust(t);
        }
    }

    function test_rejects_fake_pair() public {
        CleanToken t = new CleanToken(SUPPLY);
        // a perfectly real pair, but from a factory that is not allowlisted
        MockV2Factory rogue = new MockV2Factory(0);
        address pair = rogue.createPair(address(t), address(wokb));
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        t.transfer(pair, LIQ_TOKEN);
        wokb.deposit{value: LIQ_WOKB}();
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        wokb.transfer(pair, LIQ_WOKB);
        MockV2Pair(pair).mint(address(this));
        vm.prank(user);
        vm.expectRevert(ExitProofRouter.BadPair.selector);
        router.buyETH{value: 1 ether}(address(rogue), address(t), 0, PERMISSIVE, user, block.timestamp);
        // allowlisted factory, but no pair exists
        vm.prank(user);
        vm.expectRevert(ExitProofRouter.BadPair.selector);
        router.buyETH{value: 1 ether}(address(factory), address(t), 0, PERMISSIVE, user, block.timestamp);
        // token == tokenIn
        vm.prank(user);
        vm.expectRevert(ExitProofRouter.BadPair.selector);
        router.buy(address(factory), address(wokb), 1 ether, address(wokb), 0, PERMISSIVE, user, block.timestamp);
    }

    // ------------------------------------------------------------------ router mechanics

    function test_inspect_reports_without_state_change() public {
        CleanToken t = new CleanToken(SUPPLY);
        address pair = _list(address(t), false);
        (uint112 r0, uint112 r1,) = MockV2Pair(pair).getReserves();
        uint256 ub = user.balance;
        Rep memory r = _inspect(address(t), 1 ether, PERMISSIVE);
        assertTrue(r.allow);
        assertEq(r.reason, 0);
        assertGt(r.buyOut, 0);
        assertGt(r.sellOut, 0);
        assertEq(r.delivered, r.buyOut, "clean token: delivered == bought");
        assertLt(r.sellOut, 1 ether, "round trip loses fees");
        (uint112 s0, uint112 s1,) = MockV2Pair(pair).getReserves();
        assertEq(s0, r0);
        assertEq(s1, r1);
        assertEq(user.balance, ub);
        assertEq(t.balanceOf(user), 0);
        assertEq(wokb.balanceOf(feeTo), 0);
        assertEq(router.scanCache(address(t).codehash), 0, "scan cache untouched");
        // ERC20 tokenIn path: pulls from msg.sender (needs approval), still no state change
        vm.startPrank(user);
        wokb.deposit{value: 1 ether}();
        wokb.approve(address(router), 1 ether);
        try router.inspect(address(factory), address(wokb), 1 ether, address(t), PERMISSIVE) {
            revert("inspect returned");
        } catch (bytes memory err) {
            // forge-lint: disable-next-line(unsafe-typecast)
            assertTrue(bytes4(err) == ExitProofRouter.Report.selector);
        }
        vm.stopPrank();
        assertEq(wokb.balanceOf(user), 1 ether);
        // msg.value with a non-WOKB tokenIn is rejected
        vm.prank(user);
        vm.expectRevert(ExitProofRouter.BadAmount.selector);
        router.inspect{value: 1 ether}(address(factory), address(t), 1 ether, address(wokb), PERMISSIVE);
    }

    function test_fee_taken_10bps() public {
        CleanToken t = new CleanToken(SUPPLY);
        _list(address(t), false);
        _buy(address(t), 10 ether, PERMISSIVE);
        assertEq(wokb.balanceOf(feeTo), 0.01 ether);
        assertEq(router.feeBps(), 10);
    }

    function test_constructor_rejects_fee_above_cap() public {
        vm.expectRevert(ExitProofRouter.BadConfig.selector);
        _router(address(proc), 31);
        assertEq(address(_router(address(proc), 30).processor()), address(proc));
    }

    function test_minOut_enforced() public {
        CleanToken t = new CleanToken(SUPPLY);
        _list(address(t), false);
        Rep memory r = _inspect(address(t), 1 ether, PERMISSIVE);
        vm.prank(user);
        vm.expectRevert(ExitProofRouter.TooLittle.selector);
        router.buyETH{value: 1 ether}(address(factory), address(t), r.buyOut + 1, PERMISSIVE, user, block.timestamp);
        vm.prank(user);
        uint256 out =
            router.buyETH{value: 1 ether}(address(factory), address(t), r.buyOut, PERMISSIVE, user, block.timestamp);
        assertEq(out, r.buyOut);
    }

    function test_deadline() public {
        CleanToken t = new CleanToken(SUPPLY);
        _list(address(t), false);
        vm.prank(user);
        vm.expectRevert(ExitProofRouter.Expired.selector);
        router.buyETH{value: 1 ether}(address(factory), address(t), 0, PERMISSIVE, user, block.timestamp - 1);
    }

    function test_bad_mode_and_to() public {
        CleanToken t = new CleanToken(SUPPLY);
        _list(address(t), false);
        vm.prank(user);
        vm.expectRevert(ExitProofRouter.BadMode.selector);
        router.buyETH{value: 1 ether}(address(factory), address(t), 0, 4, user, block.timestamp);
        vm.prank(user);
        vm.expectRevert(ExitProofRouter.BadTo.selector);
        router.buyETH{value: 1 ether}(address(factory), address(t), 0, PERMISSIVE, address(router), block.timestamp);
        // mode 3 behaves like strict
        (uint8 reason,) = _blocked(address(t), 1 ether, 3);
        assertEq(reason, 6);
    }

    function test_probeSell_selfOnly() public {
        CleanToken t = new CleanToken(SUPPLY);
        address pair = _list(address(t), false);
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        t.transfer(address(router), 1e18);
        vm.expectRevert(ExitProofRouter.NotSelf.selector);
        router.probeSell(pair, address(t), address(wokb), 1e18);
    }

    function test_low_gas_reverts_not_blocked() public {
        CleanToken t = new CleanToken(SUPPLY);
        _list(address(t), false);
        vm.prank(user);
        vm.expectRevert(ExitProofRouter.LowGas.selector);
        router.buyETH{value: 1 ether, gas: 2_000_000}(
            address(factory), address(t), 0, PERMISSIVE, user, block.timestamp
        );
    }

    function test_reentrancy_blocked() public {
        ReentrantToken t = new ReentrantToken(SUPPLY);
        _list(address(t), true);
        t.setTarget(address(router), address(factory));
        assertGt(_buy(address(t), 1 ether, PERMISSIVE), 0);
        assertTrue(t.attempted());
        assertFalse(t.reentered());
        _assertNoDust(address(t));
    }

    function test_badEval_reverts() public {
        CleanToken t = new CleanToken(SUPPLY);
        _list(address(t), false);
        // allow bit with a non-zero reason is inconsistent
        router = _router(address(new FixedProcessor(hex"03")), 10);
        vm.prank(user);
        vm.expectRevert(ExitProofRouter.BadEval.selector);
        router.buyETH{value: 1 ether}(address(factory), address(t), 0, PERMISSIVE, user, block.timestamp);
        // empty output
        router = _router(address(new FixedProcessor("")), 10);
        vm.prank(user);
        vm.expectRevert(ExitProofRouter.BadEval.selector);
        router.buyETH{value: 1 ether}(address(factory), address(t), 0, PERMISSIVE, user, block.timestamp);
        // the circuit is authoritative: a processor that denies a clean token blocks it
        router = _router(address(new FixedProcessor(hex"0e")), 10);
        (uint8 reason,) = _blocked(address(t), 1 ether, PERMISSIVE);
        assertEq(reason, 7);
    }

    function test_gas_firstBuy_vs_cached() public {
        CleanToken t = new CleanToken(SUPPLY);
        _list(address(t), false);
        assertEq(router.scanCache(address(t).codehash), 0);
        vm.prank(user);
        uint256 g = gasleft();
        router.buyETH{value: 1 ether}(address(factory), address(t), 0, PERMISSIVE, user, block.timestamp);
        uint256 first = g - gasleft();
        assertTrue(router.scanCache(address(t).codehash) != 0, "cached");
        vm.prank(user);
        g = gasleft();
        router.buyETH{value: 1 ether}(address(factory), address(t), 0, PERMISSIVE, user, block.timestamp);
        uint256 cached = g - gasleft();
        emit log_named_uint("buyETH clean first-buy gas", first);
        emit log_named_uint("buyETH clean cached gas", cached);
        assertLt(cached, first);
    }
}
