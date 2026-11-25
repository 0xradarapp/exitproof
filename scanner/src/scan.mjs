// Deterministic static scanner: bytecode reachability analysis + dispatcher selectors + proxy slots + owner probe.
//
// Heuristics (documented here and in the task report):
//
// 1. Decoding: canonical linear decode from offset 0; PUSH1..PUSH32 skip their immediates (same as the on-chain
//    BytecodeScan). REACHABILITY-PRECISE liveness: code is live from offset 0 and from every canonical JUMPDEST; a
//    live run ends at STOP, RETURN, REVERT, INVALID, SELFDESTRUCT or JUMP (undefined opcodes do NOT end it).
// 2. Symbolic stack: literals (with constant folding), {set} of literals, and tags C (CALLER/ORIGIN), S (SLOAD),
//    A (ADDRESS). JUMPDEST entry stacks come from a forward dataflow pass with light context sensitivity (contexts
//    keyed by return-address literals); if any jump target is unresolved the pass is discarded (every JUMPDEST
//    starts unknown). Unmodelled ops forget the stack (conservative).
// 3. DELEGATECALL/CALLCODE count only if live; a literal 0 / precompile (0x01..0x0a) target is exempt.
// 4. Dispatcher (v3): selectors come ONLY from the dispatcher chain, followed by symbolic execution from offset 0
//    (CALLDATALOAD(0) >> 224 or / 2^224, EQ compare chain, solc GT/LT binary split, callvalue / calldatasize
//    checks). Taken EQ branches are function entries. Any non-compare logic reached on the no-match / no-selector
//    path or in the prologue => fallbackLogic. A dynamic jump or unmodelled op in the chain => not followable.
//    A linear PUSH4..EQ heuristic is kept only to match the dangerous list (more conservative).
// 5. upgradeable = unsafe live DELEGATECALL/CALLCODE OR EIP-1967 impl/beacon slot OR EIP-1822 slot OR an upgrade
//    selector. Minimal proxies (exact EIP-1167 / ERC-7511) are analysed through their implementation (one level;
//    unresolvable => fail closed: upgradeable + dispatcher-unrecognized + clone-unresolved).
// 6. dangerSetter = dangerous-list selector OR live SELFDESTRUCT OR dispatcher-unrecognized (chain not followable
//    or missing transfer/transferFrom/approve/balanceOf).
// 7. privileged (ALLOWLIST model, v3) = owner()/getOwner() non-zero OR hasRole OR CALLER/ORIGIN compared with an
//    SLOAD value or a non-zero 20-byte literal (EQ/SUB/XOR/ADD; L or -L) OR live CALL/STATICCALL to a
//    non-precompile, non-ADDRESS target OR EXTCODESIZE/EXTCODEHASH/EXTCODECOPY of a non-ADDRESS/CALLER/precompile
//    target (CALLER targets are evidence only: anti-bot code-size checks) OR BALANCE of anything but a precompile
//    (incl. CALLER/ADDRESS) or SELFBALANCE (forced ETH makes balances attacker-writable) OR any dispatcher
//    selector outside SAFE (selectors.mjs) OR
//    fallbackLogic OR dangerSetter. The owner probe is an eth_call capped at 100k gas.
import { keccak256, hexToBytes, bytesToHex, getAddress } from 'viem';
import { DANGEROUS, UPGRADE_SELECTORS, HAS_ROLE, OWNER_GETTERS, CORE_ERC20, SAFE } from './selectors.mjs';
import { readProxySlots, UPGRADE_SLOTS, isAddress20 } from './proxy.mjs';

export const SCANNER_VERSION = 8;
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
set([0x50, JUMP], [1, 0]);
set([0x52, 0x53, 0x55, 0x5d, JUMPI], [2, 0]);
set([0x37, 0x39, 0x3e, 0x5e], [3, 0]);
set([0x3c], [4, 0]);
set([0xa0, 0xa1, 0xa2, 0xa3, 0xa4], null); // LOGn: 2+n inputs
set([0xf0], [3, 1]); set([0xf5], [4, 1]);
set([CALL, CALLCODE], [7, 1]); set([DELEGATECALL, STATICCALL], [6, 1]);

// Symbolic values: bigint literal | 'C' (CALLER/ORIGIN) | 'S' (SLOAD-derived) | 'A' (ADDRESS) | null (unknown).
/** SLOAD-derived: 'S' (computed slot) or 'S:0x<slot>' (literal slot). */
const isS = (v) => typeof v === 'string' && (v === 'S' || v.startsWith('S:'));
const MASK_OPS = new Set([0x04, 0x16, 0x1c]); // DIV, AND, SHR keep taint
const TAINT_OPS = new Set([0x01, 0x02, 0x03, 0x18, 0x19]); // ADD, MUL, SUB, XOR, NOT
const CMP_OPS = new Set([0x14, 0x03, 0x18, 0x01]); // EQ, SUB, XOR, ADD (solc -O: add(caller, not(c-1)) == 0)
const MAX_PRECOMPILE = 0x0an;
const isLiteralPrecompile = (v) => (typeof v === 'bigint' && v <= MAX_PRECOMPILE)
  || (v !== null && typeof v === 'object' && Array.isArray(v.set) && v.set.every((x) => x <= MAX_PRECOMPILE));

