#!/usr/bin/env node
// ExitProof scanner CLI (v5).
//   node scanner/src/cli.mjs scan <token>                      read-only, RPC_URL (default: both X Layer public RPCs)
//   node scanner/src/cli.mjs simulate <token> <pair>           FORK_RPC must be an anvil node
//   node scanner/src/cli.mjs attest <token> [pair] [--force]   REGISTRY + attester key; dry-run unless SEND=1;
//                                                              refuses to lower a flag of the same codehash without --force
//   node scanner/src/cli.mjs daemon                            RPC_URL REGISTRY START_BLOCK [FORK_RPC SEND]
//   node scanner/src/cli.mjs backfill                          existing PotatoSwap pairs, newest first (see backfill.mjs)
// Attester key: env only, ATTESTER_KEY or ATTESTER_KEY_FILE (chmod 600). Sends on X Layer mainnet also need
// CONFIRM_MAINNET=yes. Every send needs FORK_RPC (the sell simulation) unless STATIC_ONLY=1 is set explicitly.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, defineChain, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { scan, SCANNER_VERSION } from './scan.mjs';
import { simulate, mergeSimulation } from './simulate.mjs';
import { attest, writeReport, reportURI, stringify, readEntry, decide, FLAG_KEYS } from './attest.mjs';
import { runDaemon } from './daemon.mjs';
import { runBackfill, makeTransport, XLAYER_RPCS } from './backfill.mjs';
import { sendGate, attesterKey } from './send-gate.mjs';

const BASE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;
const RPC = env.RPC_URL ?? XLAYER_RPCS[0];
// without RPC_URL: both public X Layer RPCs with fallback (rpc.xlayer.tech answers HTTP 403 when rate-limited)
const transport = env.RPC_URL ? http(RPC) : makeTransport([...XLAYER_RPCS]);

async function clients({ needKey = false, what } = {}) {
  const client = createPublicClient({ transport });
  let walletClient;
  const key = attesterKey(env);
  if (env.SEND === '1' && needKey) {
    if (!key) throw new Error('SEND=1 requires ATTESTER_KEY or ATTESTER_KEY_FILE');
    await sendGate(RPC, env, { what });
    const id = await client.getChainId();
    const chain = defineChain({
      id, name: `chain-${id}`, nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 },
      rpcUrls: { default: { http: [RPC] } },
    });
    walletClient = createWalletClient({ chain, transport, account: privateKeyToAccount(key) });
  }
  return { client, walletClient };
}

function usage() {
  console.error('usage: cli.mjs scan <token> | simulate <token> <pair> | attest <token> [pair] [--force] | daemon | backfill');
  process.exit(2);
}

const argv = process.argv.slice(2);
const force = argv.includes('--force');
const [cmd, a1, a2] = argv.filter((x) => x !== '--force');
const REPORTS = env.REPORTS_DIR ?? path.join(BASE_DIR, 'reports');
try {
  if (cmd === 'scan') {
    if (!a1) usage();
    const { client } = await clients();
    console.log(stringify(await scan(client, a1)));
  } else if (cmd === 'simulate') {
    if (!a1 || !a2 || !env.FORK_RPC) usage();
    console.log(stringify(await simulate(env.FORK_RPC, a1, a2)));
  } else if (cmd === 'attest') {
    if (!a1 || !env.REGISTRY) usage();
    if (env.SEND === '1' && !(env.FORK_RPC && a2) && env.STATIC_ONLY !== '1') {
      throw new Error('SEND=1 requires FORK_RPC and <pair> (sell simulation); STATIC_ONLY=1 to attest the static scan only');
    }
    const { client, walletClient } = await clients({ needKey: true, what: 'attest' });
    const token = getAddress(a1);
    const r = await scan(client, token);
    if (env.FORK_RPC && a2) mergeSimulation(r, await simulate(env.FORK_RPC, token, a2));
    const entry = await readEntry(client, env.REGISTRY, token);
    const d = decide(r, entry, SCANNER_VERSION);
    if (d.lowered.length && !force) {
      throw new Error(`refusing to downgrade ${d.lowered.join(', ')} (registry has true for this codehash); pass --force to override`);
    }
    const flags = force ? r : d.flags; // --force writes the new scan as is
    const uri = reportURI(token, r.codehash);
    const file = writeReport(REPORTS, {
      token, pair: a2 ? getAddress(a2) : null, block: r.block, codehash: r.codehash, scannerVersion: r.scannerVersion,
      flags: Object.fromEntries(FLAG_KEYS.map((k) => [k, !!flags[k]])),
      decision: { why: force ? 'force' : d.why, raised: d.raised ?? [], lowered: force ? d.lowered : [] },
      reportURI: uri, evidence: r.evidence,
    });
    console.log(stringify(r));
    console.error(`report: ${file}`);
    if (env.SEND === '1') {
      if (!d.send && !force) {
        console.error(`registry already has these flags for ${token} at ${r.codehash} (${d.why}); nothing to send`);
      } else {
        const hash = await attest(walletClient, env.REGISTRY, token, flags, uri);
        const rc = await client.waitForTransactionReceipt({ hash });
        console.error(`attested ${token} ${r.codehash} tx ${hash} status ${rc.status}`);
      }
    } else {
      console.error(`dry-run (${d.why}; set SEND=1 to attest)`);
    }
  } else if (cmd === 'daemon') {
    if (env.SEND === '1' && !env.FORK_RPC && env.STATIC_ONLY !== '1') {
      throw new Error('SEND=1 requires FORK_RPC (sell simulation); STATIC_ONLY=1 to attest static scans only');
    }
    const { client, walletClient } = await clients({ needKey: true, what: 'run the attester daemon' });
    await runDaemon({ client, walletClient, env, baseDir: BASE_DIR });
  } else if (cmd === 'backfill') {
    await runBackfill({ env, baseDir: BASE_DIR });
  } else {
    usage();
  }
} catch (e) {
  console.error(e.shortMessage ?? e.message);
  process.exit(1);
}
