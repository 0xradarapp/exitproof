// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice WETH9-style wrapped native token.
contract MockWOKB {
    string public constant name = "Wrapped OKB";
    string public constant symbol = "WOKB";
    uint8 public constant decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function totalSupply() external view returns (uint256) {
        return address(this).balance;
    }

    function deposit() public payable {
        balanceOf[msg.sender] += msg.value;
        emit Transfer(address(0), msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        emit Transfer(msg.sender, address(0), amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "WOKB: send");
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        emit Approval(msg.sender, s, a);
        return true;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        return transferFrom(msg.sender, to, a);
    }

    function transferFrom(address from, address to, uint256 a) public returns (bool) {
        if (from != msg.sender && allowance[from][msg.sender] != type(uint256).max) {
            allowance[from][msg.sender] -= a;
        }
        balanceOf[from] -= a;
        balanceOf[to] += a;
        emit Transfer(from, to, a);
        return true;
    }

    receive() external payable {
        deposit();
    }
}

/// @notice Minimal Uniswap-V2-style pair with a configurable fee in bps on a 10000 basis
///         (PotatoSwap: 25 -> K check on balance*10000 - amountIn*25). No LP token accounting.
contract MockV2Pair {
    address public factory;
    address public token0;
    address public token1;
    uint16 public feeBps;
    uint112 private reserve0;
    uint112 private reserve1;
    uint32 private blockTimestampLast;
    uint256 private unlocked = 1;

    event Swap(address indexed sender, uint256 a0In, uint256 a1In, uint256 a0Out, uint256 a1Out, address indexed to);
    event Sync(uint112 reserve0, uint112 reserve1);

    modifier lock() {
        require(unlocked == 1, "V2: LOCKED");
        unlocked = 0;
        _;
        unlocked = 1;
    }

    constructor() {
        factory = msg.sender;
    }

    function initialize(address t0, address t1, uint16 fee) external {
        require(msg.sender == factory, "V2: FORBIDDEN");
        token0 = t0;
        token1 = t1;
        feeBps = fee;
    }

    function getReserves() public view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, blockTimestampLast);
    }

    function _bal(address t) private view returns (uint256) {
        (bool ok, bytes memory d) = t.staticcall(abi.encodeWithSignature("balanceOf(address)", address(this)));
        require(ok && d.length >= 32, "V2: BALANCE");
        return abi.decode(d, (uint256));
    }

    function _safeTransfer(address token, address to, uint256 value) private {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSignature("transfer(address,uint256)", to, value));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "V2: TRANSFER_FAILED");
    }

    function _update(uint256 b0, uint256 b1) private {
        require(b0 <= type(uint112).max && b1 <= type(uint112).max, "V2: OVERFLOW");
        // forge-lint: disable-next-line(unsafe-typecast)
        reserve0 = uint112(b0);
        // forge-lint: disable-next-line(unsafe-typecast)
        reserve1 = uint112(b1);
        blockTimestampLast = uint32(block.timestamp);
        emit Sync(reserve0, reserve1);
    }

    /// @notice Liquidity add without LP shares: syncs reserves to balances.
    function mint(address) external lock returns (uint256) {
        _update(_bal(token0), _bal(token1));
        return 0;
    }

    function sync() external lock {
        _update(_bal(token0), _bal(token1));
    }

    function _checkK(uint256 r0, uint256 r1, uint256 o0, uint256 o1) private returns (uint256 a0In, uint256 a1In) {
        uint256 b0 = _bal(token0);
        uint256 b1 = _bal(token1);
        a0In = b0 > r0 - o0 ? b0 - (r0 - o0) : 0;
        a1In = b1 > r1 - o1 ? b1 - (r1 - o1) : 0;
        require(a0In > 0 || a1In > 0, "V2: INSUFFICIENT_INPUT_AMOUNT");
        require((b0 * 10000 - a0In * feeBps) * (b1 * 10000 - a1In * feeBps) >= r0 * r1 * 1e8, "V2: K");
        _update(b0, b1);
    }

    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata) external lock {
        require(amount0Out > 0 || amount1Out > 0, "V2: INSUFFICIENT_OUTPUT_AMOUNT");
        (uint112 r0, uint112 r1,) = getReserves();
        require(amount0Out < r0 && amount1Out < r1, "V2: INSUFFICIENT_LIQUIDITY");
        require(to != token0 && to != token1, "V2: INVALID_TO");
        if (amount0Out > 0) _safeTransfer(token0, to, amount0Out);
        if (amount1Out > 0) _safeTransfer(token1, to, amount1Out);
        (uint256 a0In, uint256 a1In) = _checkK(r0, r1, amount0Out, amount1Out);
        emit Swap(msg.sender, a0In, a1In, amount0Out, amount1Out, to);
    }
}

contract MockV2Factory {
    uint16 public immutable feeBps;
    mapping(address => mapping(address => address)) public getPair;
    address[] public allPairs;

    event PairCreated(address indexed token0, address indexed token1, address pair, uint256);

    constructor(uint16 fee) {
        feeBps = fee;
    }

    function createPair(address a, address b) external returns (address pair) {
        require(a != b, "V2: IDENTICAL");
        (address t0, address t1) = a < b ? (a, b) : (b, a);
        require(t0 != address(0), "V2: ZERO");
        require(getPair[t0][t1] == address(0), "V2: EXISTS");
        MockV2Pair p = new MockV2Pair();
        p.initialize(t0, t1, feeBps);
        pair = address(p);
        getPair[t0][t1] = pair;
        getPair[t1][t0] = pair;
        allPairs.push(pair);
        emit PairCreated(t0, t1, pair, allPairs.length);
    }
}
