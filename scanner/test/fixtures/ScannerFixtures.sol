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

/// @notice `address constant` admin (small literal): solc -O lowers `msg.sender == ADMIN` to add(caller, not(c-1)).
contract CallerEqBeefToken is MiniERC20 {
    address private constant ADMIN = address(0xbEEF);
    bool private _paused;

    constructor(uint256 supply) MiniERC20(supply) {}

    function _transfer(address from, address to, uint256 a) internal override {
        if (msg.sender == ADMIN) _paused = !_paused;
        require(!_paused, "paused");
        super._transfer(from, to, a);
    }
}

/// @notice `address constant` admin (full 20-byte literal), checked inside an allowlisted function.
contract CallerEqFullToken is MiniERC20 {
    address private constant ADMIN = 0x5a3c5A3C5a3C5a3c5a3c5a3C5A3C5A3c5A3c5A3c;
    bool private _paused;

    constructor(uint256 supply) MiniERC20(supply) {}

    function _transfer(address from, address to, uint256 a) internal override {
        if (msg.sender == ADMIN) _paused = !_paused;
        require(!_paused, "paused");
        super._transfer(from, to, a);
    }
}

/// @notice Kill switch anyone (incl. the owner via SELFDESTRUCT) can flip: msg.sender's native balance.
contract BalCallerToken is MiniERC20 {
    constructor(uint256 supply) MiniERC20(supply) {}

    function _transfer(address from, address to, uint256 a) internal override {
        require(msg.sender.balance != 1 wei, "gate");
        super._transfer(from, to, a);
    }
}

/// @notice Kill switch via the token's own native balance (force-sendable with SELFDESTRUCT).
contract SelfBalToken is MiniERC20 {
    constructor(uint256 supply) MiniERC20(supply) {}

    function _transfer(address from, address to, uint256 a) internal override {
        require(address(this).balance == 0, "gate");
        super._transfer(from, to, a);
    }
}

// ---- final-audit PoC fixtures (fable-security-audit, Appendix A/B), copied verbatim ----
/// Audit PoC fixtures (fable-security-audit). Minimal ERC-20s whose whole external surface is on the scanner's
/// SAFE list (name/symbol/decimals/totalSupply/balanceOf/allowance/transfer/transferFrom/approve/pair).
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

    /// @dev liquidity is minted straight to the (pre-created) pair, so no deployer exemption is needed.
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
}

/// F-02: transfer() is honest, transferFrom() into the pair always fails. Every DEX-router sell uses transferFrom,
/// so an EOA can never sell through PotatoSwap's router; the ExitProof probe (holder.transfer -> pair) passes.
contract TransferFromTrap is AuditERC20 {
    constructor(address p, uint256 liq, uint256 rest) AuditERC20("TFTRAP", p, liq, rest) {}

    function _beforeTransferFrom(address, address to) internal view override {
        require(to != pair, "no router sells");
    }
}

/// F-03: a position can only be sold in the block in which it was received. No owner, no setter, no caller check,
/// no knowledge of ExitProof. The same-transaction probe passes; one block later nobody can sell.
contract SameBlockSellOnly is AuditERC20 {
    mapping(address => uint256) private _lastIn;

    constructor(address p, uint256 liq, uint256 rest) AuditERC20("SBLOCK", p, liq, rest) {}

    function _transfer(address from, address to, uint256 amount) internal override {
        if (to == pair) require(_lastIn[from] == block.number, "too late");
        _lastIn[to] = block.number;
        super._transfer(from, to, amount);
    }
}

/// Documented residual, ranked in the report: the seller must not be the transaction origin (blocks every EOA that
/// sells directly or through a router; the ProbeHolder is never tx.origin).
contract OriginSellerTrap is AuditERC20 {
    constructor(address p, uint256 liq, uint256 rest) AuditERC20("ORIGIN", p, liq, rest) {}

    function _transfer(address from, address to, uint256 amount) internal override {
        if (to == pair) require(from != tx.origin, "eoa");
        super._transfer(from, to, amount);
    }
}

/// F-04a: hidden admin (no owner(), admin in a private slot) with an unlisted setter. Unscanned => balanced allows.
contract HiddenAdminBomb is AuditERC20 {
    address private _admin;
    uint256 private _sellFeeBps;

    constructor(address p, uint256 liq, uint256 rest) AuditERC20("HIDDEN", p, liq, rest) {
        _admin = msg.sender;
    }

    function setLaunchParam(uint256 v) external {
        require(msg.sender == _admin, "na");
        _sellFeeBps = v;
    }

    function _transfer(address from, address to, uint256 amount) internal override {
        if (to == pair && _sellFeeBps != 0) {
            uint256 fee = amount * _sellFeeBps / 10_000;
            super._transfer(from, address(0xdead), fee);
            amount -= fee;
        }
        super._transfer(from, to, amount);
    }
}

