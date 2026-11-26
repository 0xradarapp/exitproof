#!/usr/bin/env node
// ExitProof Token Safety Census: what share of PotatoSwap V2 (X Layer) WOKB-paired tokens are honeypots or time
// bombs at one block, as measured by ExitProof itself.
//
//   node scanner/src/census.mjs                       full run (fresh anvil fork, N=600 recent + M=200 random older)
//   N=50 M=20 node scanner/src/census.mjs             smaller sample
//   node scanner/src/census-report.mjs                JSONL -> docs/CENSUS.md, docs/census.json, docs/census.svg
//
// SAFETY: nothing is ever sent to X Layer mainnet. Mainnet is only READ (pair list, reserves) through
// https://rpc.xlayer.tech, pinned to the snapshot block. Every write (tape-out, registry/router deploy) goes to a
// LOCAL anvil fork, signed by anvil's public test key #2 (#0, #1 and #5 carry EIP-7702 code on X Layer).
//
// Per token:
//   (a) dynamic: eth_call ExitProofRouter.inspect(factory, WOKB, amountIn, token, permissive) on the fork, amountIn =
//       min(0.001 OKB, 1% of the pair's WOKB reserve). The router buys, hands the position to a fresh holder, sells it
//       all back, measures both taxes, asks the taped-out circuit, and reverts with Report(facts, allow, reason, ...).
//   (b) static: scanner scan() (v4) against the fork RPC at the same block.
//   Verdicts for all three modes = circuit/truth.json (the circuit's exhaustive truth table, generated from
//   circuit/spec.py) over the facts the router would build once the scanner daemon has attested the token
//   (registry flags = scan result), plus the "unscanned" verdicts that a brand-new token gets before attestation.
//
// Resumable: results are appended to OUT (JSONL; first line = meta with block, seed and the frozen sample). A re-run
// reuses the meta (same block, same sample), restarts anvil pinned to that block, redeploys, and skips done tokens.
//
// Env: N (600), M (200), SEED (196), DUST_OKB (0.01), CONCURRENCY (3), OUT (docs/census-raw.jsonl),
//      UPSTREAM (https://rpc.xlayer.tech), PORT (8561), FORK_RPC (reuse a running anvil fork; the stack is deployed
//      on it unless ROUTER is also given), ROUTER, LIMIT (process at most LIMIT tokens this run; debugging).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient, http, defineChain, parseAbi, encodeFunctionData, decodeErrorResult, getAddress, keccak256,
  parseEther, formatEther, encodeAbiParameters, pad, toHex,
} from 'viem';
import { scan, SCANNER_VERSION } from './scan.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const K = JSON.parse(fs.readFileSync(path.join(ROOT, 'deployments', 'constants.json'), 'utf8'));
const FACTORY = getAddress(K.potatoFactory);
const WOKB = getAddress(K.wokb);
const BEM = getAddress(K.bem);
const MULTICALL3 = getAddress(K.multicall3);
const TRUTH = JSON.parse(fs.readFileSync(path.join(ROOT, 'circuit', 'truth.json'), 'utf8'));

// anvil default key #2: a PUBLIC test key, only ever used against the local fork
const ANVIL_KEY_2 = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
const ANVIL_ADDR_2 = getAddress('0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC');
const BEM_BALANCE_SLOT = 5n;
const PROBE_FROM = getAddress('0x00000000000000000000000000000000c3a5e000');
const CALL_GAS = 10_000_000n;
const MODES = { strict: 0, balanced: 1, permissive: 2 };

export const ROUTER_ABI = parseAbi([
  'function inspect(address factory, address tokenIn, uint256 amountIn, address token, uint8 mode) payable',
  'error Blocked(uint8 reason, uint16 facts)',
  'error Report(uint16 facts, bool allow, uint8 reason, uint256 buyOut, uint256 sellOut, uint256 delivered)',
  'error BadPair()', 'error Expired()', 'error TooLittle()', 'error BadEval()', 'error BadConfig()',
  'error BadMode()', 'error BadTo()', 'error BadAmount()', 'error NotSelf()', 'error LowGas()', 'error Locked()',
  'error TransferFailed()', 'error SwapFailed()',
]);
const V2_ABI = parseAbi([
  'function allPairsLength() view returns (uint256)',
  'function allPairs(uint256) view returns (address)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function getReserves() view returns (uint112, uint112, uint32)',
]);
const ERC20_ABI = parseAbi([
  'function symbol() view returns (string)', 'function decimals() view returns (uint8)',
]);

/** Packs facts per the frozen circuit interface and evaluates the circuit truth table. */
export function verdictOf(facts) {
  const v = TRUTH[facts & 0x7ff];
  return { allow: (v & 1) === 1, reason: (v >> 1) & 7 };
}

