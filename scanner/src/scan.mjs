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
// 6. privileged = owner()/getOwner() returns a non-zero 32-byte word (a non-address word counts: conservative)
//    OR hasRole(bytes32,address) (AccessControl) selector present OR dangerSetter.
//    The owner probe is an eth_call capped at 100k gas; revert, short (<32 byte) return or gas exhaustion => no owner.
import { keccak256, hexToBytes, bytesToHex, getAddress } from 'viem';
import { DANGEROUS, UPGRADE_SELECTORS, HAS_ROLE, OWNER_GETTERS } from './selectors.mjs';
import { readProxySlots, UPGRADE_SLOTS, isAddress20 } from './proxy.mjs';

export const SCANNER_VERSION = 1;
const OWNER_CALL_GAS = 100_000n;

const STOP = 0x00, JUMP = 0x56, JUMPI = 0x57, JUMPDEST = 0x5b, PUSH0 = 0x5f, EQ = 0x14, POP = 0x50;
const CALLCODE = 0xf2, DELEGATECALL = 0xf4, RETURN = 0xf3, REVERT = 0xfd, INVALID = 0xfe, SELFDESTRUCT = 0xff;
const TERMINATORS = new Set([STOP, RETURN, REVERT, INVALID, SELFDESTRUCT, JUMP]);

// Cancun defined opcodes.
const DEFINED = new Set();
const range = (a, b) => { for (let i = a; i <= b; i++) DEFINED.add(i); };
range(0x00, 0x0b); range(0x10, 0x1d); DEFINED.add(0x20); range(0x30, 0x3f); range(0x40, 0x4a);
range(0x50, 0x5f); range(0x60, 0x7f); range(0x80, 0x8f); range(0x90, 0x9f); range(0xa0, 0xa4);
range(0xf0, 0xf5); DEFINED.add(0xfa); DEFINED.add(0xfd); DEFINED.add(0xfe); DEFINED.add(0xff);

// Zero-input opcodes that push one (unknown) value.
const PUSHES_UNKNOWN = new Set([0x30, 0x32, 0x33, 0x34, 0x36, 0x38, 0x3a, 0x3d, 0x41, 0x42, 0x43, 0x44, 0x45,
  0x46, 0x47, 0x48, 0x4a, 0x58, 0x59, 0x5a]);
const MAX_PRECOMPILE = 0x0an;

const isPush = (op) => op >= 0x60 && op <= 0x7f;
const sortStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Canonical instruction list: [{pc, op, imm (bigint|null), immHex}] */
function decode(bytes) {
  const ins = [];
  for (let pc = 0; pc < bytes.length; pc++) {
    const op = bytes[pc];
    if (isPush(op)) {
      const n = op - 0x5f;
      const raw = bytes.subarray(pc + 1, pc + 1 + n);
      // truncated trailing PUSH: missing bytes read as zero (EVM semantics)
      const full = new Uint8Array(n);
      full.set(raw);
      ins.push({ pc, op, imm: BigInt(bytesToHex(full)), n });
      pc += n;
    } else {
      ins.push({ pc, op, imm: op === PUSH0 ? 0n : null, n: 0 });
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
  let unsafeDelegate = false;

  let live = true;
  let stack = []; // symbolic: bigint (literal) or null (unknown); top = end. Floor below is unknown.
  const peek = (d) => (d < stack.length ? stack[stack.length - 1 - d] : null);
  const pop = (k) => { stack.length = Math.max(0, stack.length - k); };

  for (let i = 0; i < ins.length; i++) {
    const { op } = ins[i];
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
      const target = peek(1);
      const constant = target !== null && target <= MAX_PRECOMPILE;
      if (op === DELEGATECALL) {
        opcodes.delegatecall++;
        if (constant) opcodes.constTargetDelegatecall++;
      } else {
        opcodes.callcode++;
        if (constant) opcodes.constTargetCallcode++;
      }
      if (!constant) unsafeDelegate = true;
      pop(op === DELEGATECALL ? 6 : 7);
      stack.push(null);
      continue;
    }
    if (op === SELFDESTRUCT) opcodes.selfdestruct++;

    if (TERMINATORS.has(op) || !DEFINED.has(op)) { live = false; stack = []; continue; }

    // symbolic stack step
    if (ins[i].imm !== null) stack.push(ins[i].imm);
    else if (op >= 0x80 && op <= 0x8f) stack.push(peek(op - 0x80));
    else if (op >= 0x90 && op <= 0x9f) {
      const n = op - 0x8f;
      while (stack.length < n + 1) stack.unshift(null);
      const t = stack.length - 1;
      [stack[t], stack[t - n]] = [stack[t - n], stack[t]];
    } else if (op === POP) pop(1);
    else if (op === JUMPI) pop(2);
    else if (PUSHES_UNKNOWN.has(op)) stack.push(null);
    else stack = []; // unmodelled op: forget everything (conservative)
  }

  const sel = [...selectors].sort(sortStr);
  const dangerous = sel.filter((s) => DANGEROUS[s]).map((s) => ({ selector: s, signature: DANGEROUS[s] }));
  const upgradeSelector = sel.some((s) => UPGRADE_SELECTORS.includes(s));
  return {
    selectors: sel,
    dangerous,
    opcodes,
    upgradeable: unsafeDelegate || upgradeSelector,
    dangerSetter: dangerous.length > 0 || opcodes.selfdestruct > 0,
    privilegedCode: sel.includes(HAS_ROLE),
  };
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
  const a = analyzeCode(code);
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
  if (isAddress20(impl)) {
    const implCode = await client.getCode({ address: impl, blockNumber: bn });
    if (implCode && implCode !== '0x') {
      const ia = analyzeCode(implCode);
      implementation = {
        address: impl, codehash: keccak256(implCode), selectors: ia.selectors, dangerous: ia.dangerous,
        opcodes: ia.opcodes,
      };
      a.dangerSetter ||= ia.dangerSetter;
      a.privilegedCode ||= ia.privilegedCode;
    }
  }

  const owner = await probeOwner(client, address, bn);
  const slotUpgradeable = UPGRADE_SLOTS.some((k) => proxySlots[k] !== null);
  const upgradeable = a.upgradeable || slotUpgradeable;
  const dangerSetter = a.dangerSetter;
  const privileged = owner !== null || a.privilegedCode || dangerSetter;

  const dangerous = [...a.dangerous, ...(implementation?.dangerous ?? [])]
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
      accessControl: a.privilegedCode,
      proxySlots,
      implementation,
      owner,
      opcodes: a.opcodes,
    },
  };
}
