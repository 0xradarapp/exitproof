// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {VmSafe} from "forge-std/Vm.sol";
import {FuzzBase, Spec} from "./FuzzBase.sol";
import {FuzzTaxToken, FuzzTaxTokenDC, FuzzTaxTokenCC, FuzzTaxTokenS} from "./FuzzTokens.sol";
import {ExitProofRouter} from "../../contracts/ExitProofRouter.sol";
import {BytecodeScan} from "../../contracts/lib/BytecodeScan.sol";

/// @notice Facts packing round-trip through the REAL `_facts` path for all 2048 inputs: for every x, build a world
///         (tax token parameters, owner, bytecode variant, registry attestation, mode) whose facts must be x, then
///         observe them in `Report` (inspect) and in `Blocked` / `Checked` (a real buy), and check the verdict against
///         the spec policy. The 768 inputs with sellOk = 0 and sellTax != 3 are structurally unreachable (an unsellable
///         position always reports sellTax = 3); for those the test asserts the policy still denies with reason 1, so
///         their encoding cannot matter.
contract FactsRoundTripTest is FuzzBase {
    bytes32 internal constant CHECKED_SIG = keccak256("Checked(address,bytes32,address,uint16,bool,uint8,uint256,uint256)");

    // unscanned variants indexed by (upg, danger): 0 clean, 1 DELEGATECALL, 2 SELFDESTRUCT, 3 both; 4 CALLCODE
    FuzzTaxToken[5] internal u;
    FuzzTaxToken internal s; // attested variant

    function setUp() public {
        _baseSetUp(ROUTER_FEE);
        u[0] = new FuzzTaxToken(SUPPLY);
        u[1] = new FuzzTaxTokenDC(SUPPLY);
        u[2] = new FuzzTaxToken(SUPPLY);
        u[3] = new FuzzTaxTokenDC(SUPPLY);
        u[4] = new FuzzTaxTokenCC(SUPPLY);
        // a real SELFDESTRUCT opcode (after a STOP, unreachable) spliced in front of the metadata trailer
        vm.etch(address(u[2]), _insertBeforeTrailer(address(u[2]).code, hex"00ff"));
        vm.etch(address(u[3]), _insertBeforeTrailer(address(u[3]).code, hex"00ff"));
        _expectScan(address(u[0]), false, false, false);
        _expectScan(address(u[1]), true, false, false);
        _expectScan(address(u[2]), false, true, false);
        _expectScan(address(u[3]), true, true, false);
        _expectScan(address(u[4]), false, false, true);
        for (uint256 i = 0; i < 5; i++) {
            _list(address(u[i]), true, LIQ_TOKEN, LIQ_WOKB);
        }
        s = new FuzzTaxTokenS(SUPPLY);
        _list(address(s), true, LIQ_TOKEN, LIQ_WOKB);
    }

    function _expectScan(address t, bool dc, bool sd, bool cc) internal view {
        (bool a, bool b, bool c) = BytecodeScan.scan(t);
        require(a == dc && b == sd && c == cc, "variant scan bits");
    }

    function _bps(uint256 bucket) internal pure returns (uint16) {
        return [uint16(0), 1000, 3000, 8000][bucket];
    }

    /// @dev Builds the world for `x`; returns the token to buy.
    function _world(uint256 x) internal returns (FuzzTaxToken t) {
        bool sellOk = x & 1 != 0;
        uint256 sellTax = (x >> 1) & 3;
        uint256 buyTax = (x >> 3) & 3;
        bool owner = (x >> 5) & 1 != 0;
        bool upg = (x >> 6) & 1 != 0;
        bool danger = (x >> 7) & 1 != 0;
        bool unscanned = (x >> 8) & 1 != 0;
        if (unscanned) {
            uint256 v = (upg ? 1 : 0) | (danger ? 2 : 0);
            if (v == 1 && (x >> 9) & 1 != 0) v = 4; // alternate DELEGATECALL / CALLCODE for "upgradeable"
            t = u[v];
            t.setOwner(owner ? address(0xBEEF) : address(0));
        } else {
            t = s;
            // alternate the owner source (owner() vs registry `privileged`) and the danger flag used
            bool viaRegistry = buyTax & 1 == 0;
            t.setOwner(owner && !viaRegistry ? address(0xBEEF) : address(0));
            bool viaSetter = sellTax & 1 == 0;
            _attest(address(t), owner && viaRegistry, upg, danger && viaSetter, danger && !viaSetter);
        }
        t.setSellBlocked(!sellOk);
        t.setTax(_bps(buyTax), sellOk ? _bps(sellTax) : 0, 0);
    }

    function _roundTrip(uint256 from, uint256 to) internal {
        uint256 reachable;
        for (uint256 x = from; x < to; x++) {
            (bool allow, uint8 reason) = Spec.policy(x);
            if (x & 1 == 0 && (x >> 1) & 3 != 3) {
                assertFalse(allow, "unsellable must deny");
                assertEq(reason, 1, "reason 1");
                continue;
            }
            reachable++;
            // forge-lint: disable-next-line(unsafe-typecast)
            uint8 mode = uint8(x >> 9);
            FuzzTaxToken t = _world(x);
            Rep memory r = _inspect(address(t), 1 ether, mode);
            assertEq(uint256(r.facts), x, "Report facts != x");
            assertEq(r.allow, allow, "Report allow");
            assertEq(r.reason, reason, "Report reason");
            _buyObserves(address(t), mode, x, allow, reason);
        }
        emit log_named_uint("reachable inputs checked", reachable);
    }

    function _buyObserves(address t, uint8 mode, uint256 x, bool allow, uint8 reason) internal {
        uint256 snap = vm.snapshotState();
        vm.recordLogs();
        vm.prank(user);
        try router.buyETH{value: 1 ether}(address(factory), t, 0, mode, user, block.timestamp) {
            assertTrue(allow, "bought but policy denies");
            VmSafe.Log[] memory logs = vm.getRecordedLogs();
            bool seen;
            for (uint256 i = 0; i < logs.length; i++) {
                if (logs[i].emitter == address(router) && logs[i].topics[0] == CHECKED_SIG) {
                    (uint16 facts, bool al, uint8 rs,,) = abi.decode(logs[i].data, (uint16, bool, uint8, uint256, uint256));
                    assertEq(uint256(facts), x, "Checked facts != x");
                    assertTrue(al, "Checked allow");
                    assertEq(rs, 0, "Checked reason");
                    seen = true;
                }
            }
            assertTrue(seen, "no Checked event");
        } catch (bytes memory err) {
            (bytes4 sel, bytes memory rest) = _strip(err);
            assertEq(sel, ExitProofRouter.Blocked.selector, "not Blocked");
            (uint8 rr, uint16 ff) = abi.decode(rest, (uint8, uint16));
            assertFalse(allow, "blocked but policy allows");
            assertEq(rr, reason, "Blocked reason");
            assertEq(uint256(ff), x, "Blocked facts != x");
        }
        vm.revertToState(snap);
    }

    function test_facts_roundTrip_0000_0255() public {
        _roundTrip(0, 256);
    }

    function test_facts_roundTrip_0256_0511() public {
        _roundTrip(256, 512);
    }

    function test_facts_roundTrip_0512_0767() public {
        _roundTrip(512, 768);
    }

    function test_facts_roundTrip_0768_1023() public {
        _roundTrip(768, 1024);
    }

    function test_facts_roundTrip_1024_1279() public {
        _roundTrip(1024, 1280);
    }

    function test_facts_roundTrip_1280_1535() public {
        _roundTrip(1280, 1536);
    }

    function test_facts_roundTrip_1536_1791() public {
        _roundTrip(1536, 1792);
    }

    function test_facts_roundTrip_1792_2047() public {
        _roundTrip(1792, 2048);
    }

    /// @notice The independent Spec.policy equals circuit/truth.json (so it is a valid oracle) on all 2048 inputs.
    function test_specPolicy_matches_truth() public view {
        uint256[] memory truth = abi.decode(vm.parseJson(vm.readFile("circuit/truth.json")), (uint256[]));
        assertEq(truth.length, 2048);
        for (uint256 x = 0; x < 2048; x++) {
            (bool allow, uint8 reason) = Spec.policy(x);
            assertEq((allow ? 1 : 0) | (uint256(reason) << 1), truth[x], "Spec.policy != truth.json");
        }
    }
}
