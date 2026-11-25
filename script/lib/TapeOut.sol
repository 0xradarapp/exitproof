// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Live X Layer (chain 196) addresses used by the fork tests and the tape-out tooling.
library XLayer {
    /// TapeOut processor factory (createCPU, isCPU, deployFee in BEM).
    address internal constant TAPEOUT_FACTORY = 0x1f09DAeFA827f02CBb40967cc91b259763760761;
    /// BEM, 8 decimals: pays createCPU deployFee() and the per-call NAND mint protocolFee().
    address internal constant BEM = 0x60e62Efa9405d6873C5deaBD4E6CC91c25363952;
    /// PotatoSwap V2 factory (25 bps pair fee).
    address internal constant POTATO_FACTORY = 0x630DB8E822805c82Ca40a54daE02dd5aC31f7fcF;
    uint16 internal constant POTATO_FEE_BPS = 25;
    address internal constant WOKB = 0xe538905cf8410324e03A5A23C1c177a474D59b2b;
    uint256 internal constant NAND = 0;
}

interface ITapeOutFactory {
    function createCPU(
        string calldata name,
        string calldata symbol,
        string calldata story,
        uint256 transistorSupply,
        uint256 mintPrice
    ) external payable returns (address, address);
    function deployFee() external view returns (uint256);
    function isCPU(address) external view returns (bool);
    function cpuCount() external view returns (uint256);
}

interface ITapeOutProcessor {
    function TAPEOUT_FEE() external view returns (uint256);
    function transistors() external view returns (address);
    function tapeout(bytes calldata nl, uint32 nIn, uint32 nOut) external payable returns (uint256);
    function eval(uint256 id, bytes calldata inputs) external view returns (bytes memory);
    function netlist(uint256 id) external view returns (bytes memory);
    function circuitInfo(uint256 id) external view returns (uint32 nIn, uint32 nOut, uint32 nState, uint32 gateCount);
    function ownerOf(uint256 id) external view returns (address);
}

interface ITransistors {
    function mint(uint256 id, uint256 amount) external payable;
    function balanceOf(address account, uint256 id) external view returns (uint256);
    function protocolFee() external view returns (uint256);
    function mintPrice() external view returns (uint256);
}

interface IERC20Min {
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
}

interface IV2PairFull {
    function mint(address to) external returns (uint256);
    function token0() external view returns (address);
    function getReserves() external view returns (uint112, uint112, uint32);
}

library TapeOut {
    /// @notice createCPU returns (circuits, transistors); do not trust the order: the processor is the one that
    ///         answers TAPEOUT_FEE() and whose transistors() is the other address.
    function processorOf(address a, address b) internal view returns (address processor, address transistors) {
        if (_isProcessor(a, b)) return (a, b);
        if (_isProcessor(b, a)) return (b, a);
        revert("TapeOut: no processor in pair");
    }

    function _isProcessor(address p, address other) private view returns (bool) {
        (bool ok, bytes memory r) = p.staticcall(abi.encodeCall(ITapeOutProcessor.transistors, ()));
        if (!ok || r.length != 32) return false;
        if (abi.decode(r, (address)) != other) return false;
        (ok, r) = p.staticcall(abi.encodeCall(ITapeOutProcessor.TAPEOUT_FEE, ()));
        return ok && r.length == 32;
    }

    /// @notice Circuit input bytes for an 11-bit fact word (little-endian, as ExitProofRouter packs them).
    function input(uint256 x) internal pure returns (bytes memory) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return abi.encodePacked(uint8(x), uint8(x >> 8));
    }
}
