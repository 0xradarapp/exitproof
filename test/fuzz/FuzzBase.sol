// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ExitProofRouter} from "../../contracts/ExitProofRouter.sol";
import {RiskRegistry} from "../../contracts/RiskRegistry.sol";
import {MockProcessor} from "../mocks/MockProcessor.sol";
import {MockWOKB, MockV2Factory, MockV2Pair} from "../mocks/V2.sol";

interface IERC20X {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}

/// @notice Independent re-statement of the spec (docs/superpowers/specs/2026-11-25-exitproof-design.md): bucket math,
///         V2 math and the circuit policy, written from the spec text, NOT copied from the router or MockProcessor.
library Spec {
    uint256 internal constant BPS = 10_000;

    /// bucket: 0 <5%, 1 5-15%, 2 15-50%, 3 >=50% or unmeasurable; loss in bps rounded UP.
    function bucket(uint256 expected, uint256 actual) internal pure returns (uint256) {
        if (expected == 0) return 3;
        if (actual >= expected) return 0;
        uint256 lost = expected - actual;
        uint256 bps = lost * BPS / expected;
        if (bps * expected < lost * BPS) bps += 1; // ceil
        if (bps < 500) return 0;
        if (bps < 1500) return 1;
        if (bps < 5000) return 2;
        return 3;
    }

    function bucketOfBps(uint256 bps) internal pure returns (uint256) {
        return bps < 500 ? 0 : bps < 1500 ? 1 : bps < 5000 ? 2 : 3;
    }

    /// V2 getAmountOut with fee in bps.
    function out(uint256 a, uint256 rIn, uint256 rOut, uint256 fee) internal pure returns (uint256) {
        if (rIn == 0 || rOut == 0) return 0;
        uint256 aw = a * (BPS - fee);
        return aw * rOut / (rIn * BPS + aw);
    }

    /// V2 getAmountIn (+1 rounding as in Uniswap's library); 0 if unreachable.
    function amountIn(uint256 o, uint256 rIn, uint256 rOut, uint256 fee) internal pure returns (uint256) {
        if (o >= rOut || rIn == 0) return 0;
        return rIn * o * BPS / ((rOut - o) * (BPS - fee)) + 1;
    }

    /// Spec policy. Returns (allow, reason).
    function policy(uint256 x) internal pure returns (bool, uint8) {
        bool sellOk = x & 1 != 0;
        uint256 sellTax = (x >> 1) & 3;
        uint256 buyTax = (x >> 3) & 3;
        bool owner = (x >> 5) & 1 != 0;
        bool upg = (x >> 6) & 1 != 0;
        bool danger = (x >> 7) & 1 != 0;
        bool unscanned = (x >> 8) & 1 != 0;
        uint256 mode = (x >> 9) & 3;
        bool strict = mode == 0 || mode == 3;
        bool balanced = mode == 1;
        uint256 maxTax = strict ? 0 : 1;
        if (!sellOk) return (false, 1);
        if (sellTax > maxTax) return (false, 2);
        if (buyTax > maxTax) return (false, 3);
        if (!strict && !balanced) return (true, 0); // permissive = base
        if (upg) return (false, 4);
        if (balanced) {
            if (owner && danger) return (false, 5);
            if (owner && unscanned) return (false, 6);
            return (true, 0);
        }
        if (danger) return (false, 5);
        if (unscanned) return (false, 6);
        if (owner) return (false, 7);
        return (true, 0);
    }
}

