// Final-audit PoCs (fable-security-audit F-02 / F-03 / F-04, Appendix B) as regression tests: each token passed
// scanner v4 + simulate with no flag; scanner v5 must flag it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { scan } from '../src/scan.mjs';
import { simulate, mergeSimulation } from '../src/simulate.mjs';
import { selectorOf } from '../src/selectors.mjs';
import { startAnvil, deployInfra, launchAudit, deployToken, listToken } from './helpers.mjs';

let env;
let infra;
before(async () => {
  env = await startAnvil();
  infra = await deployInfra(env);
});
after(async () => { await env.stop(); });

async function run(name) {
  const { token, pair } = await launchAudit(env, infra, name);
  const s = await scan(env.pub, token.address);
  const sim = await simulate(env.rpc, token.address, pair.address);
  return { s, sim, merged: mergeSimulation(structuredClone(s), sim) };
}

test('control: AuditPlain passes every sell, no signal, no flag', async () => {
  const { s, sim } = await run('AuditPlain');
  assert.equal(s.privileged, false);
  assert.deepEqual(sim.signals, []);
  assert.equal(sim.ownerCanTrap, false);
  assert.equal(sim.dangerSetter, false);
  assert.equal(sim.evidence.immediate.passes, true);
  assert.ok(sim.evidence.delayed.every((d) => d.passes));
  assert.equal(sim.evidence.transferSell.passes, true);
});

test('F-02 TransferFromTrap: transfer sells, transferFrom (router) cannot => transferFrom-trap, ownerCanTrap', async () => {
  const { s, sim, merged } = await run('TransferFromTrap');
  assert.equal(s.privileged, false, 'static scan alone cannot see it');
  assert.equal(sim.evidence.transferSell.passes, true);
  assert.equal(sim.evidence.delayed.find((d) => d.label === '+1h').stage, 'transferFrom');
  assert.ok(sim.signals.includes('transferFrom-trap'));
  assert.equal(sim.ownerCanTrap, true);
  assert.equal(merged.ownerCanTrap, true);
  assert.equal(merged.privileged, true, 'privileged too, so balanced (ownerActive & danger) blocks it');
});

test('F-02 ApproveNoop: approve() stores nothing => transferFrom-trap', async () => {
  const { sim } = await run('ApproveNoop');
  assert.ok(sim.signals.includes('transferFrom-trap'));
  assert.equal(sim.ownerCanTrap, true);
});

test('F-03 SameBlockSellOnly: immediate sell passes, every later one fails => delayed-sell-trap, dangerSetter', async () => {
  const { s, sim, merged } = await run('SameBlockSellOnly');
  assert.ok(s.evidence.reasons.includes('block-context'));
  assert.ok(s.evidence.blockContext.ops.NUMBER.length > 0);
  assert.equal(s.privileged, true, 'NUMBER on the transfer path: strict fence');
  assert.equal(s.dangerSetter, false);
  assert.equal(sim.evidence.immediate.passes, true);
  assert.ok(sim.evidence.delayed.every((d) => !d.passes));
  assert.ok(sim.signals.includes('delayed-sell-trap'));
  assert.equal(sim.dangerSetter, true);
  assert.equal(merged.dangerSetter, true);
  assert.equal(merged.privileged, true);
});

test('F-03 TransientSellOnly (TLOAD/TSTORE, same transaction only) => delayed-sell-trap + block-context', async () => {
  const { s, sim } = await run('TransientSellOnly');
  assert.ok(s.evidence.blockContext.ops.TLOAD.length > 0);
  assert.ok(sim.signals.includes('delayed-sell-trap'));
  assert.equal(sim.dangerSetter, true);
});

test('F-03 SellWindowToken (sells close 10 min after receipt) => +1h / +1d fail => delayed-sell-trap', async () => {
  const { s, sim } = await run('SellWindowToken');
  assert.ok(s.evidence.blockContext.ops.TIMESTAMP.length > 0);
  const d = Object.fromEntries(sim.evidence.delayed.map((x) => [x.label, x.passes]));
  assert.deepEqual(d, { '+1block': true, '+60s': true, '+1h': false, '+1d': false, '+7d': false, '+30d': false });
  assert.ok(sim.signals.includes('delayed-sell-trap'));
  assert.equal(sim.dangerSetter, true);
});

