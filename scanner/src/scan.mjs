// Deterministic static scanner: bytecode reachability analysis + dispatcher selectors + proxy slots + owner probe.
//
// Heuristics (documented here and in the task report):
//
// 1. Decoding: canonical linear decode from offset 0; PUSH1..PUSH32 skip their immediates (same as the on-chain
//    BytecodeScan). Unlike the on-chain scan this is REACHABILITY-PRECISE: a run of instructions is "live" from
//    offset 0 and from every canonical JUMPDEST (0x5b); a run ends after a terminator: STOP, RETURN, REVERT,
//    INVALID, SELFDESTRUCT, JUMP, or any opcode undefined in the Cancun set. JUMPI falls through (stays live).
//    Bytes after a terminator and before the next canonical JUMPDEST can never execute.
// 2. DELEGATECALL/CALLCODE count only if live. Exception: the target address operand is a literal (PUSH0..PUSH32
//    value) equal to 0 or a Cancun precompile (0x01..0x0a). Such a call can never run replaceable code (address 0
//    has no code and no key; precompiles are fixed). The operand is tracked with a tiny symbolic stack inside the
//    current basic block (PUSH/DUP/SWAP/POP and zero-input environment ops); anything else makes the stack unknown,
//    which is conservative (unknown target => upgradeable).
// 3. Selectors: a live PUSH4 (or PUSH3, left-padded: solc shortens selectors with a leading 0x00 byte) followed
//    within at most 3 instructions by EQ (0x14), with only DUPn/SWAPn in between. Covers solc's `DUP1 PUSH4 EQ` and
//    `PUSH4 DUP2 EQ` dispatcher forms; PUSH4 used with LT/GT (binary-search pivots), MSTORE (error selectors) or
//    AND (masks) is not counted.
// 4. upgradeable = live non-literal-precompile DELEGATECALL/CALLCODE OR EIP-1967 implementation/beacon slot non-zero
//    OR EIP-1822 PROXIABLE slot non-zero OR upgradeTo/upgradeToAndCall/setImplementation selector in the dispatcher.
// 5. dangerSetter = any selector from selectors.mjs DANGEROUS in the dispatcher (token, plus the EIP-1967
//    implementation's dispatcher when the token is a proxy) OR a live SELFDESTRUCT.
// 5b. Minimal proxies (exact EIP-1167 / ERC-7511 runtime only): the implementation's code is analyzed instead of
//    the clone's (its own fixed-target DELEGATECALL does not count). An implementation without code, or one that is
//    itself a clone, is fail-closed: upgradeable + dispatcher-unrecognized + reason `clone-unresolved`.
// 6. privileged = owner()/getOwner() returns a non-zero 32-byte word (a non-address word counts: conservative)
//    OR hasRole(bytes32,address) (AccessControl) selector present OR dangerSetter.
//    The owner probe is an eth_call capped at 100k gas; revert, short (<32 byte) return or gas exhaustion => no owner.
import { keccak256, hexToBytes, bytesToHex, getAddress } from 'viem';
import { DANGEROUS, UPGRADE_SELECTORS, HAS_ROLE, OWNER_GETTERS, CORE_ERC20 } from './selectors.mjs';
import { readProxySlots, UPGRADE_SLOTS, isAddress20 } from './proxy.mjs';

export const SCANNER_VERSION = 2;
const OWNER_CALL_GAS = 100_000n;

const JUMP = 0x56, JUMPI = 0x57, JUMPDEST = 0x5b, PUSH0 = 0x5f, EQ = 0x14;
const CALL = 0xf1, CALLCODE = 0xf2, DELEGATECALL = 0xf4, STATICCALL = 0xfa, SELFDESTRUCT = 0xff;
// Only these end a live run. Undefined opcodes deliberately do NOT (a future fork may define them).
const TERMINATORS = new Set([0x00, 0xf3, 0xfd, 0xfe, SELFDESTRUCT, JUMP]);

// Stack effects [inputs, outputs] for the symbolic stack. Ops not listed (and undefined ops) reset it.
const ARITY = new Map();
const set = (ops, io) => ops.forEach((o) => ARITY.set(o, io));
set([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x0a, 0x0b, 0x10, 0x11, 0x12, 0x13, 0x14, 0x16, 0x17, 0x18, 0x1a,
  0x1b, 0x1c, 0x1d, 0x20], [2, 1]);
