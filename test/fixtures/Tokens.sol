// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// Test fixtures: one clean token and a zoo of honeypot patterns. All mint their whole supply to the
/// deployer. "Pair-aware" fixtures learn their pair via a one-shot `initPair` and exempt the deployer
/// (so it can seed liquidity); a "sell" is any transfer to the pair from someone other than the deployer.

abstract contract BaseToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory n, string memory s, uint256 supply) {
        name = n;
        symbol = s;
        totalSupply = supply;
        balanceOf[msg.sender] = supply;
        emit Transfer(address(0), msg.sender, supply);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) {
            require(a >= amount, "allowance");
            allowance[from][msg.sender] = a - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }

    /// @dev Moves `amount` out of `from`, burns `fee` of it, credits the rest to `to`.
    function _moveTaxed(address from, address to, uint256 amount, uint256 fee) internal {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount - fee;
        totalSupply -= fee;
        emit Transfer(from, to, amount - fee);
        if (fee > 0) emit Transfer(from, address(0), fee);
    }

    function _transfer(address from, address to, uint256 amount) internal virtual {
        _move(from, to, amount);
    }
}

abstract contract PairAware is BaseToken {
    address public immutable deployer;
    address public pair;

    constructor() {
        deployer = msg.sender;
    }

    function initPair(address p) external {
        require(msg.sender == deployer && pair == address(0), "initPair");
        pair = p;
    }

    function _isSell(address from, address to) internal view returns (bool) {
        return to == pair && from != deployer;
    }
}

/// @notice Plain ERC20, no owner, no hooks.
contract CleanToken is BaseToken {
    constructor(uint256 supply) BaseToken("Clean", "CLEAN", supply) {}
}

