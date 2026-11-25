import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createWalletClient, http as viemHttp, keccak256, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { startAnvil, deployToken, deploy, deployInfra, listToken, write, launchAudit } from './helpers.mjs';
import { attest, readEntry } from '../src/attest.mjs';
import { attesterKey, sendGate, isLoopbackUrl } from '../src/send-gate.mjs';
import { publishReports } from '../src/publish-reports.mjs';
import { costEstimate, ATTEST_GAS } from '../src/backfill.mjs';

const run = promisify(execFile);
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/cli.mjs');
// anvil dev keys #2 and #3 (public test keys): the attesters of this file
const KEY2 = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
const KEY3 = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6';

let env;
before(async () => { env = await startAnvil(); });
after(async () => { await env.stop(); });

const tmp = (p) => mkdtempSync(path.join(tmpdir(), p));

test('cli scan prints the scan JSON (with the block it was pinned to)', async () => {
  const t = await deployToken(env, 'TimeBombToken');
  const { stdout } = await run('node', [CLI, 'scan', t.address], { env: { ...process.env, RPC_URL: env.rpc } });
  const r = JSON.parse(stdout);
  assert.equal(r.dangerSetter, true);
  assert.equal(r.privileged, true);
  assert.equal(r.scannerVersion, 8);
  assert.equal(r.block, Number(await env.pub.getBlockNumber({ cacheTime: 0 })));
});

test('cli without command exits 2 with usage', async () => {
  await assert.rejects(run('node', [CLI]), (e) => e.code === 2 && /usage/.test(e.stderr));
});

async function registryWith(attesterKeyHex) {
  const registry = await deploy(env, 'RiskRegistry.sol', 'RiskRegistry');
  await write(env, registry, 'setAttester', [privateKeyToAccount(attesterKeyHex).address, true]);
  return registry;
}

test('cli attest refuses to downgrade a flag of the same codehash unless --force; writes reports/<token>.json', async () => {
  const registry = await registryWith(KEY2);
  const t = await deployToken(env, 'CleanToken');
  const codehash = keccak256(await env.pub.getCode({ address: t.address }));
  const w = createWalletClient({ chain: foundry, transport: viemHttp(env.rpc), account: privateKeyToAccount(KEY2) });
  const hash = await attest(w, registry.address, t.address, {
    codehash, privileged: true, upgradeable: false, dangerSetter: false, ownerCanTrap: false, scannerVersion: 8,
  });
  await env.pub.waitForTransactionReceipt({ hash });
  const reports = tmp('exitproof-cli-');
  const cliEnv = {
    ...process.env, RPC_URL: env.rpc, REGISTRY: registry.address, ATTESTER_KEY: KEY2, SEND: '1', REPORTS_DIR: reports,
  };
  // N-06: no send without the sell simulation unless STATIC_ONLY=1 is explicit
  await assert.rejects(run('node', [CLI, 'attest', t.address], { env: cliEnv }), (e) => e.code === 1 && /requires FORK_RPC/.test(e.stderr));
  await assert.rejects(run('node', [CLI, 'daemon'], { env: { ...cliEnv, START_BLOCK: '0' } }), (e) => e.code === 1 && /requires FORK_RPC/.test(e.stderr));
  cliEnv.STATIC_ONLY = '1';
  await assert.rejects(run('node', [CLI, 'attest', t.address], { env: cliEnv }),
    (e) => e.code === 1 && /downgrade/.test(e.stderr) && /privileged/.test(e.stderr));
  assert.equal((await readEntry(env.pub, registry.address, t.address)).f.privileged, true);
  await run('node', [CLI, 'attest', t.address, '--force'], { env: cliEnv });
  const e = await readEntry(env.pub, registry.address, t.address);
  assert.equal(e.f.privileged, false);
  assert.equal(e.codehash, codehash);
  const rep = JSON.parse(readFileSync(path.join(reports, `${t.address.toLowerCase()}.json`), 'utf8'));
  assert.deepEqual([rep.token, rep.codehash, typeof rep.block, rep.decision.why], [getAddress(t.address), codehash, 'number', 'force']);
});

test('cli attest: an entry for another codehash (code changed) is not a downgrade', async () => {
  const registry = await registryWith(KEY2);
  const t = await deployToken(env, 'CleanToken');
  const w = createWalletClient({ chain: foundry, transport: viemHttp(env.rpc), account: privateKeyToAccount(KEY2) });
  await env.pub.waitForTransactionReceipt({ hash: await attest(w, registry.address, t.address, {
    codehash: `0x${'77'.repeat(32)}`, privileged: true, upgradeable: true, dangerSetter: true, ownerCanTrap: true, scannerVersion: 8,
  }) });
  const cliEnv = { ...process.env, RPC_URL: env.rpc, REGISTRY: registry.address, ATTESTER_KEY: KEY2, SEND: '1', STATIC_ONLY: '1', REPORTS_DIR: tmp('exitproof-cli-') };
  const { stderr } = await run('node', [CLI, 'attest', t.address], { env: cliEnv });
  assert.match(stderr, /attested/);
  const e = await readEntry(env.pub, registry.address, t.address);
  assert.equal(e.f.privileged, false);
  assert.equal(e.codehash, keccak256(await env.pub.getCode({ address: t.address })));
});