/**
 * Facts the router builds once the registry holds the scan result for this token address and its current codehash
 * (RiskRegistry v2 is keyed by token: flagsOf(token) -> (Flags, codehash)), from the facts it built for the unscanned
 * token. Mirrors ExitProofRouter._riskBits: scanned => upgradeable = registry flag (the on-chain
 * opcode scan is ignored), danger = dangerSetter | ownerCanTrap, ownerActive = privileged | owner() != 0, unscanned 0.
 * `raw` has fl.scanned = false, so its ownerActive bit is exactly owner() != 0.
 */
export function scannedFacts(raw, flags) {
  const ownerOnChain = (raw >> 5) & 1;
  const owner = ownerOnChain || flags.privileged ? 1 : 0;
  const upg = flags.upgradeable ? 1 : 0;
  const danger = flags.dangerSetter || flags.ownerCanTrap ? 1 : 0;
  return (raw & 0x1f) | (owner << 5) | (upg << 6) | (danger << 7);
}

export function verdictsFor(factsNoMode) {
  const out = {};
  for (const [m, bits] of Object.entries(MODES)) out[m] = verdictOf((factsNoMode & 0x1ff) | (bits << 9));
  return out;
}

/** mulberry32: small deterministic PRNG (seed recorded in the output). */
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seeded partial Fisher-Yates: k distinct items of arr. */
export function sample(arr, k, seed) {
  const a = arr.slice();
  const r = prng(seed);
  const n = Math.min(k, a.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(r() * (a.length - i));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

// ----------------------------------------------------------------------------------------------------- helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);
const J = (v) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x));

function chainFor(rpc) {
  return defineChain({
    id: 196, name: 'X Layer', nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 },
    rpcUrls: { default: { http: [rpc] } }, contracts: { multicall3: { address: MULTICALL3 } },
  });
}
const clientFor = (rpc, timeout = 120_000) =>
  createPublicClient({ chain: chainFor(rpc), transport: http(rpc, { timeout, retryCount: 0 }) });

/** Retries anything that is not a decodable result (public RPC answers HTTP 403 when rate-limited). */
async function retry(fn, label, tries = 8) {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      if (i + 1 >= tries) throw e;
      const ms = Math.min(30_000, 1000 * 2 ** i) + Math.floor(Math.random() * 500);
      log(`retry ${label} in ${ms}ms: ${(e.shortMessage || e.message || '').split('\n')[0].slice(0, 120)}`);
      await sleep(ms);
    }
  }
}

function revertData(e) {
  for (let x = e, i = 0; x && i < 12; x = x.cause, i++) {
    if (typeof x.data === 'string' && x.data.startsWith('0x')) return x.data;
    if (typeof x.data?.data === 'string') return x.data.data;
  }
  return null;
}
function errText(e) {
  const parts = [];
  for (let x = e, i = 0; x && i < 12; x = x.cause, i++) parts.push(x.details || x.shortMessage || x.message || '');
  return parts.join(' | ');
}

async function waitRpc(rpc, ms = 120_000) {
  const c = clientFor(rpc, 5000);
  const t0 = Date.now();
  for (;;) {
    try { return await c.getChainId(); } catch { if (Date.now() - t0 > ms) throw new Error('anvil did not start on ' + rpc); await sleep(500); }
  }
}

// Read-only JSON-RPC methods the proxy forwards to the public RPC. Anything else (eth_sendRawTransaction, ...) is
// refused, so neither anvil nor this script can ever write to X Layer mainnet through it.
const READ_METHODS = new Set(['eth_chainId', 'net_version', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getBlockByHash',
  'eth_getCode', 'eth_getStorageAt', 'eth_getBalance', 'eth_getTransactionCount', 'eth_call', 'eth_getProof',
  'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_gasPrice', 'eth_feeHistory', 'eth_maxPriorityFeePerGas',
  'web3_clientVersion', 'eth_getBlockReceipts']);

/**
 * Local proxy in front of the public RPC: method allowlist (reads only), bounded concurrency, and retry with backoff
 * on HTTP 403/429/5xx (rpc.xlayer.tech rate-limits with 403, which anvil itself does not retry).
 */
