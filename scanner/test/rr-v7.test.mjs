// v6 re-review PoCs (I-1 renounce exemption, I-2 silent magic argument, I-3 fake CBOR trailer), ported from
// /tmp/ep-v6rr (trailer-poc.mjs, rr-v6*.test.mjs, ScannerFixtures additions). Scanner v6 let each one through.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createWalletClient, http, keccak256, toHex, getAddress, hexToBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { scan, analyzeCode, metadataStart } from '../src/scan.mjs';
import { simulate, mergeSimulation, packedAddresses, sweepBudgetMs } from '../src/simulate.mjs';
import { selectorOf } from '../src/selectors.mjs';
import { startAnvil, deployInfra, launchAudit, deployToken, deployScannerFixture, SUPPLY } from './helpers.mjs';

const KEY3 = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6'; // anvil dev #3 (public test key)
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/cli.mjs');
let env;
let infra;
let other;
before(async () => {
  env = await startAnvil();
  infra = await deployInfra(env);
  other = createWalletClient({ chain: foundry, transport: http(env.rpc), account: privateKeyToAccount(KEY3) });
});
after(async () => { await env.stop(); });
const balancedBlocks = (m) => (m.privileged && (m.dangerSetter || m.ownerCanTrap)) || m.upgradeable;
const HIDDEN = getAddress(`0x${keccak256(toHex('hidden-admin')).slice(-40)}`);

test('I-1 RenouncedPackedAdmin: packed hidden admin is discovered and its setter traps', async () => {
  const { token, pair } = await launchAudit(env, infra, 'RenouncedPackedAdmin', { pairCreator: other });
  const s = await scan(env.pub, token.address);
  const sim = await simulate(env.rpc, token.address, pair.address, { callers: [other.account.address] });
  assert.equal(s.evidence.owner, null, 'owner() == 0');
  assert.ok(sim.evidence.storageCallers.includes(HIDDEN), 'address at byte offset 12 of a packed slot');
  assert.ok(sim.signals.includes(`unknown-setter-trap:${selectorOf('setLaunchParam(uint256)')}`));
  assert.ok(balancedBlocks(mergeSimulation(structuredClone(s), sim)));
});

test('I-1 renounce exemption only covers checks on the slot owner() reads: an incomplete sweep still fails closed', async () => {
  const { token, pair } = await launchAudit(env, infra, 'RenouncedPackedAdmin', { pairCreator: other });
  const s = await scan(env.pub, token.address);
  assert.ok(s.evidence.callerCheckSlots.length >= 2, JSON.stringify(s.evidence.callerCheckSlots));
  const sim = await simulate(env.rpc, token.address, pair.address, { callers: [other.account.address], maxUnknown: 0 });
  const sw = sim.evidence.unknownSweep;
  assert.equal(sw.ownerRenounced, true);
  assert.ok(sw.ownerSlots.length > 0);
  assert.ok(sw.callerCheckSlots.some((x) => !sw.ownerSlots.includes(x)), 'the _ops check is on another slot');
  assert.ok(sw.failClosedBecause.includes('caller-vs-storage'));
  assert.ok(sim.signals.includes('sweep-incomplete'));
  assert.equal(sim.dangerSetter, true);
});

test('I-1 packedAddresses: usual packing offsets, small numbers ignored', () => {
  const a = 0xb0b0000000000000000000000000000000001234n;
  assert.equal(packedAddresses((a << 96n) | 1n)[0], getAddress(`0x${a.toString(16)}`), 'uint96 then address');
  assert.ok(packedAddresses((1n << 160n) | a).includes(getAddress(`0x${a.toString(16)}`)), 'address then bool');
  assert.deepEqual(packedAddresses(a), [getAddress(`0x${a.toString(16)}`)]);
  assert.deepEqual(packedAddresses(10n ** 24n), []);
});

