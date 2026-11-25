// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {FuzzBase, Spec, IERC20X} from "./FuzzBase.sol";
import {FuzzTaxToken} from "./FuzzTokens.sol";
import {CleanToken} from "../fixtures/Tokens.sol";
import {ExitProofRouter} from "../../contracts/ExitProofRouter.sol";
import {MockV2Pair} from "../mocks/V2.sol";

/// @notice Random reserves, buy sizes (dust .. 50% of the quote reserve), router fee (0..30 bps), quote-side ordering
///         (token0 or token1) and entry path (native / WOKB / other ERC20): no dust, exact fee, minOut honoured.
contract RouterMechanicsFuzzTest is FuzzBase {
    CleanToken internal usd; // a non-WOKB ERC20 quote

    struct Case {
        address quote;
        address tok;
        address pair;
        uint256 amt;
        uint256 minOut;
        uint8 mode;
        uint8 path; // 0 buyETH, 1 buy(WOKB), 2 buy(usd)
    }

    struct Bal {
        uint256 userNative;
        uint256 userQuote;
        uint256 userTok;
        uint256 fee;
    }

    function setUp() public {
        _baseSetUp(ROUTER_FEE);
        usd = new CleanToken(1e40);
    }

    function _deployAt(address quote, bool below, uint256 supply) internal returns (address t) {
        t = below ? address(uint160(quote) - 0x1_0000) : address(uint160(quote) + 0x1_0000);
        deployCodeTo("FuzzTokens.sol:FuzzTaxToken", abi.encode(supply), t);
    }

    function _listQuote(address t, address quote, uint256 rT, uint256 rQ) internal returns (address pair) {
        pair = factory.createPair(t, quote);
        FuzzTaxToken(t).initPair(pair);
        require(IERC20X(t).transfer(pair, rT), "seed");
        if (quote == address(wokb)) wokb.deposit{value: rQ}();
        require(IERC20X(quote).transfer(pair, rQ), "seed q");
        MockV2Pair(pair).mint(address(this));
    }

    function _bal(Case memory c) internal view returns (Bal memory b) {
        b.userNative = user.balance;
        b.userQuote = IERC20X(c.quote).balanceOf(user);
        b.userTok = IERC20X(c.tok).balanceOf(user);
        b.fee = IERC20X(c.quote).balanceOf(feeTo);
    }

    function _call(Case memory c) internal returns (bool ok, bytes memory ret) {
        vm.startPrank(user);
        if (c.path == 0) {
            (ok, ret) = address(router).call{value: c.amt}(
                abi.encodeCall(
                    ExitProofRouter.buyETH, (address(factory), c.tok, c.minOut, c.mode, user, block.timestamp)
                )
            );
        } else {
            (ok, ret) = address(router).call(
                abi.encodeCall(
                    ExitProofRouter.buy,
                    (address(factory), c.quote, c.amt, c.tok, c.minOut, c.mode, user, block.timestamp)
                )
            );
        }
        vm.stopPrank();
    }

    struct Model {
        uint256 fee;
        uint256 expected;
        uint256 x;
        bool allow;
        uint8 reason;
    }

    function _model(Case memory c, uint256 rT, uint256 rQ) internal view returns (Model memory m) {
        m.fee = c.amt * router.feeBps() / 10000;
        m.expected = Spec.out(c.amt - m.fee, rQ, rT, POOL_FEE);
        if (m.expected == 0) return m;
        uint256 rT2 = rT - m.expected;
        uint256 rQ2 = rQ + c.amt - m.fee;
        uint256 sellOut = Spec.out(m.expected, rT2, rQ2, POOL_FEE);
        bool sellOk = sellOut != 0;
        uint256 sellTax = sellOk ? Spec.bucket(m.expected, Spec.amountIn(sellOut, rT2, rQ2, POOL_FEE)) : 3;
        m.x = (sellOk ? 1 : 0) | (sellTax << 1) | (1 << 8) | (uint256(c.mode) << 9);
        (m.allow, m.reason) = Spec.policy(m.x);
    }

    /// forge-config: default.fuzz.runs = 2000
    function testFuzz_noDust_exactFee_minOut(
        uint256 rT,
        uint256 rQ,
        uint256 amt,
        bool below,
        uint8 path,
        uint16 feeBps,
        uint256 minOutSeed,
        uint8 mode
    ) public {
        Case memory c;
        c.path = uint8(bound(path, 0, 2));
        c.quote = c.path == 2 ? address(usd) : address(wokb);
        c.mode = uint8(bound(mode, 0, 3));
        // forge-lint: disable-next-line(unsafe-typecast)
        router = _router(uint16(bound(feeBps, 0, 30)));
        rT = bound(rT, 1e3, 1e30);
        rQ = bound(rQ, 1e3, 1e27);
        c.amt = bound(amt, 1, rQ / 2);
        c.tok = _deployAt(c.quote, below, rT);
        c.pair = _listQuote(c.tok, c.quote, rT, rQ);
        assertEq(MockV2Pair(c.pair).token0() == c.tok, below, "ordering");

        // ---- independent model (clean token, no taxes) ----
        Model memory m = _model(c, rT, rQ);
        c.minOut = bound(minOutSeed, 0, m.expected * 2 + 1);

        if (c.path != 0) {
            vm.startPrank(user);
            if (c.path == 1) wokb.deposit{value: c.amt}();
            vm.stopPrank();
            if (c.path == 2) require(usd.transfer(user, c.amt), "fund");
            vm.prank(user);
            IERC20X(c.quote).approve(address(router), c.amt);
        }
        Bal memory b0 = _bal(c);
        (bool ok, bytes memory ret) = _call(c);
        Bal memory b1 = _bal(c);

        if (ok) {
            uint256 out = abi.decode(ret, (uint256));
            assertTrue(m.expected != 0 && m.allow, "success only when the model allows");
            assertEq(out, m.expected, "out == V2 expectation");
            assertGe(out, c.minOut, "out >= minOut");
            assertEq(b1.userTok - b0.userTok, out, "user received out");
            assertEq(b1.fee - b0.fee, m.fee, "fee == feeBps of input");
            if (c.path == 0) assertEq(b0.userNative - b1.userNative, c.amt, "native spent");
            else assertEq(b0.userQuote - b1.userQuote, c.amt, "quote spent");
        } else {
            (bytes4 sel, bytes memory rest) = _strip(ret);
            if (m.expected == 0) {
                assertEq(sel, ExitProofRouter.TooLittle.selector, "dust -> TooLittle");
            } else if (!m.allow) {
                assertEq(sel, ExitProofRouter.Blocked.selector, "deny -> Blocked");
                (uint8 rr, uint16 ff) = abi.decode(rest, (uint8, uint16));
                assertEq(rr, m.reason, "reason");
                assertEq(uint256(ff), m.x, "facts");
            } else {
                assertLt(m.expected, c.minOut, "allowed revert only on minOut");
                assertEq(sel, ExitProofRouter.TooLittle.selector, "minOut -> TooLittle");
            }
            assertEq(b1.userNative, b0.userNative, "revert: native unchanged");
            assertEq(b1.userQuote, b0.userQuote, "revert: quote unchanged");
            assertEq(b1.userTok, b0.userTok, "revert: token unchanged");
            assertEq(b1.fee, b0.fee, "revert: no fee");
        }
        _assertNoDust(c.tok);
        assertEq(usd.balanceOf(address(router)), 0, "usd dust");
        assertEq(uint256(vm.load(address(router), bytes32(uint256(2)))), 1, "lock released");
    }
}