async function startReadProxy(upstream, { concurrency = 6 } = {}) {
  const http_ = await import('node:http');
  let active = 0;
  const queue = [];
  const acquire = () => new Promise((r) => { if (active < concurrency) { active++; r(); } else queue.push(r); });
  const release = () => { const n = queue.shift(); if (n) n(); else active--; };
  const stats = { requests: 0, retries: 0, refused: 0 };
  const server = http_.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', async () => {
      let msg;
      try { msg = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
      const calls = Array.isArray(msg) ? msg : [msg];
      const bad = calls.find((c) => !READ_METHODS.has(c.method));
      if (bad) {
        stats.refused++;
        // eth_getAccountInfo: anvil's optional batch read; refusing it makes anvil fall back to plain reads
        if (bad.method !== 'eth_getAccountInfo') log(`proxy REFUSED non-read method ${bad.method}`);
        res.writeHead(200, { 'content-type': 'application/json' });
        const err = (c) => ({ jsonrpc: '2.0', id: c.id, error: { code: -32601, message: 'census proxy: method not allowed (read-only)' } });
        res.end(JSON.stringify(Array.isArray(msg) ? calls.map(err) : err(msg)));
        return;
      }
      await acquire();
      try {
        for (let i = 0; ; i++) {
          stats.requests++;
          let status = 0, text = '';
          try {
            const r = await fetch(upstream, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(60_000) });
            status = r.status;
            text = await r.text();
          } catch { status = 0; }
          if (status === 200 && !/rate limit|too many requests/i.test(text.slice(0, 300))) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(text);
            return;
          }
          if (i >= 14) {
            res.writeHead(status || 502);
            res.end(text);
            return;
          }
          stats.retries++;
          await sleep(Math.min(20_000, 500 * 2 ** Math.min(i, 6)) + Math.floor(Math.random() * 400));
        }
      } finally { release(); }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, server, stats };
}

function startAnvil(upstream, block, port) {
  const args = ['--fork-url', upstream, '--fork-block-number', String(block), '--chain-id', '196', '--port', String(port),
    '--retries', '20', '--fork-retry-backoff', '2000', '--timeout', '60000', '--silent'];
  const bin = fs.existsSync(path.join(os.homedir(), '.foundry/bin/anvil')) ? path.join(os.homedir(), '.foundry/bin/anvil') : 'anvil';
  const p = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  p.stderr.on('data', (d) => process.stderr.write('[anvil] ' + d));
  return p;
}

function run(cmd, args, env, cwd) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(cmd + ' ' + args.join(' ') + ' exited ' + code + '\n' + out.slice(-3000)))));
  });
}

/**
 * Deploys the full stack (TapeOut processor + circuit, RiskRegistry, ExitProofRouter) on the LOCAL fork with the
 * repo's own scripts, run from a throwaway copy so the repo's deployments/ files are never touched.
 */
async function deployStack(forkRpc) {
  const fork = clientFor(forkRpc);
  // refuse anything that is not anvil (never let a write target mainnet)
  await fork.request({ method: 'anvil_nodeInfo' });
  const code = await fork.getCode({ address: ANVIL_ADDR_2 });
  if (code && code !== '0x') throw new Error('anvil account #2 has code on this fork');
  await fork.request({ method: 'anvil_setBalance', params: [ANVIL_ADDR_2, toHex(parseEther('10'))] });
  const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [ANVIL_ADDR_2, BEM_BALANCE_SLOT]));
  await fork.request({ method: 'anvil_setStorageAt', params: [BEM, slot, pad(toHex(10n ** 8n), { size: 32 })] }); // 1 BEM, copy only

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exitproof-census-'));
  for (const rel of ['scripts/lib/net.mjs', 'scripts/tapeout.mjs', 'scripts/deploy-fork.mjs', 'deployments/constants.json',
    'circuit/netlist.json', 'circuit/truth.json', 'out/RiskRegistry.sol/RiskRegistry.json',
    'out/ExitProofRouter.sol/ExitProofRouter.json']) {
    fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), path.join(tmp, rel));
  }
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(tmp, 'node_modules'));
  const env = { DEPLOYER_KEY: ANVIL_KEY_2, RPC_URL: forkRpc, SEND: '1', CONFIRM_MAINNET: '' };
  log('tapeout on fork (scripts/tapeout.mjs, copy in ' + tmp + ')');
  await run(process.execPath, [path.join(tmp, 'scripts/tapeout.mjs')], env, tmp);
  log('deploy registry + router on fork (scripts/deploy-fork.mjs)');
  await run(process.execPath, [path.join(tmp, 'scripts/deploy-fork.mjs')], env, tmp);
  const dep = JSON.parse(fs.readFileSync(path.join(tmp, 'deployments', 'fork.json'), 'utf8'));
  if (dep.network !== 'fork') throw new Error('stack deployment did not run on a fork');
  fs.rmSync(tmp, { recursive: true, force: true });
  return { processor: dep.processor, circuitId: dep.circuitId, registry: dep.registry, router: dep.router, verified: dep.verified };
}

