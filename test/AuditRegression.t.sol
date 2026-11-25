// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ExitProofRouter} from "../contracts/ExitProofRouter.sol";
import {RiskRegistry} from "../contracts/RiskRegistry.sol";
import {MockProcessor, FixedProcessor} from "./mocks/MockProcessor.sol";
import {MockWOKB, MockV2Factory, MockV2Pair} from "./mocks/V2.sol";
import {Spec} from "./fuzz/FuzzBase.sol";
import {
    CleanToken,
    FeeToken,
    BlacklistOnBuy,
    SellTax99,
    ScanFalsePositiveToken,
    PairAware
} from "./fixtures/Tokens.sol";
import {
    DeliverySkim,
    TransferFromTrap,
    ApproveNoop,
    EoaOnlySeller,
    StorageConfigured,
    MiniDexRouter,
    DelegTokenA,
    DelegTokenB,
    SwapBackTaxToken,
    ReserveGamer
} from "./fixtures/AuditTokens.sol";

interface IERC20R {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}

/// @notice One regression per final-audit PoC (fable-security-audit F-01, F-02, F-06, F-07, F-10; functional audit F2
///         "Flap swap-back") plus the reserve-manipulation attempts against the post-transfer sell semantics.
contract AuditRegressionTest is Test {
    uint256 constant LIQ_TOKEN = 100_000e18;
    uint256 constant REST = 900_000e18;
    uint256 constant LIQ_WOKB = 100e18;
    uint16 constant POOL_FEE = 25;
    uint16 constant ROUTER_FEE = 10;
    uint8 constant STRICT = 0;
    uint8 constant BALANCED = 1;
    uint8 constant PERMISSIVE = 2;

    MockProcessor proc;
    RiskRegistry reg;
    MockWOKB wokb;
    MockV2Factory factory;
    ExitProofRouter router;
    MiniDexRouter dex;
    address feeTo = makeAddr("feeTo");
    address user = makeAddr("user");
    address taxWallet = makeAddr("taxWallet");

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
        factory = new MockV2Factory(POOL_FEE);
        router = _router(address(proc));
        dex = new MiniDexRouter();
        vm.deal(user, 1000 ether);
        vm.deal(address(this), 1000 ether);
    }

    // ------------------------------------------------------------------ helpers

    function _router(address processor) internal returns (ExitProofRouter) {
        address[] memory fs = new address[](1);
        fs[0] = address(factory);
        uint16[] memory fb = new uint16[](1);
        fb[0] = POOL_FEE;
        return new ExitProofRouter(processor, 7, address(reg), address(wokb), feeTo, ROUTER_FEE, fs, fb);
    }

    /// @dev Pair first (the token mints its liquidity straight to it), then the token, then WOKB liquidity.
    function _launch(bytes memory creationCode, bytes memory extraArgs) internal returns (address token, address pair) {
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        pair = factory.createPair(predicted, address(wokb));
        bytes memory init = abi.encodePacked(creationCode, abi.encode(pair, LIQ_TOKEN, REST), extraArgs);
        assembly {
            token := create(0, add(init, 32), mload(init))
        }
        require(token == predicted, "predict");
        wokb.deposit{value: LIQ_WOKB}();
        require(wokb.transfer(pair, LIQ_WOKB), "seed");
        MockV2Pair(pair).mint(address(this));
    }

    /// @dev For the deployer-minted fixtures of Tokens.sol.
    function _list(address t, bool pairAware) internal returns (address pair) {
        pair = factory.createPair(t, address(wokb));
        if (pairAware) PairAware(t).initPair(pair);
        require(IERC20R(t).transfer(pair, LIQ_TOKEN), "seed tok");
        wokb.deposit{value: LIQ_WOKB}();
        require(wokb.transfer(pair, LIQ_WOKB), "seed wokb");
        MockV2Pair(pair).mint(address(this));
    }

    function _attestClean(address t) internal {
        reg.attest(t, t.codehash, RiskRegistry.Flags(true, false, false, false, false, 4), "exitproof://scan/v1/x");
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

    /// @dev inspect as `user` with tx.origin = user (a wallet's eth_call).
    function _inspect(ExitProofRouter r_, address t, uint8 mode) internal returns (Rep memory r) {
        vm.prank(user, user);
        try r_.inspect{value: 1 ether}(address(factory), address(wokb), 1 ether, t, mode) {
            revert("inspect returned");
        } catch (bytes memory err) {
            (bytes4 sel, bytes memory rest) = _strip(err);
            assertTrue(sel == ExitProofRouter.Report.selector, "not Report");
            (r.facts, r.allow, r.reason, r.buyOut, r.sellOut, r.delivered) =
                abi.decode(rest, (uint16, bool, uint8, uint256, uint256, uint256));
        }
    }

    function _inspect(address t, uint8 mode) internal returns (Rep memory) {
        return _inspect(router, t, mode);
    }

    function _buy(address t, uint8 mode) internal returns (uint256 out) {
        vm.prank(user, user);
        out = router.buyETH{value: 1 ether}(address(factory), t, 0, mode, user, block.timestamp);
    }

    function _blocked(address t, uint8 mode) internal returns (uint8 reason, uint16 facts) {
        uint256 nat0 = user.balance;
        uint256 tok0 = IERC20R(t).balanceOf(user);
        vm.prank(user, user);
        try router.buyETH{value: 1 ether}(address(factory), t, 0, mode, user, block.timestamp) {
            revert("buy not blocked");
        } catch (bytes memory err) {
            (bytes4 sel, bytes memory rest) = _strip(err);
            assertTrue(sel == ExitProofRouter.Blocked.selector, "not Blocked");
            (reason, facts) = abi.decode(rest, (uint8, uint16));
        }
        assertEq(user.balance, nat0, "deny moved native");
        assertEq(IERC20R(t).balanceOf(user), tok0, "deny moved token");
    }

    function _expectBadEval(ExitProofRouter r_, address t, uint8 mode) internal {
        vm.prank(user, user);
        vm.expectRevert(ExitProofRouter.BadEval.selector);
        r_.buyETH{value: 1 ether}(address(factory), t, 0, mode, user, block.timestamp);
        vm.prank(user, user);
        vm.expectRevert(ExitProofRouter.BadEval.selector);
        r_.inspect{value: 1 ether}(address(factory), address(wokb), 1 ether, t, mode);
    }

    function _reservesOf(address pair, address t) internal view returns (uint256 rT, uint256 rW) {
        (uint112 r0, uint112 r1,) = MockV2Pair(pair).getReserves();
        (rT, rW) = MockV2Pair(pair).token0() == t ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
    }

    /// @dev Honest post-buy reserves for a 1 OKB buy (what the router uses as the sell-tax baseline).
    function _honestPostBuy(address pair, address t) internal view returns (uint256 rT, uint256 rW, uint256 e) {
        (rT, rW) = _reservesOf(pair, t);
        uint256 net = 1 ether - 1 ether * ROUTER_FEE / 10_000;
        e = Spec.out(net, rW, rT, POOL_FEE);
        rT -= e;
        rW += net;
    }

    /// @dev The seller's REAL tokenIn shortfall vs a tax-free sale of `held` at the honest post-buy price, floored bps.
    function _realLossBps(address pair, address t, uint256 held, uint256 sellOut) internal view returns (uint256) {
        (uint256 rT, uint256 rW,) = _honestPostBuy(pair, t);
        uint256 fair = Spec.out(held, rT, rW, POOL_FEE);
        return sellOut >= fair ? 0 : (fair - sellOut) * 10_000 / fair;
    }

    // ================================================================== F-01 delivery hop

    /// @notice PoC test_F01_deliverySkim_allowed_in_strict_buyer_gets_1_percent: now the hop is measured at the buyer,
    ///         the check reports what the buyer gets, and the buy is denied with buy-tax bucket 3 in every mode.
    function test_F01_deliverySkim_blocked_bucket3() public {
        (address t,) = _launch(type(DeliverySkim).creationCode, "");
        _attestClean(t);
        for (uint8 mode = 0; mode < 3; mode++) {
            Rep memory r = _inspect(t, mode);
            assertFalse(r.allow, "check denies");
            assertEq(r.reason, 3, "reason 3 (buy tax)");
            assertEq(_f(r.facts, 0, 1), 1, "the sale itself works");
            assertEq(_f(r.facts, 1, 2), 0, "sell tax 0");
            assertEq(_f(r.facts, 3, 2), 3, "buy tax bucket 3");
            assertEq(r.delivered, r.buyOut / 100, "Report.delivered = what the buyer would get");
            (uint8 reason, uint16 facts) = _blocked(t, mode);
            assertEq(reason, 3);
            assertEq(_f(facts, 3, 2), 3);
        }
        assertEq(IERC20R(t).balanceOf(address(router)), 0, "nothing stuck in the router");
    }

    /// @notice minOut is checked on the delivered amount, and inspect reports exactly that amount.
    function test_F01_minOut_on_delivered_and_report_matches() public {
        FeeToken t = new FeeToken(1_000_000e18, 500); // 5% on every transfer, incl. router -> buyer
        _list(address(t), false);
        Rep memory r = _inspect(address(t), PERMISSIVE);
        assertTrue(r.allow);
        assertLt(r.delivered, r.buyOut, "delivery hop is taxed");
        assertApproxEqRel(r.delivered, r.buyOut * 95 / 100, 1e12);
        vm.prank(user, user);
        vm.expectRevert(ExitProofRouter.TooLittle.selector);
        router.buyETH{value: 1 ether}(address(factory), address(t), r.delivered + 1, PERMISSIVE, user, block.timestamp);
        vm.prank(user, user);
        uint256 out =
            router.buyETH{value: 1 ether}(address(factory), address(t), r.delivered, PERMISSIVE, user, block.timestamp);
        assertEq(out, r.delivered, "buy returns what inspect reported");
        assertEq(t.balanceOf(user), out);
    }

    /// @notice The pair can never be the buyer (the delivery would be a donation into the pool).
    function test_F01_to_pair_rejected() public {
        CleanToken t = new CleanToken(1_000_000e18);
        address pair = _list(address(t), false);
        vm.prank(user);
        vm.expectRevert(ExitProofRouter.BadTo.selector);
        router.buyETH{value: 1 ether}(address(factory), address(t), 0, PERMISSIVE, pair, block.timestamp);
    }

    // ================================================================== F-02 + C spender-initiated, code-less holder

    /// @notice PoC test_F02_transferFromTrap_passes_strict_user_cannot_sell_via_dex_router: now Blocked(1) even in
    ///         strict with a clean attestation; and the user really cannot sell via a router.
    function test_F02_transferFromTrap_blocked_reason1() public {
        (address t, address pair) = _launch(type(TransferFromTrap).creationCode, "");
        _attestClean(t);
        for (uint8 mode = 0; mode < 3; mode++) {
            (uint8 reason, uint16 facts) = _blocked(t, mode);
            assertEq(reason, 1);
            assertEq(_f(facts, 0, 1), 0, "sellOk 0");
        }
        // ground truth: a holder cannot sell through a DEX router
        require(IERC20R(t).transfer(user, 1000e18), "fund");
        vm.startPrank(user, user);
        IERC20R(t).approve(address(dex), type(uint256).max);
        vm.expectRevert(bytes("TransferHelper: TRANSFER_FROM_FAILED"));
        dex.sellPull(t, pair, 1000e18);
        vm.stopPrank();
    }

    function test_F02_approveNoop_blocked_reason1() public {
        (address t,) = _launch(type(ApproveNoop).creationCode, "");
        _attestClean(t);
        (uint8 reason,) = _blocked(t, PERMISSIVE);
        assertEq(reason, 1);
    }

    /// @notice Mitigation C: an "only code-less sellers" token passes (the old holder had runtime code and failed),
    ///         and the buyer then really sells through a router.
    function test_C_codelessHolder_passes_eoaOnly_rule() public {
        (address t, address pair) = _launch(type(EoaOnlySeller).creationCode, "");
        _attestClean(t);
        Rep memory r = _inspect(t, STRICT);
        assertTrue(r.allow, "code-less holder looks like a wallet");
        uint256 out = _buy(t, STRICT);
        assertEq(out, r.delivered);
        vm.startPrank(user, user);
        IERC20R(t).approve(address(dex), type(uint256).max);
        uint256 got = dex.sellSupportingFee(t, pair, out);
        vm.stopPrank();
        assertGt(got, 0, "the buyer sells for real");
        assertApproxEqRel(got, r.sellOut, 1e15, "probe sellOut ~ the real sale");
    }

    // ================================================================== F-06 registry keyed by token address

    function _launchCfg(uint256 sellUntil) internal returns (address token, address pair) {
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        pair = factory.createPair(predicted, address(wokb));
        token = address(new StorageConfigured(pair, LIQ_TOKEN, sellUntil));
        require(token == predicted, "predict");
        wokb.deposit{value: LIQ_WOKB}();
        require(wokb.transfer(pair, LIQ_WOKB), "seed");
        MockV2Pair(pair).mint(address(this));
    }

    /// @notice PoC test_F06_codehash_attestation_reused_by_differently_configured_instance: B shares A's codehash but
    ///         is unscanned, so strict blocks it (reason 6) while A stays allowed.
    function test_F06_attestation_not_reused_by_other_instance() public {
        (address a,) = _launchCfg(type(uint256).max);
        _attestClean(a);
        (address b,) = _launchCfg(block.timestamp + 600);
        assertEq(a.codehash, b.codehash);
        assertGt(_buy(a, STRICT), 0, "attested instance allowed");
        (uint8 reason, uint16 facts) = _blocked(b, STRICT);
        assertEq(reason, 6, "other instance is unscanned");
        assertEq(_f(facts, 8, 1), 1);
    }

    /// @notice Poisoning: a bad attestation of another instance does not touch this one.
    function test_F06_poisoning_other_instance_has_no_effect() public {
        (address a,) = _launchCfg(type(uint256).max);
        (address b,) = _launchCfg(type(uint256).max);
        _attestClean(a);
        reg.attest(b, b.codehash, RiskRegistry.Flags(true, true, true, true, true, 4), "poison");
        assertGt(_buy(a, STRICT), 0, "A unaffected");
        (uint8 reason,) = _blocked(b, BALANCED);
        assertEq(reason, 4, "B carries its own flags");
    }

    /// @notice An attestation for a different codehash than the token's is ignored: unscanned, on-chain scan used.
    function test_F06_codehash_mismatch_is_unscanned() public {
        CleanToken t = new CleanToken(1_000_000e18);
        _list(address(t), false);
        reg.attest(address(t), keccak256("not the code"), RiskRegistry.Flags(true, false, false, false, false, 4), "x");
        (uint8 reason, uint16 facts) = _blocked(address(t), STRICT);
        assertEq(reason, 6);
        assertEq(_f(facts, 8, 1), 1, "unscanned");
        _attestClean(address(t));
        assertGt(_buy(address(t), STRICT), 0, "matching codehash: scanned");
    }

    /// @notice Code changed after attestation (same address, new code): the stale clean entry no longer counts.
    function test_F06_code_changed_after_attestation_is_unscanned() public {
        CleanToken t = new CleanToken(1_000_000e18);
        _list(address(t), false);
        _attestClean(address(t));
        assertGt(_buy(address(t), STRICT), 0);
        // same storage layout (BaseToken), different runtime code that contains a DELEGATECALL
        vm.etch(address(t), address(new ScanFalsePositiveToken(1)).code);
        (uint8 reason, uint16 facts) = _blocked(address(t), BALANCED);
        assertEq(reason, 4, "on-chain scan sees the DELEGATECALL");
        assertEq(_f(facts, 8, 1), 1, "unscanned");
        assertEq(_f(facts, 6, 1), 1, "upgradeable");
    }

    // ================================================================== F-07 EIP-7702 delegated account as token

    /// @notice PoC test_F07_eip7702_token_not_upgradeable_onchain_then_redelegated: now upgradeable on chain, so
    ///         balanced (and strict) block it with reason 4; permissive still allows it (spec: permissive = base).
    function test_F07_eip7702_token_upgradeable() public {
        vm.setEvmVersion("prague");
        address tokenEoa = makeAddr("attackerEOA");
        address implA = address(0x1111111111111111111111111111111111111111);
        address implB = address(0x2222222222222222222222222222222222222222);
        vm.etch(implA, address(new DelegTokenA()).code);
        vm.etch(implB, address(new DelegTokenB()).code);
        vm.etch(tokenEoa, abi.encodePacked(hex"ef0100", implA));
        assertEq(tokenEoa.code.length, 23);
        address pair = factory.createPair(tokenEoa, address(wokb));
        vm.prank(tokenEoa);
        DelegTokenA(tokenEoa).init(pair, 100_000e18);
        wokb.deposit{value: 100 ether}();
        require(wokb.transfer(pair, 100 ether), "seed");
        MockV2Pair(pair).mint(address(this));

        (uint8 reason, uint16 facts) = _blocked(tokenEoa, BALANCED);
        assertEq(reason, 4);
        assertEq(_f(facts, 6, 1), 1, "upgradeable");
        assertEq(_f(facts, 7, 1), 0, "no selfdestruct read from the designator");
        (reason,) = _blocked(tokenEoa, STRICT);
        assertEq(reason, 4);
        // the reason it matters: one re-delegation traps every holder
        uint256 out = _buy(tokenEoa, PERMISSIVE);
        assertEq(router.scanCache(tokenEoa.codehash), 0x81, "cached: delegatecall only");
        vm.etch(tokenEoa, abi.encodePacked(hex"ef0100", implB));
        vm.prank(user, user);
        vm.expectRevert(bytes("rugged"));
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        DelegTokenA(tokenEoa).transfer(pair, out);
    }

    // ================================================================== F-10 eval backstop

    /// @notice A lying processor that always answers "allow": the router still refuses anything that fails the base
    ///         (sellOk, sell tax <= 1, buy tax <= 1) with BadEval, in buys and in inspect.
    function test_F10_lyingProcessor_cannot_allow_base_failures() public {
        ExitProofRouter liar = _router(address(new FixedProcessor(hex"01")));
        BlacklistOnBuy bl = new BlacklistOnBuy(1_000_000e18);
        _list(address(bl), true);
        _expectBadEval(liar, address(bl), PERMISSIVE); // sellOk = 0
        SellTax99 st = new SellTax99(1_000_000e18);
        _list(address(st), true);
        _expectBadEval(liar, address(st), PERMISSIVE); // sell tax bucket 3
        FeeToken ft = new FeeToken(1_000_000e18, 800);
        _list(address(ft), false);
        _expectBadEval(liar, address(ft), PERMISSIVE); // buy tax bucket 2
        (address skim,) = _launch(type(DeliverySkim).creationCode, "");
        _expectBadEval(liar, skim, PERMISSIVE); // buy tax bucket 3 (delivery hop)
        (address tf,) = _launch(type(TransferFromTrap).creationCode, "");
        _expectBadEval(liar, tf, STRICT); // transferFrom trap
    }

    /// @notice The backstop is the base only: a lying "allow" on a sellable, low-tax token goes through (it bounds an
    ///         `eval` upgrade's damage to mode/owner/upgradeable checks), and an honest/lying deny always blocks.
    function test_F10_backstop_bounds() public {
        CleanToken t = new CleanToken(1_000_000e18);
        _list(address(t), false);
        ExitProofRouter liar = _router(address(new FixedProcessor(hex"01")));
        vm.prank(user, user);
        assertGt(liar.buyETH{value: 1 ether}(address(factory), address(t), 0, STRICT, user, block.timestamp), 0);
        // a deny can never become an allow
        ExitProofRouter denier = _router(address(new FixedProcessor(hex"0e")));
        vm.prank(user, user);
        try denier.buyETH{value: 1 ether}(address(factory), address(t), 0, PERMISSIVE, user, block.timestamp) {
            revert("deny became allow");
        } catch (bytes memory err) {
            (bytes4 sel,) = _strip(err);
            assertTrue(sel == ExitProofRouter.Blocked.selector);
        }
    }

    // ================================================================== Flap-style swap-back inside the sell

    function _flap(uint256 pending, uint256 threshold) internal returns (address t, address pair) {
        (t, pair) = _launch(type(SwapBackTaxToken).creationCode, abi.encode(300, pending, threshold, taxWallet));
    }

    /// @notice Functional audit F2: the token swaps its collected tax inside the seller's transfer, which moves the
    ///         reserves. The probe now prices the swap on the post-transfer reserves (like PotatoSwap's router) and
    ///         the token is allowed in permissive; the sell bucket includes the swap-back's real price impact.
    function test_Flap_swapBack_allowed_and_sellable() public {
        (address t, address pair) = _flap(1_000e18, 1e18); // 1% of the pool's tokens waiting to be liquidated
        (address q,) = _flap(1_000e18, type(uint256).max); // same token, never swaps back (control)
        Rep memory r = _inspect(t, PERMISSIVE);
        Rep memory c = _inspect(q, PERMISSIVE);
        assertTrue(r.allow, "allowed in permissive");
        assertEq(_f(r.facts, 0, 1), 1, "sellOk");
        assertLe(_f(r.facts, 1, 2), 1, "sell tax bucket <= 1");
        assertEq(_f(r.facts, 3, 2), 0, "buy tax 3% -> bucket 0");
        assertLt(r.sellOut, c.sellOut, "the swap-back ran in front of the probe sale (price impact)");
        assertTrue(c.allow);
        // a real buy, then a real sale through a supporting-fee router (which triggers the swap-back for real)
        uint256 out = _buy(t, PERMISSIVE);
        assertEq(out, r.delivered);
        vm.startPrank(user, user);
        IERC20R(t).approve(address(dex), type(uint256).max);
        uint256 got = dex.sellSupportingFee(t, pair, out);
        vm.stopPrank();
        assertEq(SwapBackTaxToken(t).swapBacks(), 1, "the real sale swapped back");
        assertApproxEqRel(got, r.sellOut, 1e15, "probe sellOut ~ the real sale");
    }

    /// @notice A large liquidation dumped in front of the seller is a real loss for that seller and counts as such.
    function test_Flap_bigSwapBack_counts_as_sell_loss() public {
        (address t, address pair) = _flap(40_000e18, 1e18); // 40% of the pool's tokens dumped in front of the sale
        Rep memory r = _inspect(t, PERMISSIVE);
        assertEq(_f(r.facts, 0, 1), 1, "still sellable");
        assertGe(_f(r.facts, 1, 2), 2, "the dump in front is >15% of the proceeds");
        assertFalse(r.allow);
        assertEq(r.reason, 2);
        assertGe(_f(r.facts, 1, 2), Spec.bucketOfBps(_realLossBps(pair, t, r.buyOut, r.sellOut)));
    }

    // ================================================================== reserve-manipulation attempts

    function _gamer(uint8 kind, uint256 param) internal returns (address t, address pair) {
        (t, pair) = _launch(type(ReserveGamer).creationCode, abi.encode(kind, param, taxWallet));
    }

    /// @dev Core claim: the sell bucket is never below the bucket of the seller's REAL tokenIn shortfall vs a tax-free
    ///      sale at the honest post-buy price.
    function _assertNotUnderReported(address t, address pair) internal returns (Rep memory r) {
        uint256 snap = vm.snapshotState();
        r = _inspect(t, PERMISSIVE);
        vm.revertToState(snap);
        if (_f(r.facts, 0, 1) == 1) {
            uint256 loss = _realLossBps(pair, t, r.buyOut, r.sellOut);
            assertGe(_f(r.facts, 1, 2), Spec.bucketOfBps(loss), "sell bucket under-reports the real loss");
        }
    }

    /// @notice 0% transfer tax, but a mint-and-sync crashes the price in front of the seller. Pricing the tax on the
    ///         post-transfer reserves would read 0% here; the pre-transfer baseline reads the real loss.
    function test_gamer_dumpInFront_mintAndSync_not_lower_bucket() public {
        (address t, address pair) = _gamer(1, 3); // pool tokens x4 just before the seller's tokens arrive
        Rep memory r = _assertNotUnderReported(t, pair);
        assertEq(_f(r.facts, 0, 1), 1, "sale works");
        assertEq(_f(r.facts, 1, 2), 3, "bucket 3");
        assertEq(r.reason, 2);
        // what a post-transfer token-equivalent would have reported: ~0% (the gamed number)
        (uint256 rT, uint256 rW,) = _honestPostBuy(pair, t);
        uint256 rTpost = rT * 4;
        uint256 naive = Spec.bucket(r.buyOut, Spec.amountIn(r.sellOut, rTpost, rW, POOL_FEE));
        assertEq(naive, 0, "post-transfer pricing of the tax would have been gamed to bucket 0");
    }

    /// @notice 60% sell tax, then sync() so the pair absorbs the input as reserve: nothing left to swap, fail closed.
    function test_gamer_taxThenSync_failsClosed() public {
        (address t, address pair) = _gamer(2, 6000);
        Rep memory r = _assertNotUnderReported(t, pair);
        assertEq(r.reason, 1);
        assertEq(_f(r.facts, 1, 2), 3);
    }

    /// @notice 60% sell tax, then skim() takes the input back out: fail closed.
    function test_gamer_taxThenSkim_failsClosed() public {
        (address t, address pair) = _gamer(3, 6000);
        Rep memory r = _assertNotUnderReported(t, pair);
        assertEq(r.reason, 1);
    }

    /// @notice Donation into the pair during the buy hop (the pair's own post-swap sync bakes a crashed price into the
    ///         post-buy reserves). The baseline is computed from the pre-buy reserves, so the crash counts.
    function test_gamer_buyHopDonor_not_lower_bucket() public {
        (address t, address pair) = _gamer(4, 3);
        Rep memory r = _assertNotUnderReported(t, pair);
        assertEq(_f(r.facts, 3, 2), 0, "the buyer received the full amount");
        assertEq(_f(r.facts, 1, 2), 3, "the crash is a sell-side loss");
        assertFalse(r.allow);
    }

    /// @notice 60% sell tax plus a price pump paid out of the pool: the bucket follows the seller's real proceeds,
    ///         never below them. (A token can lower the bucket only by paying the seller real tokenIn.)
    function test_gamer_taxPlusPump_tracks_real_proceeds() public {
        (address t, address pair) = _gamer(5, 6000);
        Rep memory r = _assertNotUnderReported(t, pair);
        assertEq(_f(r.facts, 0, 1), 1);
        assertGe(_f(r.facts, 1, 2), 2, "0.4 x 2 = 80% of fair: still bucket 2");
    }

    /// @notice Every attempt, random strength: never under-reports the real loss.
    /// forge-config: default.fuzz.runs = 300
    function testFuzz_gamer_never_underReports(uint8 kind, uint256 param) public {
        kind = uint8(bound(kind, 1, 5));
        param = (kind == 1 || kind == 4) ? bound(param, 0, 8) : bound(param, 0, 10_000);
        (address t, address pair) = _gamer(kind, param);
        _assertNotUnderReported(t, pair);
    }
}
