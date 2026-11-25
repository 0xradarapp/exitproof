// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// Regression fixtures for the final audits (fable-security-audit F-01/F-02/F-06/F-07, fable-functional-audit F2) and
/// for the post-transfer sell semantics. Minimal ERC-20s that mint their liquidity straight to a pre-created pair, so no
/// deployer exemption is needed. Ported from the audit PoCs (/tmp/ep-audit/poc-forge) plus new swap-back and
/// reserve-manipulation fixtures.

interface IPairLike {
    function getReserves() external view returns (uint112, uint112, uint32);
    function token0() external view returns (address);
    function swap(uint256 a0, uint256 a1, address to, bytes calldata data) external;
    function sync() external;
    function skim(address to) external;
}

abstract contract AuditERC20 {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    address public immutable pair;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory n, address pair_, uint256 liq, uint256 rest) {
        name = n;
        symbol = n;
        pair = pair_;
        totalSupply = liq + rest;
        balanceOf[pair_] = liq;
        balanceOf[msg.sender] = rest;
        emit Transfer(address(0), pair_, liq);
        emit Transfer(address(0), msg.sender, rest);
    }

    function approve(address spender, uint256 amount) external virtual returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        _beforeTransferFrom(from, to);
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) {
            require(a >= amount, "allowance");
            allowance[from][msg.sender] = a - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    function _beforeTransferFrom(address from, address to) internal virtual {}

    function _transfer(address from, address to, uint256 amount) internal virtual {
        _move(from, to, amount);
    }

    function _move(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }

    function _mint(address to, uint256 amount) internal {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function _burnFrom(address from, uint256 amount) internal {
        balanceOf[from] -= amount;
        totalSupply -= amount;
        emit Transfer(from, address(0), amount);
    }

    function _isSell(address from, address to) internal view returns (bool) {
        return to == pair && from != pair && from != address(this);
    }
}

// ------------------------------------------------------------------ F-01 / F-02 / F-06 (audit PoCs)

/// @notice F-01: every hop except router -> buyer is honest; the delivery to tx.origin is skimmed 99%.
contract DeliverySkim is AuditERC20 {
    constructor(address p, uint256 liq, uint256 rest) AuditERC20("SKIM", p, liq, rest) {}

    function _transfer(address from, address to, uint256 amount) internal override {
        if (to == tx.origin) {
            uint256 keep = amount / 100;
            _move(from, address(this), amount - keep);
            amount = keep;
        }
        _move(from, to, amount);
    }
}

/// @notice F-02: transfer() is honest, transferFrom() into the pair always fails (every DEX-router sell).
contract TransferFromTrap is AuditERC20 {
    constructor(address p, uint256 liq, uint256 rest) AuditERC20("TFTRAP", p, liq, rest) {}

    function _beforeTransferFrom(address, address to) internal view override {
        require(to != pair, "no router sells");
    }
}

/// @notice F-02 variant: approve() returns true but records nothing, so no spender can ever move a holder's tokens.
contract ApproveNoop is AuditERC20 {
    constructor(address p, uint256 liq, uint256 rest) AuditERC20("NOAPP", p, liq, rest) {}

    function approve(address spender, uint256 amount) external override returns (bool) {
        emit Approval(msg.sender, spender, amount);
        return true;
    }
}

/// @notice Mitigation C: sells are only accepted from code-less sellers (an "EOA only" rule). The old probe sold from
///         a holder with runtime code; the code-less holder must pass, like a wallet does.
contract EoaOnlySeller is AuditERC20 {
    constructor(address p, uint256 liq, uint256 rest) AuditERC20("EOAONLY", p, liq, rest) {}

    function _transfer(address from, address to, uint256 amount) internal override {
        if (_isSell(from, to)) require(from.code.length == 0, "contract seller");
        _move(from, to, amount);
    }
}

/// @notice F-06: behaviour configured in STORAGE by the constructor (no immutables, so every instance shares the codehash).
contract StorageConfigured {
    string public name = "CFG";
    string public symbol = "CFG";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    address public pair;
    uint256 private _sellUntil;

    constructor(address pair_, uint256 liq, uint256 sellUntil_) {
        pair = pair_;
        _sellUntil = sellUntil_;
        totalSupply = liq;
        balanceOf[pair_] = liq;
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        _t(msg.sender, to, a);
        return true;
    }

    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        if (allowance[f][msg.sender] != type(uint256).max) allowance[f][msg.sender] -= a;
        _t(f, to, a);
        return true;
    }

    function _t(address f, address to, uint256 a) internal {
        // forge-lint: disable-next-line(block-timestamp)
        if (to == pair) require(block.timestamp <= _sellUntil, "closed");
        balanceOf[f] -= a;
        balanceOf[to] += a;
    }
}

