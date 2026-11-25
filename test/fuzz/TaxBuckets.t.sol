// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {FuzzBase, Spec} from "./FuzzBase.sol";
import {FuzzTaxToken, FuzzTaxTokenS} from "./FuzzTokens.sol";
import {ExitProofRouter} from "../../contracts/ExitProofRouter.sol";
import {BytecodeScan} from "../../contracts/lib/BytecodeScan.sol";

/// @notice Parametric transfer-tax fuzzing: the router's tax buckets equal an independent model of the documented
///         math (two-hop buy-side attribution, ceil rounding, sell measured with getAmountIn), and allow/deny equals
///         the spec policy for every mode.
contract TaxBucketsFuzzTest is FuzzBase {
    FuzzTaxToken internal t; // unscanned
    FuzzTaxTokenS internal ts; // registry-attested clean
    address internal pairT;
    address internal pairS;

    struct Model {
        uint256 expected; // tax-free V2 out (E)
        uint256 received; // pair -> router (R)
        uint256 held; // router -> holder (H)
        uint256 sellOut;
        bool sellOk;
        uint256 sellTax;
        uint256 buyTax;
        uint256 delivered; // router -> buyer
    }

    function setUp() public {
        _baseSetUp(ROUTER_FEE);
        t = new FuzzTaxToken(SUPPLY);
        ts = new FuzzTaxTokenS(SUPPLY);
        pairT = _list(address(t), true, LIQ_TOKEN, LIQ_WOKB);
        pairS = _list(address(ts), true, LIQ_TOKEN, LIQ_WOKB);
        _attest(address(ts), false, false, false, false);
        // the fixture must be scan-clean for the facts below
        (bool dc, bool sd, bool cc) = BytecodeScan.scan(address(t));
        require(!dc && !sd && !cc, "fixture not scan-clean");
    }

    // ------------------------------------------------------------------ independent model

    function _tax(uint256 a, uint256 bps) internal pure returns (uint256) {
        return a - a * bps / 10000;
    }

    function _model(address tok, address pair, uint256 amtIn, uint256 b, uint256 s, uint256 h)
        internal
        view
        returns (Model memory m)
    {
        (uint256 rT, uint256 rW) = _reservesOf(pair, tok);
        uint256 net = amtIn - amtIn * router.feeBps() / 10000;
        m.expected = Spec.out(net, rW, rT, POOL_FEE);
        m.received = _tax(m.expected, b); // hop 1: pair -> router
        m.sellTax = 3;
        if (m.received != 0) {
            m.held = _tax(m.received, h); // hop 2: router -> fresh holder
            uint256 rT2 = rT - m.expected; // pair paid out the full E
            uint256 rW2 = rW + net;
            if (m.held != 0 && s < 10000) {
                uint256 n = _tax(m.held, s); // holder -> pair
                if (n != 0) m.sellOut = Spec.out(n, rT2, rW2, POOL_FEE);
            }
            m.sellOk = m.sellOut != 0;
            if (m.sellOk) m.sellTax = Spec.bucket(m.held, Spec.amountIn(m.sellOut, rT2, rW2, POOL_FEE));
            if (!m.sellOk) m.sellOut = 0;
            m.delivered = _tax(m.received, h); // router -> buyer is a wallet hop too
        }
        m.buyTax = Spec.bucket(m.expected, m.held != 0 ? m.held : m.received);
    }

    function _facts(Model memory m, bool scanned, uint8 mode) internal pure returns (uint256) {
        return (m.sellOk ? 1 : 0) | (m.sellTax << 1) | (m.buyTax << 3) | (scanned ? 0 : 1 << 8) | (uint256(mode) << 9);
    }

    // ------------------------------------------------------------------ core check

    function _check(bool scanned, uint256 b, uint256 s, uint256 h, uint8 mode, uint256 amt, bool alsoBuy)
        internal
        returns (Model memory m, Rep memory r)
    {
        FuzzTaxToken tok = scanned ? FuzzTaxToken(address(ts)) : t;
        address pair = scanned ? pairS : pairT;
        // forge-lint: disable-next-line(unsafe-typecast)
        tok.setTax(uint16(b), uint16(s), uint16(h));
        m = _model(address(tok), pair, amt, b, s, h);
        if (m.expected == 0) {
            // dust: nothing to buy -> the router refuses up front, it never reports
            vm.prank(user);
            vm.expectRevert(ExitProofRouter.TooLittle.selector);
            router.inspect{value: amt}(address(factory), address(wokb), amt, address(tok), mode);
            return (m, r);
        }
        r = _inspect(address(tok), amt, mode);
        uint256 x = _facts(m, scanned, mode);
        assertEq(r.facts & 1, x & 1, "sellOk");
        assertEq((r.facts >> 1) & 3, m.sellTax, "sellTax bucket");
        assertEq((r.facts >> 3) & 3, m.buyTax, "buyTax bucket");
        assertEq(uint256(r.facts), x, "facts");
        assertEq(r.buyOut, m.received, "buyOut");
        assertEq(r.sellOut, m.sellOut, "sellOut");
        (bool allow, uint8 reason) = Spec.policy(x);
        assertEq(r.allow, allow, "allow");
        assertEq(r.reason, reason, "reason");
        if (alsoBuy) _buyMatches(address(tok), amt, mode, m, allow, reason, x);
    }

    function _buyMatches(address tok, uint256 amt, uint8 mode, Model memory m, bool allow, uint8 reason, uint256 x)
        internal
    {
        uint256 bal0 = FuzzTaxToken(tok).balanceOf(user);
        uint256 nat0 = user.balance;
        vm.prank(user);
        try router.buyETH{value: amt}(address(factory), tok, 0, mode, user, block.timestamp) returns (uint256 out) {
            assertTrue(allow, "buy succeeded but policy denies");
            assertEq(out, m.delivered, "delivered");
            assertEq(FuzzTaxToken(tok).balanceOf(user) - bal0, out, "user received out");
        } catch (bytes memory err) {
            (bytes4 sel, bytes memory rest) = _strip(err);
            if (sel == ExitProofRouter.Blocked.selector) {
                assertFalse(allow, "blocked but policy allows");
                (uint8 rr, uint16 ff) = abi.decode(rest, (uint8, uint16));
                assertEq(rr, reason, "Blocked reason");
                assertEq(uint256(ff), x, "Blocked facts");
            } else {
                // allowed by policy but nothing deliverable (100% hop tax) -> TooLittle
                assertEq(sel, ExitProofRouter.TooLittle.selector, "unexpected revert");
                assertTrue(allow && m.delivered == 0, "TooLittle only when nothing is delivered");
            }
            assertEq(user.balance, nat0, "deny moved native");
            assertEq(FuzzTaxToken(tok).balanceOf(user), bal0, "deny moved token");
        }
        _assertNoDust(tok);
    }

    // ------------------------------------------------------------------ fuzz

    /// forge-config: default.fuzz.runs = 2000
    function testFuzz_buySellTax_buckets_and_policy(uint256 b, uint256 s, uint8 mode, bool scanned) public {
        b = bound(b, 0, 10000);
        s = bound(s, 0, 10000);
        mode = uint8(bound(mode, 0, 3));
        (Model memory m,) = _check(scanned, b, s, 0, mode, 1 ether, true);
        // semantic: with deep liquidity the measured buckets are the true tax buckets (ceil may tip a value sitting
        // 1 bps under a boundary up: conservative)
        if (b < 10000) assertEq(m.buyTax, Spec.bucketOfBps(b), "buy bucket == true bucket");
        if (b == 10000) {
            assertFalse(m.sellOk, "nothing received");
        } else if (m.sellOk) {
            assertGe(m.sellTax, Spec.bucketOfBps(s), "sell bucket >= true bucket");
            assertLe(m.sellTax, Spec.bucketOfBps(s + 1), "sell bucket <= bucket(true + 1bps)");
        } else {
            assertGe(s, 10000, "only a 100% sell tax makes a clean pool unsellable here");
        }
    }

    /// @notice Two-hop buy-side attribution: buy bucket = loss over pair -> router -> holder.
    /// forge-config: default.fuzz.runs = 2000
    function testFuzz_twoHop_buyAttribution(uint256 b, uint256 s, uint256 h, uint8 mode) public {
        b = bound(b, 0, 10000);
        s = bound(s, 0, 10000);
        h = bound(h, 0, 10000);
        mode = uint8(bound(mode, 0, 3));
        (Model memory m,) = _check(false, b, s, h, mode, 1 ether, true);
        if (b < 10000 && h < 10000) {
            // true two-hop loss in bps: 1 - (1-b)(1-h)
            uint256 keep = (10000 - b) * (10000 - h); // 1e8 scale
            uint256 lossBps1e4 = 1e8 - keep; // bps * 1e4
            uint256 lo = lossBps1e4 / 1e4;
            uint256 hi = (lossBps1e4 + 1e4 - 1) / 1e4;
            assertGe(m.buyTax, Spec.bucketOfBps(lo), "buy bucket >= floor(true loss)");
            assertLe(m.buyTax, Spec.bucketOfBps(hi + 1), "buy bucket <= ceil(true loss)+1");
        }
    }

    /// @notice Same, with random pool depth and buy size (dust .. 50% of the WOKB reserve): exact model match only.
    /// forge-config: default.fuzz.runs = 2000
    function testFuzz_taxBuckets_randomPool(uint256 b, uint256 s, uint256 h, uint256 rT, uint256 rW, uint256 amt)
        public
    {
        b = bound(b, 0, 10000);
        s = bound(s, 0, 10000);
        h = bound(h, 0, 10000);
        rT = bound(rT, 1e6, 1e30);
        rW = bound(rW, 1e6, 1e27);
        amt = bound(amt, 1, rW / 2);
        FuzzTaxToken tok = new FuzzTaxToken(SUPPLY + rT);
        _list(address(tok), true, rT, rW);
        t = tok;
        pairT = factory.getPair(address(tok), address(wokb));
        _check(false, b, s, h, 2, amt, true);
    }

    // ------------------------------------------------------------------ explicit boundaries

    function _boundaryValues() internal pure returns (uint256[15] memory v) {
        v = [uint256(0), 1, 499, 500, 501, 1499, 1500, 1501, 4999, 5000, 5001, 7500, 9999, 10000, 250];
    }

    /// @notice Every (buy, sell) pair over the boundary set {0,1,499,500,501,1499,1500,1501,4999,5000,5001,...}.
    function test_taxBuckets_boundaries_grid() public {
        uint256[15] memory v = _boundaryValues();
        for (uint256 i = 0; i < v.length; i++) {
            for (uint256 j = 0; j < v.length; j++) {
                (Model memory m,) = _check(false, v[i], v[j], 0, 2, 1 ether, false);
                if (v[i] < 10000) assertEq(m.buyTax, Spec.bucketOfBps(v[i]), "buy boundary");
                if (m.sellOk) {
                    // sell side: getAmountIn on a floored output over-estimates the loss by a few wei, and ceil turns
                    // that into +1 bps, so a tax sitting exactly 1 bps under a line may tip up (conservative)
                    assertGe(m.sellTax, Spec.bucketOfBps(v[j]), "sell boundary lo");
                    assertLe(m.sellTax, Spec.bucketOfBps(v[j] + 1), "sell boundary hi");
                    if (m.sellTax != Spec.bucketOfBps(v[j])) emit log_named_uint("sell tax tipped up at bps", v[j]);
                }
            }
        }
    }

    /// @notice Exactly-on-the-line taxes land in the upper bucket (5% -> 1, 15% -> 2, 50% -> 3) on both legs, and
    ///         1 bps under stays below on the buy leg (the sell leg tips up by design, 2 bps under stays below), in every
    ///         mode, via real buys.
    function test_taxBuckets_exact_lines_all_modes() public {
        uint256[3] memory line = [uint256(500), 1500, 5000];
        for (uint8 mode = 0; mode < 4; mode++) {
            for (uint256 k = 0; k < 3; k++) {
                (Model memory m,) = _check(true, line[k], 0, 0, mode, 1 ether, true);
                assertEq(m.buyTax, k + 1, "buy on line");
                (m,) = _check(true, line[k] - 1, 0, 0, mode, 1 ether, true);
                assertEq(m.buyTax, k, "buy under line");
                (m,) = _check(true, 0, line[k], 0, mode, 1 ether, true);
                assertEq(m.sellTax, k + 1, "sell on line");
                (m,) = _check(true, 0, line[k] - 1, 0, mode, 1 ether, true);
                assertEq(m.sellTax, k + 1, "sell 1 bps under line tips up (documented, conservative)");
                (m,) = _check(true, 0, line[k] - 2, 0, mode, 1 ether, true);
                assertEq(m.sellTax, k, "sell 2 bps under line");
            }
        }
    }
}
