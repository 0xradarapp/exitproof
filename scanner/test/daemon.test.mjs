import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWalletClient, http, keccak256, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { runOnce, loadState, MAX_RETRIES } from '../src/daemon.mjs';
import { attest, reportURI, readEntry, decide } from '../src/attest.mjs';
import { scan } from '../src/scan.mjs';
import {
  startAnvil, deploy, deployInfra, deployToken, listToken, write, ATTESTER_KEY, deployScannerFixture, SUPPLY,
  launchAudit,
} from './helpers.mjs';
import { SLOTS } from '../src/proxy.mjs';

let env;
let infra;
let registry;
let attester;
let quote2; // a second quote asset (skipped like WOKB) to list an already-attested token again
before(async () => {
  env = await startAnvil();
  infra = await deployInfra(env);
  quote2 = await deploy(env, 'V2.sol', 'MockWOKB');
  registry = await deploy(env, 'RiskRegistry.sol', 'RiskRegistry');
  const account = privateKeyToAccount(ATTESTER_KEY);
  attester = createWalletClient({ chain: foundry, transport: http(env.rpc), account });
  await write(env, registry, 'setAttester', [account.address, true]);
});
after(async () => { await env.stop(); });

const entryOf = (token) => readEntry(env.pub, registry.address, token);
const codehashOf = async (a) => keccak256(await env.pub.getCode({ address: a }));
const ZERO32 = `0x${'00'.repeat(32)}`;

test('reportURI: per token, carries the codehash; REPORT_BASE_URL points at the published bundle', () => {
  const t = '0x00000000000000000000000000000000000000AA';
  assert.equal(reportURI(t, `0x${'AB'.repeat(32)}`, ''), `exitproof://scan/v2/0x00000000000000000000000000000000000000aa/0x${'ab'.repeat(32)}`);
  assert.equal(reportURI(t, `0x${'ab'.repeat(32)}`, 'https://x.example/reports/'), 'https://x.example/reports/0x00000000000000000000000000000000000000aa.json');
});

test('decide(): per-token entry rules (new, code-changed, raised, version, known, no downgrade)', () => {
  const f = (o = {}) => ({ scanned: true, privileged: false, upgradeable: false, dangerSetter: false, ownerCanTrap: false, scannerVersion: 6, ...o });
  const r = (o = {}) => ({ codehash: `0x${'11'.repeat(32)}`, privileged: false, upgradeable: false, dangerSetter: false, ownerCanTrap: false, scannerVersion: 6, ...o });
  assert.equal(decide(r(), { f: f({ scanned: false }), codehash: ZERO32 }).why, 'new');
  assert.equal(decide(r(), { f: f({ privileged: true }), codehash: `0x${'22'.repeat(32)}` }).why, 'code-changed');
  const cc = decide(r(), { f: f({ privileged: true }), codehash: `0x${'22'.repeat(32)}` });
  assert.equal(cc.flags.privileged, false, 'a new codehash is a new token state: old flags do not carry over');
  const up = decide(r({ ownerCanTrap: true }), { f: f({ privileged: true }), codehash: `0x${'11'.repeat(32)}` });
  assert.deepEqual([up.send, up.why, up.flags.privileged, up.flags.ownerCanTrap], [true, 'raised', true, true]);
  const kn = decide(r(), { f: f({ privileged: true }), codehash: `0x${'11'.repeat(32)}` });
  assert.deepEqual([kn.send, kn.why, kn.lowered], [false, 'known', ['privileged']]);
  assert.equal(decide(r(), { f: f({ scannerVersion: 4 }), codehash: `0x${'11'.repeat(32)}` }).why, 'version');
});

test('attest writes the scan flags to RiskRegistry under the token address with its codehash', async () => {
  const t = await deployToken(env, 'TradingDisabled');
  const r = await scan(env.pub, t.address);
  const hash = await attest(attester, registry.address, t.address, r);
  const rc = await env.pub.waitForTransactionReceipt({ hash });
  assert.equal(rc.status, 'success');
  const e = await entryOf(t.address);
  assert.equal(e.codehash, r.codehash);
  assert.deepEqual(e.f, {
    scanned: true, privileged: true, upgradeable: false, dangerSetter: true, ownerCanTrap: false, scannerVersion: 6,
  });
});

