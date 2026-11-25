import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { keccak256 } from 'viem';
import { scan } from '../src/scan.mjs';
import { selectorOf } from '../src/selectors.mjs';
import { SLOTS } from '../src/proxy.mjs';
import { startAnvil, deployToken, deployScannerFixture, SUPPLY } from './helpers.mjs';
import { XOR_DISPATCHER, DECOY_XOR, eqDispatcher, eip1167, erc7511 } from './fixtures/raw.mjs';

let env;
before(async () => { env = await startAnvil(); });
after(async () => { await env.stop(); });

const FLAGS = (r) => ({
  privileged: r.privileged, upgradeable: r.upgradeable, dangerSetter: r.dangerSetter, ownerCanTrap: r.ownerCanTrap,
});

test('CleanToken: all flags false, codehash = keccak(runtime), version 8', async () => {
  const t = await deployToken(env, 'CleanToken');
  const r = await scan(env.pub, t.address);
  assert.deepEqual(FLAGS(r), { privileged: false, upgradeable: false, dangerSetter: false, ownerCanTrap: false });
  assert.equal(r.scannerVersion, 8);
  assert.equal(r.codehash, keccak256(await env.pub.getCode({ address: t.address })));
  assert.equal(r.evidence.owner, null);
  assert.ok(r.evidence.selectors.includes(selectorOf('transfer(address,uint256)')));
  assert.deepEqual(r.evidence.dangerous, []);
  assert.deepEqual(r.evidence.reasons, []);
  assert.deepEqual(r.evidence.unknownSelectors, []);
  assert.equal(r.evidence.dispatcher.fallbackLogic, false);
  assert.deepEqual(r.evidence.externalCalls, { count: 0, offsets: [] });
  assert.deepEqual(r.evidence.externalState, { count: 0, offsets: [], balance: 0 });
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
  assert.deepEqual(r.evidence.unknownSelectors, [], 'owner()/renounceOwnership() are allowlisted');
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
  // v3: still not upgradeable (literal-0 DELEGATECALL), but privileged: ping() is not allowlisted and is gated on
  // `caller() == 0xdead` (caller vs literal).
  // v8: ping() reads CALLER (the 0xdead gate) => caller-gated unknown selector => dangerSetter
  assert.deepEqual(FLAGS(r), { privileged: true, upgradeable: false, dangerSetter: true, ownerCanTrap: false });
  assert.deepEqual(r.evidence.reasons, ['caller-gated-unknown', 'caller-vs-literal', 'unknown-selector']);
  assert.deepEqual(r.evidence.callerGatedUnknown, [selectorOf('ping()')]);
  assert.equal(r.evidence.opcodes.constTargetDelegatecall, 1);
});

test('owner() probe robustness: revert / gas hog => no owner; garbage word => privileged', async () => {
  for (const n of ['OwnerRevertsToken', 'OwnerShortToken']) {
    const t = await deployToken(env, n);
    const r = await scan(env.pub, t.address);
    assert.equal(r.privileged, false, n);
    assert.equal(r.evidence.owner, null, n);
  }
  // GasHog: owner() runs out of gas => no owner; privileged only because its public `sink()` is not allowlisted
  const h = await scan(env.pub, (await deployToken(env, 'OwnerGasHogToken')).address);
  assert.equal(h.evidence.owner, null);
  assert.deepEqual(h.evidence.reasons, ['unknown-selector']);
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
  assert.deepEqual(r2.evidence.reasons, ['access-control', 'unknown-selector']);
  assert.deepEqual(r2.evidence.unknownSelectors, ['0x91d14854']);
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
  assert.equal(r.dangerSetter, true, 'v8: configure() is a caller-gated unknown selector');
  assert.equal(r.upgradeable, false);
  assert.equal(r.evidence.owner, null);
  assert.ok(r.evidence.callerChecks.length >= 1);
  assert.deepEqual(r.evidence.reasons, ['caller-gated-unknown', 'caller-vs-storage', 'unknown-selector']);
  assert.ok(r.evidence.unknownSelectors.includes(selectorOf('configure(uint256)')));
});

