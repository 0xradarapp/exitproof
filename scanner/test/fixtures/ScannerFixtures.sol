// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// Scanner-only fixtures (adversarial cases for the off-chain scanner). Build: node scanner/test/fixtures/build.mjs

abstract contract MiniERC20 {
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(uint256 supply) {
        totalSupply = supply;
        balanceOf[msg.sender] = supply;
        emit Transfer(address(0), msg.sender, supply);
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        emit Approval(msg.sender, s, a);
        return true;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        _transfer(msg.sender, to, a);
        return true;
    }

    function transferFrom(address from, address to, uint256 a) external returns (bool) {
        uint256 al = allowance[from][msg.sender];
        if (al != type(uint256).max) {
            require(al >= a, "allowance");
            allowance[from][msg.sender] = al - a;
        }
        _transfer(from, to, a);
        return true;
    }

    function _transfer(address from, address to, uint256 a) internal virtual {
        require(balanceOf[from] >= a, "balance");
        balanceOf[from] -= a;
        balanceOf[to] += a;
        emit Transfer(from, to, a);
    }
}

/// @notice Hidden owner: no owner()/getOwner(), admin kept in a custom slot, unlisted setter name.
contract HiddenOwnerToken is MiniERC20 {
    bytes32 private constant ADMIN_SLOT = keccak256("hidden.admin");
    uint256 public cfg;

    constructor(uint256 supply) MiniERC20(supply) {
        bytes32 s = ADMIN_SLOT;
        assembly {
            sstore(s, caller())
        }
    }

    function _admin() internal view returns (address a) {
        bytes32 s = ADMIN_SLOT;
        assembly {
            a := sload(s)
        }
    }

    function configure(uint256 v) external {
        require(msg.sender == _admin(), "nope");
        cfg = v;
    }

    function _transfer(address from, address to, uint256 a) internal override {
        uint256 fee = a * cfg / 10000;
        super._transfer(from, to, a - fee);
        if (fee > 0) {
            balanceOf[from] -= fee;
            totalSupply -= fee;
        }
    }
}

interface IFeeOracle {
    function feeBps(address from, address to) external view returns (uint256);
}

/// @notice No owner at all, but every transfer asks an external (stored) oracle for the fee.
contract OracleFeeToken is MiniERC20 {
    address public immutable oracle;

    constructor(uint256 supply, address o) MiniERC20(supply) {
        oracle = o;
    }

    function _transfer(address from, address to, uint256 a) internal override {
        uint256 fee = a * IFeeOracle(oracle).feeBps(from, to) / 10000;
        super._transfer(from, to, a - fee);
        if (fee > 0) {
            balanceOf[from] -= fee;
            totalSupply -= fee;
        }
    }
}

/// @notice balanceOf() reverts for the simulator's synthetic holder (forces simulate's unwrapped reads to throw).
contract HolderRevertToken {
    uint256 public totalSupply;
    mapping(address => uint256) internal _bal;

    event Transfer(address indexed from, address indexed to, uint256 value);

    constructor(uint256 supply) {
        totalSupply = supply;
        _bal[msg.sender] = supply;
        emit Transfer(address(0), msg.sender, supply);
    }

    function balanceOf(address a) external view returns (uint256) {
        require(a != 0x000000000000000000000000000000000000e417, "no");
        return _bal[a];
    }

    function approve(address, uint256) external pure returns (bool) {
        return true;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        _bal[msg.sender] -= a;
        _bal[to] += a;
        emit Transfer(msg.sender, to, a);
        return true;
    }

    function transferFrom(address from, address to, uint256 a) external returns (bool) {
        _bal[from] -= a;
        _bal[to] += a;
        emit Transfer(from, to, a);
        return true;
    }
}