const runOpts = (dir, start, extra = {}) => ({
  client: env.pub, walletClient: attester, factory: infra.factory.address, registry: registry.address,
  stateFile: path.join(dir, 's.json'), reportsDir: path.join(dir, 'r'), startBlock: start, window: 100n,
  skip: [infra.wokb.address, quote2.address], send: true, log: () => {}, ...extra,
});
const tmp = () => mkdtempSync(path.join(tmpdir(), 'exitproof-daemon-'));
const report = (dir, token) => JSON.parse(readFileSync(path.join(dir, 'r', `${token.toLowerCase()}.json`), 'utf8'));

test('daemon: windows PairCreated logs, scans non-base side, attests per token, persists cursor', async () => {
  const dir = tmp();
  const stateFile = path.join(dir, 's.json');
  const start = await env.pub.getBlockNumber({ cacheTime: 0 });
  const bomb = await deployToken(env, 'TimeBombToken');
  const clean = await deployToken(env, 'CleanToken');
  const proxy = await deployToken(env, 'ProxyToken');
  for (const t of [bomb, clean, proxy]) await listToken(env, infra, t);
  const latest = await env.pub.getBlockNumber({ cacheTime: 0 });
  const common = runOpts(dir, start, { window: 3n }); // forces several windows

  // dry run: scans, writes reports, does not attest, does not persist state
  const dry = await runOnce({ ...common, send: false });
  assert.equal(dry.scanned.length, 3);
  assert.equal(dry.attested.length, 0);
  assert.equal(existsSync(stateFile), false);
  assert.equal((await entryOf(bomb.address)).f.scanned, false);

  const res = await runOnce(common);
  assert.equal(res.attested.length, 3);
  assert.equal(loadState(stateFile, start).cursor, latest + 1n);
  const fb = await entryOf(bomb.address);
  assert.equal(fb.f.dangerSetter, true);
  assert.equal(fb.codehash, await codehashOf(bomb.address));
  assert.equal((await entryOf(proxy.address)).f.upgradeable, true);
  assert.deepEqual((await entryOf(clean.address)).f, {
    scanned: true, privileged: false, upgradeable: false, dangerSetter: false, ownerCanTrap: false, scannerVersion: 6,
  });
  const rep = report(dir, bomb.address);
  assert.equal(rep.token, getAddress(bomb.address));
  assert.equal(rep.codehash, fb.codehash);
  assert.equal(typeof rep.block, 'number');
  assert.equal(rep.flags.dangerSetter, true);
  assert.match(rep.attestation.tx, /^0x/);

  // second pass: nothing new
  const again = await runOnce(common);
  assert.equal(again.attested.length, 0);
});

test('F-06: two instances with the same codehash get independent per-token entries (no reuse, no poisoning)', async () => {
  const dir = tmp();
  const start = await env.pub.getBlockNumber({ cacheTime: 0 });
  const plain = await deployToken(env, 'FeeToken', [SUPPLY, 123n]);
  const slotted = await deployToken(env, 'FeeToken', [SUPPLY, 123n]);
  await env.pub.request({ method: 'anvil_setStorageAt', params: [slotted.address, SLOTS.eip1822Proxiable, `0x${'00'.repeat(31)}01`] });
  await listToken(env, infra, plain);
  await listToken(env, infra, slotted);
  assert.equal(await codehashOf(plain.address), await codehashOf(slotted.address));
  const res = await runOnce(runOpts(dir, start));
  assert.equal(res.attested.length, 2);
  assert.equal((await entryOf(slotted.address)).f.upgradeable, true);
  assert.equal((await entryOf(plain.address)).f.upgradeable, false, 'the slotted instance does not poison the plain one');
  // an unscanned third instance inherits nothing
  const third = await deployToken(env, 'FeeToken', [SUPPLY, 123n]);
  assert.equal((await entryOf(third.address)).f.scanned, false);
});

