// `backfill`: scan and attest the EXISTING PotatoSwap pairs (the daemon only follows new PairCreated logs, so every
// token listed before it started stays `unscanned`, which balanced mode blocks whenever the owner looks active).
//
//   node scanner/src/cli.mjs backfill        dry-run (default): scans, writes reports, prints the plan + OKB cost
//   SEND=1 CONFIRM_MAINNET=yes REGISTRY=0x.. ATTESTER_KEY_FILE=.. FORK_RPC=.. node scanner/src/cli.mjs backfill
//
// - Pairs are enumerated from factory.allPairs newest first (multicall at one pinned block). A pair qualifies when
//   exactly one side is WOKB or USD₮0 and that reserve is at least DUST_OKB (0.01) / DUST_USDT (1) units.
// - Resumable: STATE_FILE (default state/backfill-<dry|send>.json) pins the block and records every finished token;
//   a re-run skips them (RESET=1 starts over; BLOCK=<n> pins another block).
// - Rate-limit aware: requests go through a viem fallback transport over RPC_URLS (default rpc.xlayer.tech, then
//   xlayerrpc.okx.com; the first one answers HTTP 403 when rate-limited), every token is retried with exponential
//   backoff, and RATE_MS (250) spaces tokens.
// - SEND=1 attests through the same per-token decision as the daemon (no downgrade of a same-codehash entry), behind
//   the mainnet gate (CONFIRM_MAINNET=yes). It requires FORK_RPC (an anvil fork, pinned to the block with
//   FORK_UPSTREAM) unless STATIC_ONLY=1 (ALLOW_STATIC_ONLY=1 is still accepted): a static-only "clean" attestation would turn strict mode's
//   `unscanned` block into an allow without the sell simulation.
// - SHARD=i/N runs one of N parallel shards (pairs with index mod N == i; own state file), SWEEP_BUDGET_S (180)
//   bounds each token's simulation (an exhausted budget with an owner / caller check fails closed).
// Env: SHARD, SWEEP_BUDGET_S, STATE_DIR, RPC_URLS, REGISTRY, FACTORY, BASE_WOKB / BASE_USDT0 (local tests only), BLOCK, LIMIT, DUST_OKB, DUST_USDT, STATE_FILE, REPORTS_DIR, RATE_MS, FORK_RPC,
//      FORK_UPSTREAM, STATIC_ONLY, ESTIMATE_PAIRS (950), COUNT_ALL (count every live pair for the estimate).
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import {
  createPublicClient, createWalletClient, fallback, http, defineChain, getAddress, parseAbi, parseEther, parseUnits,
  formatEther, formatGwei,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { POTATOSWAP_FACTORY, BASE_TOKENS, processToken } from './daemon.mjs';
import { sweepBudgetMs } from './simulate.mjs';

export { sweepBudgetMs };
import { sendGate, attesterKey } from './send-gate.mjs';

export const XLAYER_RPCS = Object.freeze(['https://rpc.xlayer.tech', 'https://xlayerrpc.okx.com']);
export const WOKB = getAddress(BASE_TOKENS[0]);
export const USDT0 = getAddress(BASE_TOKENS[1]);
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
/** Gas of a first RiskRegistry.attest for a token (two new slots + event), measured on anvil: 79,041. */
export const ATTEST_GAS = 80_000n;
const CHUNK = 200;

const FACTORY_ABI = parseAbi([
  'function allPairsLength() view returns (uint256)',
  'function allPairs(uint256) view returns (address)',
]);
const PAIR_ABI = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function getReserves() view returns (uint112,uint112,uint32)',
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const msg = (e) => (e.shortMessage ?? e.message ?? String(e)).split('\n')[0];

/** Exponential backoff for rate limits (HTTP 403/429) and flaky public RPCs. */
export async function withRetry(fn, { tries = 5, baseMs = 1000, label = '', log = () => {}, retryIf = () => true } = {}) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i + 1 >= tries || !retryIf(e)) throw e;
      const ms = Math.min(30_000, baseMs * 2 ** i);
      log(`retry ${label} in ${ms} ms: ${msg(e).slice(0, 120)}`);
      await sleep(ms);
    }
  }
}

function chainFor(id, urls) {
  return defineChain({
    id, name: `chain-${id}`, nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 },
    rpcUrls: { default: { http: urls } }, contracts: { multicall3: { address: MULTICALL3 } },
  });
}

/** Read client over several RPCs (in order; the next one is used when one fails, e.g. HTTP 403). */
export function makeTransport(urls) {
  return fallback(urls.map((u) => http(u, { timeout: 30_000, retryCount: 1, retryDelay: 500 })), { rank: false, retryCount: 2 });
}