abstract contract FuzzBase is Test {
    uint256 internal constant SUPPLY = 1_000_000_000e18;
    uint256 internal constant LIQ_TOKEN = 100_000e18;
    uint256 internal constant LIQ_WOKB = 100e18;
    uint16 internal constant POOL_FEE = 25;
    uint16 internal constant ROUTER_FEE = 10;

    MockProcessor internal proc;
    RiskRegistry internal reg;
    MockWOKB internal wokb;
    MockV2Factory internal factory;
    ExitProofRouter internal router;
    address internal feeTo = makeAddr("feeTo");
    address internal user = makeAddr("user");

    struct Rep {
        uint16 facts;
        bool allow;
        uint8 reason;
        uint256 buyOut;
        uint256 sellOut;
        uint256 delivered;
    }

    function _baseSetUp(uint16 feeBps) internal {
        proc = new MockProcessor();
        reg = new RiskRegistry();
        reg.setAttester(address(this), true);
        wokb = new MockWOKB();
        factory = new MockV2Factory(POOL_FEE);
        router = _router(feeBps);
        vm.deal(user, 1e30);
        vm.deal(address(this), 1e30);
    }

    function _router(uint16 feeBps) internal returns (ExitProofRouter) {
        address[] memory fs = new address[](1);
        fs[0] = address(factory);
        uint16[] memory fb = new uint16[](1);
        fb[0] = POOL_FEE;
        return new ExitProofRouter(address(proc), 7, address(reg), address(wokb), feeTo, feeBps, fs, fb);
    }

    /// @dev Creates the WOKB pair, calls initPair if asked, seeds liquidity from this contract.
    function _list(address t, bool pairAware, uint256 liqTok, uint256 liqW) internal returns (address pair) {
        pair = factory.createPair(t, address(wokb));
        if (pairAware) {
            (bool ok,) = t.call(abi.encodeWithSignature("initPair(address)", pair));
            require(ok, "initPair");
        }
        require(IERC20X(t).transfer(pair, liqTok), "seed tok");
        wokb.deposit{value: liqW}();
        require(wokb.transfer(pair, liqW), "seed wokb");
        MockV2Pair(pair).mint(address(this));
    }

    function _reservesOf(address pair, address t) internal view returns (uint256 rTok, uint256 rW) {
        (uint112 r0, uint112 r1,) = MockV2Pair(pair).getReserves();
        (rTok, rW) = MockV2Pair(pair).token0() == t ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
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

    function _inspect(address t, uint256 amt, uint8 mode) internal returns (Rep memory r) {
        vm.prank(user);
        try router.inspect{value: amt}(address(factory), address(wokb), amt, t, mode) {
            revert("inspect returned");
        } catch (bytes memory err) {
            (bytes4 sel, bytes memory rest) = _strip(err);
            require(sel == ExitProofRouter.Report.selector, "not Report");
            (r.facts, r.allow, r.reason, r.buyOut, r.sellOut, r.delivered) =
                abi.decode(rest, (uint16, bool, uint8, uint256, uint256, uint256));
        }
    }

    function _attest(address t, bool privileged, bool upg, bool dangerSetter, bool ownerCanTrap) internal {
        reg.attest(t, t.codehash, RiskRegistry.Flags(true, privileged, upg, dangerSetter, ownerCanTrap, 1), "ipfs://f");
    }

    function _assertNoDust(address t) internal view {
        assertEq(IERC20X(t).balanceOf(address(router)), 0, "token dust");
        assertEq(wokb.balanceOf(address(router)), 0, "wokb dust");
        assertEq(address(router).balance, 0, "native dust");
    }

    /// @dev Inserts `ins` right before a solc ipfs CBOR trailer (last 0x35 bytes), so the trailer is still recognised
    ///      by the scanner and the code section (and its jump targets) is untouched.
    function _insertBeforeTrailer(bytes memory code, bytes memory ins) internal pure returns (bytes memory r) {
        require(code.length > 0x35 && code[code.length - 1] == 0x33 && code[code.length - 2] == 0x00, "trailer");
        uint256 st = code.length - 0x35;
        r = new bytes(code.length + ins.length);
        for (uint256 i = 0; i < st; i++) {
            r[i] = code[i];
        }
        for (uint256 i = 0; i < ins.length; i++) {
            r[st + i] = ins[i];
        }
        for (uint256 i = st; i < code.length; i++) {
            r[i + ins.length] = code[i];
        }
    }
}
