#!/usr/bin/env node
// Turns the census JSONL (scanner/src/census.mjs) into docs/CENSUS.md, docs/census.json and docs/census.svg.
//
//   node scanner/src/census-report.mjs [in=docs/census-raw.jsonl] [outDir=docs]
//
// Denominators (stated in the report too):
//   measured  = tokens whose inspect() returned a Report AND whose static scan succeeded
//   cannotBuy = inspect() reverted with something other than Report (no buy possible through the router at all)
//   classified = measured + cannotBuy. Every percentage uses `measured` (tokens that can be bought) as the base;
//              cannot-buy is reported as its own share of `classified` (pre-launch tokens whose trading is closed,
//              drained pools) and is not counted as a honeypot.
//   errors    = RPC/transient failures, excluded from every percentage
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MODES = ['permissive', 'balanced', 'strict'];
export const REASONS = {
  0: 'allowed', 1: 'cannot sell', 2: 'sell tax too high', 3: 'buy tax too high', 4: 'upgradeable',
  5: 'dangerous owner powers', 6: 'unscanned', 7: 'owner still active',
};
const TAX = ['<5%', '5-15%', '15-50%', '>=50%/unmeasurable'];

export function decodeFacts(f) {
  return {
    sellOk: (f & 1) === 1, sellTax: (f >> 1) & 3, buyTax: (f >> 3) & 3, ownerActive: ((f >> 5) & 1) === 1,
    upgradeable: ((f >> 6) & 1) === 1, danger: ((f >> 7) & 1) === 1, unscanned: ((f >> 8) & 1) === 1,
  };
}

export function parseJsonl(text) {
  const rows = [];
  let meta = null, done = null;
  const runs = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    if (r.type === 'meta') meta = r;
    else if (r.type === 'run') runs.push(r);
    else if (r.type === 'done') done = r;
    else if (r.type === 'token') rows.push(r);
  }
  // a resumed run may have re-processed a token that failed before: the last row per token wins
  const last = new Map();
  for (const r of rows) last.set(r.token, r);
  return { meta, runs, done, rows: [...last.values()] };
}

const pct = (n, d) => (d ? Math.round((1000 * n) / d) / 10 : 0);
const okb = (wei) => Number(BigInt(wei)) / 1e18;