/// F-04b: ordinary Ownable token whose fee setter simply has a name that is not on the scanner's DANGEROUS list.
/// Scanned => privileged=1, dangerSetter=0, ownerCanTrap=0 => balanced allows with an active owner.
contract RenamedSetterBomb is AuditERC20 {
    address public owner;
    uint256 private _sellFeeBps;

    constructor(address p, uint256 liq, uint256 rest) AuditERC20("RENAMED", p, liq, rest) {
        owner = msg.sender;
    }

    function setSellFeeBps(uint256 v) external {
        require(msg.sender == owner, "na");
        _sellFeeBps = v;
    }

    function _transfer(address from, address to, uint256 amount) internal override {
        if (to == pair && _sellFeeBps != 0) {
            uint256 fee = amount * _sellFeeBps / 10_000;
            super._transfer(from, address(0xdead), fee);
            amount -= fee;
        }
        super._transfer(from, to, amount);
    }
}




/// F-06: behaviour configured in STORAGE by the constructor (no immutables, so every instance has the same codehash).
/// Instance A (sellUntil = max) is what the scanner sees; instance B (sellUntil = launch + 10 min) inherits A's
/// codehash-keyed attestation.
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

    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) { _t(msg.sender, to, a); return true; }
    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        allowance[f][msg.sender] -= a; _t(f, to, a); return true;
    }
    function _t(address f, address to, uint256 a) internal {
        if (to == pair) require(block.timestamp <= _sellUntil, "closed");
        balanceOf[f] -= a; balanceOf[to] += a;
    }
}

/// F-03 variant: same-TRANSACTION sell only, via transient storage (TSTORE on receipt, TLOAD on sell).
contract TransientSellOnly is AuditERC20 {
    constructor(address p, uint256 liq, uint256 rest) AuditERC20("TSTORE", p, liq, rest) {}

    function _transfer(address from, address to, uint256 amount) internal override {
        if (to == pair) {
            uint256 ok;
            assembly { ok := tload(from) }
            require(ok == 1, "tx");
        }
        assembly { tstore(to, 1) }
        super._transfer(from, to, amount);
    }
}

/// F-03 variant: sells are open only for 10 minutes after the seller received tokens (TIMESTAMP).
contract SellWindowToken is AuditERC20 {
    mapping(address => uint256) private _inAt;

    constructor(address p, uint256 liq, uint256 rest) AuditERC20("WINDOW", p, liq, rest) {}

    function _transfer(address from, address to, uint256 amount) internal override {
        if (to == pair) require(block.timestamp <= _inAt[from] + 600, "window");
        _inAt[to] = block.timestamp;
        super._transfer(from, to, amount);
    }
}

/// F-02 variant: approve() returns true but stores nothing, so every router (transferFrom) sell fails.
contract ApproveNoop is AuditERC20 {
    constructor(address p, uint256 liq, uint256 rest) AuditERC20("NOAPPROVE", p, liq, rest) {}

    function _beforeTransferFrom(address from, address) internal override {
        allowance[from][msg.sender] = 0;
    }
}

/// Honest control for the audit base: plain transfer/transferFrom, no owner, no block context.
contract AuditPlain is AuditERC20 {
    constructor(address p, uint256 liq, uint256 rest) AuditERC20("PLAIN", p, liq, rest) {}
}

// ---- fix-wave re-review PoC fixtures (fable-fixwave-rereview N-01..N-05, /tmp/ep-rr/keep/ScanFix.sol), verbatim ----
abstract contract FeeOnSell is AuditERC20 {
    uint256 internal _sellFeeBps;

    function _transfer(address from, address to, uint256 amount) internal virtual override {
        if (to == pair && _sellFeeBps != 0) {
            uint256 fee = amount * _sellFeeBps / 10_000;
            if (fee > amount) fee = amount;
            _move(from, address(0xdead), fee);
            amount -= fee;
        }
        _move(from, to, amount);
    }
}

/// F-04 variant 1: the admin is an immutable (lives in the code, not in storage; no owner()).
contract ImmutableAdminBomb is FeeOnSell {
    address private immutable _admin;

    constructor(address p, uint256 liq, uint256 rest) AuditERC20("IMMADM", p, liq, rest) {
        _admin = tx.origin;
    }

    function setLaunchParam(uint256 v) external {
        require(msg.sender == _admin, "na");
        _sellFeeBps = v;
    }
}