const BALANCE = 0x31, SELFBALANCE = 0x47;
const EXT_STATE_OPS = new Set([0x31, 0x3b, 0x3c, 0x3f]); // BALANCE, EXTCODESIZE, EXTCODECOPY, EXTCODEHASH
const M256 = (1n << 256n) - 1n;

/** Constant folding for the symbolic stack (args[0] = top of stack). */
function fold(op, args) {
  if (!args.every((v) => typeof v === 'bigint')) return null;
  const [a, b] = args;
  switch (op) {
    case 0x01: return (a + b) & M256;
    case 0x02: return (a * b) & M256;
    case 0x03: return (a - b) & M256;
    case 0x04: return b === 0n ? 0n : a / b;
    case 0x16: return a & b;
    case 0x17: return a | b;
    case 0x18: return a ^ b;
    case 0x19: return M256 ^ a;
    case 0x1b: return a >= 256n ? 0n : (b << a) & M256;
    case 0x1c: return a >= 256n ? 0n : b >> a;
    case 0x14: return a === b ? 1n : 0n;
    case 0x15: return a === 0n ? 1n : 0n;
    default: return null;
  }
}

/**
 * One symbolic stack step (mutates `stack`, top = end). Values: bigint literal | {set:[bigint]} (one of a few
 * literals, from dataflow joins) | 'C' (CALLER/ORIGIN) | 'S' (SLOAD-derived) | 'A' (ADDRESS) | null (unknown).
 * `onCmp(pc, args)` is called for EQ/SUB/XOR. Unmodelled / undefined ops forget the whole stack (conservative).
 */
function stepStack(x, stack, onCmp) {
  const { op, imm, pc } = x;
  const peek = (d) => (d < stack.length ? stack[stack.length - 1 - d] : null);
  if (op === JUMPDEST) return;
  if (imm !== null) { stack.push(imm); return; }
  if (op >= 0x80 && op <= 0x8f) { stack.push(peek(op - 0x80)); return; }
  if (op >= 0x90 && op <= 0x9f) {
    const n = op - 0x8f;
    while (stack.length < n + 1) stack.unshift(null);
    const t = stack.length - 1;
    [stack[t], stack[t - n]] = [stack[t - n], stack[t]];
    return;
  }
  const io = op >= 0xa0 && op <= 0xa4 ? [2 + op - 0xa0, 0] : ARITY.get(op);
  if (!io) { stack.length = 0; return; }
  const args = Array.from({ length: io[0] }, (_, k) => peek(k));
  stack.length = Math.max(0, stack.length - io[0]);
  if (io[1] === 0) return;
  let out = fold(op, args);
  if (op === 0x33 || op === 0x32) out = 'C';
  else if (op === 0x30) out = 'A';
  else if (op === 0x54) out = typeof args[0] === 'bigint' ? `S:0x${args[0].toString(16)}` : 'S'; // v7: literal slot kept
  else if (MASK_OPS.has(op) && out === null) out = args.find((v) => v === 'C' || isS(v)) ?? null;
  else if (CMP_OPS.has(op) && onCmp) onCmp(pc, args);
  // v8: SLOAD taint survives XOR / ADD / SUB / NOT / MUL as a computed-slot 'S' (evidence quality: masked admins)
  if (out === null && TAINT_OPS.has(op) && args.some(isS)) out = 'S';
  stack.push(out);
}

const MAX_SET = 64;
const asSet = (v) => (typeof v === 'bigint' ? [v] : v !== null && typeof v === 'object' && v.set ? v.set : null);
function joinVal(a, b) {
  if (a === b) return a;
  const sa = asSet(a);
  const sb = asSet(b);
  if (sa && sb) {
    const u = [...new Set([...sa, ...sb])].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    if (u.length === 1) return u[0];
    return u.length <= MAX_SET ? { set: u } : null;
  }
  return null;
}
function joinStacks(a, b) {
  const n = Math.min(a.length, b.length);
  const A = a.slice(a.length - n);
  const B = b.slice(b.length - n);
  return A.map((v, k) => joinVal(v, B[k]));
}
const sig = (st) => st.map((v) => (v === null ? '_' : typeof v === 'bigint' ? v.toString(16)
  : typeof v === 'string' ? v : `{${v.set.map((x) => x.toString(16)).join(',')}}`)).join(' ');

/**
 * Forward dataflow over basic blocks with light context sensitivity: each block keeps up to MAX_CTX distinct entry
 * stacks (so an internal function analysed per call site returns to the right caller frame); past the cap its
 * contexts collapse into one joined summary. Returns one joined entry stack per instruction index (used by the
 * detection pass) and whether any jump target stayed unresolved.
 */