/** Pure aggregation over token rows. */
export function aggregate(rows, meta = null) {
  const measured = rows.filter((r) => r.inspect?.kind === 'report' && r.scan && !r.scan.error && r.verdicts);
  const cannotBuy = rows.filter((r) => r.inspect?.kind === 'revert' || r.inspect?.kind === 'noRevert');
  const errors = rows.filter((r) => !measured.includes(r) && !cannotBuy.includes(r));
  const classified = measured.length + cannotBuy.length;

  const facts = measured.map((r) => ({ r, f: decodeFacts(r.scannedFacts) }));
  const count = (pred) => facts.filter(({ r, f }) => pred(f, r)).length;
  const c = {
    cannotSell: count((f) => !f.sellOk),
    sellTaxHigh: count((f) => f.sellOk && f.sellTax >= 2),
    buyTaxHigh: count((f) => f.buyTax >= 2),
    sellTaxAny: count((f) => f.sellOk && f.sellTax >= 1),
    buyTaxAny: count((f) => f.buyTax >= 1),
    ownerActive: count((f) => f.ownerActive),
    ownerGetter: count((f, r) => r.scan.owner != null),
    dangerSetter: count((f, r) => r.scan.dangerSetter),
    dangerousOwnerSwitches: count((f, r) => f.ownerActive && r.scan.dangerSetter),
    listedDangerousSelector: count((f, r) => (r.scan.dangerous || []).length > 0),
    upgradeable: count((f) => f.upgradeable),
    unknownSelectorPrivileged: count((f, r) => (r.scan.reasons || []).includes('unknown-selector')),
    privileged: count((f, r) => r.scan.privileged),
    circuitMismatch: measured.filter((r) => r.circuitMatches === false).length,
  };
  // EOA cross-check (plain wallet buying/selling directly on the pair, next block), cannot-sell rows
  const cs = facts.filter(({ f }) => !f.sellOk).map(({ r }) => r);
  const ok = (r) => r.eoa && !r.eoa.error; // a thrown cross-check (RPC trouble) counts as unchecked
  const eoa = {
    cannotSellChecked: cs.filter(ok).length,
    cannotSellEoaAlsoFails: cs.filter((r) => ok(r) && r.eoa.buyOk && !r.eoa.sellOk).length,
    cannotSellEoaSells: cs.filter((r) => ok(r) && r.eoa.sellOk).length,
    cannotSellEoaCannotBuy: cs.filter((r) => ok(r) && !r.eoa.buyOk).length,
    cannotBuyChecked: cannotBuy.filter(ok).length,
    cannotBuyEoaAlsoFails: cannotBuy.filter((r) => ok(r) && !r.eoa.buyOk).length,
    cannotBuyEoaBuys: cannotBuy.filter((r) => ok(r) && r.eoa.buyOk).length,
    cannotBuyEoaBuysCannotSell: cannotBuy.filter((r) => ok(r) && r.eoa.buyOk && !r.eoa.sellOk).length,
  };
  const percent = Object.fromEntries(Object.entries(c).map(([k, v]) => [k, pct(v, measured.length)]));

  const allowed = {}, allowedPct = {}, reasons = {}, unscannedAllowedPct = {};
  for (const m of MODES) {
    allowed[m] = measured.filter((r) => r.verdicts[m].allow).length;
    allowedPct[m] = pct(allowed[m], measured.length);
    unscannedAllowedPct[m] = pct(measured.filter((r) => r.unscannedVerdicts?.[m]?.allow).length, measured.length);
    const rc = {};
    for (const r of measured) { const k = r.verdicts[m].reason; rc[k] = (rc[k] ?? 0) + 1; }
    if (cannotBuy.length) rc.cannotBuy = cannotBuy.length;
    reasons[m] = rc;
  }
  const cannotBuyErrors = {};
  for (const r of cannotBuy) { const k = r.inspect.error ?? r.inspect.kind; cannotBuyErrors[k] = (cannotBuyErrors[k] ?? 0) + 1; }

  // honeypot-like = buyable but blocked even in permissive (cannot sell all back, or a tax of 15% or more)
  const honeypotLike = measured.filter((r) => !r.verdicts.permissive.allow).length;

  const byGroup = {};
  for (const g of ['recent', 'older']) {
    const ms = measured.filter((r) => r.group === g);
    const cb = cannotBuy.filter((r) => r.group === g).length;
    byGroup[g] = {
      measured: ms.length, cannotBuy: cb,
      cannotSellPct: pct(ms.filter((r) => !decodeFacts(r.scannedFacts).sellOk).length, ms.length),
      cannotBuyPct: pct(cb, ms.length + cb),
      permissiveBlockedPct: pct(ms.filter((r) => !r.verdicts.permissive.allow).length, ms.length),
      allowedPct: Object.fromEntries(MODES.map((m) => [m, pct(ms.filter((r) => r.verdicts[m].allow).length, ms.length)])),
    };
  }

  const liquidity = (r) => okb(r.wokbReserve ?? '0');
  // notable: most WOKB liquidity at stake among tokens ExitProof blocks for a hard reason
  const severity = (r) => {
    if (cannotBuy.includes(r)) return 1;
    const f = decodeFacts(r.scannedFacts);
    if (!f.sellOk) return 5;
    if (f.sellTax >= 2 || f.buyTax >= 2) return 4;
    if (f.ownerActive && r.scan.dangerSetter) return 3;
    if (f.upgradeable) return 2;
    return 0;
  };
  const notable = [...measured, ...cannotBuy].filter((r) => severity(r) > 0)
    .sort((a, b) => severity(b) - severity(a) || liquidity(b) - liquidity(a)).slice(0, 20)
    .map((r) => {
      const isCb = cannotBuy.includes(r);
      const f = isCb ? null : decodeFacts(r.scannedFacts);
      return {
        token: r.token, pair: r.pair, symbol: r.symbol ?? null, group: r.group, pairIndex: r.index,
        liquidityOkb: Math.round(liquidity(r) * 1e4) / 1e4,
        facts: isCb ? null : r.scannedFacts,
        eoa: r.eoa && !r.eoa.error ? (r.eoa.buyOk ? (r.eoa.sellOk ? 'EOA buys and sells' : 'EOA buys, cannot sell') : 'EOA cannot buy') : null,
        factsText: isCb ? `inspect reverted: ${r.inspect.error}` : [
          f.sellOk ? 'sells' : 'CANNOT SELL', `sell tax ${TAX[f.sellTax]}`, `buy tax ${TAX[f.buyTax]}`,
          f.ownerActive && 'owner active', f.upgradeable && 'upgradeable', f.danger && 'danger switches',
        ].filter(Boolean).join(', '),
        reason: isCb ? 'cannot buy' : (r.verdicts.permissive.allow
          ? `${REASONS[r.verdicts.balanced.reason]} (balanced)` : `${REASONS[r.verdicts.permissive.reason]} (all modes)`),
        dangerous: isCb ? [] : (r.scan.dangerous || []).slice(0, 4),
      };
    });

  const liqMeasured = measured.map(liquidity).sort((a, b) => a - b);
  return {
    sampled: rows.length, measured: measured.length, cannotBuy: cannotBuy.length, errors: errors.length, classified,
    skipped: meta?.sample?.skipped ?? null,
    scannerVersions: [...new Set(measured.map((r) => r.scan.scannerVersion))].sort((x, y) => x - y),
    counts: c, percent, eoa, allowed, allowedPct, unscannedAllowedPct, reasons, cannotBuyErrors,
    honeypotLike, honeypotLikePct: pct(honeypotLike, measured.length), cannotBuyPct: pct(cannotBuy.length, classified), byGroup, notable,
    liquidityOkb: liqMeasured.length ? {
      median: liqMeasured[Math.floor(liqMeasured.length / 2)], total: Math.round(liqMeasured.reduce((a, b) => a + b, 0) * 100) / 100,
    } : null,
  };
}

