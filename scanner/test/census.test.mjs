// Census report aggregation + verdict derivation, on synthetic rows (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, parseJsonl, renderMarkdown, renderSvg, decodeFacts } from '../src/census-report.mjs';
import { scannedFacts, verdictsFor, verdictOf, sample } from '../src/census.mjs';

const clean = { privileged: false, upgradeable: false, dangerSetter: false, ownerCanTrap: false, reasons: [], dangerous: [], owner: null };

function row(token, raw, scanFlags, extra = {}) {
  const facts = scannedFacts(raw, scanFlags);
  return {
    type: 'token', token, pair: '0x' + 'p'.repeat(40), group: 'recent', index: 1, wokbReserve: '1000000000000000000',
    inspect: { kind: 'report', facts: raw | (2 << 9) }, scan: scanFlags, scannedFacts: facts,
    verdicts: verdictsFor(facts), unscannedVerdicts: verdictsFor(raw | (1 << 8)), circuitMatches: true, ...extra,
  };
}

test('verdictOf follows the spec policy (truth table)', () => {
  assert.deepEqual(verdictOf(1 | (2 << 9)), { allow: true, reason: 0 }); // sellOk, permissive
  assert.deepEqual(verdictOf(0 | (2 << 9)), { allow: false, reason: 1 }); // cannot sell
  assert.deepEqual(verdictOf(1 | (2 << 1) | (2 << 9)), { allow: false, reason: 2 }); // sell tax 15-50%
  assert.deepEqual(verdictOf(1 | (1 << 5) | (1 << 7) | (1 << 9)), { allow: false, reason: 5 }); // balanced owner+danger
  assert.deepEqual(verdictOf(1 | (1 << 5)), { allow: false, reason: 7 }); // strict owner active
  assert.deepEqual(verdictOf(1 | (1 << 8)), { allow: false, reason: 6 }); // strict unscanned
});

test('scannedFacts mirrors the router: registry authoritative for upgradeable, ORs owner, clears unscanned', () => {
  const raw = 1 | (1 << 6) | (1 << 8); // sellOk, on-chain opcode scan says upgradeable, unscanned
  assert.equal(scannedFacts(raw, clean), 1);
  const f = decodeFacts(scannedFacts(1, { ...clean, privileged: true, dangerSetter: true }));
  assert.equal(f.ownerActive, true);
  assert.equal(f.danger, true);
  assert.equal(f.unscanned, false);
  assert.equal(decodeFacts(scannedFacts(1 | (1 << 5), clean)).ownerActive, true); // owner() on chain kept
});

test('aggregate: counts, denominators, per-mode allowed and notable ranking', () => {
  const rows = [
    row('0xa1', 1, clean), // clean: allowed everywhere
    row('0xa2', 0, clean, { wokbReserve: '5000000000000000000' }), // honeypot
    row('0xa3', 1 | (3 << 1), clean), // sell tax >= 50%
    row('0xa4', 1 | (2 << 3), clean), // buy tax 15-50%
    row('0xa5', 1 | (1 << 5), { ...clean, dangerSetter: true, privileged: true, dangerous: ['setFee(uint256)'], reasons: ['dangerous-selector'], owner: '0x' + '1'.repeat(40) }),
    row('0xa6', 1, { ...clean, upgradeable: true }),
    row('0xa7', 1, { ...clean, privileged: true, reasons: ['unknown-selector'] }),
    { type: 'token', token: '0xa8', pair: '0xp', group: 'older', wokbReserve: '1', inspect: { kind: 'revert', error: 'SwapFailed' }, scan: clean },
    { type: 'token', token: '0xa9', pair: '0xp', group: 'older', wokbReserve: '1', inspect: { kind: 'error', error: 'rpc' }, scan: { error: 'skipped' } },
  ];
  const a = aggregate(rows, { sample: { skipped: { dust: 3, dustRecent: 2, dustOlder: 1 } } });
  assert.equal(a.sampled, 9);
  assert.equal(a.measured, 7);
  assert.equal(a.cannotBuy, 1);
  assert.equal(a.errors, 1);
  assert.equal(a.classified, 8);
  assert.equal(a.skipped.dust, 3);
  assert.equal(a.counts.cannotSell, 1);
  assert.equal(a.counts.sellTaxHigh, 1);
  assert.equal(a.counts.buyTaxHigh, 1);
  assert.equal(a.counts.dangerousOwnerSwitches, 1);
  assert.equal(a.counts.upgradeable, 1);
  assert.equal(a.counts.unknownSelectorPrivileged, 1);
  assert.equal(a.percent.cannotSell, 14.3); // 1/7
  // permissive allows a1, a5, a6, a7 -> 4/7 ; balanced a1, a7 -> 2/7 (a7 privileged but no danger) ; strict a1 -> 1/7
  assert.deepEqual(a.allowed, { permissive: 4, balanced: 2, strict: 1 });
  assert.deepEqual(a.allowedPct, { permissive: 57.1, balanced: 28.6, strict: 14.3 });
  assert.equal(a.honeypotLike, 3); // a2, a3, a4; cannot-buy a8 is reported apart
  assert.equal(a.honeypotLikePct, 42.9);
  assert.equal(a.cannotBuyPct, 12.5); // 1/8
  assert.equal(a.reasons.permissive[1], 1);
  assert.equal(a.reasons.permissive.cannotBuy, 1);
  assert.equal(a.reasons.balanced[5], 1);
  assert.equal(a.reasons.balanced[4], 1);
  assert.equal(a.notable[0].token, '0xa2'); // cannot sell ranks first
  assert.equal(a.notable[a.notable.length - 1].token, '0xa8'); // cannot buy ranks last
  assert.ok(!a.notable.some((t) => t.token === '0xa1' || t.token === '0xa7'));
  assert.equal(a.byGroup.older.cannotBuy, 1);
});

