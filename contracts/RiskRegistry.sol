// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title RiskRegistry
/// @notice Token-address-keyed risk flags written by whitelisted off-chain scanners. Each entry records the code hash
///         of the token at scan time; a consumer must treat the entry as valid only while the token's current
///         EXTCODEHASH equals it (ExitProofRouter does). Keying by address means an attestation of one instance is
///         never reused by, and can never be poisoned by, another instance of the same bytecode.
contract RiskRegistry {
    struct Flags {
        bool scanned;
        bool privileged;
        bool upgradeable;
        bool dangerSetter;
        bool ownerCanTrap;
        uint16 scannerVersion;
    }

    struct Entry {
        Flags f;
        bytes32 codehash;
    }

    error NotOwner();
    error NotPendingOwner();
    error NotAttester();
    error ZeroAddress();

    event Attested(address indexed token, bytes32 indexed codehash, Flags f, string reportURI, address attester);
    event AttesterSet(address indexed attester, bool allowed);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    address public owner;
    address public pendingOwner;
    mapping(address => bool) public isAttester;
    mapping(address => Entry) private _entries;

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

    /// @notice Flags and the code hash they were attested for. All zero if `token` was never attested.
    function flagsOf(address token) external view returns (Flags memory f, bytes32 codehash) {
        Entry storage e = _entries[token];
        return (e.f, e.codehash);
    }

    /// @notice Store flags for `token` scanned at `codehash`; `scanned` is always forced to true. Overwrites.
    function attest(address token, bytes32 codehash, Flags calldata f, string calldata reportURI)
        external
        onlyAttester
    {
        if (token == address(0)) revert ZeroAddress();
        Flags memory m = f;
        m.scanned = true;
        _entries[token] = Entry(m, codehash);
        emit Attested(token, codehash, m, reportURI, msg.sender);
    }

    function setAttester(address a, bool allowed) external onlyOwner {
        isAttester[a] = allowed;
        emit AttesterSet(a, allowed);
    }

    /// @notice Step 1 of 2: nominate `newOwner`. Ownership moves only when it calls acceptOwnership. A later call
    ///         replaces the nomination.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    /// @notice Step 2 of 2: the nominated address takes ownership.
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }
}
