// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title BytecodeScan
/// @notice Flags DELEGATECALL (0xF4), SELFDESTRUCT (0xFF) and CALLCODE (0xF2) that appear as
///         real opcodes in a contract's runtime code. PUSH1..PUSH32 immediates are skipped.
/// @dev The whole runtime code is scanned, including any Solidity CBOR metadata trailer. That
///      trailer is data whose 32-byte IPFS hash would otherwise yield a false positive for ~1 in 3
///      ordinary tokens, so a trailer is excluded, but ONLY if it matches one of two exact solc
///      layouts (ipfs+solc, length 0x33; solc-only, length 0x0a). The length field alone is never
///      trusted, so a forged length cannot move the scan boundary. Other layouts (e.g. old bzzr1
///      swarm trailers) are scanned in full and may false-positive (conservative).
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
            let size := extcodesize(t)
            if size {
                let ptr := mload(0x40)
                extcodecopy(t, ptr, 0, size)
                // Exclude a strictly-validated Solidity CBOR metadata trailer from the scan. Only two
                // exact layouts are recognised, and only if none of the variable bytes (hash/version)
                // is 0x5b (JUMPDEST): the EVM does not treat the trailer as data, so a JUMP into a
                // forged 0x5b there could reach hidden opcodes. Otherwise the full code is scanned.
                // Free memory pointer is intentionally not bumped: the buffer is scratch only.
                let l := 0
                if gt(size, 1) {
                    l := or(
                        shl(8, byte(0, mload(add(ptr, sub(size, 2))))),
                        byte(0, mload(add(ptr, sub(size, 1))))
                    )
                }
                if and(gt(size, 0x34), eq(l, 0x33)) {
                    // a2 64 "ipfs" 58 22 <34 bytes ipfs hash> 64 "solc" 43 <3 bytes version> 00 33
                    let st := sub(size, 0x35)
                    if and(
                        eq(shr(192, mload(add(ptr, st))), 0xa264697066735822),
                        eq(shr(208, mload(add(ptr, add(st, 42)))), 0x64736f6c6343)
                    ) {
                        if iszero(or(has5b(add(ptr, add(st, 8)), 34), has5b(add(ptr, add(st, 48)), 3))) {
                            size := st
                        }
                    }
                }
                if and(gt(size, 0x0b), eq(l, 0x0a)) {
                    // a1 64 "solc" 43 <3 bytes version> 00 0a
                    let st := sub(size, 0x0c)
                    if eq(shr(200, mload(add(ptr, st))), 0xa164736f6c6343) {
                        if iszero(has5b(add(ptr, add(st, 7)), 3)) { size := st }
                    }
                }
                let i := 0
                for {} lt(i, size) { i := add(i, 1) } {
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
