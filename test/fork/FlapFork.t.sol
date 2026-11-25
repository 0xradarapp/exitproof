// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ExitProofRouter} from "../../contracts/ExitProofRouter.sol";
import {RiskRegistry} from "../../contracts/RiskRegistry.sol";
import {BytecodeScan} from "../../contracts/lib/BytecodeScan.sol";
import {
    XLayer,
    ITapeOutFactory,
    ITapeOutProcessor,
    ITransistors,
    IERC20Min,
    TapeOut
} from "../../script/lib/TapeOut.sol";

interface IPotatoRouter {
    function swapExactETHForTokensSupportingFeeOnTransferTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable;
    function swapExactTokensForETHSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external;
}

interface IERC20Fl {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

contract ScanProbe {
    function scan(address t) external view returns (bool, bool, bool) {
        return BytecodeScan.scan(t);
    }
}

/// @notice Real-token regression for the functional audit's F2 (fable-functional-audit.md section 3.3): three Flap
///         launchpad tokens (`...7777`) swap their collected tax inside the seller's transfer, which moved the pair's
///         reserves under the old probe ("Potato: K", reason 1 although they sell fine). At the audit's block, with the
///         real TapeOut circuit and the real PotatoSwap pairs, they must now be allowed in permissive, the controls
///         stay allowed and the real honeypots stay blocked. Ground truth: a plain EOA buys and sells through the
///         REAL PotatoSwap router.
/// @dev Skipped unless XLAYER_RPC is set: XLAYER_RPC=https://xlayerrpc.okx.com forge test --match-path 'test/fork/*'
contract FlapForkTest is Test {
    /// The functional audit's block (2026-11-25).
    uint256 constant FORK_BLOCK = 76_871_779;
    address constant POTATO_ROUTER = 0x881fB2f98c13d521009464e7D1CBf16E1b394e8E;
    uint8 constant STRICT = 0;
    uint8 constant BALANCED = 1;
    uint8 constant PERMISSIVE = 2;
    uint256 constant AMT = 0.01 ether;

    // the three false positives
    address constant QIANKUN = 0x5f1f052A6C1430280e403356a1621e99fdcE7777;
    address constant LINGTOUYANG = 0x648367A6F46b0bF727deA950990d0bd479097777;
    address constant POTBOY = 0xF83a3B2980909600daC1a745c4F6eb72472c7777;
    // Flap controls that were already allowed
    address constant YANGSHIDAN = 0x7e97D98e5103dA0F28C03E92A545dDFFED277777;
    address constant O3B = 0xF8C6BC7102894F7AAc1148E231Fd4487Efe37777;
    address constant ASTEROID = 0xe31FA5cB43534cE3Fff606546AeB4bb30f877777;
    // real honeypots in the same sample (router sell reverts)
    address constant OKS = 0xfDd1f2103f566fc4aAb4a8d95b29dEeEc45eD2a5;
    address constant L14 = 0xF79D3f032a786083B5684699E43c9deC9AC229c5;
    address constant L13 = 0xF6DFFb4C478981bF08E69bee85cAe1365EE64761;
    address constant L11 = 0xF4B7cCd63Af9f5382541B62AD77C6E8a4bf48901;

    ITapeOutProcessor proc;
    uint256 circuitId;
    RiskRegistry reg;
    ExitProofRouter router;
    address author = makeAddr("tapeoutAuthor");
    address buyer = makeAddr("flapBuyer");
    address truthEoa = makeAddr("truthEoa");

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
        router = new ExitProofRouter(address(proc), circuitId, address(reg), XLayer.WOKB, makeAddr("feeTo"), 10, fs, fb);
        vm.deal(buyer, 100 ether);
        vm.deal(truthEoa, 100 ether);
    }