test('F-13 key hygiene: key only from env; key file must not be group/world readable; no key on argv', () => {
  const dir = tmp('exitproof-key-');
  const f = path.join(dir, 'attester.key');
  writeFileSync(f, `${KEY3}\n`);
  chmodSync(f, 0o644);
  assert.throws(() => attesterKey({ ATTESTER_KEY_FILE: f }, []), /chmod 600/);
  chmodSync(f, 0o600);
  assert.equal(attesterKey({ ATTESTER_KEY_FILE: f }, []), KEY3);
  assert.equal(attesterKey({ ATTESTER_KEY: KEY3 }, []), KEY3);
  assert.equal(attesterKey({}, []), null);
  assert.throws(() => attesterKey({ ATTESTER_KEY: KEY3, ATTESTER_KEY_FILE: f }, []), /not both/);
  assert.throws(() => attesterKey({}, ['node', 'cli.mjs', 'attest', KEY3]), /command line/);
  assert.throws(() => attesterKey({}, ['node', 'cli.mjs', '--private-key', 'x']), /command line/);
  assert.throws(() => attesterKey({ ATTESTER_KEY: 'nope' }, []), /32-byte/);
});

test('F-13 / F-14 mainnet gate: chain 196 needs CONFIRM_MAINNET=yes; an anvil answer from a remote URL is mainnet', async () => {
  assert.equal(isLoopbackUrl('http://127.0.0.1:8545'), true);
  assert.equal(isLoopbackUrl('http://localhost:1'), true);
  assert.equal(isLoopbackUrl('https://rpc.xlayer.tech'), false);
  // a fake chain-196 node that does not identify as anvil
  const fake = (client) => http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const m = JSON.parse(body);
      const result = m.method === 'eth_chainId' ? '0xc4' : m.method === 'web3_clientVersion' ? client : null;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(result === null
        ? { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no' } } : { jsonrpc: '2.0', id: m.id, result }));
    });
  });
  const srv = fake('Geth/v1');
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  const logs = [];
  try {
    await assert.rejects(sendGate(url, {}, { what: 'attest', log: (x) => logs.push(x) }), /CONFIRM_MAINNET=yes/);
    assert.ok(logs.some((l) => /X LAYER MAINNET/.test(l)), 'banner printed');
    assert.equal((await sendGate(url, { CONFIRM_MAINNET: 'yes' }, { log: () => {} })).network, 'xlayer');
    // the CLI send path is gated too
    await assert.rejects(run('node', [CLI, 'attest', '0x00000000000000000000000000000000000000aa'], {
      env: { ...process.env, RPC_URL: url, REGISTRY: '0x00000000000000000000000000000000000000bb', ATTESTER_KEY: KEY3, SEND: '1', STATIC_ONLY: '1' },
    }), (e) => e.code === 1 && /CONFIRM_MAINNET=yes/.test(e.stderr));
  } finally {
    srv.close();
  }
  // local anvil (chain 31337): no gate
  assert.equal((await sendGate(env.rpc, {}, { log: () => {} })).network, 'chain-31337');
});