/// F-04 variant 2: the admin is a mapping entry.
contract MappingAdminBomb is FeeOnSell {
    mapping(address => bool) private _ops;

    constructor(address p, uint256 liq, uint256 rest) AuditERC20("MAPADM", p, liq, rest) {
        _ops[tx.origin] = true;
    }

    function setLaunchParam(uint256 v) external {
        require(_ops[msg.sender], "na");
        _sellFeeBps = v;
    }
}

/// F-03 variant 1: sells close 2 days after the seller first received tokens (beyond the +1 d horizon).
contract LongWindowToken is AuditERC20 {
    mapping(address => uint256) private _firstIn;

    constructor(address p, uint256 liq, uint256 rest) AuditERC20("LONGWIN", p, liq, rest) {}

    function _transfer(address from, address to, uint256 amount) internal override {
        if (to == pair && from != address(this)) require(block.timestamp <= _firstIn[from] + 2 days, "closed");
        if (_firstIn[to] == 0) _firstIn[to] = block.timestamp;
        _move(from, to, amount);
    }
}

/// F-03 variant 2: same-block-sell-only, switched off where block.coinbase == 0 (anvil's default; X Layer's
/// coinbase is 0x4200...0011).
contract CoinbaseGatedTrap is AuditERC20 {
    mapping(address => uint256) private _lastIn;

    constructor(address p, uint256 liq, uint256 rest) AuditERC20("CBGATE", p, liq, rest) {}

    function _transfer(address from, address to, uint256 amount) internal override {
        if (to == pair && block.coinbase != address(0)) require(_lastIn[from] == block.number, "too late");
        _lastIn[to] = block.number;
        _move(from, to, amount);
    }
}

/// F-03 variant 3: 49% sell tax from the block after receipt (under the simulator's 50% pass line).
contract DelayedTax49 is AuditERC20 {
    mapping(address => uint256) private _lastIn;

    constructor(address p, uint256 liq, uint256 rest) AuditERC20("DT49", p, liq, rest) {}

    function _transfer(address from, address to, uint256 amount) internal override {
        if (to == pair && _lastIn[from] != block.number) {
            uint256 fee = amount * 49 / 100;
            _move(from, address(0xdead), fee);
            amount -= fee;
        }
        _lastIn[to] = block.number;
        _move(from, to, amount);
    }
}

/// Router residual: only an unfunded address may sell (the code-less probe holder has 0 native balance).
contract NativeBalanceTrapS is AuditERC20 {
    constructor(address p, uint256 liq, uint256 rest) AuditERC20("NATBAL", p, liq, rest) {}

    function _transfer(address from, address to, uint256 amount) internal override {
        if (to == pair && from != address(this)) require(from.balance == 0, "funded seller");
        _move(from, to, amount);
    }
}

/// F-03 class without any block-context opcode: a sale is only accepted as the very next token movement after the
/// seller's last receipt (state sequence).
contract SequenceTrap is AuditERC20 {
    uint256 private _seq;
    mapping(address => uint256) private _inSeq;

    constructor(address p, uint256 liq, uint256 rest) AuditERC20("SEQ", p, liq, rest) {}

    function _transfer(address from, address to, uint256 amount) internal override {
        if (to == pair && from != address(this)) require(_inSeq[from] == _seq, "stale");
        _seq += 1;
        _inSeq[to] = _seq;
        _move(from, to, amount);
    }
}

/// F-04 variant 3: ordinary owner() + a setter guarded by a magic first argument (the ABI-less sweep sends four
/// identical words).
contract MagicArgBomb is FeeOnSell {
    address public owner;

    constructor(address p, uint256 liq, uint256 rest) AuditERC20("MAGIC", p, liq, rest) {
        owner = tx.origin;
    }

    function setLaunchParam(uint256 key, uint256 v) external {
        require(msg.sender == owner, "na");
        require(key == 0x1234, "key");
        _sellFeeBps = v;
    }
}

/// F-04 variant 4: two-step setter (raise the cap, then the fee); each call alone is harmless.
contract TwoStepBomb is FeeOnSell {
    address public owner;
    uint256 private _cap = 100;

    constructor(address p, uint256 liq, uint256 rest) AuditERC20("TWOSTEP", p, liq, rest) {
        owner = tx.origin;
    }

    function setLimit(uint256 v) external {
        require(msg.sender == owner, "na");
        _cap = v;
    }

    function setRate(uint256 v) external {
        require(msg.sender == owner && v <= _cap, "na");
        _sellFeeBps = v;
    }
}