test('OracleFeeToken: STATICCALL to a stored/immutable oracle in _transfer => privileged (externalCalls)', async () => {
  const t = await deployScannerFixture(env, 'OracleFeeToken', [SUPPLY, '0x00000000000000000000000000000000000000aa']);
  const r = await scan(env.pub, t.address);
  assert.equal(r.privileged, true);
  assert.equal(r.dangerSetter, false);
  assert.ok(r.evidence.externalCalls.count >= 1);
  assert.equal(r.evidence.externalCalls.offsets.length, r.evidence.externalCalls.count);
  assert.ok(r.evidence.reasons.includes('external-call'));
});

test('decoy JUMPDEST block + XOR dispatcher => dispatcher-unrecognized', async () => {
  const addr = '0x000000000000000000000000000000000000dec0';
  await env.pub.request({ method: 'anvil_setCode', params: [addr, DECOY_XOR] });
  const r = await scan(env.pub, addr);
  assert.deepEqual(r.evidence.selectors, []);
  assert.ok(r.evidence.reasons.includes('dispatcher-unrecognized'));
  assert.equal(r.privileged, true);
  assert.equal(r.dangerSetter, true);
});

test('MappingAdminToken: require(_ops[msg.sender]) + configure(uint256) => privileged via unknownSelectors', async () => {
  const t = await deployScannerFixture(env, 'MappingAdminToken', [SUPPLY]);
  const r = await scan(env.pub, t.address);
  assert.equal(r.privileged, true);
  assert.equal(r.dangerSetter, true, 'v8: the mapping-gated configure() reads CALLER');
  assert.deepEqual(r.evidence.unknownSelectors, [selectorOf('configure(uint256)')]);
  assert.deepEqual(r.evidence.callerGatedUnknown, [selectorOf('configure(uint256)')]);
  assert.deepEqual(r.evidence.reasons, ['caller-gated-unknown', 'unknown-selector']);
});

test('ImmutableAdminToken: CALLER vs immutable literal => privileged', async () => {
  const t = await deployScannerFixture(env, 'ImmutableAdminToken', [SUPPLY]);
  const r = await scan(env.pub, t.address);
  assert.equal(r.privileged, true);
  assert.ok(r.evidence.callerLiteralChecks.length >= 1);
  assert.equal(r.dangerSetter, true, 'v8');
  assert.deepEqual(r.evidence.reasons, ['caller-gated-unknown', 'caller-vs-literal', 'unknown-selector']);
});

test('BalanceOracleToken: BALANCE(0xBEEF) on the transfer path => privileged (external-state)', async () => {
  const t = await deployScannerFixture(env, 'BalanceOracleToken', [SUPPLY]);
  const r = await scan(env.pub, t.address);
  assert.equal(r.privileged, true);
  assert.ok(r.evidence.externalState.count >= 1);
  assert.deepEqual(r.evidence.reasons, ['external-state']);
});

test('`address constant` admin: optimizer on and off, small and full literal => caller-vs-literal', async () => {
  for (const n of ['CallerEqBeefToken', 'CallerEqBeefToken_noopt', 'CallerEqFullToken', 'CallerEqFullToken_noopt']) {
    const t = await deployScannerFixture(env, n, [SUPPLY]);
    const r = await scan(env.pub, t.address);
    assert.ok(r.evidence.callerLiteralChecks.length >= 1, n);
    assert.equal(r.privileged, true, n);
    assert.deepEqual(r.evidence.reasons, ['caller-vs-literal'], n);
  }
});

test('balance kill switches: BALANCE(msg.sender) and SELFBALANCE => privileged (external-state)', async () => {
  for (const n of ['BalCallerToken', 'SelfBalToken']) {
    const t = await deployScannerFixture(env, n, [SUPPLY]);
    const r = await scan(env.pub, t.address);
    assert.equal(r.privileged, true, n);
    assert.ok(r.evidence.externalState.balance >= 1, n);
    assert.deepEqual(r.evidence.reasons, ['external-state'], n);
  }
});

test('PermitToken (OZ-shaped ERC20 + permit + eip712Domain) is not privileged', async () => {
  const t = await deployScannerFixture(env, 'PermitToken', [SUPPLY]);
  const r = await scan(env.pub, t.address);
  assert.deepEqual(FLAGS(r), { privileged: false, upgradeable: false, dangerSetter: false, ownerCanTrap: false });
  assert.deepEqual(r.evidence.reasons, []);
  assert.deepEqual(r.evidence.unknownSelectors, []);
  assert.ok(r.evidence.selectors.includes(selectorOf('permit(address,address,uint256,uint256,uint8,bytes32,bytes32)')));
});

