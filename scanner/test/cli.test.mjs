import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createWalletClient, http, keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { startAnvil, deployToken, deploy, write, DEV_KEY } from './helpers.mjs';
import { attest, REGISTRY_ABI } from '../src/attest.mjs';

const run = promisify(execFile);
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/cli.mjs');

let env;
before(async () => { env = await startAnvil(); });
after(async () => { await env.stop(); });

test('cli scan prints the scan JSON', async () => {
  const t = await deployToken(env, 'TimeBombToken');
  const { stdout } = await run('node', [CLI, 'scan', t.address], { env: { ...process.env, RPC_URL: env.rpc } });
  const r = JSON.parse(stdout);
  assert.equal(r.dangerSetter, true);
  assert.equal(r.privileged, true);
  assert.equal(r.scannerVersion, 2);
});

test('cli without command exits 2 with usage', async () => {
  await assert.rejects(run('node', [CLI]), (e) => e.code === 2 && /usage/.test(e.stderr));
});

test('cli attest refuses to downgrade a registry flag unless --force', async () => {
  const registry = await deploy(env, 'RiskRegistry.sol', 'RiskRegistry');
  await write(env, registry, 'setAttester', [env.account.address, true]);
  const t = await deployToken(env, 'CleanToken');
  const codehash = keccak256(await env.pub.getCode({ address: t.address }));
  const w = createWalletClient({ chain: foundry, transport: http(env.rpc), account: privateKeyToAccount(DEV_KEY) });
  const hash = await attest(w, registry.address, {
    codehash, privileged: true, upgradeable: false, dangerSetter: false, ownerCanTrap: false, scannerVersion: 2,
  });
  await env.pub.waitForTransactionReceipt({ hash });
  const cliEnv = {
    ...process.env, RPC_URL: env.rpc, REGISTRY: registry.address, ATTESTER_KEY: DEV_KEY, SEND: '1',
    REPORTS_DIR: mkdtempSync(path.join(tmpdir(), 'exitproof-cli-')),
  };
  await assert.rejects(run('node', [CLI, 'attest', t.address], { env: cliEnv }),
    (e) => e.code === 1 && /downgrade/.test(e.stderr) && /privileged/.test(e.stderr));
  const flags = () => env.pub.readContract({
    address: registry.address, abi: REGISTRY_ABI, functionName: 'flagsOf', args: [codehash],
  });
  assert.equal((await flags()).privileged, true);
  await run('node', [CLI, 'attest', t.address, '--force'], { env: cliEnv });
  assert.equal((await flags()).privileged, false);
});

