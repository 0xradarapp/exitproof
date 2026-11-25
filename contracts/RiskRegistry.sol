// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title RiskRegistry
/// @notice Codehash-keyed risk flags written by whitelisted off-chain scanners.
contract RiskRegistry {
    struct Flags {
        bool scanned;
        bool privileged;
        bool upgradeable;
        bool dangerSetter;
        bool ownerCanTrap;
        uint16 scannerVersion;
    }

    error NotOwner();
    error NotAttester();
    error ZeroAddress();

    event Attested(bytes32 indexed codehash, Flags f, string reportURI, address attester);
    event AttesterSet(address indexed attester, bool allowed);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    address public owner;
    mapping(address => bool) public isAttester;
    mapping(bytes32 => Flags) private _flags;

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyAttester() {
        if (!isAttester[msg.sender]) revert NotAttester();
        _;
    }

    function flagsOf(bytes32 codehash) external view returns (Flags memory) {
        return _flags[codehash];
    }

    /// @notice Store flags for a codehash; `scanned` is always forced to true.
    function attest(bytes32 codehash, Flags calldata f, string calldata reportURI) external onlyAttester {
        Flags memory m = f;
        m.scanned = true;
        _flags[codehash] = m;
        emit Attested(codehash, m, reportURI, msg.sender);
    }

    function setAttester(address a, bool allowed) external onlyOwner {
        isAttester[a] = allowed;
        emit AttesterSet(a, allowed);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}