test('F-03 OriginSellerTrap (seller must not be tx.origin): nothing a wallet can do sells => baseline-sell-failed', async () => {
  const { s, sim, merged } = await run('OriginSellerTrap');
  assert.ok(s.evidence.blockContext.ops.ORIGIN.length > 0);
  assert.equal(s.privileged, true);
  assert.ok(sim.signals.includes('baseline-sell-failed'));
  assert.equal(merged.ownerCanTrap, true);
});

test('cooldown (no same-block sell) is not a delayed trap: immediate fails, later sells pass', async () => {
  const t = await deployToken(env, 'CooldownToken');
  const pair = await listToken(env, infra, t);
  const sim = await simulate(env.rpc, t.address, pair.address);
  assert.equal(sim.evidence.immediate.passes, false);
  assert.ok(sim.evidence.delayed.every((d) => d.passes));
  assert.ok(!sim.signals.includes('delayed-sell-trap'));
  assert.equal(sim.ownerCanTrap, false);
  // v6: the fixture's one-shot initPair(address) (deployer-only, already called) reverts for every identity, and
  // the token has a caller-vs-literal check => the sweep is incomplete and fails closed (sweep-incomplete)
  assert.deepEqual(sim.signals, ['sweep-incomplete']);
  assert.deepEqual(sim.evidence.unknownSweep.unexercised, [selectorOf('initPair(address)')]);
});

test('F-04a HiddenAdminBomb: unlisted setter, admin in a private slot => unknown sweep finds it, ownerCanTrap', async () => {
  const { s, sim } = await run('HiddenAdminBomb');
  assert.equal(s.dangerSetter, true, 'v8: setLaunchParam reads CALLER => caller-gated-unknown (statically)');
  assert.equal(s.evidence.owner, null);
  const sel = selectorOf('setLaunchParam(uint256)');
  assert.ok(s.evidence.unknownSelectors.includes(sel));
  assert.ok(sim.evidence.callers.includes(env.account.address), 'admin found (creator / storage word)');
  assert.ok(sim.signals.includes(`unknown-setter-trap:${sel}`));
  assert.ok(sim.evidence.unknownAttempts.some((a) => a.selector === sel && a.trapped));
  assert.equal(sim.ownerCanTrap, true);
  assert.equal(sim.evidence.unknownSweep.complete, true);
});

test('F-04b RenamedSetterBomb: owner + setSellFeeBps (not on the name list) => ownerCanTrap', async () => {
  const { s, sim } = await run('RenamedSetterBomb');
  assert.equal(s.dangerSetter, true, 'v8: caller-gated-unknown (statically)');
  const sel = selectorOf('setSellFeeBps(uint256)');
  assert.ok(sim.signals.includes(`unknown-setter-trap:${sel}`));
  const hits = sim.evidence.unknownAttempts.filter((a) => a.selector === sel).map((a) => a.pattern).sort();
  // 0 and 1 (0.01%) are harmless fees; 10000, max and the address words (huge numbers) all break the sell
  assert.deepEqual(hits, ['10000', 'holder', 'max', 'pair']);
  assert.equal(sim.ownerCanTrap, true);
});

test('F-04 sweep bound: more unknown selectors than the cap with a privileged caller => incomplete, fail closed', async () => {
  const { token, pair } = await launchAudit(env, infra, 'RenamedSetterBomb');
  const sim = await simulate(env.rpc, token.address, pair.address, { maxUnknown: 0 });
  assert.equal(sim.evidence.unknownSweep.complete, false);
  assert.match(sim.evidence.unknownSweep.truncatedBy, /max-selectors/);
  assert.ok(sim.signals.includes('sweep-incomplete'));
  assert.equal(sim.dangerSetter, true, 'owner() is set: fail closed');
});
