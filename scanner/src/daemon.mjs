// Attester daemon (scanner v5). Follows PotatoSwap V2 PairCreated logs in <=100-block windows, scans the non-base
// token of each new pair at its first liquidity, optionally runs the fork simulation, writes a local report
// (reports/<token>.json) and attests to RiskRegistry per token address (F-06). Dry-run unless `send` (SEND=1).
//
// Coverage (F-05): a token is never dropped.
//  - No code yet (PotatoFactory.createPair accepts any address) or no liquidity yet => the token goes to the
//    `pending` set. It is re-checked when its pair emits Sync (first Mint / Sync = the moment it becomes tradeable)
//    and directly every PENDING_RECHECK_BLOCKS blocks, and scanned then (at the launch configuration).
//  - A scan or simulation that keeps failing is retried (state `retry`); after MAX_RETRIES it is attested fail-closed
//    (simulate-gave-up: ownerCanTrap; scan-gave-up: every flag) instead of being dropped.
// Re-attestation (per token): when the codehash changed, or any flag rises, or the entry is from an older scanner
// version. Flags of an entry with the same codehash are never lowered (only `cli attest --force` can).
// The cursor (next block to read) is persisted only when sending, and only after a window's attestations are mined.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { createPublicClient, getAddress, http, keccak256, parseAbi, parseAbiItem } from 'viem';
import { scan, SCANNER_VERSION } from './scan.mjs';
import { simulate, mergeSimulation } from './simulate.mjs';
import { attest, writeReport, reportURI, readEntry, decide, FLAG_KEYS } from './attest.mjs';

export { FLAG_KEYS };
export const POTATOSWAP_FACTORY = '0x630DB8E822805c82Ca40a54daE02dd5aC31f7fcF';
/** Base / quote assets on X Layer that are never the "new" token: WOKB, USD₮0, USDT (bridged), USDC. */
export const BASE_TOKENS = Object.freeze([
  '0xe538905cf8410324e03A5A23C1c177a474D59b2b',
  '0x779Ded0c9e1022225f8E0630b35a9b54bE713736',
  '0x1E4a5963aBFD975d8c9021ce480b42188849D41d',
  '0x74b7F16337b8972027F6196A17a631aC6dE26d22',
]);
export const MAX_WINDOW = 100n;
export const MAX_RETRIES = 5;
export const PENDING_RECHECK_BLOCKS = 600n;

const PAIR_CREATED = parseAbiItem(
  'event PairCreated(address indexed token0, address indexed token1, address pair, uint256)',
);
const SYNC = parseAbiItem('event Sync(uint112 reserve0, uint112 reserve1)');
const PAIR_ABI = parseAbi(['function getReserves() view returns (uint112,uint112,uint32)']);

async function resetFork(forkRpc, upstream, blockNumber) {
  const fork = createPublicClient({ transport: http(forkRpc) });
  await fork.request({
    method: 'anvil_reset', params: [{ forking: { jsonRpcUrl: upstream, blockNumber: Number(blockNumber) } }],
  });
}

export function loadState(file, startBlock) {
  if (file && existsSync(file)) {
    const s = JSON.parse(readFileSync(file, 'utf8'));
    return { cursor: BigInt(s.cursor), retry: s.retry ?? [], pending: s.pending ?? [] };
  }
  return { cursor: BigInt(startBlock ?? 0), retry: [], pending: [] };
}