/** All PotatoSwap pairs (index, pair, token0, token1) at `block`, read from the public RPC (multicall), cached. */
async function allPairs(pub, block) {
  const cache = path.join(os.tmpdir(), `exitproof-census-pairs-${FACTORY.toLowerCase()}-${block}.json`);
  if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, 'utf8'));
  const bn = BigInt(block);
  const n = Number(await retry(() => pub.readContract({ address: FACTORY, abi: V2_ABI, functionName: 'allPairsLength', blockNumber: bn }), 'allPairsLength'));
  log(`factory has ${n} pairs at block ${block}; reading pair list`);
  const pairs = [];
  const CH = 400;
  for (let s = 0; s < n; s += CH) {
    const idx = Array.from({ length: Math.min(CH, n - s) }, (_, i) => s + i);
    const addrs = await retry(() => pub.multicall({ contracts: idx.map((i) => ({ address: FACTORY, abi: V2_ABI, functionName: 'allPairs', args: [BigInt(i)] })), allowFailure: false, blockNumber: bn, batchSize: 0 }), 'allPairs ' + s);
    const toks = await retry(() => pub.multicall({ contracts: addrs.flatMap((a) => [{ address: a, abi: V2_ABI, functionName: 'token0' }, { address: a, abi: V2_ABI, functionName: 'token1' }]), blockNumber: bn, batchSize: 0 }), 'tokens ' + s);
    idx.forEach((i, k) => pairs.push({ index: i, pair: getAddress(addrs[k]), token0: toks[2 * k].result ?? null, token1: toks[2 * k + 1].result ?? null }));
    if ((s / CH) % 10 === 0) log(`  pairs ${s + idx.length}/${n}`);
  }
  fs.writeFileSync(cache, JSON.stringify(pairs));
  return pairs;
}

/** WOKB-side and token-side reserves of every pair in `pairs` at `block` (public RPC multicall), cached. */
async function allReserves(pub, block, pairs) {
  const cache = path.join(os.tmpdir(), `exitproof-census-reserves-${FACTORY.toLowerCase()}-${block}.json`);
  if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, 'utf8'));
  const bn = BigInt(block);
  const out = [];
  const CH = 500;
  for (let s = 0; s < pairs.length; s += CH) {
    const part = pairs.slice(s, s + CH);
    const r = await retry(() => pub.multicall({ contracts: part.map((p) => ({ address: p.pair, abi: V2_ABI, functionName: 'getReserves' })), blockNumber: bn, batchSize: 0 }), 'reserves ' + s);
    r.forEach((x, k) => {
      const p = part[k];
      out.push(x.status === 'success'
        ? { w: (p.wokbIs0 ? x.result[0] : x.result[1]).toString(), t: (p.wokbIs0 ? x.result[1] : x.result[0]).toString() }
        : null);
    });
    if ((s / CH) % 10 === 0) log(`  reserves ${s + part.length}/${pairs.length}`);
  }
  fs.writeFileSync(cache, JSON.stringify(out));
  return out;
}

/**
 * Sample over LIVE pools: the reserves of every WOKB pair are read first; pairs whose WOKB reserve is under the dust
 * threshold (never funded, drained or rugged) are skipped and counted over the whole population. From the live pairs:
 * the N most recent + M drawn uniformly (seeded) from the older live ones.
 */
async function buildSample(pub, block, { N, M, SEED, DUST }) {
  const pairs = await allPairs(pub, block);
  const wokbPairs = pairs.filter((p) => p.token0 && p.token1 && (getAddress(p.token0) === WOKB) !== (getAddress(p.token1) === WOKB))
    .map((p) => ({ index: p.index, pair: p.pair, token: getAddress(getAddress(p.token0) === WOKB ? p.token1 : p.token0), wokbIs0: getAddress(p.token0) === WOKB }));
  log(`reading reserves of all ${wokbPairs.length} WOKB pairs`);
  const res = await allReserves(pub, block, wokbPairs);
  const dust = parseEther(String(DUST));
  const skipped = { dust: 0, empty: 0, noReserves: 0, dustInLastN: 0 };
  const live = [];
  wokbPairs.forEach((p, i) => {
    const r = res[i];
    const recentWindow = i >= wokbPairs.length - N;
    if (!r) { skipped.noReserves++; return; }
    if (BigInt(r.w) < dust) {
      skipped.dust++;
      if (BigInt(r.w) === 0n) skipped.empty++;
      if (recentWindow) skipped.dustInLastN++;
      return;
    }
    live.push({ ...p, wokbReserve: r.w, tokenReserve: r.t });
  });
  const recent = live.slice(-N).map((p) => ({ ...p, group: 'recent' }));
  const older = sample(live.slice(0, Math.max(0, live.length - N)), M, SEED).map((p) => ({ ...p, group: 'older' }))
    .sort((a, b) => a.index - b.index);
  const seen = new Set();
  const tokens = [...recent, ...older].filter((p) => (seen.has(p.token) ? false : seen.add(p.token)));
  const liveWokb = live.reduce((a, p) => a + BigInt(p.wokbReserve), 0n);
  return {
    totalPairs: pairs.length, wokbPairs: wokbPairs.length, nonWokbPairs: pairs.length - wokbPairs.length,
    livePairs: live.length, liveWokbReserve: liveWokb.toString(), lastNWindow: Math.min(N, wokbPairs.length),
    recentRange: recent.length ? [recent[0].index, recent[recent.length - 1].index] : null,
    olderPool: Math.max(0, live.length - N), pickedRecent: recent.length, pickedOlder: older.length,
    skipped, tokens,
  };
}

