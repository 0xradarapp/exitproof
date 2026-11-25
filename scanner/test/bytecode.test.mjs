import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCode } from '../src/scan.mjs';
import { eqDispatcher, splitDispatcher, DECOY_XOR } from './fixtures/raw.mjs';
import { DANGEROUS, UPGRADE_SELECTORS, SAFE, selectorOf } from '../src/selectors.mjs';

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

test('terminators end a live run: JUMP, RETURN, REVERT, INVALID, SELFDESTRUCT, STOP', () => {
  for (const t of ['56', 'f3', 'fd', 'fe', 'ff', '00']) {
    assert.equal(A(`${t}f4`).opcodes.delegatecall, 0, `terminator ${t}`);
  }
});

test('undefined opcodes do NOT end a live run (conservative against future forks)', () => {
  for (const t of ['0c', 'ef', '21', '1e']) {
    assert.equal(A(`${t}f4`).opcodes.delegatecall, 1, `undefined op ${t}`);
  }
  // PUSH1 x, 0x1e, POP, DELEGATECALL
  assert.equal(A('60011e50f4').upgradeable, true);
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

test('linear selector heuristic: DUP1 PUSH4 EQ and PUSH4 DUP2 EQ forms (used for the dangerous list only)', () => {
  const r = A('8063aabbccdd1461001057' + '63a9059cbb81146100105700');
  assert.deepEqual(r.linearSelectors, ['0xa9059cbb', '0xaabbccdd']);
  assert.deepEqual(r.selectors, [], 'no CALLDATALOAD(0)>>224 dispatcher chain');
});

test('linear selector heuristic: PUSH3 (leading-zero selector) is padded', () => {
  assert.deepEqual(A('8062bbccdd14').linearSelectors, ['0x00bbccdd']);
});

test('PUSH4 not followed by EQ (custom error, mask) is not a selector', () => {
  assert.deepEqual(A('63aabbccdd5f52').linearSelectors, []);
  assert.deepEqual(A('63aabbccdd1061001057').linearSelectors, []);
});

test('dispatcher chain: EQ chain from CALLDATALOAD(0)>>224, no-match revert', () => {
  const r = analyzeCode(eqDispatcher());
  assert.deepEqual(r.selectors, ['0x095ea7b3', '0x23b872dd', '0x70a08231', '0xa9059cbb']);
  assert.equal(r.dispatcher.ok, true);
  assert.equal(r.dispatcher.fallbackLogic, false);
});

test('dispatcher chain: solc binary split (GT pivot) is followed on both sides', () => {
  const r = analyzeCode(splitDispatcher());
  assert.deepEqual(r.selectors, ['0x095ea7b3', '0x23b872dd', '0x70a08231', '0xa9059cbb']);
  assert.equal(r.dispatcher.fallbackLogic, false);
});

test('dispatcher chain: decoy block selectors do not count; XOR compare is fallback logic', () => {
  const r = analyzeCode(DECOY_XOR);
  assert.deepEqual(r.selectors, []);
  assert.equal(r.linearSelectors.length, 4, 'the decoy fools the linear heuristic');
  assert.equal(r.dispatcher.fallbackLogic, true);
});

test('dispatcher chain: no-match path with logic (SSTORE) => fallbackLogic', () => {
  const r = analyzeCode(eqDispatcher([], '', '60015f5500'));
  assert.equal(r.dispatcher.fallbackLogic, true);
  assert.equal(analyzeCode(eqDispatcher([], '', '00')).dispatcher.fallbackLogic, false, 'plain STOP');
});

test('dispatcher chain: dynamic jump cannot be followed => not ok', () => {
  const r = A('5f3560e01c8056');
  assert.equal(r.dispatcher.ok, false);
});

test('caller vs non-zero 20-byte literal (immutable admin) is a caller check', () => {
  assert.deepEqual(A(`3373${'11'.repeat(20)}14`).callerLiteralChecks, [22]);
  assert.deepEqual(A('335f14').callerLiteralChecks, []);
  assert.deepEqual(A(`337f${'00'.repeat(12)}${'22'.repeat(20)}1460016001601b1b0316`).callerLiteralChecks, [34]);
  assert.equal(A(`3373${'11'.repeat(20)}14`).privilegedCode, true);
});

test('caller vs literal through ADD (solc -O: add(caller, not(c-1)) for `msg.sender == CONST`)', () => {
  // PUSH2 0xbeee NOT CALLER ADD  => caller - 0xbeef
  assert.deepEqual(A('61beee193301').callerLiteralChecks, [5]);
  // CALLER PUSH20 <-L mod 2^256 does not fit 20 bytes>, but L itself does
  assert.deepEqual(A(`3373${'11'.repeat(20)}01`).callerLiteralChecks, [22]);
  assert.deepEqual(A('335f01').callerLiteralChecks, [], 'add 0');
  assert.deepEqual(A('5f3501').callerLiteralChecks, [], 'no caller');
});

test('external state reads: BALANCE/EXTCODESIZE/EXTCODEHASH/EXTCODECOPY', () => {
  assert.deepEqual(A(`73${'be'.repeat(20)}31`).externalState, { count: 1, offsets: [21], balance: 1 });
  assert.equal(A('5f353b').externalState.count, 1, 'EXTCODESIZE of calldata address');
  assert.equal(A('5f353f').externalState.count, 1, 'EXTCODEHASH');
  assert.equal(A('5f5f5f5f353c').externalState.count, 1, 'EXTCODECOPY');
  assert.equal(A('3031').externalState.count, 1, 'BALANCE(ADDRESS): force-sendable (v4)');
  assert.equal(A('3031').externalState.balance, 1);
  assert.deepEqual(A('3331').externalState, { count: 1, offsets: [1], balance: 1 }, 'BALANCE(CALLER) (v4)');
  assert.deepEqual(A('47').externalState, { count: 1, offsets: [0], balance: 1 }, 'SELFBALANCE (v4)');
  assert.equal(A('0047').externalState.count, 0, 'dead SELFBALANCE');
  assert.equal(A('303b').externalState.count, 0, 'EXTCODESIZE(ADDRESS)');
  assert.equal(A('600131').externalState.count, 0, 'precompile literal');
  assert.equal(A('00' + '5f353b').externalState.count, 0, 'dead');
  assert.equal(A('5f353b').privilegedCode, true);
  const cc = A('333b');
  assert.equal(cc.externalState.count, 0);
  assert.deepEqual(cc.callerCodeChecks, { count: 1, offsets: [1] });
  assert.equal(cc.privilegedCode, false, 'msg.sender code-size (anti-bot) is evidence only');
  assert.equal(A('333f').privilegedCode, false, 'EXTCODEHASH(CALLER) evidence only');
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
  assert.deepEqual(A('00').callerChecks, []);
  assert.deepEqual(A('00').externalCalls, { count: 0, offsets: [] });
});

test('SAFE_SELECTORS allowlist is keccak-derived and excludes every dangerous selector', () => {
  for (const [sel, sig] of Object.entries(SAFE)) {
    assert.equal(selectorOf(sig), sel, sig);
    assert.equal(DANGEROUS[sel], undefined, sig);
  }
  assert.ok(SAFE[selectorOf('permit(address,address,uint256,uint256,uint8,bytes32,bytes32)')]);
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

test('caller-vs-storage taint: CALLER/ORIGIN compared (EQ/SUB/XOR) with an SLOAD, through AND/SHR/DIV masks', () => {
  assert.equal(A('335f5414').callerChecks.length, 1, 'CALLER PUSH0 SLOAD EQ');
  assert.deepEqual(A('335f5414').callerChecks, [3]);
  assert.equal(A(`335f5473${'ff'.repeat(20)}1614`).callerChecks.length, 1, 'AND mask');
  assert.equal(A('5f5460a01c3318').callerChecks.length, 1, 'SHR then XOR');
  assert.equal(A('5f54600204325f03').callerChecks.length, 0, 'unrelated SUB');
  assert.equal(A('5f546002043203').callerChecks.length, 1, 'DIV then ORIGIN SUB');
  assert.equal(A('335f3514').callerChecks.length, 0, 'calldata, not storage');
  assert.equal(A('3360011460015f5414').callerChecks.length, 0, 'taint does not survive EQ');
  // v8: the SLOAD taint survives ADD / XOR / SUB / NOT / MUL (computed 'S'), so this is a check now
  assert.equal(A('335f54600101' + '14').callerChecks.length, 1, 'ADD no longer launders');
  assert.equal(A('335f5414').privilegedCode, true);
});

test('external calls: live CALL/STATICCALL to a non-literal, non-ADDRESS target', () => {
  const call = A('5f5f5f5f5f5f545af1');
  assert.deepEqual(call.externalCalls, { count: 1, offsets: [8] });
  assert.equal(call.privilegedCode, true);
  assert.equal(A('5f5f5f5f5f545afa').externalCalls.count, 1, 'STATICCALL to stored address');
  assert.equal(A('5f5f5f5f305afa').externalCalls.count, 0, 'self call');
  assert.equal(A('5f5f5f5f60015afa').externalCalls.count, 0, 'precompile');
  assert.equal(A('005f5f5f5f5f545afa').externalCalls.count, 0, 'dead');
  assert.equal(A('5f5f5f5f5f545afa').privilegedCode, true);
});


test('v6: solc CBOR metadata trailer is data (a 0x5b in its hash does not make EXTCODEHASH "live")', async () => {
  const { metadataStart } = await import('../src/scan.mjs');
  const { hexToBytes } = await import('viem');
  // STOP, INVALID, then a fake metadata map {ipfs: <bytes with 5b 3f>} + 2-byte length
  const meta = `a264697066735822${'1220'}${'91d7991a41255b15bb9e3fb3'.padEnd(64, '0')}64736f6c6343000818`;
  const len = (meta.length / 2).toString(16).padStart(4, '0');
  const code = `0x00fe${meta}${len}`;
  assert.equal(metadataStart(hexToBytes(code)), 2);
  const a = analyzeCode(code);
  assert.equal(a.externalState.count, 0);
  // without the trailer shape the same bytes stay conservative (live after the JUMPDEST)
  assert.equal(analyzeCode(`0x00fe${meta}`).externalState.count, 1);
});
