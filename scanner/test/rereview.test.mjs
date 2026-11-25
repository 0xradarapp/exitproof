// Fix-wave re-review PoCs (fable-fixwave-rereview N-01..N-05; fixtures from /tmp/ep-rr/keep/ScanFix.sol, copied
// into ScannerFixtures.sol). Each token was attested privileged-only (or clean) by scanner v5; v6 must flag it so
// balanced mode blocks it. As in the PoC, the pair is created by another account (anvil dev #3) and the daemon's
// hint (the PairCreated sender) is passed as the only extra caller.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { scan } from '../src/scan.mjs';
import { simulate, mergeSimulation } from '../src/simulate.mjs';
import { selectorOf } from '../src/selectors.mjs';
import { startAnvil, deployInfra, launchAudit } from './helpers.mjs';

const KEY3 = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6'; // anvil dev #3 (public test key)
let env;
let infra;
let other;
before(async () => {
  env = await startAnvil();
  infra = await deployInfra(env);
  other = createWalletClient({ chain: foundry, transport: http(env.rpc), account: privateKeyToAccount(KEY3) });
});
after(async () => { await env.stop(); });

async function run(name, e = env, inf = infra, creator = other) {
  const { token, pair } = await launchAudit(e, inf, name, { pairCreator: creator });
  const s = await scan(e.pub, token.address);
  const sim = await simulate(e.rpc, token.address, pair.address, { callers: [creator.account.address] });
  return { s, sim, m: mergeSimulation(structuredClone(s), sim) };
}
/** balanced mode would block: (privileged | owner()) & (dangerSetter | ownerCanTrap), or upgradeable */
const balancedBlocks = (m) => (m.privileged && (m.dangerSetter || m.ownerCanTrap)) || m.upgradeable;

test('N-01 ImmutableAdminBomb: admin is an immutable => caller-vs-literal address becomes a caller => trap found', async () => {
  const { s, sim, m } = await run('ImmutableAdminBomb');
  assert.ok(s.evidence.reasons.includes('caller-vs-literal'));
  assert.ok(s.evidence.callerLiterals.includes(env.account.address));
  assert.ok(sim.signals.includes(`unknown-setter-trap:${selectorOf('setLaunchParam(uint256)')}`));
  assert.equal(sim.evidence.unknownSweep.complete, true);
  assert.ok(balancedBlocks(m));
});

test('N-01 MappingAdminBomb: admin is a mapping entry => the token creator is impersonated => trap found', async () => {
  const { sim, m } = await run('MappingAdminBomb');
  assert.ok(sim.evidence.creator.from.includes(env.account.address));
  assert.ok(sim.signals.includes(`unknown-setter-trap:${selectorOf('setLaunchParam(uint256)')}`));
  assert.ok(balancedBlocks(m));
});

test('N-01 MagicArgBomb: setter needs key == 0x1234 => constant from the code is tried => trap found', async () => {
  const { s, sim, m } = await run('MagicArgBomb');
  const sel = selectorOf('setLaunchParam(uint256,uint256)');
  assert.ok(s.evidence.selectorHints[sel].includes('0x1234'));
  assert.ok(sim.evidence.unknownAttempts.some((a) => a.selector === sel && a.pattern.startsWith('magic:0x1234') && a.trapped));
  assert.ok(balancedBlocks(m));
});

test('N-01 TwoStepBomb: setLimit then setRate => two-step pair found', async () => {
  const { sim, m } = await run('TwoStepBomb');
  const pairSel = `${selectorOf('setLimit(uint256)')}+${selectorOf('setRate(uint256)')}`;
  assert.ok(sim.evidence.unknownSweep.stateChanging.includes(selectorOf('setLimit(uint256)')));
  assert.ok(sim.signals.includes(`unknown-setter-trap:${pairSel}`), JSON.stringify(sim.signals));
  assert.ok(balancedBlocks(m));
});

test('N-01 an unknown selector no identity can execute => complete=false => sweep-incomplete (dangerSetter)', async () => {
  // MagicArgBomb with the hint stripped: setLaunchParam reverts for every identity and word pattern
  const { token, pair } = await launchAudit(env, infra, 'MagicArgBomb', { pairCreator: other });
  const sim = await simulate(env.rpc, token.address, pair.address, { callers: [other.account.address], noHints: true });
  assert.equal(sim.evidence.unknownSweep.complete, false);
  assert.deepEqual(sim.evidence.unknownSweep.unexercised, [selectorOf('setLaunchParam(uint256,uint256)')]);
  assert.ok(sim.signals.includes('sweep-incomplete'));
  assert.equal(sim.dangerSetter, true);
});

test('N-03 SequenceTrap: sells pass alone, fail after a third-party trade => sequence-trap', async () => {
  const { s, sim, m } = await run('SequenceTrap');
  assert.equal(s.privileged, false, 'static scan is clean');
  assert.equal(sim.evidence.delayed.find((d) => d.label === '+1h').passes, true);
  assert.equal(sim.evidence.interleavedSell.passes, false);
  assert.ok(sim.signals.includes('sequence-trap'));
  assert.equal(m.dangerSetter, true);
  assert.equal(m.privileged, true);
});