/**
 * Qualifying pairs, newest first: [{ index, pair, token, base, baseReserve, tokenReserve }]. Stops after `limit`
 * candidates (0 = all). `stats` gets the number of pairs looked at.
 */
export async function listPairs(client, {
  block, factory = POTATOSWAP_FACTORY, limit = 0, dustOkb, dustUsdt, stats = {}, log = () => {}, wokb = WOKB, usdt0 = USDT0,
  shard = null,
}) {
  const n = await pairCount(client, factory, block, log);
  stats.allPairs = n;
  stats.looked = 0;
  const out = [];
  for (let hi = n - 1; hi >= 0; hi -= CHUNK) {
    const idx = Array.from({ length: Math.min(CHUNK, hi + 1) }, (_, k) => hi - k);
    const pairs = (await withRetry(async () => {
      const r = await multi(client, idx.map((i) => ({ address: factory, abi: FACTORY_ABI, functionName: 'allPairs', args: [BigInt(i)] })), block);
      if (r.some((x) => x.status !== 'success')) throw new Error('allPairs read failed');
      return r;
    }, { label: `allPairs ${hi}`, log })).map((x) => x.result);
    const info = await withRetry(() => multi(client,
      pairs.flatMap((p) => ['token0', 'token1', 'getReserves'].map((functionName) => ({ address: p, abi: PAIR_ABI, functionName }))),
      block), { label: `pairInfo ${hi}`, log });
    for (let k = 0; k < pairs.length; k++) {
      stats.looked++;
      const [a, b, r] = info.slice(3 * k, 3 * k + 3);
      if (a.status !== 'success' || b.status !== 'success' || r.status !== 'success') continue;
      const t0 = getAddress(a.result);
      const t1 = getAddress(b.result);
      const baseIs0 = t0 === wokb || t0 === usdt0;
      const baseIs1 = t1 === wokb || t1 === usdt0;
      if (baseIs0 === baseIs1) continue; // no base, or base/base
      const base = baseIs0 ? t0 : t1;
      const baseReserve = baseIs0 ? r.result[0] : r.result[1];
      const tokenReserve = baseIs0 ? r.result[1] : r.result[0];
      if (baseReserve < (base === wokb ? dustOkb : dustUsdt) || tokenReserve === 0n) continue;
      if (shard && idx[k] % shard.n !== shard.i) continue; // SHARD=i/N: pair index mod N
      out.push({ index: idx[k], pair: getAddress(pairs[k]), token: baseIs0 ? t1 : t0, base, baseReserve, tokenReserve });
      if (limit && out.length >= limit) return out;
    }
  }
  return out;
}

const isRevert = (e) => /revert/i.test(`${e?.shortMessage ?? ''} ${e?.message ?? ''}`);

/** allPairsLength(), or (factories without it) the first index where allPairs(i) reverts, by doubling + bisection. */
async function pairCount(client, factory, block, log) {
  const read = (functionName, args = []) => client.readContract({ address: factory, abi: FACTORY_ABI, functionName, args, blockNumber: block });
  try {
    return Number(await withRetry(() => read('allPairsLength').catch((e) => { if (isRevert(e)) e.noRetry = true; throw e; }),
      { label: 'allPairsLength', log, retryIf: (e) => !e.noRetry }));
  } catch (e) {
    if (!e.noRetry) throw e;
  }
  const exists = (i) => withRetry(() => read('allPairs', [BigInt(i)]).then(() => true, (e) => { if (isRevert(e)) return false; throw e; }), { label: `allPairs(${i})`, log });
  let hi = 1;
  while (await exists(hi - 1)) hi *= 2; // now !exists(hi - 1), and exists(hi / 2 - 1) unless hi === 1
  if (hi === 1) return 0;
  let a = hi / 2;
  let b = hi - 1; // the first missing index is in [a, b]
  while (a < b) {
    const m = Math.floor((a + b) / 2);
    if (await exists(m)) a = m + 1; else b = m;
  }
  return a;
}

/** multicall3 when the chain has it (X Layer does), else plain eth_calls (local anvil). Always allowFailure. */
const HAS_MC = new WeakMap();
async function multi(client, contracts, block) {
  if (!HAS_MC.has(client)) HAS_MC.set(client, !!(await client.getCode({ address: MULTICALL3 }).catch(() => null))?.slice(2));
  if (HAS_MC.get(client)) return client.multicall({ contracts, blockNumber: block, batchSize: 0 });
  return Promise.all(contracts.map((c) => client.readContract({ ...c, blockNumber: block })
    .then((result) => ({ status: 'success', result }), (error) => ({ status: 'failure', error }))));
}

