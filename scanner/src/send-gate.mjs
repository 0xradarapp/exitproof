// F-13: guards for every path that sends a transaction (attest, daemon, backfill).
//  - The network is detected by probing the RPC (scripts/lib/net.mjs). On X Layer mainnet a send needs
//    CONFIRM_MAINNET=yes and prints a banner. F-14 hardening: "fork" is only believed for a loopback RPC URL.
//  - The attester key comes only from the environment: ATTESTER_KEY, or ATTESTER_KEY_FILE pointing at a file that
//    is not readable by group/others (chmod 600). A private key on the command line is refused.
import { readFileSync, statSync } from 'node:fs';
import { createPublicClient, http } from 'viem';

// scripts/lib/net.mjs (shared with the deploy scripts) is loaded lazily: read-only scanner commands must not need the
// repo-root node_modules it resolves viem from.
const net = () => import('../../scripts/lib/net.mjs');

const KEY_RE = /^(0x)?[0-9a-fA-F]{64}$/;

export function isLoopbackUrl(url) {
  try {
    const h = new URL(url).hostname;
    return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1';
  } catch {
    return false;
  }
}

/**
 * Returns { network: 'xlayer' | 'fork' | 'chain-<id>', chainId }. Throws on X Layer mainnet unless
 * env.CONFIRM_MAINNET === 'yes'. `what` names the send path in the banner.
 */
export async function sendGate(rpcUrl, env = process.env, { what = 'send', log = console.error } = {}) {
  const { loadConstants, detectNetwork } = await net();
  const K = loadConstants();
  const chainId = await createPublicClient({ transport: http(rpcUrl) }).getChainId();
  if (chainId !== K.chainId) return { network: `chain-${chainId}`, chainId };
  let { network } = await detectNetwork(rpcUrl, K);
  if (network === 'fork' && !isLoopbackUrl(rpcUrl)) network = 'xlayer'; // an "anvil" answer from a remote URL is not trusted
  if (network === 'xlayer') {
    log('================================================================');
    log(` X LAYER MAINNET (chain ${chainId}): ${what} will send real transactions`);
    log(` RPC ${new URL(rpcUrl).host}`);
    log('================================================================');
    if (env.CONFIRM_MAINNET !== 'yes') {
      throw new Error(`refusing to ${what} on X Layer mainnet without CONFIRM_MAINNET=yes`);
    }
  }
  return { network, chainId };
}

/** The attester key from env (ATTESTER_KEY or ATTESTER_KEY_FILE), or null. Never from argv. */
export function attesterKey(env = process.env, argv = process.argv) {
  if (argv.some((a) => KEY_RE.test(a) || /^--?(private-?key|key)(=|$)/i.test(a))) {
    throw new Error('refusing a private key on the command line: use ATTESTER_KEY or ATTESTER_KEY_FILE');
  }
  if (env.ATTESTER_KEY && env.ATTESTER_KEY_FILE) throw new Error('set ATTESTER_KEY or ATTESTER_KEY_FILE, not both');
  let key = env.ATTESTER_KEY;
  if (env.ATTESTER_KEY_FILE) {
    const st = statSync(env.ATTESTER_KEY_FILE);
    if ((st.mode & 0o077) !== 0) {
      throw new Error(`refusing ATTESTER_KEY_FILE readable by group/others (mode ${(st.mode & 0o777).toString(8)}): chmod 600 it`);
    }
    key = readFileSync(env.ATTESTER_KEY_FILE, 'utf8').trim();
  }
  if (!key) return null;
  if (!KEY_RE.test(key)) throw new Error('attester key is not a 32-byte hex string');
  return key.startsWith('0x') ? key : `0x${key}`;
}
