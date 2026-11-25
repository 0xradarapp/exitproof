// Shared by scripts/tapeout.mjs and scripts/deploy-fork.mjs: X Layer constants (one source of truth,
// deployments/constants.json) and network detection by probing the RPC (never by free text).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, defineChain, getAddress } from 'viem';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function loadConstants() {
  const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'deployments', 'constants.json'), 'utf8'));
  for (const k of ['tapeoutFactory', 'bem', 'potatoFactory', 'wokb', 'multicall3']) c[k] = getAddress(c[k]);
  return c;
}

export function xlayerChain(rpcUrl, K) {
  return defineChain({
    id: K.chainId, name: 'X Layer', nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } }, contracts: { multicall3: { address: K.multicall3 } }
  });
}

/// Returns { network: 'fork' | 'xlayer', client, chainId }. "fork" iff the node identifies as anvil
/// (anvil_nodeInfo answers, or web3_clientVersion mentions anvil). Any other chain-196 node is mainnet.
export async function detectNetwork(rpcUrl, K) {
  const pub = createPublicClient({ chain: xlayerChain(rpcUrl, K), transport: http(rpcUrl, { timeout: 60_000 }) });
  const chainId = await pub.getChainId();
  if (chainId !== K.chainId) throw new Error('RPC is chain ' + chainId + ', expected ' + K.chainId + ' (X Layer or an anvil fork of it)');
  let client = '';
  try { client = String(await pub.request({ method: 'web3_clientVersion' })); } catch { /* not exposed */ }
  let anvil = /anvil/i.test(client);
  if (!anvil) {
    try { await pub.request({ method: 'anvil_nodeInfo' }); anvil = true; } catch { /* not anvil */ }
  }
  return { network: anvil ? 'fork' : 'xlayer', pub, chainId, client };
}

export const deploymentFile = (network) => path.join(ROOT, 'deployments', network + '.json');