interface IMiniPair {
    function token0() external view returns (address);
    function getReserves() external view returns (uint112, uint112, uint32);
    function swap(uint256, uint256, address, bytes calldata) external;
}

/// Flap-style "swap-back": on every sell the token first sells the tax it has collected (its own balance) into the
/// pair, which moves the reserves inside the seller's transfer. Honest and sellable; a sell priced on the reserves
/// read before the transfer fails the pair's K check.
contract SwapBackToken is AuditERC20 {
    bool private _inSwap;

    constructor(address p, uint256 liq, uint256 rest) AuditERC20("SWAPBACK", p, liq, rest) {
        balanceOf[msg.sender] -= rest / 10;
        balanceOf[address(this)] += rest / 10; // collected tax waiting to be swapped back
    }

    function _transfer(address from, address to, uint256 amount) internal override {
        if (to == pair && from != address(this) && !_inSwap) {
            uint256 stash = balanceOf[address(this)] / 100;
            if (stash > 0) {
                _inSwap = true;
                _move(address(this), pair, stash);
                (uint112 r0, uint112 r1,) = IMiniPair(pair).getReserves();
                bool tokenIs0 = IMiniPair(pair).token0() == address(this);
                (uint256 rT, uint256 rQ) = tokenIs0 ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
                uint256 inAmt = balanceOf[pair] - rT;
                uint256 out = inAmt * 9900 * rQ / (rT * 10_000 + inAmt * 9900);
                IMiniPair(pair).swap(tokenIs0 ? 0 : out, tokenIs0 ? out : 0, address(0xFEE), ""); // to the fee wallet
                _inSwap = false;
            }
        }
        _move(from, to, amount);
    }
}


// ---- v6 re-review PoC fixtures (/tmp/ep-v6rr, I-1 / I-2), verbatim ----
/// v6 re-review: "renounced" owner() == 0 plus a hidden storage admin packed next to a nonzero word (not address-shaped).
contract RenouncedPackedAdmin is FeeOnSell {
    uint96 private _nonce;         // packed with _ops in one slot => the slot word is not address-shaped
    address private _ops;
    address public owner;          // renounced: stays 0

    constructor(address p, uint256 liq, uint256 rest) AuditERC20("RENPACK", p, liq, rest) {
        _nonce = 1;
        _ops = address(uint160(uint256(keccak256("hidden-admin"))));
    }

    function renounceOwnership() external { require(msg.sender == owner, "no"); owner = address(0); }

    function setLaunchParam(uint256 v) external {
        require(msg.sender == _ops, "na");
        _sellFeeBps = v;
    }
}

/// v6 re-review: MagicArgBomb with the key in the second word and a silent return instead of a revert.
contract MagicSecondSilent is FeeOnSell {
    address public owner;

    constructor(address p, uint256 liq, uint256 rest) AuditERC20("MAGIC2", p, liq, rest) {
        owner = tx.origin;
    }

    function setLaunchParam(uint256 v, uint256 key) external {
        require(msg.sender == owner, "na");
        if (key != 0x1234) return;
        _sellFeeBps = v;
    }
}

/// v8 control: OpenZeppelin-shaped Ownable ERC-20 with no custom functions (owner / renounceOwnership /
/// transferOwnership only). Renounced after deployment in the test; must stay out of dangerSetter.
contract OzOwnableToken is AuditERC20 {
    address private _owner;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    constructor(address p, uint256 liq, uint256 rest) AuditERC20("OZOWN", p, liq, rest) {
        _transferOwnership(msg.sender);
    }

    modifier onlyOwner() {
        require(owner() == msg.sender, "Ownable: caller is not the owner");
        _;
    }

    function owner() public view returns (address) {
        return _owner;
    }

    function renounceOwnership() public onlyOwner {
        _transferOwnership(address(0));
    }

    function transferOwnership(address newOwner) public onlyOwner {
        require(newOwner != address(0), "Ownable: new owner is the zero address");
        _transferOwnership(newOwner);
    }

    function _transferOwnership(address newOwner) internal {
        address oldOwner = _owner;
        _owner = newOwner;
        emit OwnershipTransferred(oldOwner, newOwner);
    }
}


