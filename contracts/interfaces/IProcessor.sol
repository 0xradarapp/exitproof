// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice TapeOut processor: evaluates a taped-out circuit on packed input bits.
interface IProcessor {
    function eval(uint256 circuitId, bytes calldata input) external view returns (bytes memory);
}
