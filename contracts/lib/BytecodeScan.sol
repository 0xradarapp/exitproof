// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title BytecodeScan
/// @notice Flags DELEGATECALL (0xF4), SELFDESTRUCT (0xFF) and CALLCODE (0xF2) that appear as
///         real opcodes in a contract's runtime code. PUSH1..PUSH32 immediates are skipped.
///         An EIP-7702 delegation designator (exactly 23 bytes, 0xef0100 || implementation) is reported as
///         DELEGATECALL: the account's owner can re-delegate it to any implementation with one transaction, so the
///         code behind the address is swappable (upgradeable). The designator itself is not scanned as code.
/// @dev The whole runtime code is scanned, except a Solidity CBOR metadata trailer. That trailer is data
///      whose 32-byte IPFS hash would otherwise yield a false positive for ~1 in 3 ordinary tokens, so it
///      is excluded, but ONLY if it matches the exact solc ipfs+solc layout (length field 0x33) and the
///      linear scan reaches it on an instruction boundary. Every other layout (solc-only, bzzr0/bzzr1
///      swarm trailers, ...) is scanned in full and may false-positive (conservative). The length field
///      alone is never trusted, so a forged length cannot move the scan boundary.
///      This is a linear-time heuristic: it does not resolve jump targets, so unreachable code
///      or data tables embedded in code can also produce false positives.
library BytecodeScan {
    function scan(address t) internal view returns (bool hasDelegatecall, bool hasSelfdestruct, bool hasCallcode) {
        assembly ("memory-safe") {
            function has5b(p, n) -> r {
                for { let k := 0 } lt(k, n) { k := add(k, 1) } {
                    if eq(byte(0, mload(add(p, k))), 0x5b) {
                        r := 1
                        break
                    }
                }
            }
            t := and(t, 0xffffffffffffffffffffffffffffffffffffffff)
            let size := extcodesize(t)
            let ptr := mload(0x40)
            if size { extcodecopy(t, ptr, 0, size) }
            // EIP-7702 delegated EOA: 0xef0100 || 20-byte implementation address
            let delegated := and(eq(size, 23), eq(shr(232, mload(ptr)), 0xef0100))
            if delegated { hasDelegatecall := 1 }
            if iszero(or(iszero(size), delegated)) {
                // Exclude a strictly-validated Solidity CBOR metadata trailer from the scan. Only the
                // ipfs+solc layout is recognised (the solc-only layout is scanned in full: its bytes
                // are executable-reachable by fall-through and contain no 0xf2/f4/ff when honest),
                // and only if none of the variable bytes (hash/version) is 0x5b (JUMPDEST): the EVM does
                // not treat the trailer as data, so a JUMP into a forged 0x5b there could reach hidden
                // opcodes. Otherwise the full code is scanned.
                // Free memory pointer is intentionally not bumped: the buffer is scratch only.
                let scanEnd := size
                let l := 0
                if gt(size, 1) {
                    l := or(shl(8, byte(0, mload(add(ptr, sub(size, 2))))), byte(0, mload(add(ptr, sub(size, 1)))))
                }
                if and(gt(size, 0x34), eq(l, 0x33)) {
                    // a2 64 "ipfs" 58 22 <34 bytes ipfs hash> 64 "solc" 43 <3 bytes version> 00 33
                    let st := sub(size, 0x35)
                    if and(
                        eq(shr(192, mload(add(ptr, st))), 0xa264697066735822),
                        eq(shr(208, mload(add(ptr, add(st, 42)))), 0x64736f6c6343)
                    ) {
                        if iszero(or(has5b(add(ptr, add(st, 8)), 34), has5b(add(ptr, add(st, 48)), 3))) {
                            scanEnd := st
                        }
                    }
                }
                let i := 0
                for {} lt(i, size) { i := add(i, 1) } {
                    // Trailer is skipped only if the linear scan reaches it on an instruction
                    // boundary; if a PUSH overran into it, execution can fall through, so keep scanning.
                    if eq(i, scanEnd) { break }
                    let op := byte(0, mload(add(ptr, i)))
                    if gt(op, 0xf1) {
                        if eq(op, 0xf4) { hasDelegatecall := 1 }
                        if eq(op, 0xff) { hasSelfdestruct := 1 }
                        if eq(op, 0xf2) { hasCallcode := 1 }
                        continue
                    }
                    // PUSH1..PUSH32 (0x60..0x7f): skip n immediate bytes
                    if and(gt(op, 0x5f), lt(op, 0x80)) { i := add(i, sub(op, 0x5f)) }
                }
            }
        }
    }
}