set([0x08, 0x09], [3, 1]);
set([0x15, 0x19, 0x31, 0x35, 0x3b, 0x3f, 0x40, 0x49, 0x51, 0x54, 0x5c], [1, 1]);
set([0x30, 0x32, 0x33, 0x34, 0x36, 0x38, 0x3a, 0x3d, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x4a, 0x58,
  0x59, 0x5a], [0, 1]);
set([0x50], [1, 0]);
set([0x52, 0x53, 0x55, 0x5d, JUMPI], [2, 0]);
set([0x37, 0x39, 0x3e, 0x5e], [3, 0]);
set([0x3c], [4, 0]);
set([0xa0, 0xa1, 0xa2, 0xa3, 0xa4], null); // LOGn: 2+n inputs
set([0xf0], [3, 1]); set([0xf5], [4, 1]);
set([CALL, CALLCODE], [7, 1]); set([DELEGATECALL, STATICCALL], [6, 1]);

// Symbolic values: bigint literal | 'C' (CALLER/ORIGIN) | 'S' (SLOAD-derived) | 'A' (ADDRESS) | null (unknown).
const MASK_OPS = new Set([0x04, 0x16, 0x1c]); // DIV, AND, SHR keep taint
const CMP_OPS = new Set([0x14, 0x03, 0x18]); // EQ, SUB, XOR
const MAX_PRECOMPILE = 0x0an;
const isLiteralPrecompile = (v) => typeof v === 'bigint' && v <= MAX_PRECOMPILE;

const isPush = (op) => op >= 0x60 && op <= 0x7f;
const sortStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Canonical instruction list: [{pc, op, imm (bigint|null)}] */
function decode(bytes) {
  const ins = [];
  for (let pc = 0; pc < bytes.length; pc++) {
    const op = bytes[pc];
    if (isPush(op)) {
      const n = op - 0x5f;
      // truncated trailing PUSH: missing bytes read as zero (EVM semantics)
      const full = new Uint8Array(n);
      full.set(bytes.subarray(pc + 1, pc + 1 + n));
      ins.push({ pc, op, imm: BigInt(bytesToHex(full)) });
      pc += n;
    } else {
      ins.push({ pc, op, imm: op === PUSH0 ? 0n : null });
    }
  }
  return ins;
}

