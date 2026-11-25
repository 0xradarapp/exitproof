// Proxy storage-slot probes: EIP-1967 implementation / beacon / admin and EIP-1822 PROXIABLE.
import { getAddress } from 'viem';

export const SLOTS = Object.freeze({
  eip1967Implementation: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
  eip1967Beacon: '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50',
  eip1967Admin: '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103',
  eip1822Proxiable: '0xc5f16f0fcc639fa48a6947836d9850f504798523bf8c9a3a87d5876cf622bcf7',
});

/** Slots whose non-zero value means the code behind the token can be replaced. */
export const UPGRADE_SLOTS = Object.freeze(['eip1967Implementation', 'eip1967Beacon', 'eip1822Proxiable']);

const ZERO_WORD = `0x${'00'.repeat(32)}`;

/** A storage word rendered as a checksummed address if it fits in 20 bytes, else the raw word; zero -> null. */
export function renderWord(word) {
  if (!word || BigInt(word) === 0n) return null;
  const hex = word.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  if (hex.slice(0, 24) === '0'.repeat(24)) return getAddress(`0x${hex.slice(24)}`);
  return `0x${hex}`;
}

/** Reads all proxy slots (fixed key order). */
export async function readProxySlots(client, address, blockNumber) {
  const out = {};
  for (const [name, slot] of Object.entries(SLOTS)) {
    const w = await client.getStorageAt({ address, slot, blockNumber });
    out[name] = renderWord(w ?? ZERO_WORD);
  }
  return out;
}

export const isAddress20 = (v) => typeof v === 'string' && v.length === 42;
