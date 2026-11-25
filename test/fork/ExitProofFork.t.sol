// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ExitProofRouter} from "../../contracts/ExitProofRouter.sol";
import {RiskRegistry} from "../../contracts/RiskRegistry.sol";
import {MockV2Factory, MockV2Pair} from "../mocks/V2.sol";
import {
    XLayer,
    ITapeOutFactory,
    ITapeOutProcessor,
    ITransistors,
    IERC20Min,
    IV2PairFull,
    TapeOut
} from "../../script/lib/TapeOut.sol";
import {IWOKB} from "../../contracts/interfaces/IWOKB.sol";
import {IV2Factory} from "../../contracts/interfaces/IV2Factory.sol";
import "../fixtures/Tokens.sol";

interface IPotatoPair {
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

interface IERC20F {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

/// @notice ExitProof on an X Layer mainnet fork with the REAL TapeOut factory/processor (our own processor is created,
///         54 NAND minted, the policy netlist taped out) and the REAL PotatoSwap V2 factory (real pairs per fixture).
///         Mirrors the verdicts of test/ExitProofRouter.t.sol.
/// @dev Skipped unless XLAYER_RPC is set, so the default `forge test` stays offline:
///      XLAYER_RPC=https://rpc.xlayer.tech forge test --match-path 'test/fork/*' -vv
contract ExitProofForkTest is Test {
    /// Pinned for reproducibility (X Layer mainnet, 2026-11-25).
    uint256 constant FORK_BLOCK = 76_861_306;

    uint256 constant SUPPLY = 1_000_000e18;
    uint256 constant LIQ_TOKEN = 100_000e18;
    uint256 constant LIQ_WOKB = 100e18;
    uint8 constant STRICT = 0;
    uint8 constant BALANCED = 1;
    uint8 constant PERMISSIVE = 2;

    ITapeOutProcessor proc;
    ITransistors transistors;
    uint256 circuitId;
    uint256 bemSpent;
    RiskRegistry reg;
    IWOKB wokb = IWOKB(XLayer.WOKB);
    IV2Factory factory = IV2Factory(XLayer.POTATO_FACTORY);
    ExitProofRouter router;
    address author = makeAddr("tapeoutAuthor");
    address feeTo = makeAddr("feeTo");
    address user = makeAddr("user");

    struct Rep {
        uint16 facts;
        bool allow;
        uint8 reason;
        uint256 buyOut;
        uint256 sellOut;
        uint256 delivered;
    }

    function setUp() public {
        string memory rpc = vm.envOr("XLAYER_RPC", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc, FORK_BLOCK);
        _tapeOut();
        reg = new RiskRegistry();
        reg.setAttester(address(this), true);
        address[] memory fs = new address[](1);
        fs[0] = XLayer.POTATO_FACTORY;
        uint16[] memory fb = new uint16[](1);
        fb[0] = XLayer.POTATO_FEE_BPS;
        router = new ExitProofRouter(address(proc), circuitId, address(reg), XLayer.WOKB, feeTo, 10, fs, fb);
        vm.deal(user, 1000 ether);
        vm.deal(address(this), 10_000 ether);
    }

    // ------------------------------------------------------------------ real TapeOut flow

    /// @dev createCPU (BEM deployFee via approve) -> mint NAND (BEM protocolFee via approve, mintPrice in OKB)
    ///      -> tapeout(netlist, 11, 4) paying TAPEOUT_FEE in OKB. All as a plain EOA.
    function _tapeOut() internal {
        string memory j = vm.readFile("circuit/netlist.json");
        bytes memory nl = vm.parseJsonBytes(j, ".netlist");
        uint256 gates = vm.parseJsonUint(j, ".gates");
        ITapeOutFactory f = ITapeOutFactory(XLayer.TAPEOUT_FACTORY);
        IERC20Min bem = IERC20Min(XLayer.BEM);

        deal(XLayer.BEM, author, 1e8); // 1 BEM
        vm.deal(author, 1 ether);
        uint256 bem0 = bem.balanceOf(author);
        vm.startPrank(author, author);

        bem.approve(address(f), f.deployFee());
        (address a, address b) = f.createCPU(
            "ExitProof Guard Fork",
            "EXITPF",
            "ExitProof: a buy router that only lets you buy what it just proved you can sell.",
            10_000,
            0
        );
        address p;
        address t;
        (p, t) = TapeOut.processorOf(a, b);
        proc = ITapeOutProcessor(p);
        transistors = ITransistors(t);
        assertTrue(f.isCPU(p), "isCPU");

        bem.approve(t, transistors.protocolFee());
        transistors.mint{value: transistors.mintPrice() * gates}(XLayer.NAND, gates);
        assertEq(transistors.balanceOf(author, XLayer.NAND), gates, "NAND minted");

        circuitId = proc.tapeout{value: proc.TAPEOUT_FEE()}(nl, 11, 4);
        vm.stopPrank();
        bemSpent = bem0 - bem.balanceOf(author);
        assertEq(transistors.balanceOf(author, XLayer.NAND), 0, "NAND consumed");
    }

    function test_fork_tapeout_netlist_and_info() public {
        string memory j = vm.readFile("circuit/netlist.json");
        assertEq(keccak256(proc.netlist(circuitId)), keccak256(vm.parseJsonBytes(j, ".netlist")), "netlist bytes");
        (uint32 nIn, uint32 nOut, uint32 nState, uint32 g) = proc.circuitInfo(circuitId);
        assertEq(nIn, 11);
        assertEq(nOut, 4);
        assertEq(nState, 0);
        assertEq(g, vm.parseJsonUint(j, ".gates"));
        assertEq(proc.ownerOf(circuitId), author, "circuit NFT owner");
        emit log_named_address("processor", address(proc));
        emit log_named_address("transistors", address(transistors));
        emit log_named_uint("circuitId", circuitId);
        emit log_named_uint("BEM spent (1e-8)", bemSpent);
        emit log_named_uint("TAPEOUT_FEE (wei)", proc.TAPEOUT_FEE());
    }

    /// @notice The REAL taped-out circuit equals spec.py (truth.json) on all 2048 inputs.
    function test_fork_eval_matches_truth_all_2048() public {
        uint256[] memory truth = abi.decode(vm.parseJson(vm.readFile("circuit/truth.json")), (uint256[]));
        assertEq(truth.length, 2048);
        uint256 g = gasleft();
        for (uint256 x = 0; x < 2048; x++) {
            bytes memory o = proc.eval(circuitId, TapeOut.input(x));
            assertEq(o.length, 1, "1 output byte");
            assertEq(uint256(uint8(o[0])), truth[x], "real circuit != spec");
        }
        emit log_named_uint("2048 evals: avg gas per eval", (g - gasleft()) / 2048);
    }

    // ------------------------------------------------------------------ helpers

    function _list(address t, bool pairAware) internal returns (address pair) {
        pair = factory.createPair(t, address(wokb));
        if (pairAware) PairAware(t).initPair(pair);
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        IERC20F(t).transfer(pair, LIQ_TOKEN);
        wokb.deposit{value: LIQ_WOKB}();
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        wokb.transfer(pair, LIQ_WOKB);
        IV2PairFull(pair).mint(address(this));
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
        assertEq(IERC20F(t).balanceOf(address(router)), 0, "token dust");
        assertEq(wokb.balanceOf(address(router)), 0, "wokb dust");
        assertEq(address(router).balance, 0, "native dust");
    }

    // ------------------------------------------------------------------ verdicts (mirror of the unit suite)

    function test_fork_clean_permissive_allows() public {
        CleanToken t = new CleanToken(SUPPLY);
        _list(address(t), false);
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

    function test_fork_clean_strict_blocks_unscanned() public {
        CleanToken t = new CleanToken(SUPPLY);
        _list(address(t), false);
        (uint8 reason,) = _blocked(address(t), 1 ether, STRICT);
        assertEq(reason, 6);
        _attest(address(t), false, false, false);
        assertGt(_buy(address(t), 1 ether, STRICT), 0);
        _assertNoDust(address(t));
    }

    function test_fork_blacklist_blocked_reason1() public {
        BlacklistOnBuy t = new BlacklistOnBuy(SUPPLY);
        _list(address(t), true);
        (uint8 reason, uint16 facts) = _blocked(address(t), 1 ether, PERMISSIVE);
        assertEq(reason, 1);
        assertEq(_f(facts, 0, 1), 0);
        assertEq(_f(facts, 1, 2), 3);
        assertEq(user.balance, 1000 ether, "money never moved");
    }

    function test_fork_sellTax99_blocked_reason2() public {
        SellTax99 t = new SellTax99(SUPPLY);
        _list(address(t), true);
        (uint8 reason, uint16 facts) = _blocked(address(t), 1 ether, PERMISSIVE);
        assertEq(reason, 2);
        assertEq(_f(facts, 0, 1), 1);
        assertEq(_f(facts, 1, 2), 3);
        assertEq(_f(facts, 3, 2), 0);
    }

    function test_fork_maxTx_blocked_reason1() public {
        MaxTxToken t = new MaxTxToken(SUPPLY);
        _list(address(t), true);
        assertTrue(_inspect(address(t), 1 ether, PERMISSIVE).allow);
        Rep memory r = _inspect(address(t), 20 ether, PERMISSIVE);
        assertGt(r.buyOut, SUPPLY / 100);
        (uint8 reason,) = _blocked(address(t), 20 ether, PERMISSIVE);
        assertEq(reason, 1);
    }

    function test_fork_cooldown_blocked_reason1() public {
        CooldownToken t = new CooldownToken(SUPPLY);
        _list(address(t), true);
        (uint8 reason,) = _blocked(address(t), 1 ether, PERMISSIVE);
        assertEq(reason, 1);
    }

    function test_fork_tradingDisabled_blocked_reason1() public {
        TradingDisabled t = new TradingDisabled(SUPPLY);
        _list(address(t), true);
        (uint8 reason, uint16 facts) = _blocked(address(t), 1 ether, PERMISSIVE);
        assertEq(reason, 1);
        assertEq(_f(facts, 5, 1), 1, "owner active");
        t.enableTrading();
        assertGt(_buy(address(t), 1 ether, PERMISSIVE), 0);
    }

    function test_fork_timeBomb_balanced() public {
        TimeBombToken t = new TimeBombToken(SUPPLY);
        _list(address(t), true);
        (uint8 reason,) = _blocked(address(t), 1 ether, BALANCED);
        assertEq(reason, 6);
        _attest(address(t), true, false, true);
        uint16 facts;
        (reason, facts) = _blocked(address(t), 1 ether, BALANCED);
        assertEq(reason, 5);
        assertEq(_f(facts, 5, 1), 1);
        assertEq(_f(facts, 7, 1), 1);
        assertEq(_f(facts, 8, 1), 0);
        assertGt(_buy(address(t), 1 ether, PERMISSIVE), 0);
    }

    function test_fork_proxy_balanced_reason4() public {
        ProxyImpl impl = new ProxyImpl();
        ProxyToken p = new ProxyToken(address(impl), abi.encodeCall(ProxyImpl.initialize, (SUPPLY, address(this))));
        _list(address(p), false);
        (uint8 reason, uint16 facts) = _blocked(address(p), 1 ether, BALANCED);
        assertEq(reason, 4);
        assertEq(_f(facts, 6, 1), 1);
        assertEq(_f(facts, 8, 1), 1);
        assertEq(_f(facts, 7, 1), 0);
    }

    function test_fork_scan_falsePositive_cleared_by_registry() public {
        ScanFalsePositiveToken t = new ScanFalsePositiveToken(SUPPLY);
        _list(address(t), false);
        (uint8 reason, uint16 facts) = _blocked(address(t), 1 ether, BALANCED);
        assertEq(reason, 4);
        assertEq(_f(facts, 6, 1), 1);
        _attest(address(t), false, false, false);
        assertGt(_buy(address(t), 1 ether, BALANCED), 0);
        assertTrue(_inspect(address(t), 1 ether, STRICT).allow);
    }

    function test_fork_registry_upgradeable_authoritative() public {
        CleanToken t = new CleanToken(SUPPLY);
        _list(address(t), false);
        _attest(address(t), false, true, false);
        (uint8 reason, uint16 facts) = _blocked(address(t), 1 ether, BALANCED);
        assertEq(reason, 4);
        assertEq(_f(facts, 6, 1), 1);
    }

    function test_fork_buy_feeOnTransfer_5pct_bucket1() public {
        FeeToken t = new FeeToken(SUPPLY, 500);
        _list(address(t), false);
        Rep memory r = _inspect(address(t), 1 ether, PERMISSIVE);
        assertTrue(r.allow);
        assertEq(_f(r.facts, 3, 2), 1, "buyTax bucket 1");
        assertEq(_f(r.facts, 1, 2), 1, "sellTax bucket 1");
        uint256 out = _buy(address(t), 1 ether, PERMISSIVE);
        assertEq(t.balanceOf(user), out);
        assertApproxEqRel(out, r.buyOut * 95 / 100, 1e12);
        _assertNoDust(address(t));
        (uint8 reason,) = _blocked(address(t), 1 ether, STRICT);
        assertEq(reason, 2);
    }

    function test_fork_feeOnTransfer_8pct_buy_crosses_15pct() public {
        FeeToken t = new FeeToken(SUPPLY, 800);
        _list(address(t), false);
        Rep memory r = _inspect(address(t), 1 ether, PERMISSIVE);
        assertEq(_f(r.facts, 0, 1), 1);
        assertEq(_f(r.facts, 3, 2), 2);
        assertEq(_f(r.facts, 1, 2), 1);
        (uint8 reason,) = _blocked(address(t), 1 ether, PERMISSIVE);
        assertEq(reason, 3);
    }

    function test_fork_txOriginTrap_known_limitation() public {
        TxOriginTrap t = new TxOriginTrap(SUPPLY);
        address pair = _list(address(t), true);
        vm.startPrank(user, user);
        uint256 out = router.buyETH{value: 1 ether}(address(factory), address(t), 0, PERMISSIVE, user, block.timestamp);
        assertGt(out, 0, "probe passes: documented limitation");
        vm.roll(block.number + 1);
        vm.expectRevert(bytes("trapped"));
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        t.transfer(pair, out);
        vm.stopPrank();
    }

    function test_fork_owner_probe_robust() public {
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
            assertEq(_f(r.facts, 5, 1), 0);
            assertGt(_buy(ts[i], 1 ether, PERMISSIVE), 0);
        }
        OwnerGarbageToken g = new OwnerGarbageToken(SUPPLY);
        _list(address(g), false);
        assertEq(_f(_inspect(address(g), 1 ether, PERMISSIVE).facts, 5, 1), 1);
        OwnedCleanToken o = new OwnedCleanToken(SUPPLY);
        _list(address(o), false);
        assertEq(_f(_inspect(address(o), 1 ether, PERMISSIVE).facts, 5, 1), 1);
        o.renounceOwnership();
        assertEq(_f(_inspect(address(o), 1 ether, PERMISSIVE).facts, 5, 1), 0);
        _attest(address(o), true, false, false);
        assertEq(_f(_inspect(address(o), 1 ether, PERMISSIVE).facts, 5, 1), 1);
    }

    function test_fork_probe_gasBomb_blocked() public {
        GasBombToken t = new GasBombToken(SUPPLY);
        _list(address(t), true);
        (uint8 reason, uint16 facts) = _blocked(address(t), 1 ether, PERMISSIVE);
        assertEq(reason, 1);
        assertEq(_f(facts, 0, 1), 0);
    }

    function test_fork_probe_returnBomb_blocked() public {
        ReturnBombToken t = new ReturnBombToken(SUPPLY);
        _list(address(t), true);
        (uint8 reason, uint16 facts) = _blocked(address(t), 1 ether, PERMISSIVE);
        assertEq(reason, 1);
        assertEq(_f(facts, 0, 1), 0);
    }

    function test_fork_probe_cannot_be_forged_by_token() public {
        ForgedProbeToken t = new ForgedProbeToken(SUPPLY);
        _list(address(t), true);
        (uint8 reason, uint16 facts) = _blocked(address(t), 1 ether, PERMISSIVE);
        assertEq(reason, 1);
        assertEq(_f(facts, 0, 1), 0);
    }

    function test_fork_secondHopTrap_blocked_reason1() public {
        SecondHopTrap t = new SecondHopTrap(SUPPLY);
        _list(address(t), true);
        (uint8 reason, uint16 facts) = _blocked(address(t), 1 ether, PERMISSIVE);
        assertEq(reason, 1);
        assertEq(_f(facts, 0, 1), 0);
    }

    function test_fork_lyingBalance_saturates_not_panics() public {
        LyingBalanceToken t = new LyingBalanceToken(SUPPLY);
        _list(address(t), true);
        (uint8 reason, uint16 facts) = _blocked(address(t), 1 ether, PERMISSIVE);
        assertEq(reason, 2);
        assertEq(_f(facts, 1, 2), 3);
    }

    function test_fork_reentrancy_blocked() public {
        ReentrantToken t = new ReentrantToken(SUPPLY);
        _list(address(t), true);
        t.setTarget(address(router), address(factory));
        assertGt(_buy(address(t), 1 ether, PERMISSIVE), 0);
        assertTrue(t.attempted());
        assertFalse(t.reentered());
        _assertNoDust(address(t));
    }

    // ------------------------------------------------------------------ mechanics on real pairs

    function test_fork_no_dust_both_orderings() public {
        address lo = address(uint160(address(wokb)) - 0x1000);
        address hi = address(uint160(address(wokb)) + 0x1000);
        deployCodeTo("Tokens.sol:CleanToken", abi.encode(SUPPLY), lo);
        deployCodeTo("Tokens.sol:CleanToken", abi.encode(SUPPLY), hi);
        address[2] memory ts = [lo, hi];
        for (uint256 i = 0; i < 2; i++) {
            address t = ts[i];
            address pair = _list(t, false);
            assertEq(IV2PairFull(pair).token0() == t, i == 0, "ordering");
            uint256 fee0 = wokb.balanceOf(feeTo);
            assertGt(_buy(t, 1 ether + 7, PERMISSIVE), 0);
            _assertNoDust(t);
            assertEq(wokb.balanceOf(feeTo) - fee0, uint256(1 ether + 7) * 10 / 10000);
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

    function test_fork_rejects_fake_pair() public {
        CleanToken t = new CleanToken(SUPPLY);
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
        vm.prank(user);
        vm.expectRevert(ExitProofRouter.BadPair.selector);
        router.buyETH{value: 1 ether}(address(factory), address(t), 0, PERMISSIVE, user, block.timestamp);
    }

    /// @notice The router's configured 25 bps is exactly PotatoSwap's fee: an output priced at 24 bps breaks K,
    ///         one priced at 25 bps clears it.
    function test_fork_potato_fee_is_25bps() public {
        CleanToken t = new CleanToken(SUPPLY);
        address pair = _list(address(t), false);
        uint256 amtIn = 1 ether;
        wokb.deposit{value: amtIn}();
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        wokb.transfer(pair, amtIn);
        bool tIs0 = IV2PairFull(pair).token0() == address(t);
        (uint112 r0, uint112 r1,) = IV2PairFull(pair).getReserves();
        (uint256 rIn, uint256 rOut) = tIs0 ? (uint256(r1), uint256(r0)) : (uint256(r0), uint256(r1));
        uint256 at24 = _out(amtIn, rIn, rOut, 24);
        uint256 at25 = _out(amtIn, rIn, rOut, 25);
        assertGt(at24, at25);
        (uint256 a0, uint256 a1) = tIs0 ? (at24, uint256(0)) : (uint256(0), at24);
        vm.expectRevert();
        IPotatoPair(pair).swap(a0, a1, address(this), "");
        (a0, a1) = tIs0 ? (at25, uint256(0)) : (uint256(0), at25);
        IPotatoPair(pair).swap(a0, a1, address(this), "");
        assertEq(t.balanceOf(address(this)), SUPPLY - LIQ_TOKEN + at25);
    }

    function _out(uint256 a, uint256 rIn, uint256 rOut, uint256 feeBps) internal pure returns (uint256) {
        uint256 aFee = a * (10_000 - feeBps);
        return aFee * rOut / (rIn * 10_000 + aFee);
    }

    function test_fork_inspect_no_state_change() public {
        CleanToken t = new CleanToken(SUPPLY);
        address pair = _list(address(t), false);
        (uint112 r0, uint112 r1,) = IV2PairFull(pair).getReserves();
        uint256 ub = user.balance;
        Rep memory r = _inspect(address(t), 1 ether, PERMISSIVE);
        assertTrue(r.allow);
        assertLt(r.sellOut, 1 ether, "round trip loses fees");
        (uint112 s0, uint112 s1,) = IV2PairFull(pair).getReserves();
        assertEq(s0, r0);
        assertEq(s1, r1);
        assertEq(user.balance, ub);
        assertEq(wokb.balanceOf(feeTo), 0);
    }

    function test_fork_minOut_enforced() public {
        CleanToken t = new CleanToken(SUPPLY);
        _list(address(t), false);
        Rep memory r = _inspect(address(t), 1 ether, PERMISSIVE);
        vm.prank(user);
        vm.expectRevert(ExitProofRouter.TooLittle.selector);
        router.buyETH{value: 1 ether}(address(factory), address(t), r.buyOut + 1, PERMISSIVE, user, block.timestamp);
        vm.prank(user);
        assertEq(
            router.buyETH{value: 1 ether}(address(factory), address(t), r.buyOut, PERMISSIVE, user, block.timestamp),
            r.buyOut
        );
    }

    function test_fork_gas_firstBuy_vs_cached() public {
        CleanToken t = new CleanToken(SUPPLY);
        _list(address(t), false);
        vm.prank(user);
        uint256 g = gasleft();
        router.buyETH{value: 1 ether}(address(factory), address(t), 0, PERMISSIVE, user, block.timestamp);
        uint256 first = g - gasleft();
        vm.prank(user);
        g = gasleft();
        router.buyETH{value: 1 ether}(address(factory), address(t), 0, PERMISSIVE, user, block.timestamp);
        uint256 cached = g - gasleft();
        emit log_named_uint("fork buyETH clean first-buy gas", first);
        emit log_named_uint("fork buyETH clean cached gas", cached);
        assertLt(cached, first);
    }
}
