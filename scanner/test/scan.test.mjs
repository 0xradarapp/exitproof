import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { keccak256 } from 'viem';
import { scan } from '../src/scan.mjs';
import { selectorOf } from '../src/selectors.mjs';
import { SLOTS } from '../src/proxy.mjs';
import { startAnvil, deployToken, deployScannerFixture, SUPPLY } from './helpers.mjs';
import { XOR_DISPATCHER, eqDispatcher, eip1167, erc7511 } from './fixtures/raw.mjs';

let env;
before(async () => { env = await startAnvil(); });
after(async () => { await env.stop(); });

const FLAGS = (r) => ({
  privileged: r.privileged, upgradeable: r.upgradeable, dangerSetter: r.dangerSetter, ownerCanTrap: r.ownerCanTrap,
});

test('CleanToken: all flags false, codehash = keccak(runtime), version 1', async () => {
  const t = await deployToken(env, 'CleanToken');
  const r = await scan(env.pub, t.address);
  assert.deepEqual(FLAGS(r), { privileged: false, upgradeable: false, dangerSetter: false, ownerCanTrap: false });
  assert.equal(r.scannerVersion, 2);
  assert.equal(r.codehash, keccak256(await env.pub.getCode({ address: t.address })));
  assert.equal(r.evidence.owner, null);
  assert.ok(r.evidence.selectors.includes(selectorOf('transfer(address,uint256)')));
  assert.deepEqual(r.evidence.dangerous, []);
  assert.deepEqual(r.evidence.reasons, []);
  assert.deepEqual(r.evidence.externalCalls, { count: 0, offsets: [] });
});

test('scan output is identical across runs', async () => {
  const t = await deployToken(env, 'TimeBombToken');
  const a = await scan(env.pub, t.address);
  const b = await scan(env.pub, t.address);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.deepEqual([...a.evidence.selectors].sort(), a.evidence.selectors);
});

test('OwnedCleanToken: privileged only', async () => {
  const t = await deployToken(env, 'OwnedCleanToken');
  const r = await scan(env.pub, t.address);
  assert.deepEqual(FLAGS(r), { privileged: true, upgradeable: false, dangerSetter: false, ownerCanTrap: false });
  assert.equal(r.evidence.owner.toLowerCase(), env.account.address.toLowerCase());
});

test('TimeBombToken: privileged + dangerSetter (setSellFee)', async () => {
  const t = await deployToken(env, 'TimeBombToken');
  const r = await scan(env.pub, t.address);
  assert.deepEqual(FLAGS(r), { privileged: true, upgradeable: false, dangerSetter: true, ownerCanTrap: false });
  assert.deepEqual(r.evidence.dangerous, [{ selector: selectorOf('setSellFee(uint256)'), signature: 'setSellFee(uint256)' }]);
});

test('TradingDisabled: dangerSetter (enableTrading) + privileged', async () => {
  const t = await deployToken(env, 'TradingDisabled');
  const r = await scan(env.pub, t.address);
  assert.equal(r.dangerSetter, true);
  assert.equal(r.privileged, true);
  assert.equal(r.upgradeable, false);
  assert.ok(r.evidence.dangerous.some((d) => d.signature === 'enableTrading()'));
});

test('ProxyToken: upgradeable via EIP-1967 slot, live DELEGATECALL and upgradeTo', async () => {
  const t = await deployToken(env, 'ProxyToken');
  const r = await scan(env.pub, t.address);
  assert.equal(r.upgradeable, true);
  assert.equal(r.evidence.proxySlots.eip1967Implementation.toLowerCase(), t.impl.address.toLowerCase());
  assert.ok(r.evidence.opcodes.delegatecall >= 1);
  assert.ok(r.evidence.dangerous.some((d) => d.signature === 'upgradeTo(address)'));
  assert.equal(r.dangerSetter, true);
  assert.equal(r.privileged, true, 'a dangerous setter implies someone privileged');
});

test('ScanFalsePositiveToken: delegatecall to literal 0 is cleared (not upgradeable)', async () => {
  const t = await deployToken(env, 'ScanFalsePositiveToken');
  const r = await scan(env.pub, t.address);
  assert.deepEqual(FLAGS(r), { privileged: false, upgradeable: false, dangerSetter: false, ownerCanTrap: false });
  assert.equal(r.evidence.opcodes.constTargetDelegatecall, 1);
});