test('per token: re-listing a known token is skipped; a raised flag or a code change re-attests', async () => {
  const dir = tmp();
  const start = await env.pub.getBlockNumber({ cacheTime: 0 });
  const t = await deployToken(env, 'CleanToken');
  await listToken(env, infra, t);
  assert.equal((await runOnce(runOpts(dir, start))).attested.length, 1);

  // listed again against another quote: same codehash, same flags => known
  const s2 = await env.pub.getBlockNumber({ cacheTime: 0 });
  await listToken(env, { ...infra, wokb: quote2 }, t, SUPPLY / 8n);
  const r2 = await runOnce(runOpts(dir, s2, { stateFile: path.join(dir, 's2.json') }));
  assert.equal(r2.attested.length, 0);
  assert.deepEqual(r2.skippedKnown, [getAddress(t.address)]);

  // a flag rises (beacon slot set) => re-attested, other flags kept
  await env.pub.request({ method: 'anvil_setStorageAt', params: [t.address, SLOTS.eip1967Beacon, `0x${'00'.repeat(31)}01`] });
  const s3 = await env.pub.getBlockNumber({ cacheTime: 0 });
  const q3 = await deploy(env, 'V2.sol', 'MockWOKB');
  await listToken(env, { ...infra, wokb: q3 }, t, SUPPLY / 8n);
  const skip3 = [infra.wokb.address, quote2.address, q3.address];
  const r3 = await runOnce(runOpts(dir, s3, { stateFile: path.join(dir, 's3.json'), skip: skip3 }));
  assert.equal(r3.attested.length, 1);
  assert.equal(report(dir, t.address).decision.why, 'raised');
  assert.equal((await entryOf(t.address)).f.upgradeable, true);

  // the code changes (same storage layout: BaseToken) => the entry is for another codehash => attested from scratch
  const fee = await deployToken(env, 'FeeToken', [SUPPLY, 1n]);
  await env.pub.request({ method: 'anvil_setStorageAt', params: [t.address, SLOTS.eip1967Beacon, ZERO32] });
  await env.pub.request({ method: 'anvil_setCode', params: [t.address, await env.pub.getCode({ address: fee.address })] });
  const s4 = await env.pub.getBlockNumber({ cacheTime: 0 });
  const q4 = await deploy(env, 'V2.sol', 'MockWOKB');
  await listToken(env, { ...infra, wokb: q4 }, t, SUPPLY / 8n);
  const r4 = await runOnce(runOpts(dir, s4, { stateFile: path.join(dir, 's4.json'), skip: [...skip3, q4.address] }));
  assert.equal(r4.attested.length, 1);
  const e = await entryOf(t.address);
  assert.equal(e.codehash, await codehashOf(fee.address));
  assert.equal(report(dir, t.address).decision.why, 'code-changed');
  assert.equal(e.f.upgradeable, false, 'flags of the old code do not carry over');
  assert.equal(e.f.privileged, true, 'FeeToken: unknown feeBps() getter');
});

test('F-05: a pair created before its token has code is never dropped; scanned at first liquidity (Sync)', async () => {
  const dir = tmp();
  const start = await env.pub.getBlockNumber({ cacheTime: 0 });
  const l = await launchAudit(env, infra, 'HiddenAdminBomb', { deployNow: false });
  const passes = [];
  for (let i = 0; i < MAX_RETRIES + 2; i++) {
    const r = await runOnce(runOpts(dir, start, { forkRpc: env.rpc }));
    passes.push(r);
  }
  const st = loadState(path.join(dir, 's.json'));
  assert.deepEqual(st.pending.map((p) => [p.token, p.reason]), [[l.predicted, 'no-code']]);
  assert.equal(st.retry.length, 0);
  assert.ok(passes.every((r) => r.errors.length === 0 && r.scanned.length === 0));
  const token = await l.finish(); // the token goes live only now (deploy + liquidity => Sync)
  const after = await runOnce(runOpts(dir, start, { forkRpc: env.rpc }));
  assert.equal(after.attested.length, 1);
  assert.deepEqual(loadState(path.join(dir, 's.json')).pending, []);
  const e = await entryOf(token.address);
  assert.equal(e.f.scanned, true);
  assert.equal(e.f.ownerCanTrap, true, 'F-04 unknown-setter sweep, run at the launch configuration');
  assert.equal(e.codehash, await codehashOf(token.address));
});

test('F-05: a pending token whose code appears without a Sync is picked up by the periodic re-check', async () => {
  const dir = tmp();
  const start = await env.pub.getBlockNumber({ cacheTime: 0 });
  const l = await launchAudit(env, infra, 'AuditPlain', { deployNow: false });
  await runOnce(runOpts(dir, start));
  assert.equal(loadState(path.join(dir, 's.json')).pending.length, 1);
  // code + liquidity appear, but the Sync is in a block the cursor already passed (simulate by re-using the state)
  await l.finish();
  const s = loadState(path.join(dir, 's.json'));
  s.cursor = (await env.pub.getBlockNumber({ cacheTime: 0 })) + 1n;
  writeFileSync(path.join(dir, 's.json'), JSON.stringify({ ...s, cursor: s.cursor.toString() }));
  const r = await runOnce(runOpts(dir, start, { pendingRecheck: 0n }));
  assert.equal(r.attested.length, 1);
  assert.equal((await entryOf(l.predicted)).f.scanned, true);
});

