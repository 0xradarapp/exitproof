// node --test cli/test/loopback.test.mjs
// The CLI lets `buy` sign for a non-buyEnabled network (the fork) only through a loopback RPC; the web app uses the
// same helper to explain why buying is off. A look-alike host must never count as loopback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLoopbackHost, isLoopbackUrl } from '../../web/verdict.js';

const cases = [
  ['127.0.0.1', true], ['127.1.2.3', true], ['localhost', true], ['[::1]', true], ['LOCALHOST', true],
  ['127.0.0.1.evil.com', false], ['127.evil.com', false], ['localhost.attacker.net', false],
  ['evil-localhost', false], ['0.0.0.0', false], ['rpc.xlayer.tech', false], ['::1', false], ['', false],
];

test('isLoopbackHost: exact hostnames only', () => {
  for (const [h, want] of cases) assert.equal(isLoopbackHost(h), want, h);
});

test('isLoopbackUrl: parses the URL hostname', () => {
  assert.equal(isLoopbackUrl('http://127.0.0.1:8549'), true);
  assert.equal(isLoopbackUrl('http://localhost:8549/'), true);
  assert.equal(isLoopbackUrl('http://[::1]:8549'), true);
  assert.equal(isLoopbackUrl('http://127.0.0.1.evil.com:8549'), false);
  assert.equal(isLoopbackUrl('http://127.evil.com'), false);
  assert.equal(isLoopbackUrl('http://localhost.attacker.net'), false);
  assert.equal(isLoopbackUrl('http://user@evil.com#@127.0.0.1'), false);
  assert.equal(isLoopbackUrl('https://rpc.xlayer.tech'), false);
  assert.equal(isLoopbackUrl('not a url'), false);
});