/// @notice Clean token with an Ownable-style `owner()` but no setters.
contract OwnedCleanToken is BaseToken {
    address public owner;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    constructor(uint256 supply) BaseToken("Owned", "OWN", supply) {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    function renounceOwnership() external {
        require(msg.sender == owner, "owner");
        emit OwnershipTransferred(owner, address(0));
        owner = address(0);
    }
}

/// @notice Burns `bps` of every transfer (so both buys and sells are taxed).
contract FeeToken is BaseToken {
    uint256 public immutable feeBps;

    constructor(uint256 supply, uint256 bps) BaseToken("Fee", "FEE", supply) {
        feeBps = bps;
    }

    function _transfer(address from, address to, uint256 amount) internal override {
        _moveTaxed(from, to, amount, amount * feeBps / 10000);
    }
}

/// @notice Every receiver of a transfer from the pair is blacklisted and can never send again.
contract BlacklistOnBuy is PairAware {
    mapping(address => bool) public blacklisted;

    constructor(uint256 supply) BaseToken("Blacklist", "BL", supply) {}

    function _transfer(address from, address to, uint256 amount) internal override {
        require(!blacklisted[from], "blacklisted");
        if (from == pair) blacklisted[to] = true;
        _move(from, to, amount);
    }
}

/// @notice 99% tax on sells.
contract SellTax99 is PairAware {
    constructor(uint256 supply) BaseToken("Tax99", "T99", supply) {}

    function _transfer(address from, address to, uint256 amount) internal override {
        _moveTaxed(from, to, amount, _isSell(from, to) ? amount * 99 / 100 : 0);
    }
}

/// @notice Max-sell honeypot: a transfer TO the pair may not exceed 1% of supply. Buys are unlimited.
contract MaxTxToken is PairAware {
    uint256 public immutable maxTx;

    constructor(uint256 supply) BaseToken("MaxTx", "MTX", supply) {
        maxTx = supply / 100;
    }

    function _transfer(address from, address to, uint256 amount) internal override {
        if (_isSell(from, to)) require(amount <= maxTx, "maxTx");
        _move(from, to, amount);
    }
}

/// @notice No selling in the same block in which the seller received tokens.
contract CooldownToken is PairAware {
    mapping(address => uint256) public lastIn;

    constructor(uint256 supply) BaseToken("Cooldown", "CD", supply) {}

    function _transfer(address from, address to, uint256 amount) internal override {
        if (_isSell(from, to)) require(lastIn[from] != block.number, "cooldown");
        lastIn[to] = block.number;
        _move(from, to, amount);
    }
}

/// @notice Sells revert until the owner enables trading.
contract TradingDisabled is PairAware {
    address public owner;
    bool public tradingEnabled;

    constructor(uint256 supply) BaseToken("Disabled", "DIS", supply) {
        owner = msg.sender;
    }

    function enableTrading() external {
        require(msg.sender == owner, "owner");
        tradingEnabled = true;
    }

    function _transfer(address from, address to, uint256 amount) internal override {
        if (_isSell(from, to)) require(tradingEnabled, "trading disabled");
        _move(from, to, amount);
    }
}

/// @notice Sell fee starts at 0 (passes any probe) but the owner can raise it to 100% at any time.
contract TimeBombToken is PairAware {
    address public owner;
    uint256 public sellFeeBps;

    constructor(uint256 supply) BaseToken("TimeBomb", "BOMB", supply) {
        owner = msg.sender;
    }

    function setSellFee(uint256 bps) external {
        require(msg.sender == owner, "owner");
        require(bps <= 10000, "bps");
        sellFeeBps = bps;
    }

    function _transfer(address from, address to, uint256 amount) internal override {
        _moveTaxed(from, to, amount, _isSell(from, to) ? amount * sellFeeBps / 10000 : 0);
    }
}

/// @notice Sell transfers burn all available gas.
contract GasBombToken is PairAware {
    uint256 public sink;

    constructor(uint256 supply) BaseToken("GasBomb", "GAS", supply) {}

    function _transfer(address from, address to, uint256 amount) internal override {
        if (_isSell(from, to)) {
            while (sink != type(uint256).max) {
                unchecked {
                    sink++;
                }
            }
        }
        _move(from, to, amount);
    }
}

/// @notice Sell transfers revert with ~1 MB of revert data.
contract ReturnBombToken is PairAware {
    constructor(uint256 supply) BaseToken("ReturnBomb", "RB", supply) {}

    function _transfer(address from, address to, uint256 amount) internal override {
        if (_isSell(from, to)) {
            assembly {
                revert(0, 1000000)
            }
        }
        _move(from, to, amount);
    }
}

/// @notice Records tx.origin of every buyer; that origin can never sell in a LATER block. A same-tx
///         probe passes, so ExitProof allows it: a documented limitation (see router test).
contract TxOriginTrap is PairAware {
    mapping(address => uint256) public boughtAt;

    constructor(uint256 supply) BaseToken("Origin", "ORI", supply) {}

    function _transfer(address from, address to, uint256 amount) internal override {
        if (_isSell(from, to)) {
            uint256 b = boughtAt[tx.origin];
            require(b == 0 || b == block.number, "trapped");
        }
        if (from == pair) boughtAt[tx.origin] = block.number;
        _move(from, to, amount);
    }
}

/// @notice ERC20 implementation used behind ProxyToken (storage lives in the proxy).
contract ProxyImpl {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool private initialized;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function initialize(uint256 supply, address holder) external {
        require(!initialized, "init");
        initialized = true;
        name = "Proxy";
        symbol = "PRX";
        totalSupply = supply;
        balanceOf[holder] = supply;
        emit Transfer(address(0), holder, supply);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) {
            require(a >= amount, "allowance");
            allowance[from][msg.sender] = a - amount;
        }
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

/// @notice ERC1967-style upgradeable proxy: admin can swap the implementation at will.
contract ProxyToken {
    bytes32 internal constant IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    bytes32 internal constant ADMIN_SLOT = 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103;

    event Upgraded(address indexed implementation);

    constructor(address impl, bytes memory init) {
        assembly {
            sstore(IMPL_SLOT, impl)
            sstore(ADMIN_SLOT, caller())
        }
        emit Upgraded(impl);
        (bool ok,) = impl.delegatecall(init);
        require(ok, "init");
    }

    function upgradeTo(address impl) external {
        address admin;
        assembly {
            admin := sload(ADMIN_SLOT)
        }
        require(msg.sender == admin, "admin");
        assembly {
            sstore(IMPL_SLOT, impl)
        }
        emit Upgraded(impl);
    }

    fallback() external payable {
        assembly {
            let impl := sload(IMPL_SLOT)
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), impl, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            if iszero(ok) { revert(0, returndatasize()) }
            return(0, returndatasize())
        }
    }

    receive() external payable {}
}

/// @notice Honest token whose bytecode contains a reachable-but-harmless DELEGATECALL: the on-chain
///         opcode scan flags it, an off-chain (reachability-precise) attestation can clear it.
contract ScanFalsePositiveToken is BaseToken {
    constructor(uint256 supply) BaseToken("FalsePos", "FP", supply) {}

    function ping() external returns (bool r) {
        assembly {
            if eq(caller(), 0xdead) { r := delegatecall(gas(), 0, 0, 0, 0, 0) }
        }
    }
}

// ---- owner() probe robustness ----

contract OwnerRevertsToken is BaseToken {
    constructor(uint256 supply) BaseToken("OwnRev", "OR", supply) {}

    function owner() external pure returns (address) {
        revert("no owner");
    }
}

contract OwnerShortToken is BaseToken {
    constructor(uint256 supply) BaseToken("OwnShort", "OS", supply) {}

    function owner() external pure returns (address) {
        assembly {
            mstore(0, 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff)
            return(0, 16)
        }
    }
}

contract OwnerGarbageToken is BaseToken {
    constructor(uint256 supply) BaseToken("OwnGarbage", "OG", supply) {}

    function owner() external pure returns (address) {
        assembly {
            mstore(0, 0xdeadbeef00000000000000000000000000000000000000000000000000000001)
            return(0, 32)
        }
    }
}

contract OwnerGasHogToken is BaseToken {
    uint256 public sink;

    constructor(uint256 supply) BaseToken("OwnHog", "OH", supply) {}

    function owner() external view returns (address) {
        uint256 i;
        while (i != type(uint256).max) {
            unchecked {
                i += sink + 1;
            }
        }
        // forge-lint: disable-next-line(unsafe-typecast)
        return address(uint160(i));
    }
}

interface IRouterReenter {
    function buyETH(address factory, address token, uint256 minOut, uint8 mode, address to, uint256 deadline)
        external
        payable
        returns (uint256);
}

/// @notice On buy, tries to re-enter the router; records whether the re-entry succeeded.
contract ReentrantToken is PairAware {
    address public router;
    address public factory;
    bool public reentered;
    bool public attempted;

    constructor(uint256 supply) BaseToken("Reenter", "RE", supply) {}

    function setTarget(address r, address f) external {
        require(msg.sender == deployer, "deployer");
        router = r;
        factory = f;
    }

    function _transfer(address from, address to, uint256 amount) internal override {
        if (from == pair && router != address(0) && !attempted) {
            attempted = true;
            (bool ok,) = router.call(
                abi.encodeCall(IRouterReenter.buyETH, (factory, address(this), 0, 2, to, type(uint256).max))
            );
            reentered = ok;
        }
        _move(from, to, amount);
    }
}

/// @notice On sells, reverts with data shaped exactly like the router's `ProbeResult(true, 1e18)`, trying to
///         forge a successful probe. The router must never bubble foreign revert data out of probeSell.
contract ForgedProbeToken is PairAware {
    constructor(uint256 supply) BaseToken("Forge", "FRG", supply) {}

    function _transfer(address from, address to, uint256 amount) internal override {
        if (_isSell(from, to)) {
            bytes memory d = abi.encodeWithSignature("ProbeResult(bool,uint256)", true, 1e18);
            assembly {
                revert(add(d, 32), mload(d))
            }
        }
        _move(from, to, amount);
    }
}

/// @notice Second-hop trap (reviewer PoC): blacklists the receiver of any transfer that neither comes from nor goes
///         to the pair. The router's forward to the buyer is such a hop, so the buyer is trapped after delivery.
contract SecondHopTrap is PairAware {
    mapping(address => bool) public blacklisted;

    constructor(uint256 supply) BaseToken("SecondHop", "HOP", supply) {}

    function _transfer(address from, address to, uint256 amount) internal override {
        require(!blacklisted[from], "blacklisted");
        if (from != pair && to != pair && from != deployer) blacklisted[to] = true;
        _move(from, to, amount);
    }
}

/// @notice Reports an astronomically large balance for anyone who bought from the pair, and only moves the real
///         balance on transfer. Used to check that tax math saturates instead of panicking.
contract LyingBalanceToken {
    string public constant name = "Liar";
    string public constant symbol = "LIE";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    address public immutable deployer;
    address public pair;
    mapping(address => uint256) internal real;
    mapping(address => bool) public inflated;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);

    constructor(uint256 supply) {
        deployer = msg.sender;
        totalSupply = supply;
        real[msg.sender] = supply;
    }

    function initPair(address p) external {
        require(msg.sender == deployer && pair == address(0), "initPair");
        pair = p;
    }

    function balanceOf(address a) external view returns (uint256) {
        return real[a] + (inflated[a] ? 1 << 250 : 0);
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        if (inflated[from] && amount > real[from]) amount = real[from];
        if (from == pair) inflated[to] = true;
        real[from] -= amount;
        real[to] += amount;
        emit Transfer(from, to, amount);
    }
}