const MAX_CTX = 64;
function computeEntries(ins, seeds = [[0, []]], onCmp = null, onOp = null) {
  const idx = new Map(ins.map((x, k) => [x.pc, k]));
  const isDest = (v) => typeof v === 'bigint' && v <= 0xffffffffn && ins[idx.get(Number(v))]?.op === JUMPDEST;
  // Context key = stack depth + the positions/values of JUMPDEST-valued literals (return addresses: a call-string
  // proxy). Contexts with the same key are joined (this widens loop counters and memory offsets).
  const ctxKey = (st) => `${st.length}|${st.map((v) => (isDest(v) ? v.toString(16) : '.')).join(',')}`;
  const ctx = new Map(); // k -> Map(key -> stack), or { summary: stack }
  const work = [];
  let unresolved = false;
  let visits = 0;
  const targetsOf = (v) => {
    const s = asSet(v);
    if (!s) return null;
    return s.map((t) => (t <= 0xffffffffn ? idx.get(Number(t)) : undefined))
      .filter((k) => k !== undefined && ins[k].op === JUMPDEST);
  };
  const edge = (k, st) => {
    let c = ctx.get(k);
    if (!c) { c = { map: new Map(), summary: null }; ctx.set(k, c); }
    if (c.summary) {
      const j = joinStacks(c.summary, st);
      if (sig(j) === sig(c.summary)) return;
      c.summary = j;
      work.push([k, 'S']);
      return;
    }
    const key = ctxKey(st);
    const cur = c.map.get(key);
    if (cur) {
      const j = joinStacks(cur, st);
      if (sig(j) === sig(cur)) return;
      c.map.set(key, j);
      work.push([k, key]);
      return;
    }
    if (c.map.size < MAX_CTX) {
      c.map.set(key, [...st]);
      work.push([k, key]);
      return;
    }
    c.summary = [...c.map.values()].reduce((acc, x) => joinStacks(acc, x), st);
    c.map.clear();
    work.push([k, 'S']);
  };
  const visited = new Set();
  for (const [k, st] of seeds) edge(k, st);
  while (work.length) {
    if (++visits > 200_000) return { entries: new Map(), unresolved: true, visited };
    const [start, key] = work.pop();
    const c = ctx.get(start);
    const entry = key === 'S' ? c.summary : c.map.get(key);
    if (!entry) continue; // superseded by a summary
    const stack = [...entry];
    for (let i = start; i < ins.length; i++) {
      const { op } = ins[i];
      if (i > start && op === JUMPDEST) { edge(i, stack); break; }
      visited.add(i);
      if (onOp) onOp(ins[i], stack);
      if (op === JUMP || op === JUMPI) {
        const t = targetsOf(stack.length ? stack[stack.length - 1] : null);
        stepStack(ins[i], stack, onCmp);
        if (t === null) unresolved = true;
        else for (const k of t) edge(k, stack);
        if (op === JUMP) break;
        continue; // JUMPI falls through within this walk
      }
      if (TERMINATORS.has(op)) break;
      stepStack(ins[i], stack, onCmp);
    }
  }
  const entries = new Map();
  for (const [k, c] of ctx) {
    const all = c.summary ? [c.summary] : [...c.map.values()];
    entries.set(k, all.reduce((acc, x) => joinStacks(acc, x)));
  }
  return { entries, unresolved, visited };
}

// ---- dispatcher chain (scanner v3) ----
// Symbolic execution from offset 0 over the dispatcher only. Values: bigint | 'CD0' (calldataload(0)) |
// 'SEL' (selector) | {eq: sel} / {neq: sel} | 'CMP' (SEL vs literal ordering) | 'CDS' (calldatasize-derived) |
// 'CV' (callvalue-derived) | null. Phases: 'pre' (before any calldatasize check: prologue), 'cds' (after it),
// 'chain' (selector exists). Taken EQ branches are function entries (not followed); GT/LT pivots, callvalue and
// calldatasize checks fork both ways. In 'cds'/'chain' only compare-chain ops are allowed; any other op is the
// body of a fallback/receive (or prologue logic) => fallbackLogic.
const CHAIN_OPS = new Set([0x00, 0x10, 0x11, 0x14, 0x15, 0x16, 0x34, 0x36, 0x50, 0x56, 0x57, 0x5b, 0xfd, 0xfe]);
const SEL_OPS = new Set([0x04, 0x1c, 0x35]); // DIV, SHR, CALLDATALOAD (selector extraction)
const PRE_OPS = new Set([...CHAIN_OPS, ...SEL_OPS, 0x52]); // + MSTORE (free memory pointer)
const DISPATCH_BUDGET = 20_000;
const isSelConst = (v) => typeof v === 'bigint' && v <= 0xffffffffn;
const selHex = (v) => `0x${v.toString(16).padStart(8, '0')}`;

