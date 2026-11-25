#!/usr/bin/env node
// Bundles the per-token scan reports (scanner/reports/<token>.json, written by attest / daemon / backfill) into a
// static directory that can be published as is (DeWEB, any static host, a git branch):
//   <out>/index.json          [{ token, codehash, block, scannerVersion, flags, signals, reportURI, file, keccak256 }]
//   <out>/<token>.json        the report, byte for byte
// Anyone can then re-run `cli.mjs scan <token>` at `block` (and `simulate` on a fork pinned there) and compare.
// Set REPORT_BASE_URL to the published <out> URL when attesting so the on-chain reportURI points here.
//   node scanner/src/publish-reports.mjs [reportsDir] [outDir]   (defaults: scanner/reports, scanner/dist/reports)
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak256, toHex, getAddress } from 'viem';

const BASE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function publishReports(reportsDir, outDir) {
  mkdirSync(outDir, { recursive: true });
  const index = [];
  const skipped = [];
  for (const f of readdirSync(reportsDir).filter((x) => /^0x[0-9a-f]{40}\.json$/.test(x)).sort()) {
    const raw = readFileSync(path.join(reportsDir, f), 'utf8');
    let r;
    try { r = JSON.parse(raw); } catch { skipped.push({ file: f, why: 'not JSON' }); continue; }
    if (!r.token || !r.codehash || r.block === undefined) { skipped.push({ file: f, why: 'missing token/codehash/block' }); continue; }
    const sim = r.evidence?.simulation;
    index.push({
      token: getAddress(r.token), codehash: r.codehash, block: r.block, scannerVersion: r.scannerVersion,
      flags: r.flags, reasons: r.evidence?.reasons ?? [], signals: sim?.signals ?? r.evidence?.signals ?? [],
      simulated: !!sim && !sim.error, attestation: r.attestation ?? null, reportURI: r.reportURI, file: f,
      keccak256: keccak256(toHex(raw)),
    });
    writeFileSync(path.join(outDir, f), raw);
  }
  const doc = { generatedAt: new Date().toISOString(), count: index.length, reports: index };
  writeFileSync(path.join(outDir, 'index.json'), `${JSON.stringify(doc, null, 1)}\n`);
  return { count: index.length, skipped, outDir };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const reportsDir = process.argv[2] ?? path.join(BASE_DIR, 'reports');
  const outDir = process.argv[3] ?? path.join(BASE_DIR, 'dist', 'reports');
  const r = publishReports(reportsDir, outDir);
  console.log(`published ${r.count} reports to ${r.outDir}${r.skipped.length ? ` (skipped ${r.skipped.length})` : ''}`);
}
