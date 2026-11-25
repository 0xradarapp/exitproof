// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ExitProofRouter} from "../../contracts/ExitProofRouter.sol";
import {RiskRegistry} from "../../contracts/RiskRegistry.sol";
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
import {Spec} from "../fuzz/FuzzBase.sol";
import {FuzzTaxToken, HeavyHookToken} from "../fuzz/FuzzTokens.sol";
import "../fixtures/Tokens.sol";

interface IERC20S {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}

/// @notice ~30 sequential buys on an X Layer mainnet fork against the REAL TapeOut processor (own circuit taped out)
///         and REAL PotatoSwap pairs created for fixtures, with mixed verdicts, registry attestations and owner
///         actions in between. Per step: verdict == expected, Blocked/Checked consistent with the spec policy, deny
///         leaves the buyer untouched, router holds nothing, fee sum exact, cold tx gas < 3.5M.
/// @dev Skipped unless XLAYER_RPC is set (same guard as ExitProofFork.t.sol):
///      XLAYER_RPC=https://rpc.xlayer.tech forge test --match-path test/fork/ForkStress.t.sol -vv
contract ForkStressTest is Test {
    uint256 constant FORK_BLOCK = 76_861_306;
    uint256 constant SUPPLY = 1_000_000e18;
    uint256 constant LIQ_TOKEN = 100_000e18;
    uint256 constant LIQ_WOKB = 100e18;
    uint256 constant TX_BUDGET = 3_500_000;
    uint8 constant S = 0;
    uint8 constant B = 1;
    uint8 constant P = 2;
    uint8 constant ALLOW = 0;

    ITapeOutProcessor proc;
    uint256 circuitId;
    RiskRegistry reg;
    IWOKB wokb = IWOKB(XLayer.WOKB);
    IV2Factory factory = IV2Factory(XLayer.POTATO_FACTORY);
    ExitProofRouter router;
    address author = makeAddr("tapeoutAuthor");
    address feeTo = makeAddr("feeTo");
    address[3] users;

    mapping(address => address) pairOf;
    address[] listed;
    uint256 fees;
    uint256 step;
    uint256 allowed;
    uint256 blocked;
    uint256 maxGas;

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
        vm.deal(address(this), 10_000 ether);
        for (uint256 i = 0; i < 3; i++) {
            users[i] = makeAddr(string(abi.encodePacked("stressUser", vm.toString(i))));
            vm.deal(users[i], 1000 ether);
        }
    }

    function _tapeOut() internal {
        string memory j = vm.readFile("circuit/netlist.json");
        bytes memory nl = vm.parseJsonBytes(j, ".netlist");
        uint256 gates = vm.parseJsonUint(j, ".gates");
        ITapeOutFactory f = ITapeOutFactory(XLayer.TAPEOUT_FACTORY);
        IERC20Min bem = IERC20Min(XLayer.BEM);
        deal(XLayer.BEM, author, 1e8);
        vm.deal(author, 1 ether);
        vm.startPrank(author, author);
        bem.approve(address(f), f.deployFee());
        (address a, address b) = f.createCPU("ExitProof Stress", "EXPST", "ExitProof fork stress.", 10_000, 0);
        (address p, address t) = TapeOut.processorOf(a, b);
        proc = ITapeOutProcessor(p);
        ITransistors tr = ITransistors(t);
        bem.approve(t, tr.protocolFee());
        tr.mint{value: tr.mintPrice() * gates}(XLayer.NAND, gates);
        circuitId = proc.tapeout{value: proc.TAPEOUT_FEE()}(nl, 11, 4);
        vm.stopPrank();
    }

    function _list(address t, bool pairAware) internal returns (address) {
        address pair = factory.createPair(t, address(wokb));
        if (pairAware) PairAware(t).initPair(pair);
        require(IERC20S(t).transfer(pair, LIQ_TOKEN), "seed");
        wokb.deposit{value: LIQ_WOKB}();
        require(IERC20S(address(wokb)).transfer(pair, LIQ_WOKB), "seed w");
        IV2PairFull(pair).mint(address(this));
        pairOf[t] = pair;
        listed.push(t);
        return t;
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

    function _cool(address t) internal {
        vm.cool(address(router));
        vm.cool(t);
        vm.cool(pairOf[t]);
        vm.cool(address(wokb));
        vm.cool(address(factory));
        vm.cool(address(reg));
        vm.cool(address(proc));
        vm.cool(feeTo);
    }

    function _calldataGas(bytes memory data) internal pure returns (uint256 g) {
        for (uint256 i = 0; i < data.length; i++) {
            g += data[i] == 0 ? 4 : 16;
        }
    }

    struct St {
        string name;
        address t;
        uint256 amt;
        uint8 mode;
        uint8 expect; // ALLOW (0) or the expected Blocked reason
        bool erc20; // WOKB pull path instead of native
        address u;
        uint256 n0;
        uint256 w0;
        uint256 t0;
    }

    function _send(St memory c) internal returns (bool ok, bytes memory ret, uint256 g) {
        bytes memory data = c.erc20
            ? abi.encodeCall(
                ExitProofRouter.buy, (address(factory), address(wokb), c.amt, c.t, 0, c.mode, c.u, block.timestamp)
            )
            : abi.encodeCall(ExitProofRouter.buyETH, (address(factory), c.t, 0, c.mode, c.u, block.timestamp));
        _cool(c.t);
        vm.prank(c.u);
        g = gasleft();
        (ok, ret) = address(router).call{value: c.erc20 ? 0 : c.amt}(data);
        g = g - gasleft() + 21_000 + _calldataGas(data);
    }

    function _onOk(St memory c, bytes memory ret) internal returns (string memory) {
        allowed++;
        uint256 out = abi.decode(ret, (uint256));
        assertEq(c.expect, ALLOW, string(abi.encodePacked(c.name, ": allowed, expected a block")));
        assertGt(out, 0);
        assertEq(IERC20S(c.t).balanceOf(c.u) - c.t0, out, "delivered");
        fees += c.amt * router.feeBps() / 10000;
        return "ALLOW";
    }

    function _onBlock(St memory c, bytes memory ret) internal returns (string memory) {
        blocked++;
        (bytes4 sel, bytes memory rest) = _strip(ret);
        assertEq(sel, ExitProofRouter.Blocked.selector, string(abi.encodePacked(c.name, ": not Blocked")));
        (uint8 reason, uint16 facts) = abi.decode(rest, (uint8, uint16));
        (bool pAllow, uint8 pReason) = Spec.policy(facts);
        assertFalse(pAllow, "policy");
        assertEq(reason, pReason, "reason vs policy");
        assertEq(reason, c.expect, string(abi.encodePacked(c.name, ": reason")));
        assertEq(c.u.balance, c.n0, "deny: native moved");
        assertEq(IERC20S(address(wokb)).balanceOf(c.u), c.w0, "deny: wokb moved");
        assertEq(IERC20S(c.t).balanceOf(c.u), c.t0, "deny: token moved");
        return string(abi.encodePacked("BLOCK ", vm.toString(reason)));
    }

    function _routerEmpty() internal view {
        for (uint256 i = 0; i < listed.length; i++) {
            assertEq(IERC20S(listed[i]).balanceOf(address(router)), 0, "router token dust");
        }
        assertEq(IERC20S(address(wokb)).balanceOf(address(router)), 0, "router wokb dust");
        assertEq(address(router).balance, 0, "router native dust");
        assertEq(IERC20S(address(wokb)).balanceOf(feeTo), fees, "fee ledger");
    }

    /// @dev One stress step: buy, check verdict / balances / dust / fee ledger / gas, log a table row.
    function _step(string memory name, address t, uint256 amt, uint8 mode, uint8 expect, bool erc20) internal {
        step++;
        St memory c = St(name, t, amt, mode, expect, erc20, users[step % 3], 0, 0, 0);
        if (erc20) {
            vm.startPrank(c.u);
            wokb.deposit{value: amt}();
            IERC20S(address(wokb)).approve(address(router), amt);
            vm.stopPrank();
        }
        c.n0 = c.u.balance;
        c.w0 = IERC20S(address(wokb)).balanceOf(c.u);
        c.t0 = IERC20S(t).balanceOf(c.u);
        (bool ok, bytes memory ret, uint256 g) = _send(c);
        if (g > maxGas) maxGas = g;
        string memory verdict = ok ? _onOk(c, ret) : _onBlock(c, ret);
        assertLt(g, TX_BUDGET, string(abi.encodePacked(name, ": gas over budget")));
        _routerEmpty();
        emit log(
            string(
                abi.encodePacked(
                    vm.toString(step), " | ", name, " | mode ", vm.toString(mode), " | ", verdict, " | gas ", vm.toString(g)
                )
            )
        );
    }

    function _attest(address t, bool privileged, bool upg, bool danger) internal {
        reg.attest(t.codehash, RiskRegistry.Flags(true, privileged, upg, danger, false, 1), "ipfs://stress");
    }

    // fixtures (storage: the scenario is too long for the stack)
    address clean;
    address owned;
    address fee3;
    address fee8;
    address bl;
    address t99;
    address maxTx;
    address cd;
    TradingDisabled td;
    TimeBombToken bomb;
    address gb;
    address hop;
    FuzzTaxToken sb;
    HeavyHookToken heavy;
    address px;
    address sfp;
    address rb;
    address fp;

    function _fixtures() internal {
        clean = _list(address(new CleanToken(SUPPLY)), false);
        owned = _list(address(new OwnedCleanToken(SUPPLY)), false);
        fee3 = _list(address(new FeeToken(SUPPLY, 300)), false);
        fee8 = _list(address(new FeeToken(SUPPLY, 800)), false);
        bl = _list(address(new BlacklistOnBuy(SUPPLY)), true);
        t99 = _list(address(new SellTax99(SUPPLY)), true);
        maxTx = _list(address(new MaxTxToken(SUPPLY)), true);
        cd = _list(address(new CooldownToken(SUPPLY)), true);
        td = TradingDisabled(_list(address(new TradingDisabled(SUPPLY)), true));
        bomb = TimeBombToken(_list(address(new TimeBombToken(SUPPLY)), true));
        gb = _list(address(new GasBombToken(SUPPLY)), true);
        hop = _list(address(new SecondHopTrap(SUPPLY)), true);
        sb = new FuzzTaxToken(SUPPLY);
        _list(address(sb), true);
        sb.setSellBlocked(true);
        heavy = new HeavyHookToken(SUPPLY);
        _list(address(heavy), false);
        heavy.setIters(10);
        ProxyImpl impl = new ProxyImpl();
        px = _list(
            address(new ProxyToken(address(impl), abi.encodeCall(ProxyImpl.initialize, (SUPPLY, address(this))))), false
        );
        sfp = _list(address(new ScanFalsePositiveToken(SUPPLY)), false);
        rb = _list(address(new ReturnBombToken(SUPPLY)), true);
        fp = _list(address(new ForgedProbeToken(SUPPLY)), true);
    }

    function test_fork_stress_30_sequential_buys() public {
        _fixtures();

        _step("clean first buy", clean, 1 ether, P, ALLOW, false);
        _step("clean unscanned strict", clean, 0.5 ether, S, 6, false);
        _attest(clean, false, false, false);
        _step("clean attested strict", clean, 2 ether, S, ALLOW, false);
        _step("owned permissive", owned, 1 ether, P, ALLOW, false);
        _step("owned balanced unscanned", owned, 1 ether, B, 6, false);
        _step("owned strict", owned, 1 ether, S, 6, false);
        _step("fee 3% permissive", fee3, 1 ether, P, ALLOW, false);
        _step("fee 3% strict (buy bucket 1)", fee3, 1 ether, S, 3, false);
        _step("fee 8% permissive (buy 15.4%)", fee8, 1 ether, P, 3, false);
        _step("blacklist", bl, 1 ether, P, 1, false);
        _step("sell tax 99%", t99, 1 ether, P, 2, false);
        _step("maxTx small", maxTx, 1 ether, P, ALLOW, false);
        _step("maxTx large", maxTx, 20 ether, P, 1, false);
        _step("cooldown", cd, 1 ether, P, 1, false);
        _step("trading disabled", address(td), 1 ether, P, 1, false);
        td.enableTrading();
        _step("trading enabled", address(td), 1 ether, P, ALLOW, false);
        _step("time bomb permissive", address(bomb), 1 ether, P, ALLOW, false);
        _step("time bomb balanced", address(bomb), 1 ether, B, 6, false);
        bomb.setSellFee(2000);
        _step("time bomb armed 20%", address(bomb), 1 ether, P, 2, false);
        _step("gas bomb (probe cap)", gb, 1 ether, P, 1, false);
        _step("second-hop trap", hop, 1 ether, P, 1, false);
        _step("sell blocked", address(sb), 1 ether, P, 1, false);
        _step("heavy hook N=10", address(heavy), 1 ether, P, ALLOW, false);
        _step("proxy balanced", px, 1 ether, B, 4, false);
        _step("proxy permissive", px, 1 ether, P, ALLOW, false);
        _step("scan false positive balanced", sfp, 1 ether, B, 4, false);
        _attest(sfp, false, false, false);
        _step("scan fp attested balanced", sfp, 1 ether, B, ALLOW, false);
        _step("clean cached, bigger", clean, 5 ether, P, ALLOW, false);
        _step("clean WOKB path strict", clean, 1 ether, S, ALLOW, true);
        _step("return bomb", rb, 1 ether, P, 1, false);
        _step("forged probe", fp, 1 ether, P, 1, false);
        _attest(owned, true, false, true);
        _step("owned attested danger balanced", owned, 1 ether, B, 5, true);

        emit log_named_uint("steps", step);
        emit log_named_uint("allowed", allowed);
        emit log_named_uint("blocked", blocked);
        emit log_named_uint("max cold tx gas", maxGas);
        assertGe(step, 30);
        assertGt(allowed, 10);
        assertGt(blocked, 10);
    }
}