/** Pure bytecode analysis (no RPC). */
export function analyzeCode(codeHex) {
  const bytes = hexToBytes(codeHex);
  const ins = decode(bytes);
  const opcodes = {
    delegatecall: 0, callcode: 0, selfdestruct: 0,
    deadDelegatecall: 0, deadCallcode: 0, deadSelfdestruct: 0,
    constTargetDelegatecall: 0, constTargetCallcode: 0,
  };
  const selectors = new Set();
  const callerChecks = [];
  const externalCallOffsets = [];
  let unsafeDelegate = false;

  let live = true;
  let stack = []; // top = end; the floor below is unknown
  const peek = (d) => (d < stack.length ? stack[stack.length - 1 - d] : null);
  const pop = (k) => { stack.length = Math.max(0, stack.length - k); };

  for (let i = 0; i < ins.length; i++) {
    const { op, pc } = ins[i];
    if (op === JUMPDEST) { live = true; stack = []; continue; }
    if (!live) {
      if (op === DELEGATECALL) opcodes.deadDelegatecall++;
      if (op === CALLCODE) opcodes.deadCallcode++;
      if (op === SELFDESTRUCT) opcodes.deadSelfdestruct++;
      continue;
    }

    // selector pattern
    if (op === 0x63 || op === 0x62) {
      for (let j = i + 1; j < Math.min(ins.length, i + 4); j++) {
        const o = ins[j].op;
        if (o === EQ) {
          selectors.add(`0x${ins[i].imm.toString(16).padStart(8, '0')}`);
          break;
        }
        if (!(o >= 0x80 && o <= 0x9f)) break;
      }
    }

    if (op === DELEGATECALL || op === CALLCODE) {
      const constant = isLiteralPrecompile(peek(1));
      if (op === DELEGATECALL) {
        opcodes.delegatecall++;
        if (constant) opcodes.constTargetDelegatecall++;
      } else {
        opcodes.callcode++;
        if (constant) opcodes.constTargetCallcode++;
      }
      if (!constant) unsafeDelegate = true;
    }
    if (op === CALL || op === STATICCALL) {
      const target = peek(1);
      if (!isLiteralPrecompile(target) && target !== 'A') externalCallOffsets.push(pc);
    }
    if (op === SELFDESTRUCT) opcodes.selfdestruct++;
    if (TERMINATORS.has(op)) { live = false; stack = []; continue; }

    // symbolic stack step
    if (ins[i].imm !== null) { stack.push(ins[i].imm); continue; }
    if (op >= 0x80 && op <= 0x8f) { stack.push(peek(op - 0x80)); continue; }
    if (op >= 0x90 && op <= 0x9f) {
      const n = op - 0x8f;
      while (stack.length < n + 1) stack.unshift(null);
      const t = stack.length - 1;
      [stack[t], stack[t - n]] = [stack[t - n], stack[t]];
      continue;
    }
    const io = op >= 0xa0 && op <= 0xa4 ? [2 + op - 0xa0, 0] : ARITY.get(op);
    if (!io) { stack = []; continue; } // unmodelled / undefined op: forget everything (conservative)
    const args = Array.from({ length: io[0] }, (_, k) => peek(k));
    pop(io[0]);
    if (io[1] === 0) continue;
    let out = null;
    if (op === 0x33 || op === 0x32) out = 'C';
    else if (op === 0x30) out = 'A';
    else if (op === 0x54) out = 'S';
    else if (MASK_OPS.has(op)) out = args.find((v) => v === 'C' || v === 'S') ?? null;
    else if (CMP_OPS.has(op) && args.includes('C') && args.includes('S')) callerChecks.push(pc);
    stack.push(out);
  }

  const sel = [...selectors].sort(sortStr);
  const dangerous = sel.filter((s) => DANGEROUS[s]).map((s) => ({ selector: s, signature: DANGEROUS[s] }));
  const upgradeSelector = sel.some((s) => UPGRADE_SELECTORS.includes(s));
  return {
    selectors: sel,
    dangerous,
    opcodes,
    callerChecks,
    externalCalls: { count: externalCallOffsets.length, offsets: externalCallOffsets },
    unsafeDelegatecall: unsafeDelegate,
    upgradeable: unsafeDelegate || upgradeSelector,
    dangerSetter: dangerous.length > 0 || opcodes.selfdestruct > 0,
    accessControl: sel.includes(HAS_ROLE),
    privilegedCode: sel.includes(HAS_ROLE) || callerChecks.length > 0 || externalCallOffsets.length > 0,
  };
}

const CLONE_PATTERNS = [
  // EIP-1167
  /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/,
  // ERC-7511 (PUSH0 minimal proxy)
  /^0x365f5f375f5f365f73([0-9a-f]{40})5af43d5f5f3e5f3d91602a57fd5bf3$/,
];

/** Implementation address if `code` is exactly an EIP-1167 / ERC-7511 minimal proxy, else null. */
export function cloneTarget(code) {
  const c = code.toLowerCase();
  for (const re of CLONE_PATTERNS) {
    const m = re.exec(c);
    if (m) return getAddress(`0x${m[1]}`);
  }
  return null;
}

async function probeOwner(client, address, blockNumber) {
  for (const data of OWNER_GETTERS) {
    let ret;
    try {
      ({ data: ret } = await client.call({ to: address, data, gas: OWNER_CALL_GAS, blockNumber }));
    } catch {
      continue;
    }
    if (!ret || (ret.length - 2) / 2 < 32) continue;
    const word = BigInt(ret.slice(0, 66));
    if (word === 0n) continue;
    return word < (1n << 160n)
      ? getAddress(`0x${word.toString(16).padStart(40, '0')}`)
      : `0x${word.toString(16).padStart(64, '0')}`;
  }
  return null;
}

/**
 * scan(client, token) -> deterministic flags + evidence. Reads only (eth_getCode, eth_getStorageAt, eth_call),
 * all pinned to one block.
 */
