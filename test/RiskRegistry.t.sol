// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {RiskRegistry} from "../contracts/RiskRegistry.sol";

contract RiskRegistryTest is Test {
    RiskRegistry reg;
    address owner = address(0xA11CE);
    address attester = address(0xA77E57);
    address rando = address(0xBAD);
    bytes32 constant H = keccak256("code");

    event Attested(bytes32 indexed codehash, RiskRegistry.Flags f, string reportURI, address attester);
    event AttesterSet(address indexed attester, bool allowed);

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
    }

    function test_attestByNonAttesterReverts() public {
        vm.prank(rando);
        vm.expectRevert(RiskRegistry.NotAttester.selector);
        reg.attest(H, _flags(), "ipfs://x");
    }

    function test_flagsRoundTripAndScannedForced() public {
        RiskRegistry.Flags memory f = _flags();
        vm.expectEmit(true, false, false, true);
        RiskRegistry.Flags memory fe = f;
        fe.scanned = true;
        emit Attested(H, fe, "ipfs://x", attester);
        vm.prank(attester);
        reg.attest(H, f, "ipfs://x");
        RiskRegistry.Flags memory g = reg.flagsOf(H);
        assertTrue(g.scanned);
        assertTrue(g.privileged);
        assertFalse(g.upgradeable);
        assertTrue(g.dangerSetter);
        assertTrue(g.ownerCanTrap);
        assertEq(g.scannerVersion, 7);
    }

    function test_unattestedIsZero() public view {
        RiskRegistry.Flags memory g = reg.flagsOf(H);
        assertFalse(g.scanned);
        assertEq(g.scannerVersion, 0);
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
        reg.attest(H, _flags(), "");
    }

    function test_transferOwnership() public {
        vm.prank(rando);
        vm.expectRevert(RiskRegistry.NotOwner.selector);
        reg.transferOwnership(rando);

        vm.prank(owner);
        vm.expectRevert(RiskRegistry.ZeroAddress.selector);
        reg.transferOwnership(address(0));

        vm.prank(owner);
        reg.transferOwnership(rando);
        assertEq(reg.owner(), rando);
        vm.prank(owner);
        vm.expectRevert(RiskRegistry.NotOwner.selector);
        reg.setAttester(owner, true);
    }
}