function analyzeDispatcher(ins) {
  const idx = new Map(ins.map((x, k) => [x.pc, k]));
  const res = { ok: true, failure: null, selectors: [], fallbackLogic: false, logicAt: [], entries: {} };
  const sels = new Set();
  const addEntry = (sel, k) => { (res.entries[sel] ??= []).includes(k) || res.entries[sel].push(k); };
  const logic = new Set();
  const fail = (why) => { if (res.ok) { res.ok = false; res.failure = why; } };
  const jumpIdx = (t) => {
    if (typeof t !== 'bigint' || t > 0xffffffffn) return -1;
    const k = idx.get(Number(t));
    return k !== undefined && ins[k].op === JUMPDEST ? k : -1;
  };
  const seen = new Set();
  const work = [{ i: 0, stack: [], phase: 'pre' }];
  let steps = 0;
  const key = (st) => `${st.i}|${st.phase}|${st.stack.map((v) => (typeof v === 'bigint' ? v.toString(16) : JSON.stringify(v))).join(',')}`;

  while (work.length && res.ok) {
    const st = work.pop();
    const k0 = key(st);
    if (seen.has(k0)) continue;
    seen.add(k0);
    let { i, phase } = st;
    const stack = [...st.stack];
    const peek = (d) => (d < stack.length ? stack[stack.length - 1 - d] : null);
    const pop = () => (stack.length ? stack.pop() : null);
    for (;;) {
      if (++steps > DISPATCH_BUDGET) { fail('budget'); break; }
      if (i >= ins.length) break; // implicit STOP
      const { op, imm, pc } = ins[i];
      const allowed = phase === 'chain' ? CHAIN_OPS : phase === 'cds' ? new Set([...CHAIN_OPS, ...SEL_OPS]) : PRE_OPS;
      if (imm === null && !(op >= 0x80 && op <= 0x9f) && !allowed.has(op)) { logic.add(pc); break; }
      if (imm !== null) { stack.push(imm); i++; continue; }
      if (op >= 0x80 && op <= 0x8f) { stack.push(peek(op - 0x80)); i++; continue; }
      if (op >= 0x90 && op <= 0x9f) {
        const n = op - 0x8f;
        while (stack.length < n + 1) stack.unshift(null);
        const t = stack.length - 1;
        [stack[t], stack[t - n]] = [stack[t - n], stack[t]];
        i++;
        continue;
      }
      if (op === 0x00 || op === 0xfd || op === 0xfe) break; // STOP / REVERT / INVALID: path ends cleanly
      if (op === JUMPDEST) { i++; continue; }
      if (op === 0x50) { pop(); i++; continue; }
      if (op === 0x52) { pop(); pop(); i++; continue; }
      if (op === 0x36) { stack.push('CDS'); i++; continue; }
      if (op === 0x34) { stack.push('CV'); i++; continue; }
      if (op === 0x35) { const a = pop(); stack.push(a === 0n ? 'CD0' : null); i++; continue; }
      if (op === 0x1c) { // SHR
        const a = pop(); const b = pop();
        stack.push(a === 224n && b === 'CD0' ? 'SEL' : fold(op, [a, b]));
        if (stack[stack.length - 1] === 'SEL') phase = 'chain';
        i++; continue;
      }
      if (op === 0x04) { // DIV
        const a = pop(); const b = pop();
        stack.push(a === 'CD0' && b === 1n << 224n ? 'SEL' : fold(op, [a, b]));
        if (stack[stack.length - 1] === 'SEL') phase = 'chain';
        i++; continue;
      }
      if (op === 0x16) { // AND
        const a = pop(); const b = pop();
        const isMask = (x) => x === 0xffffffffn;
        stack.push((a === 'SEL' && isMask(b)) || (b === 'SEL' && isMask(a)) ? 'SEL' : fold(op, [a, b]));
        i++; continue;
      }
      if (op === 0x14) { // EQ
        const a = pop(); const b = pop();
        let v = fold(op, [a, b]);
        if (a === 'SEL' && isSelConst(b)) v = { eq: b };
        else if (b === 'SEL' && isSelConst(a)) v = { eq: a };
        else if (a === 'CDS' || b === 'CDS') v = 'CDS';
        else if (a === 'CV' || b === 'CV') v = 'CV';
        stack.push(v); i++; continue;
      }
      if (op === 0x10 || op === 0x11) { // LT / GT
        const a = pop(); const b = pop();
        let v = fold(op === 0x10 ? 0x10 : 0x11, [a, b]);
        if (v === null && typeof a === 'bigint' && typeof b === 'bigint') v = op === 0x10 ? (a < b ? 1n : 0n) : (a > b ? 1n : 0n);
        if ((a === 'SEL' && typeof b === 'bigint') || (b === 'SEL' && typeof a === 'bigint')) v = 'CMP';
        else if (a === 'CDS' || b === 'CDS') v = 'CDS';
        else if (a === 'CV' || b === 'CV') v = 'CV';
        stack.push(v); i++; continue;
      }
      if (op === 0x15) { // ISZERO
        const a = pop();
        let v = fold(op, [a]);
        if (a && typeof a === 'object') v = a.eq !== undefined ? { neq: a.eq } : { eq: a.neq };
        else if (a === 'CDS' || a === 'CV' || a === 'CMP') v = a;
        stack.push(v); i++; continue;
      }
      if (op === JUMP) {
        const t = jumpIdx(pop());
        if (t < 0) { fail(`dynamic-jump@${pc}`); break; }
        i = t; continue;
      }
      if (op === JUMPI) {
        const t = jumpIdx(pop()); const c = pop();
        if (t < 0) { fail(`dynamic-jumpi@${pc}`); break; }
        if (c && typeof c === 'object' && c.eq !== undefined) { sels.add(selHex(c.eq)); addEntry(selHex(c.eq), t); i++; continue; }
        if (c && typeof c === 'object' && c.neq !== undefined) { sels.add(selHex(c.neq)); addEntry(selHex(c.neq), i + 1); i = t; continue; }
        if (typeof c === 'bigint') { i = c === 0n ? i + 1 : t; continue; }
        if (c === 'CMP' || c === 'CV' || c === 'CDS' || phase === 'pre') {
          const np = c === 'CDS' && phase === 'pre' ? 'cds' : phase;
          work.push({ i: t, stack: [...stack], phase: np });
          phase = np;
          i++;
          continue;
        }
        logic.add(pc); // a JUMPI on something that is not a selector compare: not dispatcher code
        break;
      }
      fail(`unmodelled@${pc}`);
      break;
    }
  }
  res.selectors = [...sels].sort(sortStr);
  res.logicAt = [...logic].sort((a, b) => a - b);
  res.fallbackLogic = res.logicAt.length > 0;
  return res;
}

