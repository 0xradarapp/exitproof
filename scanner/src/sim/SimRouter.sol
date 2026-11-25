// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title SimRouter
/// @notice Router stand-in for scanner/src/simulate.mjs. Its runtime code is installed with anvil_setCode at a
/// per-scan address (derived from the fork block hash and the token), never deployed on a real chain.
/// It sells the way a wallet user sells through a V2 router: the user approves this contract, the contract pulls
/// the tokens into the pair with `transferFrom(user, pair, amount)` and calls `pair.swap(..., user)`. The user is
/// `tx.origin` and the router is `msg.sender` of the transferFrom, as on PotatoSwap's router.
/// Nothing reverts on a token failure: every outcome is reported in an event (stage codes below), so the scanner can
/// tell a transferFrom trap from a swap failure. Arithmetic overflow on hostile balances does revert (= sell failed).
contract SimRouter {
    /// @param ok buy completed; got = token balance delta of the user
    event Bought(bool ok, uint256 got);
    /// @param stage 0 ok, 1 reserves unreadable, 2 transferFrom failed, 3 nothing arrived at the pair,
    /// 4 swap failed, 5 user quote balance unreadable or not increased
    /// @param expectedOut V2 output for `amount` at the pre-sell reserves with no token tax
    /// @param actualOut quote balance delta of the user
    event Sold(bool ok, uint8 stage, uint256 amount, uint256 expectedOut, uint256 actualOut);

    bytes4 private constant BALANCE_OF = 0x70a08231;
    bytes4 private constant TRANSFER_FROM = 0x23b872dd;
    bytes4 private constant TOKEN0 = 0x0dfe1681;
    bytes4 private constant GET_RESERVES = 0x0902f1ac;
    bytes4 private constant SWAP = 0x022c0d9f;

    function buy(address pair, address quote, address token, uint256 qIn, uint256 feeBps) external {
        (bool ok, uint256 got) = _buy(msg.sender, pair, quote, token, qIn, feeBps);
        emit Bought(ok, got);
    }

    /// @param amount 0 = the user's whole balance
    function sell(address pair, address quote, address token, uint256 amount, uint256 feeBps) external {
        if (amount == 0) (, amount) = _bal(token, msg.sender);
        _sellAndEmit(msg.sender, pair, quote, token, amount, feeBps);
    }

    /// @notice Buy and sell back the bought amount in one transaction (the "immediate" sell).
    function roundTrip(address pair, address quote, address token, uint256 qIn, uint256 feeBps) external {
        (bool ok, uint256 got) = _buy(msg.sender, pair, quote, token, qIn, feeBps);
        emit Bought(ok, got);
        if (ok) _sellAndEmit(msg.sender, pair, quote, token, got, feeBps);
    }

    function _sellAndEmit(address user, address pair, address quote, address token, uint256 amount, uint256 feeBps)
        private
    {
        (uint8 stage, uint256 expected, uint256 actual) = _sell(user, pair, quote, token, amount, feeBps);
        emit Sold(stage == 0, stage, amount, expected, actual);
    }

    function _word(bool s, bytes memory r) private pure returns (bool ok, uint256 w) {
        if (!s || r.length < 32) return (false, 0);
        assembly {
            w := mload(add(r, 32))
        }
        ok = true;
    }

    /// @dev SafeTransfer semantics: call succeeded and returned nothing or a non-zero word.
    function _okTransfer(bool s, bytes memory r) private pure returns (bool) {
        if (!s) return false;
        if (r.length == 0) return true;
        (bool ok, uint256 w) = _word(s, r);
        return ok && w != 0;
    }

    function _bal(address t, address who) private view returns (bool, uint256) {
        (bool s, bytes memory r) = t.staticcall(abi.encodeWithSelector(BALANCE_OF, who));
        return _word(s, r);
    }

    function _reserves(address pair, address token) private view returns (bool ok, bool t0, uint256 rT, uint256 rQ) {
        (bool s0, bytes memory a) = pair.staticcall(abi.encodeWithSelector(TOKEN0));
        (bool okA, uint256 w0) = _word(s0, a);
        (bool s1, bytes memory b) = pair.staticcall(abi.encodeWithSelector(GET_RESERVES));
        if (!okA || !s1 || b.length < 64) return (false, false, 0, 0);
        uint256 r0;
        uint256 r1;
        assembly {
            r0 := mload(add(b, 32))
            r1 := mload(add(b, 64))
        }
        t0 = address(uint160(w0)) == token;
        (rT, rQ) = t0 ? (r0, r1) : (r1, r0);
        ok = true;
    }

    function _out(uint256 amountIn, uint256 rIn, uint256 rOut, uint256 feeBps) private pure returns (uint256) {
        if (amountIn == 0 || rIn == 0 || rOut == 0) return 0;
        uint256 f = amountIn * (10_000 - feeBps);
        return (f * rOut) / (rIn * 10_000 + f);
    }

    function _swap(address pair, bool t0, bool outIsToken, uint256 out, address to) private returns (bool s) {
        // token is token0 and we want token out => amount0Out; etc.
        bool out0 = t0 == outIsToken;
        (s,) = pair.call(abi.encodeWithSelector(SWAP, out0 ? out : 0, out0 ? 0 : out, to, new bytes(0)));
    }

    function _buy(address user, address pair, address quote, address token, uint256 qIn, uint256 feeBps)
        private
        returns (bool, uint256)
    {
        (bool ok, bool t0, uint256 rT, uint256 rQ) = _reserves(pair, token);
        if (!ok) return (false, 0);
        (bool s, bytes memory r) = quote.call(abi.encodeWithSelector(TRANSFER_FROM, user, pair, qIn));
        if (!_okTransfer(s, r)) return (false, 0);
        (bool okQ, uint256 q) = _bal(quote, pair);
        if (!okQ || q <= rQ) return (false, 0);
        uint256 out = _out(q - rQ, rQ, rT, feeBps);
        if (out == 0) return (false, 0);
        (bool okB, uint256 before) = _bal(token, user);
        if (!okB) return (false, 0);
        if (!_swap(pair, t0, true, out, user)) return (false, 0);
        (bool okA, uint256 afterB) = _bal(token, user);
        if (!okA || afterB <= before) return (false, 0);
        return (true, afterB - before);
    }

    function _sell(address user, address pair, address quote, address token, uint256 amount, uint256 feeBps)
        private
        returns (uint8 stage, uint256 expected, uint256 actual)
    {
        (bool ok, bool t0, uint256 rT, uint256 rQ) = _reserves(pair, token);
        if (!ok) return (1, 0, 0);
        // the tax is measured against the pre-sell reserves (what the user expects to get) ...
        expected = _out(amount, rT, rQ, feeBps);
        (bool s, bytes memory r) = token.call(abi.encodeWithSelector(TRANSFER_FROM, user, pair, amount));
        if (!_okTransfer(s, r)) return (2, expected, 0);
        // ... but the swap is priced on the POST-transfer reserves: a token may swap its collected tax into the pair
        // inside the transfer (Flap "swap-back"), which moves the reserves (same rule as ExitProofRouter)
        (ok, t0, rT, rQ) = _reserves(pair, token);
        if (!ok) return (1, expected, 0);
        (bool okT, uint256 tb) = _bal(token, pair);
        if (!okT || tb <= rT) return (3, expected, 0);
        uint256 out = _out(tb - rT, rT, rQ, feeBps);
        if (out == 0) return (3, expected, 0);
        (bool okQ0, uint256 q0) = _bal(quote, user);
        if (!okQ0) return (5, expected, 0);
        if (!_swap(pair, t0, false, out, user)) return (4, expected, 0);
        (bool okQ1, uint256 q1) = _bal(quote, user);
        if (!okQ1 || q1 <= q0) return (5, expected, 0);
        return (0, expected, q1 - q0);
    }
}
