import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCode } from '../src/scan.mjs';
import { DANGEROUS, UPGRADE_SELECTORS, selectorOf } from '../src/selectors.mjs';

const A = (hex) => analyzeCode(`0x${hex}`);

test('DELEGATECALL at offset 0 region is live', () => {
  assert.equal(A('f4').opcodes.delegatecall, 1);
});

test('DELEGATECALL after STOP with no JUMPDEST is dead', () => {
  const r = A('00f4');
  assert.equal(r.opcodes.delegatecall, 0);
  assert.equal(r.opcodes.deadDelegatecall, 1);
});

test('DELEGATECALL after a canonical JUMPDEST is live again', () => {
  assert.equal(A('005bf4').opcodes.delegatecall, 1);
});

test('PUSH immediates are skipped (0xf4 / 0x5b inside data)', () => {
  assert.equal(A('60f4').opcodes.delegatecall, 0);
  // PUSH2 0x5bf4: neither the JUMPDEST nor DELEGATECALL byte are canonical
  const r = A('00615bf4');
  assert.equal(r.opcodes.delegatecall, 0);
  assert.equal(r.opcodes.deadDelegatecall, 0);
});

test('terminators end a live run: JUMP, RETURN, REVERT, INVALID, SELFDESTRUCT, undefined', () => {
  for (const t of ['56', 'f3', 'fd', 'fe', 'ff', '0c', 'ef', '21']) {
    assert.equal(A(`${t}f4`).opcodes.delegatecall, 0, `terminator ${t}`);
  }
});

test('JUMPI falls through: still live', () => {
  assert.equal(A('57f4').opcodes.delegatecall, 1);
});

test('Cancun opcodes (TLOAD/TSTORE/MCOPY/PUSH0/BLOBHASH) do not terminate', () => {
  for (const t of ['5c', '5d', '5e', '5f', '49', '4a']) {
    assert.equal(A(`${t}f4`).opcodes.delegatecall, 1, `cancun op ${t}`);
  }
});

test('live DELEGATECALL / CALLCODE => upgradeable; dead => not', () => {
  assert.equal(A('f4').upgradeable, true);
  assert.equal(A('f2').upgradeable, true);
  assert.equal(A('00f4').upgradeable, false);
  assert.equal(A('00f2').upgradeable, false);
});

test('DELEGATECALL to literal zero / precompile address is not upgradeable', () => {
  // PUSH0 DUP1 PUSH0 DUP1 PUSH0 GAS DELEGATECALL (solc output for delegatecall(gas(),0,0,0,0,0))
  const r = A('5f805f805f5af4');
  assert.equal(r.upgradeable, false);
  assert.equal(r.opcodes.delegatecall, 1);
  assert.equal(r.opcodes.constTargetDelegatecall, 1);
  // literal precompile 0x04 (identity)
  assert.equal(A('5f805f8060045af4').upgradeable, false);
});

test('DELEGATECALL to a literal non-precompile address stays upgradeable', () => {
  assert.equal(A(`5f805f8073${'11'.repeat(20)}5af4`).upgradeable, true);
});

test('DELEGATECALL whose target comes from storage is upgradeable', () => {
  // PUSH0 DUP1 PUSH0 DUP1 PUSH0 SLOAD GAS DELEGATECALL
  assert.equal(A('5f805f805f545af4').upgradeable, true);
});

test('live SELFDESTRUCT => dangerSetter, dead one is ignored', () => {
  assert.equal(A('ff').dangerSetter, true);
  assert.equal(A('00ff').dangerSetter, false);
});

test('selector extraction: DUP1 PUSH4 EQ and PUSH4 DUP2 EQ forms', () => {
  const r = A('8063aabbccdd1461001057' + '63a9059cbb81146100105700');
  assert.deepEqual(r.selectors, ['0xa9059cbb', '0xaabbccdd']);
});

test('selector extraction: PUSH3 (leading-zero selector) is padded', () => {
  assert.deepEqual(A('8062bbccdd14').selectors, ['0x00bbccdd']);
});

test('PUSH4 not followed by EQ (custom error, mask) is not a selector', () => {
  assert.deepEqual(A('63aabbccdd5f52').selectors, []);
  assert.deepEqual(A('63aabbccdd1061001057').selectors, []);
});

test('dangerous selector in dispatcher => dangerSetter; upgradeTo => upgradeable', () => {
  const setSellFee = selectorOf('setSellFee(uint256)').slice(2);
  const r = A(`8063${setSellFee}14`);
  assert.equal(r.dangerSetter, true);
  assert.equal(r.upgradeable, false);
  const up = selectorOf('upgradeToAndCall(address,bytes)').slice(2);
  const u = A(`8063${up}14`);
  assert.equal(u.upgradeable, true);
});

test('AccessControl hasRole selector => privilegedCode', () => {
  assert.equal(A('806391d1485414').privilegedCode, true);
  assert.equal(A('00').privilegedCode, false);
});

test('dangerous list is keccak-derived and covers required names', () => {
  assert.equal(selectorOf('transfer(address,uint256)'), '0xa9059cbb');
  const names = new Set(Object.values(DANGEROUS).map((s) => s.split('(')[0]));
  for (const n of ['setFee', 'setFees', 'setTax', 'setTaxes', 'setBuyFee', 'setSellFee', 'setBuyTax',
    'setSellTax', 'updateFees', 'setTaxFeePercent', 'setMarketingFee', 'setLiquidityFee', 'blacklist', 'addBot',
    'addBots', 'setBots', 'blacklistAddress', 'setBlacklist', 'addToBlacklist', 'setMaxTxAmount', 'setMaxTx',
    'setMaxWallet', 'setMaxWalletSize', 'setMaxSellAmount', 'pause', 'unpause', 'enableTrading', 'openTrading',
    'setTradingEnabled', 'setTrading', 'tradingStatus', 'setRouter', 'setPair', 'setUniswapPair', 'excludeFromFee',
    'includeInFee', 'setFeeExempt', 'mint', 'setCooldown', 'setCooldownEnabled', 'setSwapEnabled', 'upgradeTo',
    'upgradeToAndCall', 'setImplementation', 'setTaxRates', 'setPool', 'setAuthorizedBuyer']) {
    assert.ok(names.has(n), `missing ${n}`);
  }
  for (const [sel, sig] of Object.entries(DANGEROUS)) assert.equal(selectorOf(sig), sel, sig);
  for (const s of UPGRADE_SELECTORS) assert.ok(DANGEROUS[s]);
});

test('analysis is deterministic', () => {
  const code = '8063aabbccdd14' + '63a9059cbb811400' + '5bf4';
  assert.deepEqual(A(code), A(code));
});