test('N-04 LongWindowToken (sells close 2 days after first receipt) => +7d / +30d fail => delayed-sell-trap', async () => {
  const { sim, m } = await run('LongWindowToken');
  const d = Object.fromEntries(sim.evidence.delayed.map((x) => [x.label, x.passes]));
  assert.deepEqual([d['+1d'], d['+7d'], d['+30d']], [true, false, false]);
  assert.ok(sim.signals.includes('delayed-sell-trap'));
  assert.ok(balancedBlocks(m));
});

test('N-05 DelayedTax49 (0% in the receipt block, 49% later) => delayed-tax-jump', async () => {
  const { sim, m } = await run('DelayedTax49');
  assert.ok(sim.evidence.delayed.every((x) => x.passes), 'under the 50% pass line');
  assert.ok(sim.signals.includes('delayed-tax-jump'));
  assert.ok(balancedBlocks(m));
});

test('NativeBalanceTrapS (only an unfunded address may sell) => baseline-sell-failed', async () => {
  const { sim, m } = await run('NativeBalanceTrapS');
  assert.ok(sim.signals.includes('baseline-sell-failed'));
  assert.ok(balancedBlocks(m));
});

test('honest control with an owner-free surface stays clean (AuditPlain)', async () => {
  const { sim, m } = await run('AuditPlain');
  assert.deepEqual(sim.signals, []);
  assert.equal(balancedBlocks(m), false);
  assert.equal(m.privileged, false);
});

test('N-02 CoinbaseGatedTrap: the fork gets the forked chain coinbase => trap caught (and COINBASE => env-fingerprint)', async () => {
  // upstream "mainnet": coinbase 0x4200...0011 like X Layer
  const up = await startAnvil();
  const fork = { rpc: null };
  try {
    const XL_COINBASE = '0x4200000000000000000000000000000000000011';
    await up.pub.request({ method: 'anvil_setCoinbase', params: [XL_COINBASE] });
    const upInfra = await deployInfra(up);
    const { token, pair } = await launchAudit(up, upInfra, 'CoinbaseGatedTrap');
    const head = await up.pub.getBlock();
    assert.equal(head.miner.toLowerCase(), XL_COINBASE);
    const s = await scan(up.pub, token.address);
    assert.ok(s.evidence.blockContext.ops.COINBASE.length > 0);
    assert.ok(s.evidence.reasons.includes('env-fingerprint'));
    assert.equal(s.dangerSetter, true, 'COINBASE on a transfer path => dangerSetter');
    // the simulator's fork of it (anvil forks mine with coinbase 0x0 by default)
    const f = await startAnvil(['--fork-url', up.rpc, '--fork-block-number', String(head.number)]);
    fork.stop = f.stop;
    await f.pub.request({ method: 'evm_mine' });
    assert.equal((await f.pub.getBlock()).miner, '0x0000000000000000000000000000000000000000', 'anvil fork default');
    const sim = await simulate(f.rpc, token.address, pair.address);
    assert.equal(sim.evidence.env.coinbase.toLowerCase(), XL_COINBASE);
    assert.equal(sim.evidence.env.refBlock, Number(head.number));
    assert.ok(sim.signals.includes('delayed-sell-trap'), JSON.stringify(sim.signals));
  } finally {
    if (fork.stop) await fork.stop();
    await up.stop();
  }
});

test('N-01 fail-closed rule: a renounced owner (owner() == 0) does not make the onlyOwner leftovers fail closed', async () => {
  // RenamedSetterBomb with its owner slot zeroed: setSellFeeBps now reverts for everyone (like transferOwnership on a
  // renounced token); the caller-vs-storage gate belongs to the renounced owner
  const { token, pair } = await launchAudit(env, infra, 'RenamedSetterBomb', { pairCreator: other });
  const sim0 = await simulate(env.rpc, token.address, pair.address, { callers: [other.account.address] });
  assert.ok(sim0.signals.some((x) => x.startsWith('unknown-setter-trap')), 'owner active: trap found');
  // AuditERC20 slots: name 0, symbol 1, totalSupply 2, balanceOf 3, allowance 4, then owner 5
  await env.pub.request({ method: 'anvil_setStorageAt', params: [token.address, `0x${'00'.repeat(31)}05`, `0x${'00'.repeat(32)}`] });
  const sim = await simulate(env.rpc, token.address, pair.address, { callers: [other.account.address] });
  assert.equal(sim.evidence.unknownSweep.complete, false);
  assert.equal(sim.evidence.unknownSweep.ownerRenounced, true);
  assert.deepEqual(sim.evidence.unknownSweep.failClosedBecause, []);
  assert.ok(!sim.signals.includes('sweep-incomplete'));
  assert.equal(sim.dangerSetter, false);
});