/// @notice What a standard V2 router does on a sell: pull the seller's tokens into the pair with transferFrom.
contract MiniDexRouter {
    function sellPull(address token, address pair, uint256 amount) external {
        (bool ok, bytes memory d) =
            token.call(abi.encodeWithSignature("transferFrom(address,address,uint256)", msg.sender, pair, amount));
        require(ok && (d.length == 0 || abi.decode(d, (bool))), "TransferHelper: TRANSFER_FROM_FAILED");
    }

    /// @notice swapExactTokensForTokensSupportingFeeOnTransferTokens for one hop (fee 25 bps): transferFrom the
    ///         seller into the pair, read the reserves AFTER that transfer, swap the pair's surplus to the seller.
    function sellSupportingFee(address token, address pair, uint256 amount) external returns (uint256 out) {
        (bool ok, bytes memory d) =
            token.call(abi.encodeWithSignature("transferFrom(address,address,uint256)", msg.sender, pair, amount));
        require(ok && (d.length == 0 || abi.decode(d, (bool))), "TransferHelper: TRANSFER_FROM_FAILED");
        (uint112 r0, uint112 r1,) = IPairLike(pair).getReserves();
        bool t0 = IPairLike(pair).token0() == token;
        (uint256 rT, uint256 rW) = t0 ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        (bool okB, bytes memory b) = token.staticcall(abi.encodeWithSignature("balanceOf(address)", pair));
        require(okB && b.length >= 32, "balanceOf");
        uint256 aIn = (abi.decode(b, (uint256)) - rT) * 9975;
        out = aIn * rW / (rT * 10_000 + aIn);
        IPairLike(pair).swap(t0 ? 0 : out, t0 ? out : 0, msg.sender, "");
    }
}

// ------------------------------------------------------------------ F-07 (EIP-7702 delegated account as token)

/// @notice ERC-20 logic meant to run as the EIP-7702 delegate of an EOA (storage lives in the EOA).
contract DelegTokenA {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;
    address public pair;

    function name() external pure returns (string memory) {
        return "Deleg";
    }

    function symbol() external pure returns (string memory) {
        return "DLG";
    }

    function decimals() external pure returns (uint8) {
        return 18;
    }

    function init(address p, uint256 liq) external {
        require(msg.sender == address(this) && pair == address(0), "init");
        pair = p;
        totalSupply = liq;
        balanceOf[p] = liq;
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        _t(msg.sender, to, a);
        return true;
    }

    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        if (allowance[f][msg.sender] != type(uint256).max) allowance[f][msg.sender] -= a;
        _t(f, to, a);
        return true;
    }

    function _t(address f, address to, uint256 a) internal virtual {
        balanceOf[f] -= a;
        balanceOf[to] += a;
    }
}

contract DelegTokenB is DelegTokenA {
    function _t(address f, address to, uint256 a) internal override {
        require(to != pair, "rugged");
        super._t(f, to, a);
    }
}

// ------------------------------------------------------------------ swap-back (Flap-style) tax token

