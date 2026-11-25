import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { startAnvil, deployToken } from './helpers.mjs';

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
  assert.equal(r.scannerVersion, 1);
});

test('cli without command exits 2 with usage', async () => {
  await assert.rejects(run('node', [CLI]), (e) => e.code === 2 && /usage/.test(e.stderr));
});