export function costEstimate(nPairs, gasPrice, gasPerAttest = ATTEST_GAS) {
  const wei = BigInt(nPairs) * gasPerAttest * gasPrice;
  return { pairs: nPairs, gasPerAttest: gasPerAttest.toString(), gasPriceGwei: formatGwei(gasPrice), okb: formatEther(wei) };
}

function loadState(file) {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}
function saveState(file, s) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, `${JSON.stringify(s, null, 1)}\n`);
  renameSync(`${file}.tmp`, file);
}

/** Runs the backfill (see header). Returns the summary object (also printed as JSON). */
export async function runBackfill({ env = process.env, baseDir, log = console.error, print = console.log }) {
  const send = env.SEND === '1';
  const urls = (env.RPC_URLS ? env.RPC_URLS.split(',') : env.RPC_URL ? [env.RPC_URL, ...XLAYER_RPCS] : [...XLAYER_RPCS])
    .map((u) => u.trim()).filter((u, i, a) => u && a.indexOf(u) === i);
  const transport = makeTransport(urls);
  const probe = createPublicClient({ transport });
  const chainId = await withRetry(() => probe.getChainId(), { label: 'chainId', log });
  const client = createPublicClient({ chain: chainFor(chainId, urls), transport });
  const registry = env.REGISTRY ? getAddress(env.REGISTRY) : undefined;
  const factory = getAddress(env.FACTORY ?? POTATOSWAP_FACTORY);
  const forkRpc = env.FORK_RPC || undefined;
  const mode = send ? 'send' : 'dry';
  const shard = parseShard(env.SHARD);
  const stateFile = env.STATE_FILE
    || path.join(env.STATE_DIR || path.join(baseDir, 'state'), `backfill-${mode}${shard ? `-shard${shard.i}of${shard.n}` : ''}.json`);
  const simOpts = { budgetMs: sweepBudgetMs(env) };
  const reportsDir = env.REPORTS_DIR ?? path.join(baseDir, 'reports');
  const rateMs = Number(env.RATE_MS ?? 250);
  const limit = Number(env.LIMIT ?? 0);

  let walletClient;
  if (send) {
    if (!registry) throw new Error('SEND=1 requires REGISTRY');
    if (!forkRpc && env.STATIC_ONLY !== '1' && env.ALLOW_STATIC_ONLY !== '1') {
      throw new Error('SEND=1 requires FORK_RPC (sell simulation); STATIC_ONLY=1 to attest static scans only');
    }
    const key = attesterKey(env);
    if (!key) throw new Error('SEND=1 requires ATTESTER_KEY or ATTESTER_KEY_FILE');
    await sendGate(urls[0], env, { what: 'backfill attestations', log });
    walletClient = createWalletClient({ chain: chainFor(chainId, urls), transport, account: privateKeyToAccount(key) });
  }

  let state = env.RESET === '1' ? null : loadState(stateFile);
  if (state && env.BLOCK && BigInt(env.BLOCK) !== BigInt(state.block)) state = null;
  if (state && state.factory !== factory) state = null;
  const block = state ? BigInt(state.block)
    : env.BLOCK ? BigInt(env.BLOCK) : await withRetry(() => client.getBlockNumber({ cacheTime: 0 }), { label: 'head', log });
  state ??= { block: block.toString(), factory, chainId, startedAt: new Date().toISOString(), done: {} };
  log(`backfill ${mode} at block ${block} via ${urls.map((u) => new URL(u).host).join(' -> ')}` +
    `${resumeNote(state)}${forkRpc ? ' (with fork simulation)' : ' (static scan only)'}`);

  if (forkRpc && env.FORK_UPSTREAM) {
    await createPublicClient({ transport: http(forkRpc) }).request({
      method: 'anvil_reset', params: [{ forking: { jsonRpcUrl: env.FORK_UPSTREAM, blockNumber: Number(block) } }],
    });
  }

  const stats = {};
  const wokb = getAddress(env.BASE_WOKB ?? WOKB); // overrides: tests against local mocks only
  const usdt0 = getAddress(env.BASE_USDT0 ?? USDT0);
  const dustOkb = parseEther(env.DUST_OKB ?? '0.01');
  const dustUsdt = parseUnits(env.DUST_USDT ?? '1', 6);
  const t0 = Date.now();
  const candidates = await listPairs(client, { block, factory, limit, dustOkb, dustUsdt, stats, log, wokb, usdt0, shard });
  log(`${candidates.length} qualifying pairs among the newest ${stats.looked} of ${stats.allPairs}`);

  const counts = {};
  const flagsSeen = { privileged: 0, upgradeable: 0, dangerSetter: 0, ownerCanTrap: 0 };
  const rows = [];
  let gasUsed = 0n;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const prev = state.done[c.token];
    if (prev && ['attested', 'known', 'dry'].includes(prev.status)) { counts.resumed = (counts.resumed ?? 0) + 1; continue; }
    const ts = Date.now();
    let res;
    try {
      res = await withRetry(() => processToken(c.token, c.pair, block, {
        client, walletClient, registry, reportsDir, send, forkRpc, simOpts, requireLiquidity: true,
        log: (m) => { if (!/^(attest|dry-run) /.test(m)) log(m); }, // the per-token line below says it
      }), { label: c.token, log, tries: 4 });
    } catch (e) {
      res = { status: 'error', error: msg(e) };
    }
    const ms = Date.now() - ts;
    counts[res.status] = (counts[res.status] ?? 0) + 1;
    if (res.flags) for (const k of Object.keys(flagsSeen)) if (res.flags[k]) flagsSeen[k]++;
    if (res.gasUsed) gasUsed += res.gasUsed;
    const f = res.flags ?? {};
    const line = `[${i + 1}/${candidates.length}] #${c.index} ${c.token} ${c.base === wokb ? 'WOKB' : 'USDT0'} ` +
      `${res.status}${res.why ? `(${res.why})` : ''}${res.reason ? `(${res.reason})` : ''}${res.error ? ` ${res.error.slice(0, 80)}` : ''} ` +
      `priv=${+!!f.privileged} upg=${+!!f.upgradeable} danger=${+!!f.dangerSetter} trap=${+!!f.ownerCanTrap} ${ms}ms`;
    print(line);
    rows.push({ index: c.index, token: c.token, pair: c.pair, status: res.status, why: res.why, flags: res.flags, ms });
    if (res.status !== 'error' && res.status !== 'pending') {
      state.done[c.token] = { status: res.status, codehash: res.codehash, why: res.why, tx: res.tx, at: new Date().toISOString() };
      saveState(stateFile, state);
    }
    if (rateMs) await sleep(rateMs);
  }

  const gasPrice = await withRetry(() => client.getGasPrice(), { label: 'gasPrice', log }).catch(() => null);
  let liveCount = null;
  if (env.COUNT_ALL === '1' && limit) {
    liveCount = (await listPairs(client, { block, factory, limit: 0, dustOkb, dustUsdt, log, wokb, usdt0 })).length;
  } else if (!limit) liveCount = candidates.length;
  const summary = {
    mode, block: block.toString(), shard: shard ? `${shard.i}/${shard.n}` : null, sweepBudgetS: simOpts.budgetMs / 1000, rpcs: urls, allPairs: stats.allPairs, looked: stats.looked,
    candidates: candidates.length, counts, flags: flagsSeen, elapsedMs: Date.now() - t0,
    avgMsPerToken: rows.length ? Math.round(rows.reduce((a, r) => a + r.ms, 0) / rows.length) : 0,
    stateFile, reportsDir,
    cost: gasPrice ? {
      thisRun: costEstimate(rows.filter((r) => ['dry', 'attested'].includes(r.status)).length, gasPrice),
      estimate: costEstimate(Number(env.ESTIMATE_PAIRS ?? 950), gasPrice),
      ...(liveCount !== null ? { allLive: costEstimate(liveCount, gasPrice) } : {}),
    } : null,
    ...(send ? { gasUsed: gasUsed.toString() } : {}),
  };
  print(JSON.stringify(summary, null, 1));
  if (!send) log('dry-run: nothing was sent (SEND=1 to attest)');
  return summary;
}

/** SHARD=i/N (0 <= i < N): this process only takes pairs whose factory index is i mod N. */
export function parseShard(v) {
  if (!v) return null;
  const m = /^(\d+)\/(\d+)$/.exec(v);
  const i = m ? Number(m[1]) : NaN;
  const n = m ? Number(m[2]) : NaN;
  if (!m || !(n >= 1) || !(i >= 0 && i < n)) throw new Error(`SHARD must be i/N with 0 <= i < N (got ${v})`);
  return { i, n };
}

function resumeNote(state) {
  const n = Object.keys(state.done).length;
  return n ? ` (resuming: ${n} tokens done)` : '';
}