// ------------------------------------------------------------------------------------------------- per token

async function inspectToken(fork, router, t) {
  const reserve = BigInt(t.wokbReserve);
  const cap = parseEther('0.001');
  const amountIn = reserve / 100n < cap ? reserve / 100n : cap;
  const data = encodeFunctionData({ abi: ROUTER_ABI, functionName: 'inspect', args: [FACTORY, WOKB, amountIn, t.token, MODES.permissive] });
  for (let attempt = 0; attempt < 6; attempt++) {
    let e;
    try {
      await fork.call({ account: PROBE_FROM, to: router, data, value: amountIn, gas: CALL_GAS,
        stateOverride: [{ address: PROBE_FROM, balance: amountIn + parseEther('1') }] });
      return { amountIn: amountIn.toString(), kind: 'noRevert' };
    } catch (err) { e = err; }
    const rd = revertData(e);
    if (rd && rd !== '0x') {
      try {
        const d = decodeErrorResult({ abi: ROUTER_ABI, data: rd });
        if (d.errorName === 'Report') {
          const [facts, allow, reason, buyOut, sellOut, delivered] = d.args;
          return { amountIn: amountIn.toString(), kind: 'report', facts: Number(facts), allow, reason: Number(reason), buyOut: buyOut.toString(), sellOut: sellOut.toString(), delivered: delivered.toString() };
        }
        return { amountIn: amountIn.toString(), kind: 'revert', error: d.errorName };
      } catch {
        return { amountIn: amountIn.toString(), kind: 'revert', error: 'unrecognized ' + rd.slice(0, 10) };
      }
    }
    const txt = errText(e);
    if (/execution reverted|revert/i.test(txt) && !/fork|fetch|error sending|timeout|429|403|connect/i.test(txt)) {
      return { amountIn: amountIn.toString(), kind: 'revert', error: 'EmptyRevert' };
    }
    log(`inspect ${t.token} transient (attempt ${attempt + 1}): ${txt.split('\n')[0].slice(0, 160)}`);
    await sleep(2000 * (attempt + 1));
  }
  return { amountIn: amountIn.toString(), kind: 'error', error: 'rpc' };
}

function compactScan(s) {
  const e = s.evidence;
  return {
    codehash: s.codehash, privileged: s.privileged, upgradeable: s.upgradeable, dangerSetter: s.dangerSetter,
    ownerCanTrap: s.ownerCanTrap, scannerVersion: s.scannerVersion, reasons: e.reasons, owner: e.owner,
    dangerous: e.dangerous.map((d) => d.signature ?? d.selector), unknownSelectors: e.unknownSelectors.length,
    selectors: e.selectors.length, clone: e.clone ? e.clone.implementation : null,
    implementation: e.implementation ? e.implementation.address : null,
  };
}

async function processToken(fork, router, block, t) {
  const t0 = Date.now();
  const [ins, sc, meta] = await Promise.all([
    inspectToken(fork, router, t),
    retry(() => scan(fork, t.token, { blockNumber: block }), 'scan ' + t.token, 4).then(compactScan).catch((e) => ({ error: (e.shortMessage || e.message || '').split('\n')[0].slice(0, 200) })),
    Promise.all([
      fork.readContract({ address: t.token, abi: ERC20_ABI, functionName: 'symbol' }).catch(() => null),
      fork.readContract({ address: t.token, abi: ERC20_ABI, functionName: 'decimals' }).catch(() => null),
    ]),
  ]);
  const row = {
    type: 'token', token: t.token, pair: t.pair, index: t.index, group: t.group, wokbReserve: t.wokbReserve,
    tokenReserve: t.tokenReserve, symbol: typeof meta[0] === 'string' ? meta[0].slice(0, 32) : null,
    decimals: meta[1] == null ? null : Number(meta[1]), inspect: ins, scan: sc, ms: Date.now() - t0,
  };
  if (ins.kind === 'report') {
    const raw = ins.facts & 0x1ff;
    // sanity: the on-chain circuit answer must equal the truth table for the same input
    const chk = verdictOf(ins.facts);
    row.circuitMatches = chk.allow === ins.allow && chk.reason === ins.reason;
    row.unscannedVerdicts = verdictsFor(raw);
    if (!sc.error) {
      row.scannedFacts = scannedFacts(raw, sc);
      row.verdicts = verdictsFor(row.scannedFacts);
    }
  }
  return row;
}