// ---- block-context reads on the transfer paths (scanner v5, F-03 static fence) ----
// NUMBER / TIMESTAMP / ORIGIN / TLOAD read on a path reachable from transfer() or transferFrom() can make a sale
// depend on the block, the time, the transaction origin or the transaction itself: the router's same-transaction
// probe cannot see such a trap. Any such read makes the token `privileged` (strict blocks it); time-based traps are
// left to the simulator for balanced mode (EIP-2612 permit and honest launch logic also read TIMESTAMP).
// v6 (N-02): block-environment reads that tell a fork from mainnet (or have no honest use on a transfer path) are
// also collected; any of them sets `dangerSetter` (reason env-fingerprint), not only `privileged`.
const BLOCK_CTX_OPS = Object.freeze({
  0x32: 'ORIGIN', 0x42: 'TIMESTAMP', 0x43: 'NUMBER', 0x5c: 'TLOAD',
  0x3a: 'GASPRICE', 0x40: 'BLOCKHASH', 0x41: 'COINBASE', 0x44: 'PREVRANDAO', 0x48: 'BASEFEE', 0x4a: 'BLOBBASEFEE',
});
export const ENV_FINGERPRINT_OPS = Object.freeze(['BASEFEE', 'BLOBBASEFEE', 'BLOCKHASH', 'COINBASE', 'GASPRICE', 'PREVRANDAO']);
const TRANSFER_PATH_SELECTORS = Object.freeze(CORE_ERC20.slice(0, 2)); // transfer, transferFrom

/**
 * Instruction indices reachable from the `starts` instruction indices: the same context-sensitive dataflow as the
 * main pass, seeded at the function entries (so an internal function shared with, say, permit() returns only to the
 * caller frames reached from here). Returns null when any jump target is unresolved (the caller then falls back to
 * whole-code liveness, which is conservative).
 */
function reachableFrom(ins, starts, entries) {
  const r = computeEntries(ins, starts.map((k) => [k, [...(entries.get(k) ?? [])]]));
  return r.unresolved ? null : r.visited;
}

function blockContextOf(ins, df, disp, liveIdx) {
  const starts = TRANSFER_PATH_SELECTORS.flatMap((s) => disp.entries[s] ?? []);
  if (!starts.length) return { scope: 'no-transfer-entry', ops: {} };
  const r = df.unresolved ? null : reachableFrom(ins, starts, df.entries);
  const scope = r === null ? 'whole-code' : 'transfer-paths';
  const ops = {};
  for (const k of r === null ? liveIdx : [...r].sort((a, b) => a - b)) {
    const name = BLOCK_CTX_OPS[ins[k].op];
    if (name) (ops[name] ??= []).push(ins[k].pc);
  }
  return { scope, ops: Object.fromEntries(Object.entries(ops).sort(([a], [b]) => sortStr(a, b))) };
}

