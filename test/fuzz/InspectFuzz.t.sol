// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {VmSafe} from "forge-std/Vm.sol";
import {FuzzBase, IERC20X} from "./FuzzBase.sol";
import {FuzzTaxToken, HeavyHookToken} from "./FuzzTokens.sol";
import "../fixtures/Tokens.sol";
import {ExitProofRouter} from "../../contracts/ExitProofRouter.sol";
import {MockV2Pair} from "../mocks/V2.sol";

/// @notice `inspect` always reverts and leaves no trace: every storage write and value move inside it is rolled back,
///         balances / reserves / router storage are unchanged, for clean and malicious tokens, any mode byte, both
///         entry flavours (msg.value or pull), with and without approval, right or wrong tokenIn.
contract InspectFuzzTest is FuzzBase {
    address[] internal tokens;
    address[] internal pairs;

    function setUp() public {
        _baseSetUp(ROUTER_FEE);
        _add(address(new FuzzTaxToken(SUPPLY)), true);
        _add(address(new FeeToken(SUPPLY, 500)), false);
        _add(address(new OwnedCleanToken(SUPPLY)), false);
        _add(address(new BlacklistOnBuy(SUPPLY)), true);
        _add(address(new SellTax99(SUPPLY)), true);
        _add(address(new MaxTxToken(SUPPLY)), true);
        _add(address(new CooldownToken(SUPPLY)), true);
        _add(address(new TradingDisabled(SUPPLY)), true);
        _add(address(new TimeBombToken(SUPPLY)), true);
        _add(address(new GasBombToken(SUPPLY)), true);
        _add(address(new ReturnBombToken(SUPPLY)), true);
        _add(address(new ForgedProbeToken(SUPPLY)), true);
        _add(address(new SecondHopTrap(SUPPLY)), true);
        _add(address(new LyingBalanceToken(SUPPLY)), true);
        _add(address(new ScanFalsePositiveToken(SUPPLY)), false);
        ProxyImpl impl = new ProxyImpl();
        _add(
            address(new ProxyToken(address(impl), abi.encodeCall(ProxyImpl.initialize, (SUPPLY, address(this))))),
            false
        );
        ReentrantToken re = new ReentrantToken(SUPPLY);
        _add(address(re), true);
        re.setTarget(address(router), address(factory));
        HeavyHookToken h = new HeavyHookToken(SUPPLY);
        h.setIters(5);
        _add(address(h), false);
        // the user can pay through either entry flavour
        vm.startPrank(user);
        wokb.deposit{value: 1000 ether}();
        vm.stopPrank();
    }

    function _add(address t, bool pairAware) internal {
        tokens.push(t);
        pairs.push(_list(t, pairAware, LIQ_TOKEN, LIQ_WOKB));
    }

    struct Snap {
        uint256 userNative;
        uint256 userWokb;
        uint256 userTok;
        uint256 feeWokb;
        uint256 routerWokb;
        uint256 routerTok;
        uint256 routerNative;
        uint112 r0;
        uint112 r1;
        uint256 pairTok;
        uint256 pairWokb;
        bytes32 lock;
        uint8 scan;
        uint256 allowance;
    }

    function _snap(address t, address pair) internal view returns (Snap memory s) {
        s.userNative = user.balance;
        s.userWokb = wokb.balanceOf(user);
        s.userTok = IERC20X(t).balanceOf(user);
        s.feeWokb = wokb.balanceOf(feeTo);
        s.routerWokb = wokb.balanceOf(address(router));
        s.routerTok = IERC20X(t).balanceOf(address(router));
        s.routerNative = address(router).balance;
        (s.r0, s.r1,) = MockV2Pair(pair).getReserves();
        s.pairTok = IERC20X(t).balanceOf(pair);
        s.pairWokb = wokb.balanceOf(pair);
        s.lock = vm.load(address(router), bytes32(uint256(2)));
        s.scan = router.scanCache(t.codehash);
        s.allowance = wokb.allowance(user, address(router));
    }

    struct Req {
        address t;
        address pair;
        address tokenIn;
        uint256 amt;
        uint8 mode;
        bool useValue;
    }

    function _call(Req memory q) internal returns (bool ok, bytes memory ret, VmSafe.AccountAccess[] memory acc) {
        vm.startStateDiffRecording();
        vm.prank(user);
        (ok, ret) = address(router).call{value: q.useValue ? q.amt : 0}(
            abi.encodeCall(ExitProofRouter.inspect, (address(factory), q.tokenIn, q.amt, q.t, q.mode))
        );
        acc = vm.stopAndReturnStateDiff();
    }

    /// @dev Nothing that happened inside the call survives: no value moved, nothing created, no storage changed.
    function _assertNothingSurvives(VmSafe.AccountAccess[] memory acc) internal pure {
        for (uint256 k = 0; k < acc.length; k++) {
            if (acc[k].reverted) continue;
            assertEq(acc[k].value, 0, "surviving value transfer");
            assertTrue(acc[k].kind != VmSafe.AccountAccessKind.Create, "surviving create");
            for (uint256 j = 0; j < acc[k].storageAccesses.length; j++) {
                VmSafe.StorageAccess memory sa = acc[k].storageAccesses[j];
                if (sa.isWrite && !sa.reverted) assertEq(sa.previousValue, sa.newValue, "surviving storage write");
            }
        }
    }

    /// forge-config: default.fuzz.runs = 2000
    function testFuzz_inspect_alwaysReverts_noStateChange(
        uint256 tokenSeed,
        uint256 amt,
        uint8 mode,
        bool useValue,
        bool approve,
        uint8 tokenInSeed
    ) public {
        Req memory q;
        uint256 i = tokenSeed % tokens.length;
        q.t = tokens[i];
        q.pair = pairs[i];
        q.amt = bound(amt, 0, 60 ether);
        q.mode = mode < 224 ? mode % 4 : mode; // mostly valid modes, sometimes BadMode
        q.useValue = useValue;
        // mostly WOKB; sometimes the token itself or a non-contract (both BadPair)
        q.tokenIn = tokenInSeed < 200 ? address(wokb) : tokenInSeed < 230 ? q.t : feeTo;
        if (approve) {
            vm.prank(user);
            wokb.approve(address(router), q.amt);
        }
        Snap memory a = _snap(q.t, q.pair);
        (bool ok, bytes memory ret, VmSafe.AccountAccess[] memory acc) = _call(q);

        assertFalse(ok, "inspect returned");
        (bytes4 sel, bytes memory rest) = _strip(ret);
        if (sel == ExitProofRouter.Report.selector) {
            (, bool allow, uint8 reason,,) = abi.decode(rest, (uint16, bool, uint8, uint256, uint256));
            assertEq(allow, reason == 0, "allow <=> reason 0");
            assertTrue(q.mode <= 3 && q.tokenIn == address(wokb) && q.amt != 0, "Report only on a valid request");
        }
        _assertNothingSurvives(acc);
        Snap memory b = _snap(q.t, q.pair);
        assertEq(keccak256(abi.encode(a)), keccak256(abi.encode(b)), "state changed");
    }

    /// @notice Positive control for the state-diff check: a real buy DOES leave surviving writes.
    function test_stateDiff_detects_real_buy() public {
        address t = tokens[0];
        vm.startStateDiffRecording();
        vm.prank(user);
        router.buyETH{value: 1 ether}(address(factory), t, 0, 2, user, block.timestamp);
        VmSafe.AccountAccess[] memory acc = vm.stopAndReturnStateDiff();
        uint256 surviving;
        for (uint256 k = 0; k < acc.length; k++) {
            for (uint256 j = 0; j < acc[k].storageAccesses.length; j++) {
                VmSafe.StorageAccess memory sa = acc[k].storageAccesses[j];
                if (sa.isWrite && !sa.reverted && sa.previousValue != sa.newValue) surviving++;
            }
        }
        assertGt(surviving, 0, "a real buy writes state");
        assertTrue(router.scanCache(t.codehash) != 0, "and the scan cache");
    }
}
