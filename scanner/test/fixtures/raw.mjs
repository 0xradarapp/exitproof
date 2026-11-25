// Raw-bytecode scanner fixtures (runtime code, installed with anvil_setCode).

const ERC20_SELECTORS = ['a9059cbb', '23b872dd', '095ea7b3', '70a08231']; // transfer, transferFrom, approve, balanceOf

/**
 * XOR dispatcher: `DUP1 PUSH4 sel XOR ISZERO PUSH1 dest JUMPI` per selector (no EQ anywhere), so the EQ-form
 * selector extraction recognises nothing. Layout: 5-byte prologue, 4 x 11-byte cases, PUSH0 PUSH0 REVERT, then
 * JUMPDEST STOP at 0x34.
 */
export const XOR_DISPATCHER = `0x5f3560e01c${ERC20_SELECTORS.map((s) => `8063${s}1815603457`).join('')}5f5ffd5b00`;

/** Standard solc-style EQ dispatcher for the four ERC-20 selectors plus `extra` (hex without 0x), all jumping to a STOP. */
export function eqDispatcher(extra = [], tail = '', noMatch = '5f5ffd') {
  const sels = [...ERC20_SELECTORS, ...extra];
  const body = sels.map((s) => `8063${s}1461ZZZZ57`).join('');
  const prologue = '5f3560e01c';
  const dest = (prologue.length + body.length + noMatch.length + tail.length) / 2;
  const d = dest.toString(16).padStart(4, '0');
  return `0x${prologue}${body.replaceAll('ZZZZ', d)}${noMatch}${tail}5b00`;
}

/** XOR dispatcher followed by a never-jumped JUMPDEST decoy block holding `PUSH4 sel DUP1 EQ POP` x4. */
export const DECOY_XOR = `${XOR_DISPATCHER}5b${ERC20_SELECTORS.map((s) => `63${s}801450`).join('')}00`;

/**
 * solc-style binary split: `DUP1 PUSH4 pivot GT PUSH2 upper JUMPI`, lower EQ cases, revert, upper JUMPDEST, upper
 * EQ cases, revert, function body JUMPDEST STOP.
 */
export function splitDispatcher() {
  const sorted = [...ERC20_SELECTORS].sort();
  const [lo, hi] = [sorted.slice(0, 2), sorted.slice(2)];
  const pro = '5f3560e01c';
  const split = `8063${lo[1]}1161UUUU57`; // 11 bytes
  const cases = (xs) => xs.map((s) => `8063${s}1461DDDD57`).join('');
  const lower = `${cases(lo)}5f5ffd`;
  const upperStart = (pro.length + split.length + lower.length) / 2;
  const upper = `5b${cases(hi)}5f5ffd`;
  const dest = upperStart + upper.length / 2;
  const hex = (n) => n.toString(16).padStart(4, '0');
  return `0x${pro}${split.replace('UUUU', hex(upperStart))}${lower}${upper}`.replaceAll('DDDD', hex(dest)) + '5b00';
}

/** EIP-1167 minimal proxy runtime pointing at `impl`. */
export const eip1167 = (impl) => `0x363d3d373d3d3d363d73${impl.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`;
/** ERC-7511 (PUSH0) minimal proxy runtime pointing at `impl`. */
export const erc7511 = (impl) => `0x365f5f375f5f365f73${impl.slice(2).toLowerCase()}5af43d5f5f3e5f3d91602a57fd5bf3`;