test('fixture audit: flags for every test/fixtures/Tokens.sol token under scanner v3', async () => {
  // [privileged, upgradeable, dangerSetter, reasons]
  // v3 changes vs v2 (all flag changes are privileged false -> true, from the allowlist / literal-caller rules):
  //  - FeeToken: public `feeBps()` getter is not allowlisted (unknown-selector).
  //  - PairAware fixtures (BlacklistOnBuy, SellTax99, MaxTxToken, CooldownToken, GasBombToken, ReturnBombToken,
  //    TxOriginTrap, ForgedProbeToken): `initPair(address)` is a deployer-only setter (unknown-selector) gated on
  //    `msg.sender == deployer` (immutable => caller-vs-literal); extra getters (maxTx, lastBuy, blacklisted, sink,
  //    boughtAt) are not allowlisted either.
  //  - ScanFalsePositiveToken: `ping()` unknown + `caller() == 0xdead` literal check.
  //  - ReentrantToken: setTarget/factory/reentered/attempted unknown (already privileged in v2 via external-call).
  //  - TradingDisabled / TimeBombToken / ProxyToken: flags unchanged; extra reasons only. ProxyToken's own
  //    fallback (delegatecall forwarder) is reported as fallback-logic.
  //  - CleanToken / OwnedCleanToken: unchanged.
  // v5: CooldownToken (block.number) and TxOriginTrap (tx.origin + block.number) read block context on the
  //  transfer path => extra reason 'block-context' (flags unchanged: both were already privileged).
  // v8: every PairAware fixture exposes `initPair(address)`, a deployer-only one-shot setter (reads CALLER) =>
  // caller-gated-unknown => dangerSetter. ScanFalsePositiveToken's ping() and ReentrantToken's setTarget() likewise.
  // CleanToken / OwnedCleanToken / FeeToken have no caller-gated unknown function and are unchanged; ProxyToken was
  // already dangerSetter (its own code has no unknown caller-gated selector; the implementation's are dangerous-list).
  const G = 'caller-gated-unknown';
  const expected = {
    CleanToken: [false, false, false, []],
    OwnedCleanToken: [true, false, false, ['caller-vs-storage', 'owner-getter']],
    FeeToken: [true, false, false, ['unknown-selector']],
    BlacklistOnBuy: [true, false, true, [G, 'caller-vs-literal', 'unknown-selector']],
    SellTax99: [true, false, true, [G, 'caller-vs-literal', 'unknown-selector']],
    MaxTxToken: [true, false, true, [G, 'caller-vs-literal', 'unknown-selector']],
    CooldownToken: [true, false, true, ['block-context', G, 'caller-vs-literal', 'unknown-selector']],
    TradingDisabled: [true, false, true,
      [G, 'caller-vs-literal', 'caller-vs-storage', 'dangerous-selector', 'owner-getter', 'unknown-selector']],
    TimeBombToken: [true, false, true,
      [G, 'caller-vs-literal', 'caller-vs-storage', 'dangerous-selector', 'owner-getter', 'unknown-selector']],
    GasBombToken: [true, false, true, [G, 'caller-vs-literal', 'unknown-selector']],
    ReturnBombToken: [true, false, true, [G, 'caller-vs-literal', 'unknown-selector']],
    TxOriginTrap: [true, false, true, ['block-context', G, 'caller-vs-literal', 'unknown-selector']],
    ScanFalsePositiveToken: [true, false, true, [G, 'caller-vs-literal', 'unknown-selector']],
    ReentrantToken: [true, false, true, [G, 'caller-vs-literal', 'external-call', 'unknown-selector']],
    ForgedProbeToken: [true, false, true, [G, 'caller-vs-literal', 'unknown-selector']],
    ProxyToken: [true, true, true, ['caller-vs-storage', 'dangerous-selector', 'delegatecall', 'fallback-logic',
      'proxy-slot', 'unknown-selector', 'upgrade-selector']],
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