test('backfill (dry-run default): newest qualifying pairs first, dust filtered, resumable, cost printed', async () => {
  const infra = await deployInfra(env);
  const a = await launchAudit(env, infra, 'AuditPlain');
  const dust = await deployToken(env, 'CleanToken');
  await listToken(env, infra, dust, 10n ** 18n, 10n ** 15n); // 0.001 WOKB < 0.01 dust
  const b = await launchAudit(env, infra, 'TransferFromTrap');
  const dir = tmp('exitproof-backfill-');
  const benv = {
    ...process.env, RPC_URLS: env.rpc, FACTORY: infra.factory.address, BASE_WOKB: infra.wokb.address,
    BASE_USDT0: '0x00000000000000000000000000000000000000c0', STATE_FILE: path.join(dir, 'state.json'),
    REPORTS_DIR: path.join(dir, 'reports'), RATE_MS: '0', FORK_RPC: env.rpc,
  };
  const r1 = await run('node', [CLI, 'backfill'], { env: benv });
  const lines = r1.stdout.trim().split('\n');
  assert.match(lines[0], new RegExp(`\\[1/2\\] #2 ${getAddress(b.token.address)} WOKB dry\\(new\\).*trap=1`));
  assert.match(lines[1], new RegExp(`\\[2/2\\] #0 ${getAddress(a.token.address)} WOKB dry\\(new\\).*trap=0`));
  const sum = JSON.parse(lines.slice(2).join('\n'));
  assert.equal(sum.mode, 'dry');
  assert.equal(sum.allPairs, 3);
  assert.equal(sum.candidates, 2);
  assert.equal(sum.counts.dry, 2);
  assert.equal(sum.cost.estimate.pairs, 950);
  assert.match(r1.stderr, /dry-run: nothing was sent/);
  assert.equal(readdirSync(path.join(dir, 'reports')).length, 2);
  // resume: both tokens are already done at the pinned block
  const r2 = await run('node', [CLI, 'backfill'], { env: benv });
  assert.equal(JSON.parse(r2.stdout).counts.resumed, 2);
  assert.match(r2.stderr, /resuming: 2 tokens done/);
  // shards: pair index mod N (#0 and #2 are both in shard 0/2), own state files, budget reported
  const sh = { ...benv, STATE_FILE: '', STATE_DIR: path.join(dir, 'st'), SWEEP_BUDGET_S: '30', REPORTS_DIR: path.join(dir, 'reports-sh') };
  const s0 = await run('node', [CLI, 'backfill'], { env: { ...sh, SHARD: '0/2' }, cwd: dir });
  const s1 = await run('node', [CLI, 'backfill'], { env: { ...sh, SHARD: '1/2' }, cwd: dir });
  const j0 = JSON.parse(s0.stdout.slice(s0.stdout.indexOf('{')));
  const j1 = JSON.parse(s1.stdout.slice(s1.stdout.indexOf('{')));
  assert.deepEqual([j0.shard, j0.candidates, j1.shard, j1.candidates], ['0/2', 2, '1/2', 0]);
  assert.equal(j0.sweepBudgetS, 30);
  assert.match(j0.stateFile, /backfill-dry-shard0of2\.json$/);
  await assert.rejects(run('node', [CLI, 'backfill'], { env: { ...sh, SHARD: '2/2' } }), (e) => /SHARD must be/.test(e.stderr));
});

test('backfill SEND=1 attests per token (needs FORK_RPC); LIMIT bounds the run', async () => {
  const infra = await deployInfra(env);
  await launchAudit(env, infra, 'AuditPlain');
  const b = await launchAudit(env, infra, 'SameBlockSellOnly');
  const registry = await registryWith(KEY3);
  const dir = tmp('exitproof-backfill-');
  const benv = {
    ...process.env, RPC_URLS: env.rpc, FACTORY: infra.factory.address, BASE_WOKB: infra.wokb.address,
    STATE_FILE: path.join(dir, 'state.json'), REPORTS_DIR: path.join(dir, 'reports'), RATE_MS: '0',
    REGISTRY: registry.address, ATTESTER_KEY: KEY3, SEND: '1', LIMIT: '1',
  };
  await assert.rejects(run('node', [CLI, 'backfill'], { env: benv }), (e) => /requires FORK_RPC/.test(e.stderr));
  const { stdout } = await run('node', [CLI, 'backfill'], { env: { ...benv, FORK_RPC: env.rpc } });
  const sum = JSON.parse(stdout.slice(stdout.indexOf('{')));
  assert.equal(sum.counts.attested, 1);
  assert.ok(BigInt(sum.gasUsed) > 0n);
  const e = await readEntry(env.pub, registry.address, b.token.address);
  assert.equal(e.f.dangerSetter, true, 'delayed-sell-trap attested');
});

test('publish-reports bundles reports/<token>.json into a static index', () => {
  const src = tmp('exitproof-rep-');
  const out = tmp('exitproof-pub-');
  const tok = '0x00000000000000000000000000000000000000aa';
  writeFileSync(path.join(src, `${tok}.json`), JSON.stringify({
    token: tok, codehash: `0x${'11'.repeat(32)}`, block: 7, scannerVersion: 8, flags: { privileged: true },
    evidence: { reasons: ['owner-getter'], simulation: { signals: ['delayed-sell-trap'] } }, reportURI: 'x',
  }));
  writeFileSync(path.join(src, 'junk.json'), '{}');
  const r = publishReports(src, out);
  assert.equal(r.count, 1);
  const idx = JSON.parse(readFileSync(path.join(out, 'index.json'), 'utf8'));
  assert.equal(idx.reports[0].token, getAddress(tok));
  assert.deepEqual(idx.reports[0].signals, ['delayed-sell-trap']);
  assert.equal(idx.reports[0].block, 7);
  assert.equal(readFileSync(path.join(out, `${tok}.json`), 'utf8'), readFileSync(path.join(src, `${tok}.json`), 'utf8'));
});

test('cost estimate: ~950 first attestations', () => {
  const c = costEstimate(950, 20_000_000n); // 0.02 gwei
  assert.equal(c.gasPerAttest, ATTEST_GAS.toString());
  assert.equal(c.okb, '0.00152');
});
