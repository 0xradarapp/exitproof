import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWalletClient, http, keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { runOnce, loadState } from '../src/daemon.mjs';
import { attest, reportURI, REGISTRY_ABI } from '../src/attest.mjs';
import { scan } from '../src/scan.mjs';
import {
  startAnvil, deploy, deployInfra, deployToken, listToken, write, ATTESTER_KEY,
} from './helpers.mjs';

let env;
let infra;
let registry;
let attester;
before(async () => {
  env = await startAnvil();
  infra = await deployInfra(env);
  registry = await deploy(env, 'RiskRegistry.sol', 'RiskRegistry');
  const account = privateKeyToAccount(ATTESTER_KEY);
  attester = createWalletClient({ chain: foundry, transport: http(env.rpc), account });
  await write(env, registry, 'setAttester', [account.address, true]);
});
after(async () => { await env.stop(); });

const flagsOf = (codehash) => env.pub.readContract({
  address: registry.address, abi: REGISTRY_ABI, functionName: 'flagsOf', args: [codehash],
});

test('reportURI format', () => {
  assert.equal(reportURI(`0x${'ab'.repeat(32)}`), `exitproof://scan/v1/0x${'ab'.repeat(32)}`);
});

test('attest writes the scan flags to RiskRegistry', async () => {
  const t = await deployToken(env, 'TradingDisabled');
  const r = await scan(env.pub, t.address);
  const hash = await attest(attester, registry.address, r);
  const rc = await env.pub.waitForTransactionReceipt({ hash });
  assert.equal(rc.status, 'success');
  const f = await flagsOf(r.codehash);
  assert.deepEqual(f, {
    scanned: true, privileged: true, upgradeable: false, dangerSetter: true, ownerCanTrap: false, scannerVersion: 1,
  });
});

test('daemon: windows PairCreated logs, scans non-base side, attests, persists cursor', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'exitproof-daemon-'));
  const stateFile = path.join(dir, 'state.json');
  const reportsDir = path.join(dir, 'reports');
  const start = await env.pub.getBlockNumber({ cacheTime: 0 });
  const bomb = await deployToken(env, 'TimeBombToken');
  const clean = await deployToken(env, 'CleanToken');
  const proxy = await deployToken(env, 'ProxyToken');
  for (const t of [bomb, clean, proxy]) await listToken(env, infra, t);
  const latest = await env.pub.getBlockNumber({ cacheTime: 0 });

  const common = {
    client: env.pub,
    factory: infra.factory.address,
    registry: registry.address,
    stateFile,
    reportsDir,
    startBlock: start,
    window: 3n, // forces several windows
    skip: [infra.wokb.address],
    log: () => {},
  };

  // dry run: scans, writes reports, does not attest, does not advance cursor
  const dry = await runOnce({ ...common, walletClient: attester, send: false });
  assert.equal(dry.scanned.length, 3);
  assert.equal(dry.attested.length, 0);
  assert.equal(loadState(stateFile, start).cursor, start);
  const bombHash = keccak256(await env.pub.getCode({ address: bomb.address }));
  assert.equal((await flagsOf(bombHash)).scanned, false);

  const res = await runOnce({ ...common, walletClient: attester, send: true });
  assert.equal(res.attested.length, 3);
  assert.equal(loadState(stateFile, start).cursor, latest + 1n);
  const fb = await flagsOf(bombHash);
  assert.equal(fb.scanned, true);
  assert.equal(fb.dangerSetter, true);
  const fp = await flagsOf(keccak256(await env.pub.getCode({ address: proxy.address })));
  assert.equal(fp.upgradeable, true);
  const fc = await flagsOf(keccak256(await env.pub.getCode({ address: clean.address })));
  assert.deepEqual(fc, {
    scanned: true, privileged: false, upgradeable: false, dangerSetter: false, ownerCanTrap: false, scannerVersion: 1,
  });
  const rep = JSON.parse(readFileSync(path.join(reportsDir, `${bombHash}.json`), 'utf8'));
  assert.equal(rep.codehash, bombHash);
  assert.equal(rep.dangerSetter, true);

  // second pass: nothing new, already-attested codehashes are not re-sent
  const again = await runOnce({ ...common, walletClient: attester, send: true });
  assert.equal(again.attested.length, 0);
  assert.ok(existsSync(stateFile));
});

test('daemon: already-scanned codehash (same version) is skipped', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'exitproof-daemon-'));
  const start = await env.pub.getBlockNumber({ cacheTime: 0 });
  const t = await deployToken(env, 'TimeBombToken'); // same code as the one attested above
  await listToken(env, infra, t);
  const res = await runOnce({
    client: env.pub, walletClient: attester, factory: infra.factory.address, registry: registry.address,
    stateFile: path.join(dir, 's.json'), reportsDir: path.join(dir, 'r'), startBlock: start, window: 100n,
    skip: [infra.wokb.address], send: true, log: () => {},
  });
  assert.equal(res.attested.length, 0);
  assert.equal(res.skippedKnown.length, 1);
});

test('daemon with FORK_RPC: simulation sets ownerCanTrap and re-attests a known codehash when it newly traps', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'exitproof-daemon-'));
  const start = await env.pub.getBlockNumber({ cacheTime: 0 });
  const t = await deployToken(env, 'ProxyToken'); // codehash already attested above with ownerCanTrap=false
  await listToken(env, infra, t);
  const res = await runOnce({
    client: env.pub, walletClient: attester, factory: infra.factory.address, registry: registry.address,
    stateFile: path.join(dir, 's.json'), reportsDir: path.join(dir, 'r'), startBlock: start, window: 100n,
    skip: [infra.wokb.address], send: true, forkRpc: env.rpc, log: () => {},
  });
  assert.equal(res.attested.length, 1);
  const codehash = keccak256(await env.pub.getCode({ address: t.address }));
  const f = await flagsOf(codehash);
  assert.equal(f.ownerCanTrap, true);
  assert.equal(f.upgradeable, true);
  const rep = JSON.parse(readFileSync(path.join(dir, 'r', `${codehash}.json`), 'utf8'));
  assert.ok(rep.evidence.simulation.attempts.some((a) => a.trapped));
});

