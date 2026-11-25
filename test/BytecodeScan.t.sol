// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {BytecodeScan} from "../contracts/lib/BytecodeScan.sol";

contract ScanHarness {
    function scan(address t) external view returns (bool d, bool s, bool c) {
        return BytecodeScan.scan(t);
    }
}

contract PlainToken {
    mapping(address => uint256) public balanceOf;
    uint256 public totalSupply;

    constructor() {
        totalSupply = 1e24;
        balanceOf[msg.sender] = 1e24;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        return true;
    }
}

contract BytecodeScanTest is Test {
    ScanHarness h = new ScanHarness();
    address constant T = address(0x7A57);

    function _scan(bytes memory code) internal returns (bool d, bool s, bool c) {
        vm.etch(T, code);
        return h.scan(T);
    }

    function test_plainErc20IsClean() public {
        // Compiled metadata hash is arbitrary and changes with any source edit, so pin it to a
        // hash with no 0x5b/f2/f4/ff (honest trailer). The code body is real solc output.
        bytes memory code = address(new PlainToken()).code;
        require(code.length > 53, "short");
        uint256 st = code.length - 53;
        for (uint256 i = st + 8; i < st + 42; ++i) code[i] = 0x11;
        (bool d, bool s, bool c) = _scan(code);
        assertFalse(d);
        assertFalse(s);
        assertFalse(c);
    }

    function test_minimalProxyHasDelegatecall() public {
        // EIP-1167 runtime; 0xf4 is a real DELEGATECALL, 20-byte impl is PUSH20 data
        bytes memory code = abi.encodePacked(
            hex"363d3d373d3d3d363d73", address(0xBEEF), hex"5af43d82803e903d91602b57fd5bf3"
        );
        (bool d, bool s, bool c) = _scan(code);
        assertTrue(d);
        assertFalse(s);
        assertFalse(c);
    }

    function test_realSelfdestruct() public {
        (bool d, bool s, bool c) = _scan(hex"6000ff");
        assertFalse(d);
        assertTrue(s);
        assertFalse(c);
    }

    function test_realCallcode() public {
        (bool d, bool s, bool c) = _scan(hex"5bf2");
        assertFalse(d);
        assertFalse(s);
        assertTrue(c);
    }

    function test_opcodesInsidePush32DataIgnored() public {
        bytes memory code = abi.encodePacked(
            hex"7f", hex"f4fff2", new bytes(29), hex"00"
        );
        assertEq(code.length, 34);
        (bool d, bool s, bool c) = _scan(code);
        assertFalse(d);
        assertFalse(s);
        assertFalse(c);
    }

    function test_push1DataIgnoredThenRealOpAfter() public {
        // PUSH1 0xf4 ; PUSH1 0xff ; PUSH1 0xf2 -> all data, clean
        (bool d, bool s, bool c) = _scan(hex"60f460ff60f2");
        assertFalse(d || s || c);
        // PUSH1 0xf4 ; DELEGATECALL
        (d, s, c) = _scan(hex"60f4f4");
        assertTrue(d);
        assertFalse(s);
        assertFalse(c);
    }

    function test_pushImmediateBoundary() public {
        // PUSH2 f4 f4 then real f4 : first two f4 are data, third is op
        (bool d,,) = _scan(hex"61f4f4");
        assertFalse(d);
        (d,,) = _scan(hex"61f4f4f4");
        assertTrue(d);
        // PUSH32 data spans exactly 32 bytes; byte 33 is an opcode
        bytes memory code = abi.encodePacked(hex"7f", new bytes(31), hex"f4", hex"ff");
        (bool d2, bool s2,) = _scan(code);
        assertFalse(d2);
        assertTrue(s2);
    }

    function test_truncatedPushAtEndStopsCleanly() public {
        (bool d, bool s, bool c) = _scan(hex"7ff4ff");
        assertFalse(d || s || c);
    }

    function test_emptyAndEoaAreClean() public view {
        (bool d, bool s, bool c) = h.scan(address(0x1234));
        assertFalse(d || s || c);
    }

    function test_gas24KB() public {
        bytes memory code = new bytes(24576);
        for (uint256 i; i < code.length; ++i) code[i] = 0x5b;
        vm.etch(T, code);
        uint256 g = gasleft();
        h.scan(T);
        emit log_named_uint("scan gas, 24KB clean (JUMPDEST)", g - gasleft());

        // worst-ish case: every byte a PUSH1 / data alternating, with real hit at end
        for (uint256 i; i < code.length; ++i) code[i] = (i % 2 == 0) ? bytes1(0x60) : bytes1(0xf4);
        vm.etch(T, code);
        g = gasleft();
        h.scan(T);
        emit log_named_uint("scan gas, 24KB PUSH1/data alternating", g - gasleft());
    }

    function _ipfsTrailer(bytes32 hi, bytes2 hi2) internal pure returns (bytes memory) {
        return abi.encodePacked(hex"a264697066735822", hi, hi2, hex"64736f6c63430008180033");
    }

    function test_metadataHashBytesAreNotFlagged() public {
        // hash full of f4/ff/f2 inside a valid ipfs trailer
        bytes memory code = abi.encodePacked(hex"5b00", _ipfsTrailer(bytes32(type(uint256).max), 0xf4f2));
        (bool d, bool s, bool c) = _scan(code);
        assertFalse(d || s || c);
    }

    function test_solcOnlyTrailerNotFlagged() public {
        // honest solc-only trailer is scanned in full and is clean
        (bool d, bool s, bool c) = _scan(hex"5b00a164736f6c6343000818000a");
        assertFalse(d || s || c);
        // forged version bytes f4 f4 f4 reachable by fall-through (a1=LOG1, 64=PUSH5)
        (d,,) = _scan(hex"00a164736f6c6343f4f4f4000a");
        assertTrue(d);
    }

    function test_realOpBeforeTrailerStillFlagged() public {
        bytes memory code = abi.encodePacked(hex"f4", _ipfsTrailer(bytes32(0), 0x0000));
        (bool d,,) = _scan(code);
        assertTrue(d);
    }

    function test_forgedLengthDoesNotHideCode() public {
        // claims a huge/short trailer but is not a valid solc layout: scanned in full
        (bool d,,) = _scan(hex"5bf45b5b5b5b5b5b0033");
        assertTrue(d);
        (d,,) = _scan(abi.encodePacked(hex"f4", new bytes(60), hex"0033"));
        assertTrue(d);
        // layout almost right (wrong cbor header byte) -> not excluded
        bytes memory code = abi.encodePacked(hex"a364697066735822", bytes32(0), hex"0000", hex"64736f6c63430008180033");
        (d,,) = _scan(abi.encodePacked(code, hex"f4"));
        assertTrue(d);
    }

    function test_forgedJumpdestInIpfsHashStillFlagged() public {
        // valid ipfs header/footer, hash region = 5b 5a f4 ... (reachable via JUMP)
        bytes memory code = abi.encodePacked(hex"00", _ipfsTrailer(bytes32(bytes3(hex"5b5af4")), 0x0000));
        (bool d,,) = _scan(code);
        assertTrue(d);
    }

    function test_forgedJumpdestInSolcOnlyVersionStillFlagged() public {
        (bool d,,) = _scan(hex"00a164736f6c63435b5af4000a");
        assertTrue(d);
    }

    function test_forgedJumpdestInIpfsVersionStillFlagged() public {
        bytes memory code = abi.encodePacked(
            hex"00a264697066735822", bytes32(0), hex"0000", hex"64736f6c63435b5af40033"
        );
        (bool d,,) = _scan(code);
        assertTrue(d);
    }

    function test_honestTrailerWithoutJumpdestStillSkipped() public {
        bytes memory code = abi.encodePacked(hex"00", _ipfsTrailer(hex"f4fff2f4fff2f4fff2f4fff2f4fff2f4fff2f4fff2f4fff2", 0xf4ff));
        (bool d, bool s, bool c) = _scan(code);
        assertFalse(d || s || c);
    }

    function test_tinyCodeNoUnderflow() public {
        (bool d, bool s, bool c) = _scan(hex"00");
        assertFalse(d || s || c);
        (d,,) = _scan(hex"f4");
        assertTrue(d);
    }

    function test_pushOverrunIntoIpfsTrailerStillFlagged() public {
        // PUSH32 whose immediates swallow header (8) + hash bytes 0..23; hash byte 24 = f4 executes
        bytes memory hash = new bytes(32);
        hash[24 - 0] = 0xf4;
        bytes memory code;
        code = abi.encodePacked(hex"7f", _ipfsTrailerBytes(hash, hex"0000"));
        // code = 7f + trailer; PUSH32 covers 32 bytes after it = header(8)+hash[0..23]; hash[24] is executed
        (bool d,,) = _scan(code);
        assertTrue(d);
    }

    function test_honestAlignedTrailerWithF4InHashSkipped() public {
        bytes memory hash = new bytes(32);
        hash[24] = 0xf4;
        bytes memory code = abi.encodePacked(hex"6001", _ipfsTrailerBytes(hash, hex"0000"));
        (bool d, bool s, bool c) = _scan(code);
        assertFalse(d || s || c);
    }

    function _ipfsTrailerBytes(bytes memory hash32, bytes2 hi2) internal pure returns (bytes memory) {
        return abi.encodePacked(hex"a264697066735822", hash32, hi2, hex"64736f6c63430008180033");
    }
}