/// @notice Flap-launchpad-style tax token (functional audit F2): `taxBps` on buys and sells goes to the contract; on
///         a sell, BEFORE the seller's tokens reach the pair, the contract swaps its whole collected balance into the
///         pair (to `taxWallet`) once it is at least `threshold`. That inner swap moves the pair's reserves inside the
///         seller's transfer, which made the old probe (reserves read before the transfer) revert with K.
///         `pending` = tax already collected by earlier trading.
contract SwapBackTaxToken is AuditERC20 {
    uint256 public immutable taxBps;
    uint256 public immutable threshold;
    address public immutable taxWallet;
    uint16 internal constant POOL_FEE = 25;
    bool private _inSwap;
    uint256 public swapBacks;

    constructor(
        address p,
        uint256 liq,
        uint256 rest,
        uint256 taxBps_,
        uint256 pending,
        uint256 threshold_,
        address wallet
    ) AuditERC20("FLAPLIKE", p, liq, rest) {
        taxBps = taxBps_;
        threshold = threshold_;
        taxWallet = wallet;
        _mint(address(this), pending);
    }

    function _transfer(address from, address to, uint256 amount) internal override {
        if (_inSwap || from == address(this)) return _move(from, to, amount);
        if (_isSell(from, to) && balanceOf[address(this)] >= threshold) _swapBack();
        uint256 tax = (from == pair || to == pair) ? amount * taxBps / 10_000 : 0;
        if (tax != 0) _move(from, address(this), tax);
        _move(from, to, amount - tax);
    }

    /// @dev What swapExactTokensForTokensSupportingFeeOnTransferTokens does for the contract: transfer in, then price
    ///      on fresh reserves and swap.
    function _swapBack() internal {
        _inSwap = true;
        uint256 amt = balanceOf[address(this)];
        _move(address(this), pair, amt);
        (uint112 r0, uint112 r1,) = IPairLike(pair).getReserves();
        bool t0 = IPairLike(pair).token0() == address(this);
        (uint256 rT, uint256 rW) = t0 ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        uint256 aIn = (balanceOf[pair] - rT) * (10_000 - POOL_FEE);
        uint256 out = aIn * rW / (rT * 10_000 + aIn);
        IPairLike(pair).swap(t0 ? 0 : out, t0 ? out : 0, taxWallet, "");
        swapBacks++;
        _inSwap = false;
    }
}

// ------------------------------------------------------------------ reserve-manipulation attempts

/// @notice A token that tries to move the pair's reserves inside its own transfer to make a sale look cheaper than it
///         is (or to crash the price in front of the seller). One fixture, `kind` selects the attempt:
///         1 DUMP_IN_FRONT : 0% transfer tax, but on a sell mints `param`x the pool's token reserve into the pair and
///                           syncs BEFORE the seller's tokens arrive (the seller sells into a crashed pool)
///         2 TAX_THEN_SYNC : `param` bps sell tax, credits the rest, then pair.sync() (absorbs the input as reserve)
///         3 TAX_THEN_SKIM : `param` bps sell tax, credits the rest, then pair.skim() (takes the input back out)
///         4 BUY_HOP_DONOR : on a buy, mints `param`x the pool's token reserve into the pair (the pair's own post-swap
///                           sync bakes a crashed price into the post-buy reserves)
///         5 TAX_PLUS_PUMP : `param` bps sell tax, and before crediting the rest deletes half of the pair's token
///                           balance from its ledger and syncs (pumps the price for the seller: real value paid to the
///                           seller out of the pool's tokenIn)
contract ReserveGamer is AuditERC20 {
    uint8 public immutable kind;
    uint256 public immutable param;
    address public immutable sink;
    bool private _inHook;

    constructor(address p, uint256 liq, uint256 rest, uint8 kind_, uint256 param_, address sink_)
        AuditERC20("GAMER", p, liq, rest)
    {
        kind = kind_;
        param = param_;
        sink = sink_;
    }

    function _transfer(address from, address to, uint256 amount) internal override {
        if (_inHook) return _move(from, to, amount);
        _inHook = true;
        if (kind == 4 && from == pair) {
            _mint(pair, balanceOf[pair] * param); // no sync possible (pair locked): its own _update syncs it
            _move(from, to, amount);
        } else if (_isSell(from, to)) {
            if (kind == 1) {
                _mint(pair, balanceOf[pair] * param);
                IPairLike(pair).sync();
                _move(from, to, amount);
            } else {
                uint256 tax = amount * param / 10_000;
                _burnFrom(from, tax);
                if (kind == 5) {
                    _burnFrom(pair, balanceOf[pair] / 2);
                    IPairLike(pair).sync();
                }
                _move(from, to, amount - tax);
                if (kind == 2) IPairLike(pair).sync();
                if (kind == 3) IPairLike(pair).skim(sink);
            }
        } else {
            _move(from, to, amount);
        }
        _inHook = false;
    }
}