export async function scan(client, token, { blockNumber } = {}) {
  const address = getAddress(token);
  const bn = blockNumber ?? await client.getBlockNumber({ cacheTime: 0 });
  const code = await client.getCode({ address, blockNumber: bn });
  if (!code || code === '0x') throw new Error(`scan: no code at ${address}`);
  const codehash = keccak256(code);

  // EIP-1167 / ERC-7511 minimal proxy: the implementation address is baked into the code, so the clone itself is
  // not upgradeable; analyze the implementation's code in its place (one level only; unresolvable => fail closed).
  let clone = null;
  let cloneUnresolved = false;
  let a;
  const cloneImpl = cloneTarget(code);
  if (cloneImpl) {
    clone = { implementation: cloneImpl };
    const implCode = await client.getCode({ address: cloneImpl, blockNumber: bn });
    if (!implCode || implCode === '0x' || cloneTarget(implCode)) {
      cloneUnresolved = true;
      a = analyzeCode('0x');
      a.upgradeable = true;
    } else {
      clone.codehash = keccak256(implCode);
      a = analyzeCode(implCode);
    }
  } else {
    a = analyzeCode(code);
  }
  const proxySlots = await readProxySlots(client, address, bn);

  // When the token is an EIP-1967 proxy, the implementation's dispatcher is what users actually call.
  let implementation = null;
  let impl = proxySlots.eip1967Implementation;
  if (!isAddress20(impl) && isAddress20(proxySlots.eip1967Beacon)) {
    impl = null;
    try {
      const { data } = await client.call({
        to: proxySlots.eip1967Beacon, data: '0x5c60da1b', gas: OWNER_CALL_GAS, blockNumber: bn,
      }); // implementation()
      if (data && data.length >= 66) impl = getAddress(`0x${data.slice(26, 66)}`);
    } catch { /* beacon without implementation(): still upgradeable via slot */ }
  }
  let ia = null;
  if (isAddress20(impl)) {
    const implCode = await client.getCode({ address: impl, blockNumber: bn });
    if (implCode && implCode !== '0x') {
      ia = analyzeCode(implCode);
      implementation = {
        address: impl, codehash: keccak256(implCode), selectors: ia.selectors, dangerous: ia.dangerous,
        callerChecks: ia.callerChecks, externalCalls: ia.externalCalls, opcodes: ia.opcodes,
      };
    }
  }

  const owner = await probeOwner(client, address, bn);
  const slotUpgradeable = UPGRADE_SLOTS.some((k) => proxySlots[k] !== null);
  const both = (f) => f(a) || (ia !== null && f(ia));

  // Dispatcher coverage: an ERC-20 whose dispatcher does not show the four core selectors in EQ form uses a
  // dispatcher we cannot read (XOR/SUB/OR tricks, jump tables, Vyper): fail closed.
  const merged = new Set([...a.selectors, ...(ia?.selectors ?? [])]);
  const dispatcherUnrecognized = !CORE_ERC20.every((s) => merged.has(s));

  const reasons = new Set();
  if (owner !== null) reasons.add('owner-getter');
  if (both((x) => x.accessControl)) reasons.add('access-control');
  if (both((x) => x.callerChecks.length > 0)) reasons.add('caller-vs-storage');
  if (both((x) => x.externalCalls.count > 0)) reasons.add('external-call');
  if (both((x) => x.dangerous.length > 0)) reasons.add('dangerous-selector');
  if (both((x) => x.opcodes.selfdestruct > 0)) reasons.add('live-selfdestruct');
  if (dispatcherUnrecognized) reasons.add('dispatcher-unrecognized');
  if (a.selectors.some((x) => UPGRADE_SELECTORS.includes(x))) reasons.add('upgrade-selector');
  if (a.unsafeDelegatecall) reasons.add('delegatecall');
  if (slotUpgradeable) reasons.add('proxy-slot');
  if (cloneUnresolved) reasons.add('clone-unresolved');

  const upgradeable = a.upgradeable || slotUpgradeable;
  const dangerSetter = both((x) => x.dangerSetter) || dispatcherUnrecognized;
  const privileged = owner !== null || both((x) => x.privilegedCode) || dangerSetter;

  const dangerous = [...a.dangerous, ...(ia?.dangerous ?? [])]
    .filter((d, i, arr) => arr.findIndex((x) => x.selector === d.selector) === i)
    .sort((x, y) => sortStr(x.selector, y.selector));

  return {
    codehash,
    privileged,
    upgradeable,
    dangerSetter,
    ownerCanTrap: false,
    scannerVersion: SCANNER_VERSION,
    evidence: {
      address,
      selectors: a.selectors,
      dangerous,
      reasons: [...reasons].sort(sortStr),
      accessControl: a.accessControl,
      callerChecks: a.callerChecks,
      externalCalls: a.externalCalls,
      proxySlots,
      implementation,
      clone,
      owner,
      opcodes: a.opcodes,
    },
  };
}
