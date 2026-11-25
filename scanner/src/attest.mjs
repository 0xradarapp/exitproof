// RiskRegistry attestation + local report files.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseAbi } from 'viem';

export const REGISTRY_ABI = parseAbi([
  'struct Flags { bool scanned; bool privileged; bool upgradeable; bool dangerSetter; bool ownerCanTrap; uint16 scannerVersion; }',
  'function attest(bytes32 codehash, Flags f, string reportURI)',
  'function flagsOf(bytes32 codehash) view returns (Flags)',
  'function isAttester(address) view returns (bool)',
]);

export const reportURI = (codehash) => `exitproof://scan/v1/${codehash.toLowerCase()}`;

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

/** Sends RiskRegistry.attest(codehash, flags, reportURI). Returns the tx hash. */
export function attest(walletClient, registry, result) {
  return walletClient.writeContract({
    address: registry,
    abi: REGISTRY_ABI,
    functionName: 'attest',
    args: [result.codehash, toFlags(result), reportURI(result.codehash)],
  });
}

export const stringify = (v) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x), 2);

/** Writes the full JSON report to `<dir>/<codehash>.json` (dir is git-ignored). */
export function writeReport(dir, report) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${report.codehash.toLowerCase()}.json`);
  writeFileSync(file, `${stringify(report)}\n`);
  return file;
}
