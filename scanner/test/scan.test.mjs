import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { keccak256 } from 'viem';
import { scan } from '../src/scan.mjs';
import { selectorOf } from '../src/selectors.mjs';
import { SLOTS } from '../src/proxy.mjs';
import { startAnvil, deployToken } from './helpers.mjs';

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
  assert.equal(r.scannerVersion, 1);
  assert.equal(r.codehash, keccak256(await env.pub.getCode({ address: t.address })));
  assert.equal(r.evidence.owner, null);
  assert.ok(r.evidence.selectors.includes(selectorOf('transfer(address,uint256)')));
  assert.deepEqual(r.evidence.dangerous, []);
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

test('live SELFDESTRUCT => dangerSetter; AccessControl hasRole => privileged', async () => {
  const addr = '0x000000000000000000000000000000000000beef';
  await env.pub.request({ method: 'anvil_setCode', params: [addr, '0x5f35ff'] });
  const r = await scan(env.pub, addr);
  assert.equal(r.dangerSetter, true);
  assert.equal(r.privileged, true);
  const ac = '0x000000000000000000000000000000000000cafe';
  await env.pub.request({ method: 'anvil_setCode', params: [ac, '0x5f3560e01c806391d1485414'] });
  const r2 = await scan(env.pub, ac);
  assert.equal(r2.privileged, true);
  assert.equal(r2.dangerSetter, false);
});

test('scan rejects an address without code', async () => {
  await assert.rejects(scan(env.pub, '0x0000000000000000000000000000000000001234'), /no code/);
});
