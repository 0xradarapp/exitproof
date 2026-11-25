// Attester daemon: follows PotatoSwap V2 PairCreated logs in <=100-block windows, scans the non-base token of each
// new pair, optionally runs the fork owner-power simulation, writes a local report and attests to RiskRegistry.
// Dry-run unless `send` (SEND=1). The cursor (next block to read) is persisted in a JSON state file and only
// advances after a window's attestations are mined, so a crash re-processes at most one window. Tokens whose scan
// or simulation failed are kept in the state file's `retry` queue (max MAX_RETRIES attempts each).
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { createPublicClient, getAddress, http, parseAbiItem } from 'viem';
import { scan, SCANNER_VERSION } from './scan.mjs';
import { simulate } from './simulate.mjs';
import { attest, writeReport, reportURI, REGISTRY_ABI } from './attest.mjs';

export const POTATOSWAP_FACTORY = '0x630DB8E822805c82Ca40a54daE02dd5aC31f7fcF';
/** Base / quote assets on X Layer that are never the "new" token: WOKB, USD₮0, USDT (bridged), USDC. */
export const BASE_TOKENS = Object.freeze([
  '0xe538905cf8410324e03A5A23C1c177a474D59b2b',
  '0x779Ded0c9e1022225f8E0630b35a9b54bE713736',
  '0x1E4a5963aBFD975d8c9021ce480b42188849D41d',
  '0x74b7F16337b8972027F6196A17a631aC6dE26d22',
]);
export const MAX_WINDOW = 100n;

const PAIR_CREATED = parseAbiItem(
  'event PairCreated(address indexed token0, address indexed token1, address pair, uint256)',
);

async function resetFork(forkRpc, upstream, blockNumber) {
  const fork = createPublicClient({ transport: http(forkRpc) });
  await fork.request({
    method: 'anvil_reset', params: [{ forking: { jsonRpcUrl: upstream, blockNumber: Number(blockNumber) } }],
  });
}

export function loadState(file, startBlock) {
  if (existsSync(file)) {
    const s = JSON.parse(readFileSync(file, 'utf8'));
    return { cursor: BigInt(s.cursor), retry: s.retry ?? [] };
  }
  return { cursor: BigInt(startBlock ?? 0), retry: [] };
}