// ------------------------------------------------------------------------------------- EOA cross-check (phase 2)

const TOKEN_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)', 'function balanceOf(address) view returns (uint256)',
]);
// PotatoSwap V2 router on X Layer (same address as test/fork/FlapFork.t.sol); the path real users take.
export const POTATO_ROUTER = getAddress('0x881fB2f98c13d521009464e7D1CBf16E1b394e8E');
const POTATO_ROUTER_ABI = parseAbi([
  'function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable',
  'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)',
]);
export const EOA_METHOD = 'potato-router';

/**
 * Cross-check on the fork, independent of ExitProof: a fresh impersonated EOA buys through PotatoSwap's own V2 router
 * (swapExactETHForTokensSupportingFeeOnTransferTokens), waits one block, approves the router and sells its WHOLE
 * balance with swapExactTokensForETHSupportingFeeOnTransferTokens: exactly what a wallet user does in the PotatoSwap
 * UI (router transferFrom, reserves read after the transfer, amountIn = balanceOf(pair) - reserve). Real auto-mined
 * fork transactions inside evm_snapshot / evm_revert, amountOutMin 0 (no slippage guard: we test sellability).
 * SERIAL ONLY.
 */
export async function eoaCheck(fork, t, amountIn) {
  const eoa = getAddress('0x' + keccak256(t.token).slice(-40));
  const snap = await fork.request({ method: 'evm_snapshot', params: [] });
  const res = { method: EOA_METHOD, buyOk: false, sellOk: false };
  const send = async (to, data, value = 0n) => {
    const hash = await fork.request({ method: 'eth_sendTransaction', params: [{ from: eoa, to, data, value: toHex(value), gas: toHex(5_000_000n) }] });
    // anvil automines: poll the receipt directly
    for (let i = 0; i < 600; i++) {
      const r = await fork.request({ method: 'eth_getTransactionReceipt', params: [hash] });
      if (r) return { ok: r.status === '0x1', fee: BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice ?? '0x0') };
      await sleep(100);
    }
    throw new Error('no receipt for ' + hash);
  };
  try {
    await fork.request({ method: 'anvil_impersonateAccount', params: [eoa] });
    await fork.request({ method: 'anvil_setBalance', params: [eoa, toHex(parseEther('1'))] });
    const deadline = (await fork.getBlock()).timestamp + 3600n;
    const buy = await send(POTATO_ROUTER, encodeFunctionData({ abi: POTATO_ROUTER_ABI,
      functionName: 'swapExactETHForTokensSupportingFeeOnTransferTokens', args: [0n, [WOKB, t.token], eoa, deadline] }), amountIn);
    const bal = await fork.readContract({ address: t.token, abi: TOKEN_ABI, functionName: 'balanceOf', args: [eoa] });
    res.buyOk = buy.ok && bal > 0n;
    res.received = bal.toString();
    if (!res.buyOk) return res;
    await fork.request({ method: 'evm_mine', params: [] }); // next block, like a later sell
    const ap = await send(t.token, encodeFunctionData({ abi: TOKEN_ABI, functionName: 'approve', args: [POTATO_ROUTER, bal] }));
    if (!ap.ok) { res.sellStep = 'approve'; return res; }
    const before = await fork.getBalance({ address: eoa });
    const sell = await send(POTATO_ROUTER, encodeFunctionData({ abi: POTATO_ROUTER_ABI,
      functionName: 'swapExactTokensForETHSupportingFeeOnTransferTokens', args: [bal, 0n, [t.token, WOKB], eoa, deadline] }));
    const after = await fork.getBalance({ address: eoa });
    const out = after + sell.fee - before;
    res.sellOk = sell.ok && out > 0n;
    if (!sell.ok) res.sellStep = 'router-sell';
    res.sellOut = out.toString();
    return res;
  } catch (e) {
    res.error = (e.shortMessage || e.message || '').split('\n')[0].slice(0, 160);
    return res;
  } finally {
    await fork.request({ method: 'anvil_stopImpersonatingAccount', params: [eoa] }).catch(() => {});
    await fork.request({ method: 'evm_revert', params: [snap] });
  }
}