test('daemon with FORK_RPC: the simulation verdict (F-02 transferFrom trap) is attested', async () => {
  const dir = tmp();
  const start = await env.pub.getBlockNumber({ cacheTime: 0 });
  const { token } = await launchAudit(env, infra, 'TransferFromTrap');
  const res = await runOnce(runOpts(dir, start, { forkRpc: env.rpc }));
  assert.equal(res.attested.length, 1);
  const e = await entryOf(token.address);
  assert.equal(e.f.ownerCanTrap, true);
  assert.equal(e.f.privileged, true);
  assert.ok(report(dir, token.address).evidence.simulation.signals.includes('transferFrom-trap'));
});

test('simulate failure: static scan is still attested and the token is queued for retry in the state file', async () => {
  const dir = tmp();
  const start = await env.pub.getBlockNumber({ cacheTime: 0 });
  const t = await deployScannerFixture(env, 'HiddenOwnerToken', [SUPPLY]);
  const pair = await listToken(env, infra, t);
  const bad = 'http://127.0.0.1:9'; // nothing listens: simulate throws before any baseline
  const res = await runOnce(runOpts(dir, start, { forkRpc: bad }));
  assert.equal(res.attested.length, 1);
  const e = await entryOf(t.address);
  assert.equal(e.f.scanned, true);
  assert.equal(e.f.privileged, true);
  const st = JSON.parse(readFileSync(path.join(dir, 's.json'), 'utf8'));
  assert.equal(st.retry.length, 1);
  assert.equal(st.retry[0].token.toLowerCase(), t.address.toLowerCase());
  assert.equal(st.retry[0].pair.toLowerCase(), pair.address.toLowerCase());
  assert.match(st.retry[0].error, /simulate/);

  // next pass with a working fork: the retry is processed and cleared
  const again = await runOnce(runOpts(dir, start, { forkRpc: env.rpc }));
  assert.equal(again.retried.length, 1);
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 's.json'), 'utf8')).retry, []);
});

test('simulate keeps failing: after MAX_RETRIES the token is attested ownerCanTrap=true (simulate-gave-up)', async () => {
  const dir = tmp();
  const t = await deployScannerFixture(env, 'MappingAdminToken', [SUPPLY]);
  const pair = await listToken(env, infra, t);
  const head = await env.pub.getBlockNumber({ cacheTime: 0 });
  writeFileSync(path.join(dir, 's.json'), JSON.stringify({
    cursor: (head + 1n).toString(),
    retry: [{ token: t.address, pair: pair.address, error: 'simulate: x', attempts: MAX_RETRIES - 1 }],
  }));
  const res = await runOnce(runOpts(dir, head + 1n, { forkRpc: 'http://127.0.0.1:9' }));
  assert.equal(res.attested.length, 1);
  assert.equal((await entryOf(t.address)).f.ownerCanTrap, true);
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 's.json'), 'utf8')).retry, []);
  assert.match(report(dir, t.address).evidence.simulation.error, /^simulate-gave-up/);
});

test('REGISTRY_ABI matches the compiled RiskRegistry (attest / flagsOf / Attested)', async () => {
  const { REGISTRY_ABI } = await import('../src/attest.mjs');
  const { artifact: art } = await import('./helpers.mjs');
  const { toFunctionSelector, toEventSelector } = await import('viem');
  const compiled = art('RiskRegistry.sol', 'RiskRegistry').abi;
  for (const name of ['attest', 'flagsOf', 'isAttester']) {
    const a = REGISTRY_ABI.find((x) => x.name === name);
    const b = compiled.find((x) => x.name === name && x.type === 'function');
    assert.equal(toFunctionSelector(a), toFunctionSelector(b), name);
    assert.deepEqual(a.outputs.map((o) => o.type), b.outputs.map((o) => o.type), `${name} outputs`);
  }
  const ea = REGISTRY_ABI.find((x) => x.name === 'Attested');
  const eb = compiled.find((x) => x.name === 'Attested');
  assert.equal(toEventSelector(ea), toEventSelector(eb));
  assert.deepEqual(ea.inputs.map((i) => i.indexed ?? false), eb.inputs.map((i) => i.indexed ?? false));
});
