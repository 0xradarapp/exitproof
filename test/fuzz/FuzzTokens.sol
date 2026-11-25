// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {BaseToken} from "../fixtures/Tokens.sol";

/// Fixtures for the fuzz / invariant / gas suites. All mint the whole supply to the deployer, and the deployer is
/// exempt from every hook (so it can seed liquidity).

/// @notice Parametric transfer-tax token. Three disjoint transfer classes, each burns its own bps:
///         buy  = transfer FROM the pair            -> buyBps
///         sell = transfer TO the pair               -> sellBps (or reverts while `sellBlocked`)
///         hop  = any other (wallet -> wallet) move  -> hopBps
///         `owner()` is a plain settable slot (0 = no owner).
contract FuzzTaxToken is BaseToken {
    address public immutable deployer;
    address public pair;
    address public owner;
    uint16 public buyBps;
    uint16 public sellBps;
    uint16 public hopBps;
    bool public sellBlocked;

    constructor(uint256 supply) BaseToken("FuzzTax", "FTX", supply) {
        deployer = msg.sender;
    }

    modifier onlyDeployer() {
        require(msg.sender == deployer, "deployer");
        _;
    }

    function initPair(address p) external onlyDeployer {
        require(pair == address(0), "initPair");
        pair = p;
    }

    function setTax(uint16 b, uint16 s, uint16 h) external onlyDeployer {
        require(b <= 10000 && s <= 10000 && h <= 10000, "bps");
        buyBps = b;
        sellBps = s;
        hopBps = h;
    }

    function setSellBlocked(bool v) external onlyDeployer {
        sellBlocked = v;
    }

    function setOwner(address o) external onlyDeployer {
        owner = o;
    }

    function _transfer(address from, address to, uint256 amount) internal override {
        uint256 bps;
        if (from == deployer) {
            bps = 0;
        } else if (from == pair) {
            bps = buyBps;
        } else if (to == pair) {
            require(!sellBlocked, "sell blocked");
            bps = sellBps;
        } else {
            bps = hopBps;
        }
        _moveTaxed(from, to, amount, amount * bps / 10000);
    }
}

/// @notice FuzzTaxToken whose runtime code contains a real (unreachable in practice) DELEGATECALL opcode.
contract FuzzTaxTokenDC is FuzzTaxToken {
    constructor(uint256 supply) FuzzTaxToken(supply) {}

    function hatch() external returns (bool r) {
        assembly {
            if eq(caller(), 0xdead) { r := delegatecall(gas(), 0, 0, 0, 0, 0) }
        }
    }
}

/// @notice FuzzTaxToken whose runtime code contains a real CALLCODE opcode.
contract FuzzTaxTokenCC is FuzzTaxToken {
    constructor(uint256 supply) FuzzTaxToken(supply) {}

    function hatch() external returns (bool r) {
        assembly {
            if eq(caller(), 0xdead) { r := callcode(gas(), 0, 0, 0, 0, 0, 0) }
        }
    }
}

/// @notice Same behaviour as FuzzTaxToken, distinct codehash (used as the registry-attested variant).
contract FuzzTaxTokenS is FuzzTaxToken {
    constructor(uint256 supply) FuzzTaxToken(supply) {}

    function variant() external pure returns (uint256) {
        return 0x5;
    }
}

/// @notice Every non-deployer transfer writes `iters` fresh storage slots (~22.1k gas each): a heavy, honest hook.
contract HeavyHookToken is BaseToken {
    address public immutable deployer;
    uint256 public iters;
    uint256 public nonce;
    mapping(uint256 => uint256) public junk;

    constructor(uint256 supply) BaseToken("Heavy", "HVY", supply) {
        deployer = msg.sender;
    }

    function setIters(uint256 n) external {
        require(msg.sender == deployer, "deployer");
        iters = n;
    }

    function _transfer(address from, address to, uint256 amount) internal override {
        if (from != deployer) {
            uint256 n = nonce;
            uint256 end = n + iters;
            for (; n < end; n++) {
                junk[n] = n + 1;
            }
            nonce = n;
        }
        _move(from, to, amount);
    }
}