test('parseJsonl keeps the last row per token (resume re-processing) and renders', () => {
  const meta = { type: 'meta', block: '1', blockTime: 't', N: 1, M: 0, seed: 1, sample: { skipped: { dust: 0 }, tokens: [] } };
  const bad = { type: 'token', token: '0xb1', inspect: { kind: 'error' }, scan: { error: 'x' } };
  const good = row('0xb1', 1, clean);
  const { rows, meta: m } = parseJsonl([meta, bad, good].map((x) => JSON.stringify(x)).join('\n') + '\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].inspect.kind, 'report');
  const a = aggregate(rows, m);
  assert.match(renderMarkdown(a, m), /Token Safety Census/);
  const svg = renderSvg(a, m);
  assert.match(svg, /<title id="t">/);
  assert.match(svg, /Allowed: strict: 100%/);
});

test('seeded sample is deterministic and distinct', () => {
  const arr = Array.from({ length: 100 }, (_, i) => i);
  const s1 = sample(arr, 10, 196);
  assert.deepEqual(s1, sample(arr, 10, 196));
  assert.equal(new Set(s1).size, 10);
  assert.notDeepEqual(s1, sample(arr, 10, 197));
});

test('aggregate: EOA cross-check tallies, thrown checks count as unchecked', () => {
  const rows = [
    row('0xc1', 0, clean, { eoa: { buyOk: true, sellOk: false } }), // agrees: wallet cannot sell either
    row('0xc2', 0, clean, { eoa: { buyOk: true, sellOk: true } }), // differs: wallet sells
    row('0xc3', 0, clean, { eoa: { buyOk: false, sellOk: false, error: 'timeout' } }), // unchecked
    { type: 'token', token: '0xc4', pair: '0xp', group: 'recent', wokbReserve: '1', inspect: { kind: 'revert', error: 'SwapFailed' }, scan: clean, eoa: { buyOk: false, sellOk: false } },
    { type: 'token', token: '0xc5', pair: '0xp', group: 'recent', wokbReserve: '1', inspect: { kind: 'revert', error: 'SwapFailed' }, scan: clean, eoa: { buyOk: true, sellOk: false } },
  ];
  const { eoa } = aggregate(rows);
  assert.deepEqual(eoa, {
    cannotSellChecked: 2, cannotSellEoaAlsoFails: 1, cannotSellEoaSells: 1, cannotSellEoaCannotBuy: 0,
    cannotBuyChecked: 2, cannotBuyEoaAlsoFails: 1, cannotBuyEoaBuys: 1, cannotBuyEoaBuysCannotSell: 1,
  });
});

test('compareRuns: counts cannot-sell -> sells (Flap), buyability and per-mode flips', async () => {
  const { compareRuns } = await import('../src/census-report.mjs');
  const flapV1 = row('0xaaaa7777', 0, clean);
  const flapV2 = row('0xaaaa7777', 1, clean);
  const same1 = row('0xb2', 1, clean);
  const cb1 = { type: 'token', token: '0xb3', inspect: { kind: 'revert', error: 'SwapFailed' }, scan: clean };
  const cb2 = row('0xb3', 1 | (2 << 3), clean); // now buyable, buy tax 15-50%
  const c = compareRuns([flapV1, same1, cb1, row('0xgone', 1, clean)], [flapV2, row('0xb2', 1, { ...clean, privileged: true }), cb2]);
  assert.equal(c.common, 3);
  assert.equal(c.onlyPrev, 1);
  assert.equal(c.cannotSellToSells, 1);
  assert.equal(c.cannotSellToSellsFlap, 1);
  assert.equal(c.cannotBuyToBuyable, 1);
  assert.equal(c.dynamicChanged, 1);
  assert.equal(c.staticChanged, 1); // 0xb2 became privileged
  assert.equal(c.flips.permissive.toAllowed, 1); // flap token
  assert.equal(c.flips.strict.toBlocked, 1); // 0xb2: owner now active
  assert.equal(c.flips.permissive.reasonChanged, 1); // 0xb3: cannotBuy -> reason 3
});