function saveState(file, state) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({
    cursor: state.cursor.toString(), retry: state.retry, pending: state.pending,
  }, null, 1)}\n`);
  renameSync(tmp, file);
}

const msg = (e) => e.shortMessage ?? e.message;
const EMPTY_ENTRY = Object.freeze({
  f: { scanned: false, privileged: false, upgradeable: false, dangerSetter: false, ownerCanTrap: false, scannerVersion: 0 },
  codehash: `0x${'00'.repeat(32)}`,
});

/** Every flag set: what is attested when even the static scan could never be completed. */
function failClosedResult(token, code, block, why) {
  return {
    codehash: keccak256(code), block: Number(block), privileged: true, upgradeable: true, dangerSetter: true,
    ownerCanTrap: true, scannerVersion: SCANNER_VERSION, evidence: { address: getAddress(token), error: why, signals: [why] },
  };
}

/**
 * Scan (+ simulate) one token at `block` and attest it. Shared by the daemon and `backfill`.
 * Returns { status: 'attested' | 'dry' | 'known' | 'pending' | 'retry', ... }.
 *   opts: client, walletClient, registry, reportsDir, send, forkRpc, simOpts, attempts, callers, log, requireLiquidity
 */
export async function processToken(token, pair, block, opts) {
  const { client, registry, reportsDir, send, forkRpc, log = () => {}, attempts = 0 } = opts;
  token = getAddress(token);
  pair = getAddress(pair);
  const code = await client.getCode({ address: token, blockNumber: block });
  if (!code || code === '0x') return { status: 'pending', reason: 'no-code' };
  if (opts.requireLiquidity !== false) {
    const [r0, r1] = await client.readContract({ address: pair, abi: PAIR_ABI, functionName: 'getReserves', blockNumber: block });
    if (r0 === 0n || r1 === 0n) return { status: 'pending', reason: 'no-liquidity' };
  }
  let r;
  try {
    r = await scan(client, token, { blockNumber: block });
  } catch (e) {
    if (attempts + 1 < MAX_RETRIES) return { status: 'retry', error: `scan: ${msg(e)}` };
    r = failClosedResult(token, code, block, `scan-gave-up: ${msg(e)}`);
    log(`scan gave up on ${token} after ${MAX_RETRIES} attempts: attesting fail-closed`);
  }
  let retry = null;
  if (forkRpc && !r.evidence.error) {
    try {
      mergeSimulation(r, await simulate(forkRpc, token, pair, { ...(opts.simOpts ?? {}), callers: opts.callers ?? [] }));
    } catch (e) {
      if (attempts + 1 >= MAX_RETRIES) {
        // fail closed: the owner-power / sell questions could never be answered
        r.ownerCanTrap = true;
        r.privileged = true;
        r.evidence.simulation = { error: `simulate-gave-up: ${msg(e)}`, signals: ['simulate-gave-up'] };
        log(`simulate gave up on ${token} after ${MAX_RETRIES} attempts: attesting ownerCanTrap=true`);
      } else {
        // the static scan is still attested; the simulation is retried on a later pass
        r.evidence.simulation = { error: `simulate-error: ${msg(e)}` };
        retry = `simulate: ${msg(e)}`;
      }
    }
  }
  // no registry yet (dry-run before the deploy): decide against an empty entry
  const entry = registry ? await readEntry(client, registry, token) : EMPTY_ENTRY;
  const d = decide(r, entry, SCANNER_VERSION);
  const uri = reportURI(token, r.codehash);
  const report = {
    token, pair, block: r.block, codehash: r.codehash, scannerVersion: r.scannerVersion,
    flags: Object.fromEntries(FLAG_KEYS.map((k) => [k, d.flags[k]])), scan: Object.fromEntries(FLAG_KEYS.map((k) => [k, !!r[k]])),
    decision: { why: d.why, send: d.send, raised: d.raised ?? [], keptFromRegistry: d.lowered },
    reportURI: uri, evidence: r.evidence,
  };
  writeReport(reportsDir, report);
  const res = { status: d.send ? (send ? 'attested' : 'dry') : 'known', token, pair, codehash: r.codehash, why: d.why, flags: report.flags, retry };
  if (!d.send) return res;
  const f = report.flags;
  log(`${send ? 'attest' : 'dry-run'} ${token} (${d.why}) priv=${f.privileged} upg=${f.upgradeable} ` +
    `danger=${f.dangerSetter} trap=${f.ownerCanTrap}`);
  if (!send) return res;
  const hash = await attest(opts.walletClient, registry, token, d.flags, uri);
  const rc = await client.waitForTransactionReceipt({ hash, pollingInterval: 250 });
  if (rc.status !== 'success') throw new Error(`attest ${token} reverted (${hash})`);
  writeReport(reportsDir, { ...report, attestation: { tx: hash, block: Number(rc.blockNumber) } });
  return { ...res, tx: hash, gasUsed: rc.gasUsed };
}

/**
 * One catch-up pass: the retry queue, then the pending set (no code / no liquidity yet), then the persisted cursor
 * to the current head (PairCreated logs + Sync logs of pending pairs, per window).
 * `state` (optional) is an in-memory state object (dry-run keeps one across passes); otherwise it is loaded from
 * `stateFile`.
 */
export async function runOnce({
  client, walletClient, factory = POTATOSWAP_FACTORY, registry, stateFile, reportsDir, startBlock,
  window = MAX_WINDOW, skip = BASE_TOKENS, send = false, forkRpc, forkUpstream, log = console.log, cursor, state: memState,
  simOpts, pendingRecheck = PENDING_RECHECK_BLOCKS,
}) {
  if (window < 1n || window > MAX_WINDOW) throw new Error(`window must be 1..${MAX_WINDOW}`);
  const skipSet = new Set(skip.map((a) => getAddress(a)));
  const state = memState
    ?? (cursor !== undefined ? { cursor: BigInt(cursor), retry: [], pending: [] } : loadState(stateFile, startBlock));
  const head = await client.getBlockNumber({ cacheTime: 0 });
  const out = {
    scanned: [], attested: [], skippedKnown: [], errors: [], retried: [], pending: [], next: state.cursor, state,
  };
  const persist = () => { if (send && !memState) saveState(stateFile, state); };
  const base = { client, walletClient, registry, reportsDir, send, forkRpc, simOpts, log };

  const removeFrom = (list, token) => { const i = list.findIndex((x) => x.token === token); if (i >= 0) list.splice(i, 1); };
  const addPending = (token, pair, reason, at, callers) => {
    const p = state.pending.find((x) => x.token === token);
    if (p) { p.reason = reason; p.checkedAt = at.toString(); return; }
    state.pending.push({ token, pair, reason, since: at.toString(), checkedAt: at.toString(), callers });
    log(`pending ${token} (${reason}): re-checked on its pair's first Sync`);
  };

  /** Process one token; routes the outcome to pending / retry / out. */
  const handle = async (token, pair, at, { attempts = 0, callers = [] } = {}) => {
    let res;
    try {
      res = await processToken(token, pair, at, { ...base, attempts, callers });
    } catch (e) {
      if (/attest .* reverted/.test(msg(e))) throw e;
      res = { status: 'retry', error: `process: ${msg(e)}` };
    }
    if (res.status === 'pending') {
      addPending(token, pair, res.reason, at, callers);
      out.pending.push({ token, reason: res.reason });
      return;
    }
    removeFrom(state.pending, token);
    if (res.status === 'retry' || res.retry) {
      const error = res.error ?? res.retry;
      out.errors.push({ token, error });
      log(`error ${token}: ${error}`);
      removeFrom(state.retry, token);
      state.retry.push({ token, pair, error, attempts: attempts + 1, callers });
      if (res.status === 'retry') return;
    }
    out.scanned.push({ token, pair, codehash: res.codehash });
    if (res.status === 'known') out.skippedKnown.push(token);
    if (res.status === 'attested') out.attested.push({ token, codehash: res.codehash, tx: res.tx });
  };

  if (send && state.retry.length) {
    const items = state.retry;
    state.retry = [];
    if (forkRpc && forkUpstream) await resetFork(forkRpc, forkUpstream, head);
    for (const it of items) {
      out.retried.push(it.token);
      await handle(it.token, it.pair, head, { attempts: it.attempts ?? 0, callers: it.callers ?? [] });
    }
    persist();
  }

  // pending entries not seen in a Sync for a while are re-checked directly (code may have appeared)
  const stale = state.pending.filter((p) => head - BigInt(p.checkedAt) >= pendingRecheck);
  if (stale.length) {
    if (forkRpc && forkUpstream) await resetFork(forkRpc, forkUpstream, head);
    for (const p of stale) await handle(p.token, p.pair, head, { callers: p.callers ?? [] });
    persist();
  }

  for (let from = state.cursor; from <= head; from += window) {
    const to = from + window - 1n > head ? head : from + window - 1n;
    const logs = await client.getLogs({ address: factory, event: PAIR_CREATED, fromBlock: from, toBlock: to });
    const pendingPairs = [...new Set(state.pending.map((p) => getAddress(p.pair)))];
    const synced = new Set();
    for (let i = 0; i < pendingPairs.length; i += 50) {
      const sl = await client.getLogs({ address: pendingPairs.slice(i, i + 50), event: SYNC, fromBlock: from, toBlock: to });
      for (const l of sl) synced.add(getAddress(l.address));
    }
    // An anvil fork is pinned to its fork block: re-pin it to this window's end so the new pairs exist there.
    if (forkRpc && forkUpstream && (logs.length || synced.size)) await resetFork(forkRpc, forkUpstream, to);
    for (const p of state.pending.filter((x) => synced.has(getAddress(x.pair)))) {
      await handle(p.token, p.pair, to, { callers: p.callers ?? [] });
    }
    for (const l of logs) {
      // the 4th event param is unnamed, so viem decodes args positionally
      const [token0, token1, pair] = Array.isArray(l.args) ? l.args : [l.args.token0, l.args.token1, l.args.pair];
      let creator = null;
      try { creator = (await client.getTransaction({ hash: l.transactionHash })).from; } catch { /* optional */ }
      for (const token of [token0, token1].map((a) => getAddress(a))) {
        if (!skipSet.has(token)) await handle(token, getAddress(pair), to, { callers: creator ? [getAddress(creator)] : [] });
      }
    }
    out.next = to + 1n;
    state.cursor = to + 1n;
    persist(); // dry-run never persists (the in-memory state carries the cursor)
  }
  return out;
}

