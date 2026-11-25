// RiskRegistry attestation (F-06: keyed by token address, the entry carries the codehash it was scanned at; the
// router honours it only while the token's current EXTCODEHASH equals that codehash) + local report files.
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { parseAbi, getAddress } from 'viem';

export const REGISTRY_ABI = parseAbi([
  'struct Flags { bool scanned; bool privileged; bool upgradeable; bool dangerSetter; bool ownerCanTrap; uint16 scannerVersion; }',
  'function attest(address token, bytes32 codehash, Flags f, string reportURI)',
  'function flagsOf(address token) view returns (Flags f, bytes32 codehash)',
  'function isAttester(address) view returns (bool)',
  'event Attested(address indexed token, bytes32 indexed codehash, Flags f, string reportURI, address attester)',
]);

export const FLAG_KEYS = Object.freeze(['privileged', 'upgradeable', 'dangerSetter', 'ownerCanTrap']);

/**
 * reportURI written on chain. With REPORT_BASE_URL (e.g. the published reports directory, see publish-reports.mjs)
 * it is `<base>/<token>.json`; otherwise `exitproof://scan/v2/<token>/<codehash>`. Either way the token and the
 * codehash identify the report in the published bundle (scanner/reports/<token>.json carries block + codehash).
 */
export function reportURI(token, codehash, base = process.env.REPORT_BASE_URL) {
  const t = token.toLowerCase();
  if (base) return `${base.replace(/\/+$/, '')}/${t}.json`;
  return `exitproof://scan/v2/${t}/${codehash.toLowerCase()}`;
}

export function toFlags(result) {
  return {
    scanned: true,
    privileged: !!result.privileged,
    upgradeable: !!result.upgradeable,
    dangerSetter: !!result.dangerSetter,
    ownerCanTrap: !!result.ownerCanTrap,
    scannerVersion: result.scannerVersion,
  };
}

/** Registry entry for `token`: { f: Flags, codehash }. */
export async function readEntry(client, registry, token) {
  const [f, codehash] = await client.readContract({
    address: registry, abi: REGISTRY_ABI, functionName: 'flagsOf', args: [getAddress(token)],
  });
  return { f, codehash };
}

/**
 * Attestation decision for one token against its registry entry (pure).
 *  - no entry, or the entry is for another codehash (code changed) -> attest the new result as is ('new' / 'code-changed');
 *  - same codehash: flags are never lowered (OR with the entry); attest only when a flag rises ('raised') or the
 *    entry is from an older scanner version ('version'); otherwise skip ('known').
 * Returns { send, why, flags (merged result), lowered (keys the new scan alone would lower) }.
 */
export function decide(result, entry, scannerVersion = result.scannerVersion) {
  const merged = { ...result };
  const same = entry.f.scanned && entry.codehash.toLowerCase() === result.codehash.toLowerCase();
  if (!same) return { send: true, why: entry.f.scanned ? 'code-changed' : 'new', flags: merged, lowered: [] };
  const lowered = FLAG_KEYS.filter((k) => entry.f[k] && !result[k]);
  const raised = FLAG_KEYS.filter((k) => result[k] && !entry.f[k]);
  for (const k of FLAG_KEYS) merged[k] = !!(result[k] || entry.f[k]);
  if (raised.length) return { send: true, why: 'raised', raised, flags: merged, lowered };
  if (entry.f.scannerVersion < scannerVersion) return { send: true, why: 'version', flags: merged, lowered };
  return { send: false, why: 'known', flags: merged, lowered };
}

/** Sends RiskRegistry.attest(token, codehash, flags, reportURI). Returns the tx hash. */
export function attest(walletClient, registry, token, result, uri = reportURI(token, result.codehash)) {
  return walletClient.writeContract({
    address: registry,
    abi: REGISTRY_ABI,
    functionName: 'attest',
    args: [getAddress(token), result.codehash, toFlags(result), uri],
  });
}

export const stringify = (v) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x), 2);

/**
 * Writes the full JSON report to `<dir>/<token>.json` (atomic). The report must carry token, codehash and block
 * so a third party can re-run the scan at that block and compare.
 */
export function writeReport(dir, report) {
  for (const k of ['token', 'codehash', 'block']) {
    if (report[k] === undefined || report[k] === null) throw new Error(`writeReport: missing ${k}`);
  }
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${report.token.toLowerCase()}.json`);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${stringify(report)}\n`);
  renameSync(tmp, file);
  return file;
}
