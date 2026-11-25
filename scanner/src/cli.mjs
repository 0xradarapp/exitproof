#!/usr/bin/env node
// ExitProof scanner CLI.
//   node scanner/src/cli.mjs scan <token>                      read-only, RPC_URL (default X Layer public RPC)
//   node scanner/src/cli.mjs simulate <token> <pair>           FORK_RPC must be an anvil node
//   node scanner/src/cli.mjs attest <token> [pair]             REGISTRY, ATTESTER_KEY; dry-run unless SEND=1
//   node scanner/src/cli.mjs daemon                            RPC_URL REGISTRY START_BLOCK [ATTESTER_KEY FORK_RPC SEND]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { scan } from './scan.mjs';
import { simulate } from './simulate.mjs';
import { attest, writeReport, reportURI, stringify } from './attest.mjs';
import { runDaemon } from './daemon.mjs';

const BASE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;
const RPC = env.RPC_URL ?? 'https://rpc.xlayer.tech';

async function clients() {
  const client = createPublicClient({ transport: http(RPC) });
  let walletClient;
  if (env.ATTESTER_KEY) {
    const id = await client.getChainId();
    const chain = defineChain({
      id, name: `chain-${id}`, nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 },
      rpcUrls: { default: { http: [RPC] } },
    });
    walletClient = createWalletClient({ chain, transport: http(RPC), account: privateKeyToAccount(env.ATTESTER_KEY) });
  }
  return { client, walletClient };
}

function usage() {
  console.error('usage: cli.mjs scan <token> | simulate <token> <pair> | attest <token> [pair] | daemon');
  process.exit(2);
}

const [cmd, a1, a2] = process.argv.slice(2);
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
    const { client, walletClient } = await clients();
    const r = await scan(client, a1);
    if (env.FORK_RPC && a2) {
      const sim = await simulate(env.FORK_RPC, a1, a2);
      r.ownerCanTrap = sim.ownerCanTrap;
      r.evidence.simulation = sim.evidence;
    }
    const file = writeReport(path.join(BASE_DIR, 'reports'), { ...r, token: a1, reportURI: reportURI(r.codehash) });
    console.log(stringify(r));
    console.error(`report: ${file}`);
    if (env.SEND === '1') {
      if (!walletClient) throw new Error('SEND=1 requires ATTESTER_KEY');
      const hash = await attest(walletClient, env.REGISTRY, r);
      const rc = await client.waitForTransactionReceipt({ hash });
      console.error(`attested ${r.codehash} tx ${hash} status ${rc.status}`);
    } else {
      console.error('dry-run (set SEND=1 to attest)');
    }
  } else if (cmd === 'daemon') {
    const { client, walletClient } = await clients();
    await runDaemon({ client, walletClient, env, baseDir: BASE_DIR });
  } else {
    usage();
  }
} catch (e) {
  console.error(e.shortMessage ?? e.message);
  process.exit(1);
}