    function _tapeOut() internal {
        string memory j = vm.readFile("circuit/netlist.json");
        bytes memory nl = vm.parseJsonBytes(j, ".netlist");
        uint256 gates = vm.parseJsonUint(j, ".gates");
        ITapeOutFactory f = ITapeOutFactory(XLayer.TAPEOUT_FACTORY);
        deal(XLayer.BEM, author, 1e8);
        vm.deal(author, 1 ether);
        vm.startPrank(author, author);
        IERC20Min(XLayer.BEM).approve(address(f), f.deployFee());
        (address a, address b) = f.createCPU("ExitProof Guard Flap", "EXITPFL", "fork regression", 10_000, 0);
        (address p, address t) = TapeOut.processorOf(a, b);
        proc = ITapeOutProcessor(p);
        ITransistors tr = ITransistors(t);
        IERC20Min(XLayer.BEM).approve(t, tr.protocolFee());
        tr.mint{value: tr.mintPrice() * gates}(XLayer.NAND, gates);
        circuitId = proc.tapeout{value: proc.TAPEOUT_FEE()}(nl, 11, 4);
        vm.stopPrank();
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

    function _inspect(address t, uint8 mode) internal returns (Rep memory r) {
        vm.prank(buyer, buyer);
        try router.inspect{value: AMT}(XLayer.POTATO_FACTORY, XLayer.WOKB, AMT, t, mode) {
            revert("inspect returned");
        } catch (bytes memory err) {
            (bytes4 sel, bytes memory rest) = _strip(err);
            assertTrue(sel == ExitProofRouter.Report.selector, "not Report");
            (r.facts, r.allow, r.reason, r.buyOut, r.sellOut, r.delivered) =
                abi.decode(rest, (uint16, bool, uint8, uint256, uint256, uint256));
        }
    }

    function _path(address a, address b) internal pure returns (address[] memory p) {
        p = new address[](2);
        p[0] = a;
        p[1] = b;
    }

    /// @dev Sells `amount` of `t` held by `who` through the real PotatoSwap router. Returns OKB received (0 = failed).
    function _routerSell(address who, address t, uint256 amount) internal returns (uint256 got) {
        vm.startPrank(who, who);
        IERC20Fl(t).approve(POTATO_ROUTER, type(uint256).max);
        uint256 n0 = who.balance;
        try IPotatoRouter(POTATO_ROUTER)
            .swapExactTokensForETHSupportingFeeOnTransferTokens(
                amount, 0, _path(t, XLayer.WOKB), who, block.timestamp
            ) {
            got = who.balance - n0;
        } catch {}
        vm.stopPrank();
    }

    /// @dev Independent ground truth: a plain EOA buys AMT through the real PotatoSwap router, then sells all of it
    ///      back through it. State is rolled back.
    function _truth(address t) internal returns (bool bought, uint256 got) {
        uint256 snap = vm.snapshotState();
        vm.prank(truthEoa, truthEoa);
        try IPotatoRouter(POTATO_ROUTER).swapExactETHForTokensSupportingFeeOnTransferTokens{value: AMT}(
            0, _path(XLayer.WOKB, t), truthEoa, block.timestamp
        ) {
            uint256 bal = IERC20Fl(t).balanceOf(truthEoa);
            bought = bal != 0;
            if (bought) got = _routerSell(truthEoa, t, bal);
        } catch {}
        vm.revertToState(snap);
    }

    function _logRep(string memory name, Rep memory r) internal {
        emit log(string(
                abi.encodePacked(
                    name,
                    ": allow=",
                    r.allow ? "1" : "0",
                    " reason=",
                    vm.toString(r.reason),
                    " sellOk=",
                    vm.toString(_f(r.facts, 0, 1)),
                    " sellTax=",
                    vm.toString(_f(r.facts, 1, 2)),
                    " buyTax=",
                    vm.toString(_f(r.facts, 3, 2)),
                    " sellOut=",
                    vm.toString(r.sellOut),
                    " delivered=",
                    vm.toString(r.delivered)
                )
            ));
    }

    /// @dev permissive allow + the buy through ExitProof succeeds + the delivered position sells through PotatoSwap.
    function _assertAllowedAndSellable(string memory name, address t) internal {
        Rep memory r = _inspect(t, PERMISSIVE);
        _logRep(name, r);
        assertTrue(r.allow, string(abi.encodePacked(name, ": permissive must allow")));
        assertEq(_f(r.facts, 0, 1), 1, "sellOk");
        assertLe(_f(r.facts, 1, 2), 1, "sell tax bucket <= 1");
        assertLe(_f(r.facts, 3, 2), 1, "buy tax bucket <= 1");
        (bool bought, uint256 truthOut) = _truth(t);
        assertTrue(bought && truthOut > 0, "ground truth: an EOA buys and sells via PotatoSwap");
        emit log_named_uint("  ground-truth round trip (bps of AMT)", truthOut * 10_000 / AMT);
        emit log_named_uint("  probe round trip (bps of AMT)", r.sellOut * 10_000 / AMT);

        uint256 snap = vm.snapshotState();
        vm.prank(buyer, buyer);
        uint256 out =
            router.buyETH{value: AMT}(XLayer.POTATO_FACTORY, t, r.delivered, PERMISSIVE, buyer, block.timestamp);
        assertEq(out, r.delivered, "buy delivers what inspect reported");
        assertEq(IERC20Fl(t).balanceOf(buyer), out);
        uint256 sold = _routerSell(buyer, t, out);
        assertGt(sold, 0, "allowed => the buyer really sells through PotatoSwap");
        emit log_named_uint("  ExitProof buy then PotatoSwap sell (bps of AMT)", sold * 10_000 / AMT);
        vm.revertToState(snap);
    }

    function _assertBlockedHoneypot(string memory name, address t) internal {
        Rep memory r = _inspect(t, PERMISSIVE);
        _logRep(name, r);
        assertFalse(r.allow, string(abi.encodePacked(name, ": honeypot must stay blocked")));
        assertEq(r.reason, 1, "reason 1");
        (bool bought, uint256 truthOut) = _truth(t);
        assertTrue(bought, "ground truth: buyable");
        assertEq(truthOut, 0, "ground truth: the EOA cannot sell via PotatoSwap");
        vm.prank(buyer, buyer);
        vm.expectRevert(abi.encodeWithSelector(ExitProofRouter.Blocked.selector, uint8(1), r.facts));
        router.buyETH{value: AMT}(XLayer.POTATO_FACTORY, t, 0, PERMISSIVE, buyer, block.timestamp);
    }

    function test_fork_flap_falsePositives_now_allowed() public {
        _assertAllowedAndSellable("QIANKUN", QIANKUN);
        _assertAllowedAndSellable("LINGTOUYANG", LINGTOUYANG);
        _assertAllowedAndSellable("POTBOY", POTBOY);
    }

    function test_fork_flap_controls_still_allowed() public {
        _assertAllowedAndSellable("YANGSHIDAN", YANGSHIDAN);
        _assertAllowedAndSellable("O3B", O3B);
        _assertAllowedAndSellable("ASTEROID", ASTEROID);
    }

    function test_fork_real_honeypots_still_blocked() public {
        _assertBlockedHoneypot("OKS", OKS);
        _assertBlockedHoneypot("L14", L14);
        _assertBlockedHoneypot("L13", L13);
        _assertBlockedHoneypot("L11", L11);
    }

    /// @notice Unscanned Flap tokens are proxies: balanced/strict block them with reason 4 (documented; an attestation
    ///         of the resolved implementation clears it once the scanner attests the token).
    function test_fork_flap_balanced_reason4_until_attested() public {
        Rep memory r = _inspect(QIANKUN, BALANCED);
        assertEq(r.reason, 4);
        assertEq(_f(r.facts, 8, 1), 1, "unscanned");
        // scanner result for the resolved clone: privileged, not upgradeable, no danger (functional audit 3.5)
        reg.attest(QIANKUN, QIANKUN.codehash, RiskRegistry.Flags(true, true, false, false, false, 5), "fork");
        r = _inspect(QIANKUN, BALANCED);
        assertTrue(r.allow, "attested: balanced allows");
        assertEq(_f(r.facts, 8, 1), 0);
    }

    /// @notice F-07 on the real chain: anvil dev account #0 carries an EIP-7702 delegation designator on X Layer.
    function test_fork_eip7702_designator_is_upgradeable() public {
        address delegated = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
        assertEq(delegated.code.length, 23);
        assertEq(uint24(bytes3(delegated.code)), 0xef0100);
        (bool d, bool s, bool c) = new ScanProbe().scan(delegated);
        assertTrue(d, "delegation designator => delegatecall (upgradeable)");
        assertFalse(s || c);
    }
}
