// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Solidity port of circuit/spec.py::policy. Output byte = allow | reason << 1.
///         Checked against circuit/truth.json for all 2048 inputs in ExitProofRouter.t.sol.
contract MockProcessor {
    function eval(uint256, bytes calldata input) external pure returns (bytes memory) {
        uint256 x = uint256(uint8(input[0])) | (uint256(uint8(input[1])) << 8);
        (uint8 allow, uint8 reason) = policy(x);
        return abi.encodePacked(uint8(allow | (reason << 1)));
    }

    function policy(uint256 x) public pure returns (uint8 allow, uint8 reason) {
        bool sellOk = x & 1 == 1;
        uint256 st = (x >> 1) & 3;
        uint256 bt = (x >> 3) & 3;
        bool owner = (x >> 5) & 1 == 1;
        bool upg = (x >> 6) & 1 == 1;
        bool dng = (x >> 7) & 1 == 1;
        bool uns = (x >> 8) & 1 == 1;
        uint256 mode = (x >> 9) & 3;
        if (mode == 3) mode = 0;
        uint256 maxTax = mode == 0 ? 0 : 1;
        if (!sellOk) return (0, 1);
        if (st > maxTax) return (0, 2);
        if (bt > maxTax) return (0, 3);
        if (mode == 2) return (1, 0);
        if (upg) return (0, 4);
        if (mode == 1) {
            if (owner && dng) return (0, 5);
            if (owner && uns) return (0, 6);
            return (1, 0);
        }
        if (dng) return (0, 5);
        if (uns) return (0, 6);
        if (owner) return (0, 7);
        return (1, 0);
    }
}

/// @notice Processor returning a fixed output byte (for BadEval tests).
contract FixedProcessor {
    bytes internal out;

    constructor(bytes memory o) {
        out = o;
    }

    function eval(uint256, bytes calldata) external view returns (bytes memory) {
        return out;
    }
}