/**
 * Compares two census runs token by token (tokens classified in both). Separates dynamic changes (the router's
 * sellOk / tax bits 0..4, or buy-ability) from static ones (scanner flags) and counts verdict flips per mode.
 * `flap` = Flap launchpad vanity addresses ending in 7777.
 */
export function compareRuns(prevRows, rows) {
  const cls = (r) => (r.inspect?.kind === 'report' && r.verdicts ? 'measured'
    : (r.inspect?.kind === 'revert' || r.inspect?.kind === 'noRevert') ? 'cannotBuy' : null);
  const prev = new Map(prevRows.filter(cls).map((r) => [r.token, r]));
  const both = rows.filter((r) => cls(r) && prev.has(r.token));
  const flap = (t) => t.toLowerCase().endsWith('7777');
  const out = {
    common: both.length, onlyPrev: prev.size - both.length, onlyNew: rows.filter((r) => cls(r) && !prev.has(r.token)).length,
    dynamicChanged: 0, staticChanged: 0, buyabilityChanged: 0,
    cannotSellToSells: 0, cannotSellToSellsFlap: 0, sellsToCannotSell: 0, cannotBuyToBuyable: 0, buyableToCannotBuy: 0,
    flips: {}, examples: [],
  };
  for (const m of MODES) out.flips[m] = { toAllowed: 0, toBlocked: 0, reasonChanged: 0 };
  for (const r of both) {
    const p = prev.get(r.token);
    const a = cls(p), b = cls(r);
    if (a !== b) {
      out.buyabilityChanged++;
      if (a === 'cannotBuy') out.cannotBuyToBuyable++; else out.buyableToCannotBuy++;
    } else if (a === 'measured') {
      if ((p.scannedFacts & 0x1f) !== (r.scannedFacts & 0x1f)) out.dynamicChanged++;
      if ((p.scannedFacts & 0x1e0) !== (r.scannedFacts & 0x1e0)) out.staticChanged++;
    }
    const pSell = a === 'measured' && (p.scannedFacts & 1) === 1;
    const nSell = b === 'measured' && (r.scannedFacts & 1) === 1;
    if (a === 'measured' && b === 'measured' && !pSell && nSell) {
      out.cannotSellToSells++;
      if (flap(r.token)) out.cannotSellToSellsFlap++;
      if (out.examples.length < 8) out.examples.push({ token: r.token, symbol: r.symbol, from: p.scannedFacts, to: r.scannedFacts });
    }
    if (a === 'measured' && b === 'measured' && pSell && !nSell) out.sellsToCannotSell++;
    for (const m of MODES) {
      const va = a === 'measured' ? p.verdicts[m] : { allow: false, reason: 'cannotBuy' };
      const vb = b === 'measured' ? r.verdicts[m] : { allow: false, reason: 'cannotBuy' };
      if (!va.allow && vb.allow) out.flips[m].toAllowed++;
      else if (va.allow && !vb.allow) out.flips[m].toBlocked++;
      else if (!va.allow && !vb.allow && va.reason !== vb.reason) out.flips[m].reasonChanged++;
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------- rendering

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const mdSafe = (s) => String(s ?? '').replace(/[|`*_<>[\]\\]/g, '').slice(0, 16);

/** Horizontal bar chart, plain SVG, high contrast, with a <title>/<desc> for screen readers. */
export function renderSvg(a, meta) {
  const bars = [
    ['Cannot sell (honeypot)', a.percent.cannotSell],
    ['Sell tax 15% or more', a.percent.sellTaxHigh],
    ['Buy tax 15% or more', a.percent.buyTaxHigh],
    ['Active owner with dangerous switches', a.percent.dangerousOwnerSwitches],
    ['Upgradeable code', a.percent.upgradeable],
    ['Allowed: permissive', a.allowedPct.permissive],
    ['Allowed: balanced', a.allowedPct.balanced],
    ['Allowed: strict', a.allowedPct.strict],
  ];
  const W = 720, left = 290, barW = 360, rowH = 34, top = 64, H = top + bars.length * rowH + 40;
  const rows = bars.map(([label, v], i) => {
    const y = top + i * rowH;
    const w = Math.max(1, (barW * v) / 100);
    const fill = i < 5 ? '#b42318' : '#1f6f43';
    return `  <g role="listitem" aria-label="${esc(label)}: ${v}%">
    <text x="${left - 10}" y="${y + 20}" text-anchor="end" font-size="14" fill="#1a1a1a">${esc(label)}</text>
    <rect x="${left}" y="${y + 6}" width="${barW}" height="20" fill="#ececec"/>
    <rect x="${left}" y="${y + 6}" width="${w.toFixed(1)}" height="20" fill="${fill}"/>
    <text x="${left + barW + 8}" y="${y + 21}" font-size="14" font-weight="600" fill="#1a1a1a">${v}%</text>
  </g>`;
  }).join('\n');
  const sub = `ExitProof census, ${a.measured} buyable PotatoSwap V2 WOKB tokens, X Layer block ${meta?.block ?? '?'}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="t d" font-family="system-ui, -apple-system, Segoe UI, sans-serif">
  <title id="t">Token Safety Census: share of sampled tokens per finding</title>
  <desc id="d">${esc(sub)}. ${bars.map(([l, v]) => `${l}: ${v}%`).join('; ')}.</desc>
  <rect width="${W}" height="${H}" fill="#ffffff"/>
  <text x="20" y="30" font-size="18" font-weight="700" fill="#1a1a1a">Token Safety Census (share of sampled tokens)</text>
  <text x="20" y="50" font-size="13" fill="#444">${esc(sub)}</text>
  <g role="list">
${rows}
  </g>
  <text x="20" y="${H - 12}" font-size="12" fill="#444">Red: risk findings (share of measured tokens). Green: share allowed by ExitProof per mode.</text>
</svg>
`;
}

export function renderMarkdown(a, meta, extra = {}) {
  const P = a.percent;
  const s = meta?.sample;
  const L = [];
  L.push('# ExitProof Token Safety Census');
  L.push('');
  L.push(`Snapshot: X Layer block **${meta?.block}** (${meta?.blockTime}). Venue: PotatoSwap V2 (factory \`${meta?.factory}\`), WOKB pairs.`);
  L.push('Every number below was measured by ExitProof itself: the real `ExitProofRouter.inspect()` with the real taped-out');
  L.push('policy circuit, run on a local anvil fork of X Layer mainnet at that block, plus the ExitProof static scanner (v' + (a.scannerVersions?.join(', v') || meta?.scannerVersion || '?') + ', which sets the static flags behind the balanced and strict verdicts).');
  L.push('');
  L.push('## Headline');
  L.push('');
  L.push(`- **${a.honeypotLikePct}%** of ${a.measured} buyable live tokens are blocked by ExitProof **even in permissive mode** (cannot sell all back, or a tax of 15% or more).`);
  L.push(`- **${P.cannotSell}%** cannot be sold back at all (reason 1, honeypot).`);
  L.push(`- **${P.dangerousOwnerSwitches}%** have an active owner holding dangerous switches (a listed fee / blacklist / pause / limit setter, or since scanner v10 any setter gated by a caller check): time bombs that look fine today.`);
  L.push(`- ExitProof allows **${a.allowedPct.permissive}%** in permissive (the default mode), **${a.allowedPct.balanced}%** in balanced and **${a.allowedPct.strict}%** in strict mode.`);
  L.push(`- A further ${a.cannotBuy} of ${a.classified} sampled live tokens (${a.cannotBuyPct}%) cannot be bought through ExitProof at all right now${a.eoa.cannotBuyChecked ? ` (${a.eoa.cannotBuyEoaAlsoFails} of ${a.eoa.cannotBuyChecked} cannot be bought by a plain wallet either: trading closed or buys disabled)` : ''}; they are reported apart and are not counted above.`);
  L.push('');
  L.push('![Census chart](census.svg)');
  L.push('');
  L.push('## Summary');
  L.push('');
  L.push('| metric | value |');
  L.push('|---|---|');
  L.push(`| PotatoSwap pairs at snapshot | ${s?.totalPairs ?? '?'} (${s?.wokbPairs ?? '?'} paired with WOKB) |`);
  L.push(`| skipped: WOKB reserve under ${meta?.dustOkb} OKB (never funded, drained or rugged) | ${a.skipped?.dust ?? 0} of ${s?.wokbPairs ?? '?'} WOKB pairs (${pct(a.skipped?.dust ?? 0, s?.wokbPairs)}%); ${a.skipped?.empty ?? 0} hold no WOKB at all${a.skipped?.noReserves ? `; ${a.skipped.noReserves} without reserves` : ''} |`);
  L.push(`| dust among the ${s?.lastNWindow ?? '?'} newest WOKB pairs | ${a.skipped?.dustInLastN ?? '?'} (${pct(a.skipped?.dustInLastN ?? 0, s?.lastNWindow)}%) |`);
  L.push(`| live WOKB pools (the population sampled) | ${s?.livePairs ?? '?'} holding ${s?.liveWokbReserve ? Math.round(okb(s.liveWokbReserve) * 100) / 100 : '?'} OKB of WOKB in total |`);
  L.push(`| sample drawn from the live pools | ${s ? s.pickedRecent + ' most recent + ' + s.pickedOlder + ' random older' : '?'} (seed ${meta?.seed}) |`);
  L.push(`| tokens checked | ${a.sampled} |`);
  L.push(`| measured (inspect Report + scan) | ${a.measured} |`);
  L.push(`| cannot buy at all (inspect reverted) | ${a.cannotBuy}${Object.keys(a.cannotBuyErrors).length ? ' (' + Object.entries(a.cannotBuyErrors).map(([k, v]) => `${k} ${v}`).join(', ') + ')' : ''} |`);
  L.push(`| excluded (RPC errors) | ${a.errors} |`);
  L.push(`| can't sell (reason 1) | ${P.cannotSell}% (${a.counts.cannotSell}) |`);
  L.push(`| sell tax >= 15% | ${P.sellTaxHigh}% (${a.counts.sellTaxHigh}) |`);
  L.push(`| buy tax >= 15% | ${P.buyTaxHigh}% (${a.counts.buyTaxHigh}) |`);
  L.push(`| any sell tax >= 5% / buy tax >= 5% | ${P.sellTaxAny}% / ${P.buyTaxAny}% |`);
  L.push(`| active owner (owner() non-zero or privileged code) | ${P.ownerActive}% (owner() non-zero: ${P.ownerGetter}%) |`);
  L.push(`| dangerous owner switches (active owner + dangerSetter) | ${P.dangerousOwnerSwitches}% (${a.counts.dangerousOwnerSwitches}) |`);
  L.push(`| a listed dangerous setter selector present | ${P.listedDangerousSelector}% |`);
  L.push(`| upgradeable (proxy / live delegatecall) | ${P.upgradeable}% (${a.counts.upgradeable}) |`);
  L.push(`| privileged via unknown selector (allowlist model) | ${P.unknownSelectorPrivileged}% (${a.counts.unknownSelectorPrivileged}) |`);
  L.push(`| allowed: permissive / balanced / strict | ${a.allowedPct.permissive}% / ${a.allowedPct.balanced}% / ${a.allowedPct.strict}% |`);
  L.push(`| allowed before the scanner attests (unscanned) | ${a.unscannedAllowedPct.permissive}% / ${a.unscannedAllowedPct.balanced}% / ${a.unscannedAllowedPct.strict}% |`);
  L.push('');
  L.push('All percentages use the measured (buyable) tokens as the base. Tokens that cannot be bought are listed apart:');
  L.push('ExitProof blocks them too (the buy reverts), but a closed or drained pool is not a honeypot.');
  L.push('');
  const E = a.eoa;
  if (E.cannotSellChecked || E.cannotBuyChecked) {
    L.push('### Cross-check with a plain wallet');
    L.push('');
    L.push('Every "cannot sell" and "cannot buy" token was re-tried on the same fork without ExitProof: a fresh impersonated EOA');
    L.push('buys through PotatoSwap\'s own V2 router, and in the next block approves it and sells its whole balance through it');
    L.push('(`swapExactTokensForETHSupportingFeeOnTransferTokens`), exactly as a wallet user does.');
    L.push('');
    L.push('| ExitProof finding | checked | plain wallet agrees | plain wallet differs |');
    L.push('|---|---|---|---|');
    L.push(`| cannot sell (reason 1) | ${E.cannotSellChecked} | ${E.cannotSellEoaAlsoFails} buy but cannot sell${E.cannotSellEoaCannotBuy ? `, ${E.cannotSellEoaCannotBuy} cannot even buy` : ''} | ${E.cannotSellEoaSells} sell fine |`);
    L.push(`| cannot buy (inspect reverted) | ${E.cannotBuyChecked} | ${E.cannotBuyEoaAlsoFails} cannot buy either | ${E.cannotBuyEoaBuys} can buy${E.cannotBuyEoaBuysCannotSell ? ` (${E.cannotBuyEoaBuysCannotSell} of them then cannot sell)` : ''} |`);
    L.push('');
    L.push('Where the plain wallet differs, the token treats contracts (the router or the fresh probe holder) differently from');
    L.push('wallets, or the same block differently from the next one. ExitProof still blocks such buys: a token that');
    L.push('discriminates by caller can do the same to any holder later, so ExitProof fails closed.');
    L.push('');
  }
  L.push('### Block reasons per mode (first failing check, as the circuit reports it)');
  L.push('');
  L.push('| reason | permissive | balanced | strict |');
  L.push('|---|---|---|---|');
  const keys = [...new Set(MODES.flatMap((m) => Object.keys(a.reasons[m])))].sort((x, y) => (x === 'cannotBuy') - (y === 'cannotBuy') || Number(x) - Number(y));
  for (const k of keys) {
    const name = k === 'cannotBuy' ? 'cannot buy (inspect reverted)' : `${k} ${REASONS[k]}`;
    L.push(`| ${name} | ${MODES.map((m) => a.reasons[m][k] ?? 0).join(' | ')} |`);
  }
  L.push('');
  L.push('### Recent launches vs older pairs');
  L.push('');
  L.push('| group | measured | cannot buy | can\'t sell | blocked in permissive | allowed permissive / balanced / strict |');
  L.push('|---|---|---|---|---|---|');
  for (const [g, b] of Object.entries(a.byGroup)) {
    L.push(`| ${g} | ${b.measured} | ${b.cannotBuy} (${b.cannotBuyPct}%) | ${b.cannotSellPct}% | ${b.permissiveBlockedPct}% | ${b.allowedPct.permissive}% / ${b.allowedPct.balanced}% / ${b.allowedPct.strict}% |`);
  }
  L.push('');
  if (extra.compare) {
    const C = extra.compare;
    const pm = extra.prevMeta;
    L.push('## v1 \u2192 v2 router');
    L.push('');
    L.push(`The first census (commit ${extra.prevCommit ?? '41ece32'}, block ${pm?.block}, scanner v${pm?.scannerVersion}) ran the v1 router. This one runs the final router (measured delivery, sell-side \`transferFrom\` from a code-less holder, post-transfer reserve read in the probe swap, eval backstop, registry keyed by token) and scanner v${a.scannerVersions?.join(', v') || meta?.scannerVersion}, at a later block, with the same sampling method and seed.`);
    L.push('');
    L.push(`${C.common} tokens were classified in both runs` + (C.onlyPrev || C.onlyNew
      ? ` (${C.onlyPrev} only in v1, ${C.onlyNew} only in v2: the newest-600 window moved or pools crossed the dust line).`
      : ' (the same 800 tokens: no pair was created and no pool crossed the dust line between the two blocks).'));
    L.push('');
    L.push('| change on the common tokens | count |');
    L.push('|---|---|');
    L.push(`| cannot sell (v1) \u2192 sells (v2) | ${C.cannotSellToSells} (${C.cannotSellToSellsFlap} of them Flap \`\u20267777\` tokens) |`);
    L.push(`| sells (v1) \u2192 cannot sell (v2) | ${C.sellsToCannotSell} |`);
    L.push(`| cannot buy (v1) \u2192 buyable (v2) / buyable \u2192 cannot buy | ${C.cannotBuyToBuyable} / ${C.buyableToCannotBuy} |`);
    L.push(`| dynamic facts changed (sellOk, buy/sell tax buckets) | ${C.dynamicChanged} |`);
    L.push(`| static facts changed (owner, upgradeable, danger: scanner v${pm?.scannerVersion} \u2192 v${a.scannerVersions?.join(', v') || meta?.scannerVersion}) | ${C.staticChanged} |`);
    for (const m of MODES) L.push(`| ${m}: blocked \u2192 allowed / allowed \u2192 blocked / other block reason | ${C.flips[m].toAllowed} / ${C.flips[m].toBlocked} / ${C.flips[m].reasonChanged} |`);
    L.push('');
    for (const n of extra.compareNotes ?? []) { L.push(n); L.push(''); }
  }
  L.push('## 20 most notable dangerous tokens');
  L.push('');
  L.push('Ranked by severity (cannot sell > tax of 15% or more > active owner with dangerous switches > upgradeable > cannot buy), then by');
  L.push('WOKB liquidity in the pool. Addresses are public chain data. Facts = the 11-bit circuit input without the mode bits.');
  L.push('');
  L.push('| # | token | symbol | pair | WOKB liquidity | facts | ExitProof verdict |');
  L.push('|---|---|---|---|---|---|---|');
  a.notable.forEach((t, i) => {
    L.push(`| ${i + 1} | \`${t.token}\` | ${mdSafe(t.symbol)} | \`${t.pair}\` | ${t.liquidityOkb} OKB | ${t.facts == null ? '' : '0x' + t.facts.toString(16).padStart(3, '0') + ': '}${t.factsText}${t.dangerous.length ? '; setters: ' + t.dangerous.map((d) => d.split('(')[0]).join(', ') : ''}${t.eoa ? '; cross-check: ' + t.eoa : ''} | ${t.reason} |`);
  });
  L.push('');
  L.push('## Methodology');
  L.push('');
  L.push(`1. **Snapshot.** A local anvil fork of X Layer mainnet (chain 196) pinned at block ${meta?.block} (${meta?.blockTime}). Mainnet was only read (via a read-only, method-allowlisted proxy); every transaction went to the local fork, signed with anvil's public test key.`);
  L.push('2. **Stack.** The repo\'s own `scripts/tapeout.mjs` and `scripts/deploy-fork.mjs` created the TapeOut processor, taped out the 54-NAND ExitProof policy circuit (verified on all 2048 inputs on the forked processor), and deployed `RiskRegistry` and `ExitProofRouter` on the fork.');
  L.push(`3. **Sample.** All ${s?.totalPairs ?? '?'} pairs were enumerated from the factory (\`allPairs\`) and the reserves of all ${s?.wokbPairs ?? '?'} WOKB pairs were read at the snapshot block. Pairs with less than ${meta?.dustOkb} OKB of WOKB reserve were skipped and counted (most launch pairs on PotatoSwap are never funded or end up drained). From the ${s?.livePairs ?? '?'} live pools: the ${meta?.N} most recent plus ${meta?.M} drawn uniformly from the older ones (${meta?.prng}, seed ${meta?.seed}).`);
  L.push(`4. **Dynamic check.** \`eth_call\` of \`ExitProofRouter.inspect(factory, WOKB, amountIn, token, permissive)\` with amountIn = ${meta?.amountInRule}. The router buys on the pair, measures what the caller would actually be delivered, moves the whole position to a fresh code-less holder address which approves the router, sells all of it back with \`transferFrom\` (a spender-initiated sale, like any DEX router; the pair reserves are read after the transfer), measures buy and sell tax into buckets (<5%, 5-15%, 15-50%, >=50%), reads \`owner()\`, and asks the circuit. It always reverts with \`Report(facts, allow, reason, buyOut, sellOut, delivered)\`.`);
  L.push('5. **Static check.** `scanner/src/scan.mjs` `scan()` on the same fork: dispatcher selectors against the safe allowlist and the dangerous-setter list, caller-vs-storage checks, external calls, proxy slots, `owner()`.');
  L.push('6. **Verdicts.** The facts the router would build once the scanner daemon has attested the token (RiskRegistry is keyed by token address and only counts an attestation made for the token\'s current codehash; registry flags = scan result: `ownerActive = owner() || privileged`, `upgradeable = scan.upgradeable`, `danger = dangerSetter`, `unscanned = 0`), evaluated for each mode with `circuit/truth.json`, the exhaustive truth table of the taped-out circuit (generated from `circuit/spec.py`). For every token the on-chain circuit answer in the Report was compared with the truth table' + (a.counts.circuitMismatch ? ` (**${a.counts.circuitMismatch} mismatches**)` : ' (0 mismatches)') + '.');
  L.push('7. **Plain-wallet cross-check.** Every cannot-sell and cannot-buy token was re-tried without ExitProof on the same fork, serially, inside `evm_snapshot` / `evm_revert`: a fresh impersonated EOA buys the probe amount through the PotatoSwap V2 router (`0x881fB2f98c13d521009464e7D1CBf16E1b394e8E`, `swapExactETHForTokensSupportingFeeOnTransferTokens`), waits one block, approves the router and sells its whole balance with `swapExactTokensForETHSupportingFeeOnTransferTokens` (amountOutMin 0).');
  L.push(`8. **Same state.** The stack deployment added 8 fork-only transactions from anvil test account #2 (block ${meta?.block} + 1 to + 8); they touch only the new TapeOut processor, the BEM token allowances of that account and the two new contracts, never a sampled token or pair. Inspect and scan ran at the fork head after them.`);
  L.push('');
  L.push('**Fork simulation = what ExitProof sees.** At that block, the fork runs the same bytecode with the same state as mainnet, so each Report is exactly what `inspect()` (and the identical check inside `buyETH`) would return for a real user at that block.');
  L.push('');
  L.push('## Caveats and limits');
  L.push('');
  L.push('- One block. Owner-controlled tokens can change after the snapshot (that is what the time-bomb columns measure: the power to change, not the change).');
  L.push('- A tiny probe (at most 0.001 OKB). Tokens with max-transaction / max-wallet limits or amount-dependent taxes may behave differently at larger sizes; tax buckets on very small amounts can be distorted by rounding on low-decimal tokens.');
  L.push('- The probe sells from a fresh code-less holder in the same transaction. Tokens that only trap EOAs or later blocks (cooldowns, time-based traps) can pass the probe; the static flags exist to cover that class, and they are heuristics with documented false positives (see `scanner/README.md`), mostly on strict mode.');
  L.push('- "Dangerous owner switches" means ExitProof found a listed dangerous setter, live SELFDESTRUCT, an unrecognized dispatcher, an environment fingerprint, or (scanner v9+) a state-changing function gated by a caller check, with an active owner. It is a capability, not proof of intent. The L3 owner-power simulation (`simulate()`) was not run in this census, so `ownerCanTrap` is false everywhere and the danger share is a lower bound in that respect.');
  L.push('- Dust pools (WOKB reserve below the threshold) are excluded from all percentages; many of them are rugged or abandoned launches, so the census describes live pools only.');
  L.push('- The sample is the newest pairs plus a random draw of older ones, not the full set; the recent group dominates and recent launches are riskier, so the totals are not a uniform estimate over all pairs. The per-group table separates them.');
  if (extra.notes) for (const n of extra.notes) L.push(`- ${n}`);
  L.push('');
  L.push('## Reproduce');
  L.push('');
  L.push('```');
  L.push(`N=${meta?.N} M=${meta?.M} SEED=${meta?.seed} node scanner/src/census.mjs   # writes docs/census-raw.jsonl (resumable)`);
  L.push('RESCAN=1 node scanner/src/census.mjs                 # optional: re-scan rows with the current scanner, re-run the wallet check');
  L.push('node scanner/src/census-report.mjs                    # writes docs/CENSUS.md, docs/census.json, docs/census.svg');
  L.push('git show 41ece32:docs/census-raw.jsonl > v1.jsonl && CENSUS_PREV=v1.jsonl node scanner/src/census-report.mjs   # + v1 comparison');
  L.push('```');
  L.push('');
  L.push(`Re-running at block ${meta?.block} needs an archive-capable upstream for the fork; a fresh run uses the latest block. Raw per-token rows: \`docs/census-raw.jsonl\`${extra.rawGz ? '.gz' : ''}.`);
  L.push('');
  return L.join('\n');
}

function main() {
  const inFile = path.resolve(ROOT, process.argv[2] ?? 'docs/census-raw.jsonl');
  const outDir = path.resolve(ROOT, process.argv[3] ?? 'docs');
  const { meta, runs, done, rows } = parseJsonl(fs.readFileSync(inFile, 'utf8'));
  if (!meta) throw new Error('no meta line in ' + inFile);
  const a = aggregate(rows, meta);
  const notes = (process.env.CENSUS_NOTES || '').split('||').map((x) => x.trim()).filter(Boolean);
  const rawGz = fs.existsSync(inFile + '.gz') && !fs.existsSync(inFile);
  // optional comparison with an earlier run (CENSUS_PREV=<jsonl>), e.g. the v1-router census from git history
  let compare = null, prevMeta = null;
  if (process.env.CENSUS_PREV) {
    const prev = parseJsonl(fs.readFileSync(process.env.CENSUS_PREV, 'utf8'));
    prevMeta = prev.meta;
    compare = compareRuns(prev.rows, rows);
  }
  const compareNotes = (process.env.CENSUS_COMPARE_NOTES || '').split('||').map((x) => x.trim()).filter(Boolean);
  fs.writeFileSync(path.join(outDir, 'CENSUS.md'), renderMarkdown(a, meta, {
    notes, rawGz, compare, prevMeta, compareNotes, prevCommit: process.env.CENSUS_PREV_COMMIT,
  }));
  fs.writeFileSync(path.join(outDir, 'census.svg'), renderSvg(a, meta));
  const { sample, ...metaLite } = meta;
  const { tokens, ...sampleLite } = sample;
  fs.writeFileSync(path.join(outDir, 'census.json'), JSON.stringify({
    meta: { ...metaLite, sample: sampleLite }, runs, done, summary: a,
    ...(compare ? { previousRun: { block: prevMeta.block, scannerVersion: prevMeta.scannerVersion, commit: process.env.CENSUS_PREV_COMMIT ?? null, compare } } : {}),
  }, null, 2) + '\n');
  console.log(JSON.stringify({ classified: a.classified, honeypotLikePct: a.honeypotLikePct, percent: a.percent, allowedPct: a.allowedPct }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