// ---- per-selector magic constants (v6, N-01) ----
// For every dispatcher selector outside SAFE: the literals compared (EQ / XOR) on the paths reachable from its entry,
// e.g. `require(key == 0x1234)`. The simulator adds them to its ABI-less argument patterns.
const MAX_HINTS = 8;
const OWNERSHIP_TRANSFER = '0xf2fde38b'; // transferOwnership(address)
const HINT_LIMIT = 1n << 160n;
function selectorHintsOf(ins, df, disp, liveIdx) {
  const hints = {};
  const callerGated = [];
  const plumbing = [];
  const opAt = new Map(ins.map((x) => [x.pc, x.op]));
  const liveCaller = liveIdx.some((k) => ins[k].op === 0x33 || ins[k].op === 0x32);
  for (const sel of Object.keys(disp.entries).sort(sortStr)) {
    if (SAFE[sel]) continue;
    const consts = new Set();
    const callerSlots = new Set();
    const sstores = [];
    let calls = 0;
    const onCmp = (pc, args) => {
      if (args.includes('C')) for (const v of args) if (isS(v)) callerSlots.add(v);
      const op = opAt.get(pc);
      if (op === 0x01 || op === 0x03) return; // ADD / SUB: memory and calldata offsets
      for (const v of args) for (const x of asSet(v) ?? []) if (x > 1n && x < HINT_LIMIT) consts.add(x);
    };
    const onOp = (x, stack) => {
      if (x.op === 0x55) sstores.push(stack.length ? stack[stack.length - 1] : null);
      if ([0xf0, 0xf1, 0xf2, 0xf4, 0xf5, 0xfa, 0xff].includes(x.op)) calls++;
    };
    const starts = disp.entries[sel];
    const r = df.unresolved ? { unresolved: true, visited: new Set() }
      : computeEntries(ins, starts.map((k) => [k, [...(df.entries.get(k) ?? [])]]), onCmp, onOp);
    // v8 rule: an unknown selector whose reachable code reads CALLER or ORIGIN is caller-gated. Unresolved jumps fall
    // back to whole-code liveness (conservative).
    const readsCaller = r.unresolved ? liveCaller
      : [...r.visited].some((k) => ins[k].op === 0x33 || ins[k].op === 0x32);
    if (readsCaller && !DANGEROUS[sel]) {
      // Ownable.transferOwnership(address) shape: no external call, one SSTORE, to the literal slot compared with
      // CALLER in this function (the owner slot). Anything more is treated as an ordinary caller-gated function.
      const slot = sstores.length === 1 && typeof sstores[0] === 'bigint' ? `S:0x${sstores[0].toString(16)}` : null;
      if (sel === OWNERSHIP_TRANSFER && !r.unresolved && calls === 0 && slot && callerSlots.has(slot)) plumbing.push(sel);
      else callerGated.push(sel);
    }
    if (r.unresolved && !consts.size) continue;
    const list = [...consts].filter((x) => x !== 0xffffffffn && !(x <= 0xffffffffn && disp.entries[selHex(x)]))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, MAX_HINTS);
    if (list.length) hints[sel] = list.map((x) => `0x${x.toString(16)}`);
  }
  return { hints, callerGated, plumbing };
}

