import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { simulate } from '../src/simulate.mjs';
import {
  startAnvil, deployInfra, deployToken, listToken, read, deployScannerFixture, SUPPLY,
} from './helpers.mjs';

let env;
let infra;
before(async () => {
  env = await startAnvil();
  infra = await deployInfra(env);
});
after(async () => { await env.stop(); });

async function setup(name) {
  const token = await deployToken(env, name);
  const pair = await listToken(env, infra, token);
  return { token, pair };
}

test('TimeBombToken: owner can raise sell fee => ownerCanTrap; state restored afterwards', async () => {
  const { token, pair } = await setup('TimeBombToken');
  const block = await env.pub.getBlockNumber({ cacheTime: 0 });
  const r = await simulate(env.rpc, token.address, pair.address);
  assert.equal(r.ownerCanTrap, true);
  assert.equal(r.evidence.baselineSellOk, true);
  const hit = r.evidence.attempts.find((a) => a.trapped);
  assert.equal(hit.signature, 'setSellFee(uint256)');
  assert.equal(await read(env, token, 'sellFeeBps'), 0n, 'setter effects reverted');
  assert.equal(await env.pub.getBlockNumber({ cacheTime: 0 }), block, 'chain rewound to initial snapshot');
});

test('TimeBombToken evidence: real buy, fee 0 harmless, fee 10000 traps', async () => {
  const { token, pair } = await setup('TimeBombToken');
  const r = await simulate(env.rpc, token.address, pair.address);
  assert.equal(r.evidence.acquiredVia, 'buy');
  const bySet = Object.fromEntries(r.evidence.attempts.map((a) => [a.args[0], a]));
  assert.equal(bySet['0'].trapped, false);
  assert.equal(bySet['10000'].trapped, true);
  assert.equal(bySet['10000'].sellOk, false);
  assert.equal(bySet['99'].trapped, false, '0.99% fee is not a trap');
});

test('ProxyToken: admin can upgrade to a bricked implementation => ownerCanTrap', async () => {
  const { token, pair } = await setup('ProxyToken');
  const r = await simulate(env.rpc, token.address, pair.address);
  assert.equal(r.evidence.baselineSellOk, true);
  assert.equal(r.ownerCanTrap, true);
  assert.ok(r.evidence.attempts.some((a) => a.signature === 'upgradeTo(address)' && a.trapped));
});

test('CleanToken: nothing to call => ownerCanTrap false, baseline sell ok', async () => {
  const { token, pair } = await setup('CleanToken');
  const r = await simulate(env.rpc, token.address, pair.address);
  assert.equal(r.ownerCanTrap, false);
  assert.equal(r.evidence.baselineSellOk, true);
  assert.deepEqual(r.evidence.attempts, []);
});

test('OwnedCleanToken: owner but no setters => ownerCanTrap false', async () => {
  const { token, pair } = await setup('OwnedCleanToken');
  const r = await simulate(env.rpc, token.address, pair.address);
  assert.equal(r.ownerCanTrap, false);
});

test('TradingDisabled: owner unlock (enableTrading) is applied first, then setters are tried; state restored', async () => {
  const { token, pair } = await setup('TradingDisabled');
  const r = await simulate(env.rpc, token.address, pair.address);
  assert.deepEqual(r.evidence.unlockedBy, ['enableTrading()']);
  assert.equal(r.evidence.baselineSellOk, true);
  assert.equal(r.ownerCanTrap, false, 'fixture has no way to disable trading again');
  assert.equal(await read(env, token, 'tradingEnabled'), false);
});

test('BlacklistOnBuy: no owner, buyer trapped by code => baseline fails, no unlock, ownerCanTrap false', async () => {
  const { token, pair } = await setup('BlacklistOnBuy');
  const r = await simulate(env.rpc, token.address, pair.address);
  assert.equal(r.evidence.baselineSellOk, false);
  assert.deepEqual(r.evidence.unlockedBy, []);
  assert.equal(r.ownerCanTrap, false);
});

test('simulate is deterministic on the same state', async () => {
  const { token, pair } = await setup('TimeBombToken');
  const a = await simulate(env.rpc, token.address, pair.address);
  const b = await simulate(env.rpc, token.address, pair.address);
  assert.deepEqual(a, b);
});

test('simulate refuses a non-anvil RPC (never writes to a real chain)', async () => {
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const { id } = JSON.parse(body);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result: 'Geth/v1.13.0' }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  try {
    await assert.rejects(
      simulate(url, '0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002'),
      /anvil/,
    );
  } finally {
    srv.close();
  }
});

/** JSON-RPC proxy in front of anvil that fails every evm_snapshot once an evm_revert has been seen. */
async function faultyProxy(upstream) {
  let armed = false;
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      const msg = JSON.parse(body);
      res.setHeader('content-type', 'application/json');
      if (msg.method === 'evm_snapshot' && armed) {
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'injected fault' } }));
        return;
      }
      if (msg.method === 'evm_revert') armed = true;
      const r = await fetch(upstream, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      res.end(await r.text());
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() };
}

test('an exception after the baseline => ownerCanTrap=true with simulate-error evidence; chain restored', async () => {
  const { token, pair } = await setup('TimeBombToken');
  const block = await env.pub.getBlockNumber({ cacheTime: 0 });
  const p = await faultyProxy(env.rpc);
  try {
    const r = await simulate(p.url, token.address, pair.address);
    assert.equal(r.evidence.baselineSellOk, true);
    assert.equal(r.ownerCanTrap, true);
    assert.match(r.evidence.error, /^simulate-error: /);
  } finally {
    p.close();
  }
  assert.equal(await env.pub.getBlockNumber({ cacheTime: 0 }), block);
});

test('balanceOf(holder) reverting does not throw out of simulate (pre-baseline: no trap claim)', async () => {
  const token = await deployScannerFixture(env, 'HolderRevertToken', [SUPPLY]);
  const pair = await listToken(env, infra, token);
  const r = await simulate(env.rpc, token.address, pair.address);
  assert.equal(r.ownerCanTrap, false);
  assert.equal(r.evidence.baselineSellOk, false);
  assert.equal(r.evidence.position, 'unreadable');
});

test('a failing final evm_revert does not replace the trap result', async () => {
  const { token, pair } = await setup('TimeBombToken');
  let initialId = null;
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      const m = JSON.parse(body);
      res.setHeader('content-type', 'application/json');
      if (m.method === 'evm_revert' && m.params[0] === initialId) {
        res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: 'injected revert fault' } }));
        return;
      }
      const r = await (await fetch(env.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).text();
      if (m.method === 'evm_snapshot' && initialId === null) initialId = JSON.parse(r).result;
      res.end(r);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const r = await simulate(`http://127.0.0.1:${srv.address().port}`, token.address, pair.address);
    assert.equal(r.ownerCanTrap, true);
    assert.match(r.evidence.restoreError, /evm_revert/);
  } finally {
    srv.close();
    await env.pub.request({ method: 'evm_revert', params: [initialId] }); // clean up the node ourselves
  }
});