/** Long-running loop driven by env: RPC_URL, REGISTRY, FORK_RPC, START_BLOCK, SEND, POLL_MS, STATE_FILE. */
export async function runDaemon({ client, walletClient, env = process.env, baseDir }) {
  const opts = {
    client,
    walletClient,
    registry: env.REGISTRY,
    stateFile: env.STATE_FILE ?? path.join(baseDir, 'state', 'daemon.json'),
    reportsDir: env.REPORTS_DIR ?? path.join(baseDir, 'reports'),
    startBlock: env.START_BLOCK,
    send: env.SEND === '1',
    forkRpc: env.FORK_RPC || undefined,
    forkUpstream: env.FORK_RPC ? (env.FORK_UPSTREAM ?? env.RPC_URL ?? 'https://rpc.xlayer.tech') : undefined,
  };
  if (!opts.registry) throw new Error('REGISTRY is required');
  if (opts.send && !walletClient) throw new Error('SEND=1 requires ATTESTER_KEY or ATTESTER_KEY_FILE');
  if (opts.send && !opts.forkRpc && env.STATIC_ONLY !== '1') {
    throw new Error('SEND=1 requires FORK_RPC (sell simulation); STATIC_ONLY=1 to attest static scans only');
  }
  if (opts.startBlock === undefined && !existsSync(opts.stateFile)) throw new Error('START_BLOCK is required on first run');
  const poll = Number(env.POLL_MS ?? 10_000);
  // dry-run keeps its whole state (cursor, pending, retry) in memory only
  const memState = opts.send ? undefined : loadState(opts.stateFile, opts.startBlock);
  for (;;) {
    try {
      const r = await runOnce({ ...opts, state: memState });
      if (r.scanned.length || r.pending.length) {
        console.log(`pass: scanned=${r.scanned.length} attested=${r.attested.length} known=${r.skippedKnown.length} ` +
          `pending=${r.state.pending.length} retry=${r.state.retry.length}`);
      }
    } catch (e) {
      console.error(`daemon pass failed: ${e.shortMessage ?? e.message}`);
    }
    await new Promise((res) => setTimeout(res, poll));
  }
}