const isPush = (op) => op >= 0x60 && op <= 0x7f;
const sortStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Offset of solc's CBOR metadata trailer (map with an ipfs / bzzr / solc key, length in the last 2 bytes), or null. */
export function metadataStart(bytes) {
  const n = bytes.length;
  if (n < 4) return null;
  const len = (bytes[n - 2] << 8) | bytes[n - 1];
  const start = n - 2 - len;
  if (len < 8 || start < 1 || bytes[start] < 0xa1 || bytes[start] > 0xa5) return null;
  const txt = Buffer.from(bytes.subarray(start, n - 2)).toString('latin1');
  return /ipfs|bzzr0|bzzr1|solc|experimental/.test(txt) ? start : null;
}

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
  const selectors = new Set(); // linear heuristic (dangerous-list matching only)
  const callerChecks = [];
  const callerLiteralChecks = [];
  const callerCheckSlots = []; // per caller-vs-storage check: the literal storage slot compared, or null
  const callerLiterals = new Set(); // the admin addresses themselves (immutables / constants compared with CALLER)
  const externalCallOffsets = [];
  const externalStateOffsets = [];
  const callerCodeOffsets = [];
  let balanceReads = 0;
  let unsafeDelegate = false;
  const liveCallerIdx = []; // live CALLER / ORIGIN (whole-code fallback of the caller-gated rule)
  const liveBlockCtx = []; // instruction indices of live NUMBER/TIMESTAMP/ORIGIN/TLOAD (whole-code fallback)

  // Entry stacks for every JUMPDEST from a small dataflow pass (constants / tags flow across internal jumps). If
  // any jump target cannot be resolved, the pass is discarded and every JUMPDEST starts from an unknown stack
  // (sound: an unresolved jump could enter any block with any stack).
  const df = computeEntries(ins);
  // v6: solc's CBOR metadata trailer is data. A 0x5b byte inside its hash would otherwise open a "live" run and
  // count random bytes as opcodes (EXTCODEHASH, BALANCE, ...). It is skipped only when the dataflow resolved every
  // jump and no executed instruction lies inside it (so no code can execute there).
  const metaFrom = metadataStart(bytes);
  // v7: no instruction the dataflow executed may start inside it (a fall-through or a PUSH whose immediate runs into
  // the trailer reaches code there without any JUMPDEST)
  const skipMeta = metaFrom !== null && !df.unresolved && ![...df.visited].some((k) => ins[k].pc >= metaFrom);
  const entries = df.unresolved ? new Map() : df.entries;

  let live = true;
  let stack = []; // top = end; the floor below is unknown
  const peek = (d) => (d < stack.length ? stack[stack.length - 1 - d] : null);
  // A literal L qualifies as an admin address if L or its two's-complement negation is non-zero and < 2^160
  // (`caller == C` may be lowered to `add(caller, not(C-1))` = caller - C). Joined literal sets are checked per member.
  const ADDR_LIMIT = 1n << 160n;
  const isAddrLit = (v) => v > 0n && v < ADDR_LIMIT;
  const litQualifies = (v) => (asSet(v) ?? []).some((x) => isAddrLit(x) || isAddrLit(((1n << 256n) - x) & M256));
  const onCmp = (pc, args) => {
    if (!args.includes('C')) return;
    const sv = args.find(isS);
    if (sv) {
      callerChecks.push(pc);
      callerCheckSlots.push(sv === 'S' ? null : sv.slice(2)); // null = computed slot (mapping, packed via SHA3, ...)
    }
    else if (args.some(litQualifies)) {
      callerLiteralChecks.push(pc);
      for (const v of args) {
        for (const x of asSet(v) ?? []) {
          const a = isAddrLit(x) ? x : isAddrLit(((1n << 256n) - x) & M256) ? ((1n << 256n) - x) & M256 : null;
          if (a !== null) callerLiterals.add(getAddress(`0x${a.toString(16).padStart(40, '0')}`));
        }
      }
    }
  };

  for (let i = 0; i < ins.length; i++) {
    const { op, pc } = ins[i];
    if (skipMeta && pc >= metaFrom) break;
    if (op === JUMPDEST) { live = true; stack = entries.has(i) ? [...entries.get(i)] : []; continue; }
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
    if (EXT_STATE_OPS.has(op)) {
      const target = peek(0);
      if (op === BALANCE && (target === 'C' || target === 'A')) {
        // native balances of msg.sender / self are writable by anyone via forced ETH (SELFDESTRUCT): kill switch
        externalStateOffsets.push(pc);
        balanceReads++;
      } else if (target === 'C') callerCodeOffsets.push(pc); // EXTCODE*(msg.sender): anti-bot, evidence only
      else if (target !== 'A' && !isLiteralPrecompile(target)) {
        externalStateOffsets.push(pc);
        if (op === BALANCE) balanceReads++;
      }
    }
    if (op === SELFBALANCE) { externalStateOffsets.push(pc); balanceReads++; }
    if (BLOCK_CTX_OPS[op]) liveBlockCtx.push(i);
    if (op === 0x33 || op === 0x32) liveCallerIdx.push(i);
    if (op === SELFDESTRUCT) opcodes.selfdestruct++;
    if (TERMINATORS.has(op)) { live = false; stack = []; continue; }
    stepStack(ins[i], stack, onCmp);
  }

  const linear = [...selectors].sort(sortStr);
  const disp = analyzeDispatcher(ins);
  const sel = disp.selectors;
  const all = [...new Set([...linear, ...sel])].sort(sortStr);
  const dangerous = all.filter((s) => DANGEROUS[s]).map((s) => ({ selector: s, signature: DANGEROUS[s] }));
  const upgradeSelector = all.some((s) => UPGRADE_SELECTORS.includes(s));
  const accessControl = all.includes(HAS_ROLE);
  const blockContext = blockContextOf(ins, df, disp, liveBlockCtx);
  const blockContextRead = Object.keys(blockContext.ops).length > 0;
  const envFingerprint = ENV_FINGERPRINT_OPS.some((n) => blockContext.ops[n]);
  const unk = selectorHintsOf(ins, df, disp, liveCallerIdx);
  const selectorHints = df.unresolved ? {} : unk.hints;
  return {
    selectors: sel,
    linearSelectors: linear,
    dispatcher: { ok: disp.ok, failure: disp.failure, fallbackLogic: disp.fallbackLogic, logicAt: disp.logicAt },
    dangerous,
    opcodes,
    jumpsResolved: !df.unresolved,
    callerChecks,
    callerLiteralChecks,
    metadataSkipped: skipMeta,
    callerLiterals: [...callerLiterals].sort(sortStr),
    callerCheckSlots: [...new Set(callerCheckSlots.map(String))].sort(sortStr).map((x) => (x === 'null' ? null : x)),
    selectorHints,
    callerGatedUnknown: unk.callerGated,
    ownershipPlumbing: unk.plumbing,
    envFingerprint,
    externalCalls: { count: externalCallOffsets.length, offsets: externalCallOffsets },
    externalState: { count: externalStateOffsets.length, offsets: externalStateOffsets, balance: balanceReads },
    callerCodeChecks: { count: callerCodeOffsets.length, offsets: callerCodeOffsets },
    unsafeDelegatecall: unsafeDelegate,
    upgradeable: unsafeDelegate || upgradeSelector,
    dangerSetter: dangerous.length > 0 || opcodes.selfdestruct > 0 || envFingerprint || unk.callerGated.length > 0,
    accessControl,
    blockContext,
    privilegedCode: accessControl || callerChecks.length > 0 || callerLiteralChecks.length > 0
      || externalCallOffsets.length > 0 || externalStateOffsets.length > 0 || blockContextRead,
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
        dispatcher: ia.dispatcher, callerChecks: ia.callerChecks, callerLiteralChecks: ia.callerLiteralChecks,
        externalCalls: ia.externalCalls, externalState: ia.externalState, callerCodeChecks: ia.callerCodeChecks,
        blockContext: ia.blockContext, opcodes: ia.opcodes,
      };
    }
  }

  const owner = await probeOwner(client, address, bn);
  const slotUpgradeable = UPGRADE_SLOTS.some((k) => proxySlots[k] !== null);
  const both = (f) => f(a) || (ia !== null && f(ia));

  // Dispatcher recognition (v3): selectors come only from the followed dispatcher chain. It must be followable and
  // contain the four ERC-20 core selectors (token + EIP-1967 implementation merged), else fail closed.
  const merged = new Set([...a.selectors, ...(ia?.selectors ?? [])]);
  const chainOk = a.dispatcher.ok && (ia === null || ia.dispatcher.ok);
  const dispatcherUnrecognized = !chainOk || !CORE_ERC20.every((s) => merged.has(s));
  // Allowlist (v3): any dispatcher selector that is not known-safe makes the token privileged.
  const unknownSelectors = [...merged].filter((s) => !SAFE[s]).sort(sortStr);
  const fallbackLogic = both((x) => x.dispatcher.fallbackLogic);

  const reasons = new Set();
  if (owner !== null) reasons.add('owner-getter');
  if (both((x) => x.accessControl)) reasons.add('access-control');
  if (both((x) => x.callerChecks.length > 0)) reasons.add('caller-vs-storage');
  if (both((x) => x.callerLiteralChecks.length > 0)) reasons.add('caller-vs-literal');
  if (both((x) => x.externalCalls.count > 0)) reasons.add('external-call');
  if (both((x) => x.externalState.count > 0)) reasons.add('external-state');
  if (both((x) => Object.keys(x.blockContext.ops).length > 0)) reasons.add('block-context');
  if (both((x) => x.envFingerprint)) reasons.add('env-fingerprint');
  if (both((x) => x.callerGatedUnknown.length > 0)) reasons.add('caller-gated-unknown');
  if (both((x) => x.dangerous.length > 0)) reasons.add('dangerous-selector');
  if (both((x) => x.opcodes.selfdestruct > 0)) reasons.add('live-selfdestruct');
  if (dispatcherUnrecognized) reasons.add('dispatcher-unrecognized');
  if (unknownSelectors.length) reasons.add('unknown-selector');
  if (fallbackLogic) reasons.add('fallback-logic');
  if ([...a.selectors, ...a.linearSelectors].some((x) => UPGRADE_SELECTORS.includes(x))) reasons.add('upgrade-selector');
  if (a.unsafeDelegatecall) reasons.add('delegatecall');
  if (slotUpgradeable) reasons.add('proxy-slot');
  if (cloneUnresolved) reasons.add('clone-unresolved');

  const upgradeable = a.upgradeable || slotUpgradeable;
  const dangerSetter = both((x) => x.dangerSetter) || dispatcherUnrecognized;
  const privileged = owner !== null || both((x) => x.privilegedCode) || dangerSetter || unknownSelectors.length > 0
    || fallbackLogic;

  const dangerous = [...a.dangerous, ...(ia?.dangerous ?? [])]
    .filter((d, i, arr) => arr.findIndex((x) => x.selector === d.selector) === i)
    .sort((x, y) => sortStr(x.selector, y.selector));

  return {
    codehash,
    block: Number(bn),
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
      unknownSelectors,
      dispatcher: a.dispatcher,
      jumpsResolved: a.jumpsResolved,
      callerChecks: a.callerChecks,
      callerLiteralChecks: a.callerLiteralChecks,
      externalCalls: a.externalCalls,
      externalState: a.externalState,
      callerCodeChecks: a.callerCodeChecks,
      blockContext: a.blockContext,
      callerLiterals: [...new Set([...a.callerLiterals, ...(ia?.callerLiterals ?? [])])].sort(sortStr),
      callerCheckSlots: [...new Set([...a.callerCheckSlots, ...(ia?.callerCheckSlots ?? [])].map(String))].sort(sortStr)
        .map((x) => (x === 'null' ? null : x)),
      selectorHints: { ...(ia?.selectorHints ?? {}), ...a.selectorHints },
      callerGatedUnknown: [...new Set([...a.callerGatedUnknown, ...(ia?.callerGatedUnknown ?? [])])].sort(sortStr),
      ownershipPlumbing: [...new Set([...a.ownershipPlumbing, ...(ia?.ownershipPlumbing ?? [])])].sort(sortStr),
      proxySlots,
      implementation,
      clone,
      owner,
      opcodes: a.opcodes,
    },
  };
}
