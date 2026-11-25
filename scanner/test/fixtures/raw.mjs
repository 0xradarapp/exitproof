// Raw-bytecode scanner fixtures (runtime code, installed with anvil_setCode).

const ERC20_SELECTORS = ['a9059cbb', '23b872dd', '095ea7b3', '70a08231']; // transfer, transferFrom, approve, balanceOf

/**
 * XOR dispatcher: `DUP1 PUSH4 sel XOR ISZERO PUSH1 dest JUMPI` per selector (no EQ anywhere), so the EQ-form
 * selector extraction recognises nothing. Layout: 5-byte prologue, 4 x 11-byte cases, PUSH0 PUSH0 REVERT, then
 * JUMPDEST STOP at 0x34.
 */
export const XOR_DISPATCHER = `0x5f3560e01c${ERC20_SELECTORS.map((s) => `8063${s}1815603457`).join('')}5f5ffd5b00`;

/** Standard solc-style EQ dispatcher for the four ERC-20 selectors plus `extra` (hex without 0x), all jumping to a STOP. */
export function eqDispatcher(extra = [], tail = '') {
  const sels = [...ERC20_SELECTORS, ...extra];
  const body = sels.map((s) => `8063${s}1461ZZZZ57`).join('');
  const prologue = '5f3560e01c';
  const dest = (prologue.length + body.length) / 2 + 3 + tail.length / 2; // after `5f5ffd` + tail
  const d = dest.toString(16).padStart(4, '0');
  return `0x${prologue}${body.replaceAll('ZZZZ', d)}5f5ffd${tail}5b00`;
}