test('I-2 MagicSecondSilent: key in word 1 is tried; the trap is found', async () => {
  const { token, pair } = await launchAudit(env, infra, 'MagicSecondSilent', { pairCreator: other });
  const sim = await simulate(env.rpc, token.address, pair.address, { callers: [other.account.address] });
  const sel = selectorOf('setLaunchParam(uint256,uint256)');
  assert.ok(sim.evidence.unknownAttempts.some((x) => x.selector === sel && /^magic:0x1234@1\//.test(x.pattern) && x.trapped));
  assert.ok(sim.signals.includes(`unknown-setter-trap:${sel}`));
});

test('I-2 a hinted selector that only ever returns silently (no storage change) is unexercised => fail closed', async () => {
  const { token, pair } = await launchAudit(env, infra, 'MagicSecondSilent', { pairCreator: other });
  // v6 behaviour: the hint only in word 0 => every call succeeds and does nothing
  const sim = await simulate(env.rpc, token.address, pair.address, { callers: [other.account.address], hintPositions: [0] });
  const sel = selectorOf('setLaunchParam(uint256,uint256)');
  assert.deepEqual(sim.evidence.unknownSweep.unexercised, [sel]);
  assert.equal(sim.evidence.unknownSweep.complete, false);
  assert.ok(sim.signals.includes('sweep-incomplete'));
  assert.equal(sim.dangerSetter, true);
});

// ---- I-3: fake CBOR trailer (trailer-poc.mjs) ----
const h = (x) => x.replace(/\s+/g, '');
function trailerCode({ marker = '69706673', overrun = false }) {
  const disp = (T) => `5f35 60e01c 80 63a9059cbb 14 61${T} 57 5f5ffd`;
  const okAt = h(disp('0000')).length / 2;
  const T = okAt + 2;
  const okHex = okAt.toString(16).padStart(4, '0');
  // hidden body: PUSH4 "ipfs" POP; CALLER PUSH0 SLOAD EQ PUSH2 OK JUMPI; PUSH0 x4 PUSH1 1 SLOAD GAS DELEGATECALL ...
  const body = h(`63${marker} 50 33 5f54 14 61${okHex} 57 5f5f5f5f 600154 5a f4 50 5f5ffd`);
  const entry = overrun ? '61' : '5f5f5f';
  const trailer = overrun ? `a100${body}` : `a1${body}`;
  const len = (trailer.length / 2).toString(16).padStart(4, '0');
  return `0x${h(disp(T.toString(16).padStart(4, '0')))}5b005b${entry}${trailer}${len}`;
}

for (const [label, opts] of [['fall-through', {}], ['PUSH overrun', { overrun: true }]]) {
  test(`I-3 fake CBOR trailer reached by ${label} is analysed as code`, () => {
    const code = trailerCode(opts);
    assert.notEqual(metadataStart(hexToBytes(code)), null, 'the trailer shape is recognised');
    const a = analyzeCode(code);
    assert.equal(a.metadataSkipped, false);
    assert.ok(a.callerChecks.length > 0);
    assert.equal(a.unsafeDelegatecall, true);
    assert.equal(a.upgradeable, true);
    assert.equal(a.privilegedCode, true);
  });
}

test('I-3 honest solc output still skips its metadata trailer', async () => {
  for (const name of ['CleanToken', 'TimeBombToken', 'FeeToken']) {
    const t = await deployToken(env, name, name === 'FeeToken' ? [SUPPLY, 1n] : [SUPPLY]);
    const a = analyzeCode(await env.pub.getCode({ address: t.address }));
    assert.equal(a.metadataSkipped, true, name);
  }
  const p = await deployScannerFixture(env, 'PermitToken', [SUPPLY]);
  assert.equal(analyzeCode(await env.pub.getCode({ address: p.address })).metadataSkipped, true);
});

test('minor: SWEEP_BUDGET_S is validated for the daemon too', async () => {
  assert.equal(sweepBudgetMs({ SWEEP_BUDGET_S: '2.5' }), 2500);
  assert.equal(sweepBudgetMs({}), 180_000);
  assert.throws(() => sweepBudgetMs({ SWEEP_BUDGET_S: 'abc' }), /positive number/);
  await assert.rejects(promisify(execFile)('node', [CLI, 'daemon'], {
    env: { ...process.env, RPC_URL: env.rpc, REGISTRY: '0x00000000000000000000000000000000000000bb', START_BLOCK: '0', SWEEP_BUDGET_S: '-1' },
  }), (e) => e.code === 1 && /SWEEP_BUDGET_S must be/.test(e.stderr));
});