test('owner() probe robustness: revert / gas hog => no owner; garbage word => privileged', async () => {
  for (const n of ['OwnerRevertsToken', 'OwnerGasHogToken', 'OwnerShortToken']) {
    const t = await deployToken(env, n);
    const r = await scan(env.pub, t.address);
    assert.equal(r.privileged, false, n);
  }
  const g = await deployToken(env, 'OwnerGarbageToken');
  assert.equal((await scan(env.pub, g.address)).privileged, true);
});

test('EIP-1822 PROXIABLE / beacon slot non-zero => upgradeable', async () => {
  for (const slot of [SLOTS.eip1822Proxiable, SLOTS.eip1967Beacon]) {
    const t = await deployToken(env, 'CleanToken');
    await env.pub.request({
      method: 'anvil_setStorageAt', params: [t.address, slot, `0x${'00'.repeat(31)}01`],
    });
    const r = await scan(env.pub, t.address);
    assert.equal(r.upgradeable, true, slot);
  }
});

test('live SELFDESTRUCT => dangerSetter; AccessControl hasRole => privileged (recognised ERC-20 dispatcher)', async () => {
  const addr = '0x000000000000000000000000000000000000beef';
  await env.pub.request({ method: 'anvil_setCode', params: [addr, eqDispatcher([], '5b5f35ff')] });
  const r = await scan(env.pub, addr);
  assert.equal(r.dangerSetter, true);
  assert.equal(r.privileged, true);
  assert.deepEqual(r.evidence.reasons, ['live-selfdestruct']);
  const ac = '0x000000000000000000000000000000000000cafe';
  await env.pub.request({ method: 'anvil_setCode', params: [ac, eqDispatcher(['91d14854'])] });
  const r2 = await scan(env.pub, ac);
  assert.equal(r2.privileged, true);
  assert.equal(r2.dangerSetter, false);
  assert.deepEqual(r2.evidence.reasons, ['access-control']);
});

test('XOR dispatcher (no EQ selectors) => dispatcher-unrecognized, fail-closed', async () => {
  const addr = '0x000000000000000000000000000000000000d15c';
  await env.pub.request({ method: 'anvil_setCode', params: [addr, XOR_DISPATCHER] });
  const r = await scan(env.pub, addr);
  assert.equal(r.privileged, true);
  assert.equal(r.dangerSetter, true);
  assert.equal(r.upgradeable, false);
  assert.ok(r.evidence.reasons.includes('dispatcher-unrecognized'));
  assert.deepEqual(r.evidence.selectors, []);
});

test('HiddenOwnerToken: custom-slot onlyOwner + unlisted configure(uint256) => privileged via caller check', async () => {
  const t = await deployScannerFixture(env, 'HiddenOwnerToken', [SUPPLY]);
  const r = await scan(env.pub, t.address);
  assert.equal(r.privileged, true);
  assert.equal(r.dangerSetter, false);
  assert.equal(r.upgradeable, false);
  assert.equal(r.evidence.owner, null);
  assert.ok(r.evidence.callerChecks.length >= 1);
  assert.deepEqual(r.evidence.reasons, ['caller-vs-storage']);
});

test('OracleFeeToken: STATICCALL to a stored/immutable oracle in _transfer => privileged (externalCalls)', async () => {
  const t = await deployScannerFixture(env, 'OracleFeeToken', [SUPPLY, '0x00000000000000000000000000000000000000aa']);
  const r = await scan(env.pub, t.address);
  assert.equal(r.privileged, true);
  assert.equal(r.dangerSetter, false);
  assert.ok(r.evidence.externalCalls.count >= 1);
  assert.equal(r.evidence.externalCalls.offsets.length, r.evidence.externalCalls.count);
  assert.deepEqual(r.evidence.reasons, ['external-call']);
});