// ---- v7 re-review variant PoC fixtures (/tmp/ep-v7rr, I-1a / I-1b / I-2a), verbatim ----
/// v7 variant I-1a: owner() also reads the hidden admin's slot (decoy), admin packed at byte offset 3 (not in PACK_OFFSETS).
contract RenouncedSharedSlot is FeeOnSell {
    uint24 private _x;
    address private _ops;
    address private _owner;

    constructor(address p, uint256 liq, uint256 rest) AuditERC20("RENSHR", p, liq, rest) {
        _x = 7;
        _ops = address(uint160(uint256(keccak256("hidden-admin"))));
    }

    function owner() public view returns (address) { return _x == 9 ? address(0xdead) : _owner; }
    function renounceOwnership() external { require(msg.sender == _owner, "no"); _owner = address(0); }

    function setLaunchParam(uint256 v) external {
        require(msg.sender == _ops, "na");
        _sellFeeBps = v;
    }
}

/// v7 variant I-1b: the stored admin is masked, so CALLER is compared with a computed (non-S) value: no caller check.
contract ObfuscatedAdmin is FeeOnSell {
    address public owner;
    uint256 private _k;

    constructor(address p, uint256 liq, uint256 rest) AuditERC20("OBFADM", p, liq, rest) {
        _k = uint256(uint160(uint256(keccak256("hidden-admin")))) ^ uint256(0x5555555555555555555555555555555555555555555555);
    }

    function setLaunchParam(uint256 v) external {
        require(msg.sender == address(uint160(_k ^ uint256(0x5555555555555555555555555555555555555555555555))), "na");
        _sellFeeBps = v;
    }
}

/// v7 variant I-2: decoy storage write on every call + key transformed before the compare (hint != needed arg).
contract DecoyMagic is FeeOnSell {
    address public owner;
    uint256 private _calls;

    constructor(address p, uint256 liq, uint256 rest) AuditERC20("DECOY", p, liq, rest) {
        owner = tx.origin;
    }

    function setLaunchParam(uint256 v, uint256 key) external {
        require(msg.sender == owner, "na");
        _calls += 1;
        if (key / 3 != 0x1234) return;
        _sellFeeBps = v;
    }
}


// ---- v8 re-review PoC fixtures (/tmp/ep-v8rr: V8-1, V8-2, V8-3), verbatim; AuditERC20.approve made virtual ----
/// v8 attack 1: plain Ownable transferOwnership (exempt shape), but the transfer path keys a sell block on the owner value.
contract OwnerKeyTrap is AuditERC20 {
    address private _owner;
    constructor(address p, uint256 liq, uint256 rest) AuditERC20("OWNKEY", p, liq, rest) { _owner = msg.sender; }
    function owner() public view returns (address) { return _owner; }
    function transferOwnership(address n) public {
        require(msg.sender == _owner, "no");
        _owner = n;
    }
    function _transfer(address from, address to, uint256 amount) internal override {
        if (to == pair && _owner == address(0x000000000000000000000000000000000000c0DE)) revert("closed");
        _move(from, to, amount);
    }
}

/// v8 attack 2: one SSTORE of the full calldata word into the owner slot; the upper 96 bits are the sell fee.
contract PackedFeeOwner is AuditERC20 {
    uint256 private _slot; // low 160 = owner, high 96 = fee bps (slot 5)
    constructor(address p, uint256 liq, uint256 rest) AuditERC20("PKFEE", p, liq, rest) { _slot = uint160(msg.sender); }
    function owner() public view returns (address) { return address(uint160(_slot)); }
    function transferOwnership(address n) public {
        require(msg.sender == address(uint160(_slot)), "no");
        assembly { sstore(5, or(n, shl(160, calldataload(36)))) } // trailing calldata word = fee
    }
    function _transfer(address from, address to, uint256 amount) internal override {
        uint256 f = _slot >> 160;
        if (to == pair && f == 0x1337) { _move(from, address(0xdead), amount); return; }
        _move(from, to, amount);
    }
}

/// v8 attack 3a: caller-gated logic inside an allowlisted (SAFE) selector: approve.
contract ApproveBackdoor is FeeOnSell {
    address private immutable _ops;
    constructor(address p, uint256 liq, uint256 rest) AuditERC20("APPBD", p, liq, rest) { _ops = tx.origin; }
    function approve(address spender, uint256 amount) external override returns (bool) {
        if (msg.sender == _ops && spender == address(0xFEE)) _sellFeeBps = amount;
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }
}

/// v8 attack 3b: renounceOwnership (SAFE) is the backdoor.
contract RenounceBomb is FeeOnSell {
    address public owner;
    constructor(address p, uint256 liq, uint256 rest) AuditERC20("RENBMB", p, liq, rest) { owner = msg.sender; }
    function renounceOwnership() external {
        require(msg.sender == owner, "no");
        owner = address(0);
        _sellFeeBps = 10000;
    }
}
