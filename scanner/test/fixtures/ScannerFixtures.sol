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

/// @notice Mapping-based admin: `require(_ops[msg.sender])` (no owner getter, no SLOAD==CALLER compare).
contract MappingAdminToken is MiniERC20 {
    mapping(address => bool) private _ops;
    uint256 private _cfg;

    constructor(uint256 supply) MiniERC20(supply) {
        _ops[msg.sender] = true;
    }

    function configure(uint256 v) external {
        require(_ops[msg.sender], "op");
        _cfg = v;
    }

    function _transfer(address from, address to, uint256 a) internal override {
        require(a >= _cfg, "cfg");
        super._transfer(from, to, a);
    }
}

/// @notice Immutable admin: `msg.sender == admin` compiles to CALLER vs a PUSH32 literal.
contract ImmutableAdminToken is MiniERC20 {
    address private immutable admin;
    bool private _frozen;

    constructor(uint256 supply) MiniERC20(supply) {
        admin = msg.sender;
    }

    function configure(uint256 v) external {
        require(msg.sender == admin, "admin");
        _frozen = v != 0;
    }

    function _transfer(address from, address to, uint256 a) internal override {
        require(!_frozen || from == admin, "frozen");
        super._transfer(from, to, a);
    }
}

/// @notice Sells are blocked whenever 0xBEEF holds any native balance: external state read without a CALL.
contract BalanceOracleToken is MiniERC20 {
    constructor(uint256 supply) MiniERC20(supply) {}

    function _transfer(address from, address to, uint256 a) internal override {
        require(address(uint160(0xBEEF)).balance == 0, "gate");
        super._transfer(from, to, a);
    }
}

/// @notice Standard ERC-20 + EIP-2612 permit + EIP-5267, OZ-shaped external surface. Must not be privileged.
contract PermitToken {
    string public name = "Permit";
    string public symbol = "PMT";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => uint256) public nonces;

    bytes32 private constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(uint256 supply) {
        totalSupply = supply;
        balanceOf[msg.sender] = supply;
        emit Transfer(address(0), msg.sender, supply);
    }

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256(bytes(name)), keccak256("1"), block.chainid, address(this)));
    }

    function eip712Domain()
        external
        view
        returns (bytes1, string memory, string memory, uint256, address, bytes32, uint256[] memory)
    {
        return (hex"0f", name, "1", block.chainid, address(this), bytes32(0), new uint256[](0));
    }

    function _approve(address o, address s, uint256 a) internal {
        allowance[o][s] = a;
        emit Approval(o, s, a);
    }

    function approve(address s, uint256 a) external returns (bool) {
        _approve(msg.sender, s, a);
        return true;
    }

    function increaseAllowance(address s, uint256 a) external returns (bool) {
        _approve(msg.sender, s, allowance[msg.sender][s] + a);
        return true;
    }

    function decreaseAllowance(address s, uint256 a) external returns (bool) {
        _approve(msg.sender, s, allowance[msg.sender][s] - a);
        return true;
    }

    function permit(address o, address s, uint256 v, uint256 deadline, uint8 pv, bytes32 r, bytes32 ps) external {
        require(block.timestamp <= deadline, "expired");
        bytes32 h = keccak256(abi.encode(PERMIT_TYPEHASH, o, s, v, nonces[o]++, deadline));
        address signer = ecrecover(keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), h)), pv, r, ps);
        require(signer != address(0) && signer == o, "sig");
        _approve(o, s, v);
    }

    function _move(address f, address t, uint256 a) internal {
        balanceOf[f] -= a;
        balanceOf[t] += a;
        emit Transfer(f, t, a);
    }

    function transfer(address t, uint256 a) external returns (bool) {
        _move(msg.sender, t, a);
        return true;
    }

    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        uint256 al = allowance[f][msg.sender];
        if (al != type(uint256).max) _approve(f, msg.sender, al - a);
        _move(f, t, a);
        return true;
    }
}
