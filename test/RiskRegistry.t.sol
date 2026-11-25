// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {RiskRegistry} from "../contracts/RiskRegistry.sol";

contract RiskRegistryTest is Test {
    RiskRegistry reg;
    address owner = address(0xA11CE);
    address attester = address(0xA77E57);
    address rando = address(0xBAD);
    address token = address(0x70CE);
    bytes32 constant H = keccak256("code");

    event Attested(
        address indexed token, bytes32 indexed codehash, RiskRegistry.Flags f, string reportURI, address attester
    );
    event AttesterSet(address indexed attester, bool allowed);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    function setUp() public {
        vm.prank(owner);
        reg = new RiskRegistry();
        vm.prank(owner);
        reg.setAttester(attester, true);
    }

    function _flags() internal pure returns (RiskRegistry.Flags memory f) {
        f = RiskRegistry.Flags(false, true, false, true, true, 7);
    }

    function test_ownerIsDeployer() public view {
        assertEq(reg.owner(), owner);
        assertEq(reg.pendingOwner(), address(0));
    }

    function test_attestByNonAttesterReverts() public {
        vm.prank(rando);
        vm.expectRevert(RiskRegistry.NotAttester.selector);
        reg.attest(token, H, _flags(), "ipfs://x");
    }

    function test_attestZeroTokenReverts() public {
        vm.prank(attester);
        vm.expectRevert(RiskRegistry.ZeroAddress.selector);
        reg.attest(address(0), H, _flags(), "ipfs://x");
    }

    function test_flagsRoundTripAndScannedForced() public {
        RiskRegistry.Flags memory f = _flags();
        RiskRegistry.Flags memory fe = f;
        fe.scanned = true;
        vm.expectEmit(true, true, false, true, address(reg));
        emit Attested(token, H, fe, "ipfs://x", attester);
        vm.prank(attester);
        reg.attest(token, H, f, "ipfs://x");
        (RiskRegistry.Flags memory g, bytes32 h) = reg.flagsOf(token);
        assertEq(h, H, "codehash stored");
        assertTrue(g.scanned);
        assertTrue(g.privileged);
        assertFalse(g.upgradeable);
        assertTrue(g.dangerSetter);
        assertTrue(g.ownerCanTrap);
        assertEq(g.scannerVersion, 7);
    }

    /// @notice F-06: entries are per token address. Another address (e.g. a second instance of the same bytecode) sees
    ///         nothing, and attesting it does not touch the first entry.
    function test_keyedByAddress_notByCodehash() public {
        address other = address(0x0711E2);
        vm.prank(attester);
        reg.attest(token, H, _flags(), "a");
        (RiskRegistry.Flags memory g, bytes32 h) = reg.flagsOf(other);
        assertFalse(g.scanned, "same codehash, other address: unscanned");
        assertEq(h, bytes32(0));
        vm.prank(attester);
        reg.attest(other, H, RiskRegistry.Flags(true, false, false, false, false, 7), "b");
        (g,) = reg.flagsOf(token);
        assertTrue(g.privileged && g.dangerSetter, "first entry untouched");
        // overwrite of the same token records the new codehash
        vm.prank(attester);
        reg.attest(token, keccak256("v2"), RiskRegistry.Flags(false, false, false, false, false, 8), "c");
        (g, h) = reg.flagsOf(token);
        assertEq(h, keccak256("v2"));
        assertTrue(g.scanned);
        assertFalse(g.privileged);
    }

    function test_unattestedIsZero() public view {
        (RiskRegistry.Flags memory g, bytes32 h) = reg.flagsOf(token);
        assertFalse(g.scanned);
        assertEq(g.scannerVersion, 0);
        assertEq(h, bytes32(0));
    }

    function test_setAttesterOnlyOwner() public {
        vm.prank(rando);
        vm.expectRevert(RiskRegistry.NotOwner.selector);
        reg.setAttester(rando, true);
    }

    function test_revokedAttesterCannotAttest() public {
        vm.prank(owner);
        vm.expectEmit(true, false, false, true);
        emit AttesterSet(attester, false);
        reg.setAttester(attester, false);
        vm.prank(attester);
        vm.expectRevert(RiskRegistry.NotAttester.selector);
        reg.attest(token, H, _flags(), "");
    }

    /// @notice F-12: two-step ownership. Nominating does not move ownership; only the nominee can accept.
    function test_twoStepOwnership() public {
        vm.prank(rando);
        vm.expectRevert(RiskRegistry.NotOwner.selector);
        reg.transferOwnership(rando);

        vm.prank(owner);
        vm.expectRevert(RiskRegistry.ZeroAddress.selector);
        reg.transferOwnership(address(0));

        vm.prank(owner);
        vm.expectEmit(true, true, false, false, address(reg));
        emit OwnershipTransferStarted(owner, rando);
        reg.transferOwnership(rando);
        assertEq(reg.owner(), owner, "still the old owner");
        assertEq(reg.pendingOwner(), rando);

        // a typo / wrong address can be replaced before acceptance
        address next = address(0x4E57);
        vm.prank(owner);
        reg.transferOwnership(next);
        vm.prank(rando);
        vm.expectRevert(RiskRegistry.NotPendingOwner.selector);
        reg.acceptOwnership();

        vm.prank(next);
        vm.expectEmit(true, true, false, false, address(reg));
        emit OwnershipTransferred(owner, next);
        reg.acceptOwnership();
        assertEq(reg.owner(), next);
        assertEq(reg.pendingOwner(), address(0));

        vm.prank(owner);
        vm.expectRevert(RiskRegistry.NotOwner.selector);
        reg.setAttester(owner, true);
        vm.prank(next);
        reg.setAttester(owner, true);
        assertTrue(reg.isAttester(owner));
        // acceptance is one-shot
        vm.prank(next);
        vm.expectRevert(RiskRegistry.NotPendingOwner.selector);
        reg.acceptOwnership();
    }
}