/** Rows that need the EOA cross-check (or a re-check with the current method): cannot buy and cannot sell. */
export const needsEoaCheck = (r) => r.type === 'token' && r.eoa?.method !== EOA_METHOD && (
  (r.inspect?.kind === 'revert' && r.inspect.error !== 'TooLittle') || (r.inspect?.kind === 'report' && (r.inspect.facts & 1) === 0));

/** Which router build the census ran: git HEAD of the repo and keccak of the compiled router bytecode. */
function routerArtifactInfo() {
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'out', 'ExitProofRouter.sol', 'ExitProofRouter.json'), 'utf8'));
  let commit = null;
  try {
    const head = fs.readFileSync(path.join(ROOT, '.git', 'HEAD'), 'utf8').trim();
    commit = head.startsWith('ref: ') ? fs.readFileSync(path.join(ROOT, '.git', head.slice(5)), 'utf8').trim() : head;
  } catch { /* packed ref or no git */ }
  return { commit, bytecodeKeccak: keccak256(j.bytecode.object), reportFields: j.abi.find((x) => x.name === 'Report')?.inputs.length };
}

// ------------------------------------------------------------------------------------------------------ main

async function main() {
  const N = Number(process.env.N ?? 600);
  const M = Number(process.env.M ?? 200);
  const SEED = Number(process.env.SEED ?? 196);
  const DUST = Number(process.env.DUST_OKB ?? 0.01);
  const CONC = Number(process.env.CONCURRENCY ?? 3);
  const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : Infinity;
  const OUT = path.resolve(ROOT, process.env.OUT ?? 'docs/census-raw.jsonl');
  const UPSTREAM = process.env.UPSTREAM ?? 'https://rpc.xlayer.tech';
  const PORT = Number(process.env.PORT ?? 8561);
  const started = Date.now();

  let meta = null;
  const done = new Set();
  if (fs.existsSync(OUT)) {
    for (const line of fs.readFileSync(OUT, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const r = JSON.parse(line);
      if (r.type === 'meta') meta = r;
      else if (r.type === 'token' && r.inspect?.kind !== 'error' && !r.scan?.error) done.add(r.token);
    }
  }
  const proxy = await startReadProxy(UPSTREAM, { concurrency: Number(process.env.UPSTREAM_CONCURRENCY ?? 6) });
  log(`read-only proxy for ${UPSTREAM} on ${proxy.url}`);
  const pub = clientFor(proxy.url, 600_000);
  let block;
  if (meta) {
    block = BigInt(meta.block);
    log(`resuming ${OUT}: block ${block}, ${done.size}/${meta.sample.tokens.length} done`);
  } else {
    block = (await retry(() => pub.getBlockNumber(), 'blockNumber')) - 3n;
  }

  let anvil = null;
  let forkRpc = process.env.FORK_RPC;
  const kill = () => { if (anvil && anvil.exitCode === null) anvil.kill('SIGTERM'); };
  const onAnvilExit = (code) => { log('anvil exited with ' + code); };
  process.on('exit', kill);
  process.on('SIGINT', () => { kill(); process.exit(130); });
  process.on('SIGTERM', () => { kill(); process.exit(143); });
  if (!forkRpc) {
    forkRpc = `http://127.0.0.1:${PORT}`;
    try { await clientFor(forkRpc, 2000).getChainId(); throw new Error(`port ${PORT} is busy; set PORT or FORK_RPC`); } catch (e) { if (/busy/.test(e.message)) throw e; }
    log(`starting anvil fork of ${UPSTREAM} at block ${block} on ${forkRpc}`);
    anvil = startAnvil(proxy.url, block, PORT);
    anvil.on('exit', onAnvilExit);
    await waitRpc(forkRpc);
  }
  const fork = clientFor(forkRpc);
  await fork.request({ method: 'anvil_nodeInfo' }); // must be anvil
  if (await fork.getChainId() !== 196) throw new Error('fork is not chain 196');

  let stack;
  if (process.env.ROUTER) stack = { router: getAddress(process.env.ROUTER) };
  else stack = await deployStack(forkRpc);
  log('stack', J(stack));
  const forkHead = await fork.getBlockNumber();

  if (!meta) {
    const snap = await retry(() => pub.getBlock({ blockNumber: block }), 'block');
    log(`sampling N=${N} recent + M=${M} older WOKB pairs (seed ${SEED})`);
    const s = await buildSample(pub, block, { N, M, SEED, DUST });
    meta = {
      type: 'meta', version: 1, block: block.toString(), blockTimestamp: Number(snap.timestamp),
      blockTime: new Date(Number(snap.timestamp) * 1000).toISOString(), chainId: 196, upstream: UPSTREAM,
      factory: FACTORY, wokb: WOKB, N, M, seed: SEED, prng: 'mulberry32 partial Fisher-Yates', dustOkb: DUST,
      amountInRule: 'min(0.001 OKB, 1% of WOKB reserve)', inspectMode: 'permissive', scannerVersion: SCANNER_VERSION,
      startedAt: new Date().toISOString(), routerArtifact: routerArtifactInfo(), sample: s,
    };
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, J(meta) + '\n');
    log(`sample: ${s.tokens.length} tokens (${s.skipped.dust} dust-skipped) of ${s.wokbPairs} WOKB pairs / ${s.totalPairs} pairs`);
  }

  // the stack exists only on the fork; record it per run (addresses can differ between runs)
  fs.appendFileSync(OUT, J({ type: 'run', at: new Date().toISOString(), forkHead: forkHead.toString(), stack }) + '\n');

  const todo = meta.sample.tokens.filter((t) => !done.has(t.token)).slice(0, LIMIT);
  log(`${todo.length} tokens to process, concurrency ${CONC}`);
  let next = 0, n = 0;
  const stats = { report: 0, revert: 0, error: 0 };
  async function worker() {
    while (next < todo.length) {
      const t = todo[next++];
      let row;
      try { row = await processToken(fork, stack.router, forkHead, t); } catch (e) {
        row = { type: 'token', token: t.token, pair: t.pair, index: t.index, group: t.group, wokbReserve: t.wokbReserve, inspect: { kind: 'error', error: (e.message || '').slice(0, 200) }, scan: { error: 'skipped' } };
      }
      fs.appendFileSync(OUT, J(row) + '\n');
      stats[row.inspect.kind] = (stats[row.inspect.kind] ?? 0) + 1;
      n++;
      if (n % 10 === 0 || n === todo.length) {
        const el = (Date.now() - started) / 1000;
        log(`${n}/${todo.length} · ${J(stats)} · ${(el / n).toFixed(1)}s/token · elapsed ${(el / 60).toFixed(1)}min`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));

  const readLatest = () => {
    const m = new Map();
    for (const line of fs.readFileSync(OUT, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const r = JSON.parse(line);
      if (r.type === 'token') m.set(r.token, r);
    }
    return m;
  };

  // phase 1b (RESCAN=1): re-run the static scan with the current scanner on rows scanned by an older version, and
  // recompute the attested facts + verdicts from the SAME dynamic Report (the router facts do not change)
  if (process.env.RESCAN === '1') {
    const stale = [...readLatest().values()].filter((r) => r.scan && r.scan.scannerVersion !== SCANNER_VERSION
      && (r.inspect?.kind === 'report' || r.inspect?.kind === 'revert'));
    log(`re-scan ${stale.length} rows with scanner v${SCANNER_VERSION}`);
    let k = 0, i = 0;
    const rescanWorker = async () => {
      while (i < stale.length) {
        const r = stale[i++];
        try {
          const sc = compactScan(await retry(() => scan(fork, r.token, { blockNumber: forkHead }), 'rescan ' + r.token, 4));
          const row = { ...r, scan: sc, rescannedFrom: r.scan.scannerVersion };
          if (r.inspect.kind === 'report') {
            row.scannedFacts = scannedFacts(r.inspect.facts & 0x1ff, sc);
            row.verdicts = verdictsFor(row.scannedFacts);
          }
          fs.appendFileSync(OUT, J(row) + '\n');
        } catch (e) { log(`rescan ${r.token} failed: ${(e.message || '').slice(0, 120)}`); }
        if (++k % 100 === 0) log(`  rescanned ${k}/${stale.length}`);
      }
    };
    await Promise.all(Array.from({ length: CONC }, rescanWorker));
  }

  // phase 2 (serial): EOA cross-check for cannot-buy / cannot-sell rows
  const latest = readLatest();
  const diag = [...latest.values()].filter(needsEoaCheck);
  log(`EOA cross-check for ${diag.length} cannot-buy / cannot-sell tokens`);
  for (const r of diag) {
    r.eoa = await eoaCheck(fork, r, BigInt(r.inspect.amountIn));
    fs.appendFileSync(OUT, J(r) + '\n');
  }
  fs.appendFileSync(OUT, J({ type: 'done', at: new Date().toISOString(), seconds: Math.round((Date.now() - started) / 1000), processed: n, stats, proxy: proxy.stats }) + '\n');
  log(`done in ${((Date.now() - started) / 60000).toFixed(1)} min`);
  kill();
  proxy.server.close();
  log('proxy', J(proxy.stats));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error('CENSUS STOPPED: ' + (e.stack || e.message)); process.exit(1); });
}