function saveState(file, state) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ cursor: state.cursor.toString(), retry: state.retry }, null, 1)}\n`);
  renameSync(tmp, file);
}

export const FLAG_KEYS = Object.freeze(['privileged', 'upgradeable', 'dangerSetter', 'ownerCanTrap']);
export const MAX_RETRIES = 5;
const msg = (e) => e.shortMessage ?? e.message;

/**
 * One catch-up pass: first the retry queue (tokens whose scan or simulation failed earlier), then the persisted
 * cursor to the current head. Flags are ORed across all instances of a codehash seen in a batch and with the
 * registry's current flags, so the daemon never downgrades a flag; a known codehash is re-attested only when some
 * flag goes false -> true (or the registry entry is from an older scanner version).
 */
export async function runOnce({
  client, walletClient, factory = POTATOSWAP_FACTORY, registry, stateFile, reportsDir, startBlock,
  window = MAX_WINDOW, skip = BASE_TOKENS, send = false, forkRpc, forkUpstream, log = console.log, cursor,
}) {
  if (window < 1n || window > MAX_WINDOW) throw new Error(`window must be 1..${MAX_WINDOW}`);
  const skipSet = new Set(skip.map((a) => getAddress(a)));
  const state = cursor !== undefined ? { cursor: BigInt(cursor), retry: [] } : loadState(stateFile, startBlock);
  const head = await client.getBlockNumber({ cacheTime: 0 });
  const out = { scanned: [], attested: [], skippedKnown: [], errors: [], retried: [], next: state.cursor };

  const queueRetry = (token, pair, error, prev = 0) => {
    out.errors.push({ token, error });
    log(`error ${token}: ${error}`);
    if (prev + 1 >= MAX_RETRIES) { log(`giving up on ${token} after ${MAX_RETRIES} attempts`); return; }
    if (state.retry.some((x) => x.token === token)) return;
    state.retry.push({ token, pair, error, attempts: prev + 1 });
  };

  /** Scan (+ simulate) one token and OR it into `batch` (codehash -> merged result). */
  const processToken = async (token, pair, batch, prevAttempts = 0) => {
    let r;
    try {
      r = await scan(client, token);
    } catch (e) {
      queueRetry(token, pair, `scan: ${msg(e)}`, prevAttempts);
      return;
    }
    if (forkRpc) {
      try {
        const sim = await simulate(forkRpc, token, pair);
        r.ownerCanTrap = sim.ownerCanTrap;
        r.evidence.simulation = sim.evidence;
      } catch (e) {
        if (prevAttempts + 1 >= MAX_RETRIES) {
          // fail closed: the owner-power question could never be answered
          r.ownerCanTrap = true;
          r.evidence.simulation = { error: `simulate-gave-up: ${msg(e)}` };
          out.errors.push({ token, error: `simulate-gave-up: ${msg(e)}` });
          log(`simulate gave up on ${token} after ${MAX_RETRIES} attempts: attesting ownerCanTrap=true`);
        } else {
          // the static scan is still attested; the simulation is retried on a later pass
          r.evidence.simulation = { error: `simulate-error: ${msg(e)}` };
          queueRetry(token, pair, `simulate: ${msg(e)}`, prevAttempts);
        }
      }
    }
    out.scanned.push({ token, pair, codehash: r.codehash });
    const m = batch.get(r.codehash);
    if (!m) {
      batch.set(r.codehash, { ...r, instances: [{ token, pair, evidence: r.evidence }] });
    } else {
      for (const k of FLAG_KEYS) m[k] ||= r[k];
      m.instances.push({ token, pair, evidence: r.evidence });
    }
  };

  /** Compare with the registry, OR with it, attest (when sending), write the merged reports. */
  const flush = async (batch) => {
    for (const r of [...batch.values()].sort((x, y) => (x.codehash < y.codehash ? -1 : 1))) {
      const f = await client.readContract({
        address: registry, abi: REGISTRY_ABI, functionName: 'flagsOf', args: [r.codehash],
      });
      const raises = FLAG_KEYS.some((k) => r[k] && !f[k]);
      if (f.scanned) for (const k of FLAG_KEYS) r[k] ||= f[k];
      writeReport(reportsDir, { ...r, reportURI: reportURI(r.codehash) });
      if (f.scanned && f.scannerVersion >= SCANNER_VERSION && !raises) {
        out.skippedKnown.push(r.codehash);
        continue;
      }
      log(`${send ? 'attest' : 'dry-run'} ${r.codehash} x${r.instances.length} priv=${r.privileged} ` +
        `upg=${r.upgradeable} danger=${r.dangerSetter} trap=${r.ownerCanTrap}`);
      if (!send) continue;
      const hash = await attest(walletClient, registry, r);
      const rc = await client.waitForTransactionReceipt({ hash, pollingInterval: 250 });
      if (rc.status !== 'success') throw new Error(`attest ${r.codehash} reverted (${hash})`);
      out.attested.push({ codehash: r.codehash, tx: hash });
    }
  };

  if (send && state.retry.length) {
    const items = state.retry;
    state.retry = [];
    const batch = new Map();
    if (forkRpc && forkUpstream) await resetFork(forkRpc, forkUpstream, head);
    for (const it of items) {
      out.retried.push(it.token);
      await processToken(it.token, it.pair, batch, it.attempts ?? 0);
    }
    await flush(batch);
    saveState(stateFile, state);
  }

  for (let from = state.cursor; from <= head; from += window) {
    const to = from + window - 1n > head ? head : from + window - 1n;
    const logs = await client.getLogs({ address: factory, event: PAIR_CREATED, fromBlock: from, toBlock: to });
    // An anvil fork is pinned to its fork block: re-pin it to this window's end so the new pairs exist there.
    if (forkRpc && forkUpstream && logs.length) await resetFork(forkRpc, forkUpstream, to);
    const batch = new Map();
    for (const l of logs) {
      // the 4th event param is unnamed, so viem decodes args positionally
      const [token0, token1, pair] = Array.isArray(l.args) ? l.args : [l.args.token0, l.args.token1, l.args.pair];
      for (const token of [token0, token1].map((a) => getAddress(a))) {
        if (!skipSet.has(token)) await processToken(token, getAddress(pair), batch);
      }
    }
    await flush(batch);
    out.next = to + 1n;
    if (!send) continue; // dry-run: never persist the cursor
    state.cursor = to + 1n;
    saveState(stateFile, state);
  }
  return out;
}

/** Long-running loop driven by env: RPC_URL, REGISTRY, ATTESTER_KEY, FORK_RPC, START_BLOCK, SEND, POLL_MS. */
export async function runDaemon({ client, walletClient, env = process.env, baseDir }) {
  const opts = {
    client,
    walletClient,
    registry: env.REGISTRY,
    stateFile: env.STATE_FILE ?? path.join(baseDir, 'state', 'daemon.json'),
    reportsDir: path.join(baseDir, 'reports'),
    startBlock: env.START_BLOCK,
    send: env.SEND === '1',
    forkRpc: env.FORK_RPC || undefined,
    forkUpstream: env.FORK_RPC ? (env.RPC_URL ?? 'https://rpc.xlayer.tech') : undefined,
  };
  if (!opts.registry) throw new Error('REGISTRY is required');
  if (opts.send && !walletClient) throw new Error('SEND=1 requires ATTESTER_KEY');
  if (opts.startBlock === undefined && !existsSync(opts.stateFile)) throw new Error('START_BLOCK is required on first run');
  const poll = Number(env.POLL_MS ?? 10_000);
  let memCursor; // dry-run keeps its cursor in memory only
  for (;;) {
    try {
      const r = await runOnce({ ...opts, cursor: opts.send ? undefined : memCursor });
      if (!opts.send) memCursor = r.next;
      if (r.scanned.length) console.log(`pass: scanned=${r.scanned.length} attested=${r.attested.length} known=${r.skippedKnown.length}`);
    } catch (e) {
      console.error(`daemon pass failed: ${e.shortMessage ?? e.message}`);
    }
    await new Promise((res) => setTimeout(res, poll));
  }
}