test('fixture audit: flags for every test/fixtures/Tokens.sol token under scanner v2', async () => {
  // [privileged, upgradeable, dangerSetter, reasons]
  const expected = {
    CleanToken: [false, false, false, []],
    OwnedCleanToken: [true, false, false, ['caller-vs-storage', 'owner-getter']], // renounceOwnership check
    FeeToken: [false, false, false, []],
    BlacklistOnBuy: [false, false, false, []],
    SellTax99: [false, false, false, []],
    MaxTxToken: [false, false, false, []],
    CooldownToken: [false, false, false, []],
    TradingDisabled: [true, false, true, ['caller-vs-storage', 'dangerous-selector', 'owner-getter']],
    TimeBombToken: [true, false, true, ['caller-vs-storage', 'dangerous-selector', 'owner-getter']],
    GasBombToken: [false, false, false, []],
    ReturnBombToken: [false, false, false, []],
    TxOriginTrap: [false, false, false, []],
    ScanFalsePositiveToken: [false, false, false, []],
    ReentrantToken: [true, false, false, ['external-call']], // v2 change: was all-false in v1
    ForgedProbeToken: [false, false, false, []],
    ProxyToken: [true, true, true, ['caller-vs-storage', 'dangerous-selector', 'delegatecall', 'proxy-slot', 'upgrade-selector']],
  };
  const got = {};
  for (const name of Object.keys(expected)) {
    const t = await deployToken(env, name, name === 'FeeToken' ? [SUPPLY, 500n] : [SUPPLY]);
    const r = await scan(env.pub, t.address);
    got[name] = [r.privileged, r.upgradeable, r.dangerSetter, r.evidence.reasons];
  }
  assert.deepEqual(got, expected);
});

const FL = (r) => [r.privileged, r.upgradeable, r.dangerSetter, r.ownerCanTrap, r.evidence.reasons];
let cloneN = 0;
async function clone(code) {
  cloneN += 1;
  const a = `0x00000000000000000000000000000000c10e${cloneN.toString(16).padStart(4, '0')}`;
  await env.pub.request({ method: 'anvil_setCode', params: [a, code] });
  return a;
}

test('EIP-1167 / ERC-7511 clone of CleanToken: same flags as CleanToken, not upgradeable', async () => {
  const t = await deployToken(env, 'CleanToken');
  const base = await scan(env.pub, t.address);
  for (const mk of [eip1167, erc7511]) {
    const c = await clone(mk(t.address));
    const r = await scan(env.pub, c);
    assert.deepEqual(FL(r), FL(base));
    assert.equal(r.upgradeable, false);
    assert.equal(r.evidence.clone.implementation.toLowerCase(), t.address.toLowerCase());
    assert.deepEqual(r.evidence.selectors, base.evidence.selectors);
  }
});

test('clone of TimeBombToken: dangerSetter (setSellFee seen through the clone)', async () => {
  const t = await deployToken(env, 'TimeBombToken');
  const r = await scan(env.pub, await clone(eip1167(t.address)));
  assert.equal(r.dangerSetter, true);
  assert.equal(r.privileged, true);
  assert.equal(r.upgradeable, false);
  assert.ok(r.evidence.dangerous.some((d) => d.signature === 'setSellFee(uint256)'));
});

test('clone of an EOA, or of another clone: fail-closed', async () => {
  const eoa = await scan(env.pub, await clone(eip1167('0x00000000000000000000000000000000000e0a01')));
  assert.equal(eoa.upgradeable, true);
  assert.equal(eoa.privileged, true);
  assert.equal(eoa.dangerSetter, true);
  assert.ok(eoa.evidence.reasons.includes('dispatcher-unrecognized'));
  assert.ok(eoa.evidence.reasons.includes('clone-unresolved'));
  const t = await deployToken(env, 'CleanToken');
  const inner = await clone(eip1167(t.address));
  const nested = await scan(env.pub, await clone(eip1167(inner)));
  assert.equal(nested.upgradeable, true);
  assert.ok(nested.evidence.reasons.includes('dispatcher-unrecognized'));
  assert.ok(nested.evidence.reasons.includes('clone-unresolved'));
});

test('near-miss clone bytes are not treated as a clone', async () => {
  const t = await deployToken(env, 'CleanToken');
  const bad = eip1167(t.address).replace(/5bf3$/, '5bfd');
  const r = await scan(env.pub, await clone(bad));
  assert.equal(r.evidence.clone, null);
  assert.equal(r.upgradeable, true);
});

test('scan rejects an address without code', async () => {
  await assert.rejects(scan(env.pub, '0x0000000000000000000000000000000000001234'), /no code/);
});
