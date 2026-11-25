// Attester daemon: follows PotatoSwap V2 PairCreated logs in <=100-block windows, scans the non-base token of each
// new pair, optionally runs the fork owner-power simulation, writes a local report and attests to RiskRegistry.
// Dry-run unless `send` (SEND=1). The cursor (next block to read) is persisted in a JSON state file and only
// advances after a window's attestations are mined, so a crash re-processes at most one window.
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
    return { cursor: BigInt(s.cursor) };
  }
  return { cursor: BigInt(startBlock ?? 0) };
}

function saveState(file, state) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ cursor: state.cursor.toString() })}\n`);
  renameSync(tmp, file);
}

/** One catch-up pass from the persisted cursor to the current head. */
export async function runOnce({
  client, walletClient, factory = POTATOSWAP_FACTORY, registry, stateFile, reportsDir, startBlock,
  window = MAX_WINDOW, skip = BASE_TOKENS, send = false, forkRpc, forkUpstream, log = console.log, cursor,
}) {
  if (window < 1n || window > MAX_WINDOW) throw new Error(`window must be 1..${MAX_WINDOW}`);
  const skipSet = new Set(skip.map((a) => getAddress(a)));
  const state = cursor !== undefined ? { cursor: BigInt(cursor) } : loadState(stateFile, startBlock);
  const head = await client.getBlockNumber({ cacheTime: 0 });
  const out = { scanned: [], attested: [], skippedKnown: [], errors: [], next: state.cursor };
  const seen = new Set();

  for (let from = state.cursor; from <= head; from += window) {
    const to = from + window - 1n > head ? head : from + window - 1n;
    const logs = await client.getLogs({ address: factory, event: PAIR_CREATED, fromBlock: from, toBlock: to });
    const pending = [];
    // An anvil fork is pinned to its fork block: re-pin it to this window's end so the new pairs exist there.
    if (forkRpc && forkUpstream && logs.length) await resetFork(forkRpc, forkUpstream, to);
    for (const l of logs) {
      // the 4th event param is unnamed, so viem decodes args positionally
      const [token0, token1, pair] = Array.isArray(l.args) ? l.args : [l.args.token0, l.args.token1, l.args.pair];
      for (const token of [token0, token1].map((a) => getAddress(a))) {
        if (skipSet.has(token)) continue;
        try {
          const r = await scan(client, token);
          if (forkRpc) {
            const sim = await simulate(forkRpc, token, pair);
            r.ownerCanTrap = sim.ownerCanTrap;
            r.evidence.simulation = sim.evidence;
          }
          out.scanned.push({ token, pair, codehash: r.codehash });
          writeReport(reportsDir, { ...r, token, pair, block: l.blockNumber, reportURI: reportURI(r.codehash) });
          if (seen.has(r.codehash)) continue;
          seen.add(r.codehash);
          const f = await client.readContract({
            address: registry, abi: REGISTRY_ABI, functionName: 'flagsOf', args: [r.codehash],
          });
          if (f.scanned && f.scannerVersion >= SCANNER_VERSION && !(r.ownerCanTrap && !f.ownerCanTrap)) {
            out.skippedKnown.push(r.codehash);
            continue;
          }
          log(`${send ? 'attest' : 'dry-run'} ${token} ${r.codehash} priv=${r.privileged} upg=${r.upgradeable} ` +
            `danger=${r.dangerSetter} trap=${r.ownerCanTrap}`);
          if (send) pending.push(r);
        } catch (e) {
          out.errors.push({ token, error: e.shortMessage ?? e.message });
          log(`error ${token}: ${e.shortMessage ?? e.message}`);
        }
      }
    }
    out.next = to + 1n;
    if (!send) continue; // dry-run: never persist the cursor
    for (const r of pending) {
      const hash = await attest(walletClient, registry, r);
      const rc = await client.waitForTransactionReceipt({ hash, pollingInterval: 250 });
      if (rc.status !== 'success') throw new Error(`attest ${r.codehash} reverted (${hash})`);
      out.attested.push({ codehash: r.codehash, tx: hash });
    }
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
