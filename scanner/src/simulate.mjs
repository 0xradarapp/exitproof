// L3 sell + owner-power simulation (scanner v5). Runs ONLY against an anvil node (local or `anvil --fork-url`).
// Everything happens between evm_snapshot / evm_revert; the node is always rewound to the initial snapshot.
//
// Procedure:
//  1. Refuse unless web3_clientVersion contains "anvil".
//  2. Static scan (scan.mjs) at the fork block -> dangerous selectors, unknown selectors, owner().
//     Callers (impersonated + funded): owner(), deployer() (if exposed), the EIP-1967 admin slot, `opts.callers`
//     (the daemon passes the PairCreated sender) and up to 4 address-shaped words from storage slots 0..15 (a hidden
//     admin kept in a plain slot).
//  3. Actors are derived from the fork block hash and the token: holder = keccak(blockHash ++ token)[12:],
//     router = keccak(that ++ "router")[12:]. Reproducible given the block, unpredictable before it (a token cannot
//     whitelist the simulator). SimRouter (src/sim/SimRouter.sol) is installed at `router` with anvil_setCode: a V2
//     router stand-in that sells with approve + transferFrom(user, pair) + swap, as a wallet user on PotatoSwap does.
//  4. Position: the holder gets quote (WETH-style deposit(), else the pair transfers 3% of its quote reserve), approves
//     the router and buys 1% (then 0.1%, 0.01%) of the quote reserve through it. Fallback: the pair transfers 1% of
//     its token reserve to the holder (`acquiredVia: pair-transfer`).
//  5. Sells (each in its own snapshot):
//       immediate  = SimRouter.roundTrip: buy and sell back in ONE transaction (same block as receipt);
//       delayed    = router sell of the whole position after +1 block, +60 s, +1 h, +1 day;
//       transfer   = holder.transfer(pair) + swap (the old path) after +1 h.
//     A sell "passes" when it executes and returns >= 50% of the no-tax V2 output for the amount sold.
//     Baseline = the +1 h router sell (or +1 d if only that passes). If nothing passes, owner "unlock" calls present
//     in the dispatcher (enableTrading/openTrading/.../setAuthorizedBuyer(holder)) are applied cumulatively and the
//     sells re-measured.
//  6. Signals (each makes the simulation verdict fail closed; all also set `privileged`, because balanced mode only
//     denies ownerActive & danger and the router's ownerActive is `fl.privileged || owner() != 0`):
//       delayed-sell-trap    immediate passes, some delayed sell fails           -> dangerSetter
//       transferFrom-trap    transfer path passes, router (transferFrom) fails   -> ownerCanTrap
//       baseline-sell-failed no sell passes at all, even after unlocks          -> ownerCanTrap
//  7. Owner sweeps against the baseline state (snapshot, call, router sell, revert; trapped = sell fails or returns
//     < 50% of the baseline):
//       a. dangerous-list setters with typed worst-case args (uintN 0/99/100/10000/max, address pair/holder,
//          bool, address[]), cartesian product <= 32 else index-aligned;
//       b. F-04: every other dispatcher selector outside SAFE (ABI-less): four identical words for 0, max, 1, 10000,
//          and [holder,1,1,1], [pair,1,1,1]. At most MAX_UNKNOWN_SELECTORS selectors and a wall-clock budget;
//          an incomplete sweep with a privileged caller fails closed (`unknown-sweep-incomplete`).
//     Any trapped attempt -> ownerCanTrap. An exception after a good baseline -> ownerCanTrap (simulate-error).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient, http, encodeFunctionData, decodeFunctionResult, decodeEventLog, parseAbi, parseAbiItem,
  getAddress, toFunctionSelector, keccak256, concat, toHex, maxUint256,
} from 'viem';
import { scan } from './scan.mjs';
import { isAddress20 } from './proxy.mjs';
import { DANGEROUS } from './selectors.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
export const SIM_ROUTER = Object.freeze(JSON.parse(readFileSync(path.join(DIR, 'sim', 'sim-router.json'), 'utf8')));

const TX_GAS = '0x7a1200'; // 8,000,000
const FUND = '0x3635c9adc5dea00000'; // 1000 ether
const ASSUMED_FEE_BPS = 100n;
const MAX_COMBOS = 32;
export const DELAYS = Object.freeze([['+1block', 0], ['+60s', 60], ['+1h', 3600], ['+1d', 86400]]);
export const MAX_UNKNOWN_SELECTORS = 40;
export const UNKNOWN_PATTERNS = Object.freeze(['0', 'max', 'holder', 'pair', '1', '10000']);
export const DEFAULT_BUDGET_MS = 180_000;
const STORAGE_CALLER_SLOTS = 16;
const MAX_STORAGE_CALLERS = 4;

/** Owner "unlock" calls tried (in this order) when no sell passes, e.g. trading not yet enabled. */
const UNLOCKS = [
  ['enableTrading()', () => []], ['openTrading()', () => []], ['startTrading()', () => []], ['unpause()', () => []],
  ['enableTrading(bool)', () => [true]], ['setTradingEnabled(bool)', () => [true]], ['setTrading(bool)', () => [true]],
  ['setTradingOpen(bool)', () => [true]], ['tradingStatus(bool)', () => [true]], ['setPaused(bool)', () => [false]],
  ['setAuthorizedBuyer(address)', (c) => [c.holder]],
];

const ERC20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
  'function approve(address,uint256) returns (bool)',
  'function deposit() payable',
]);
const PAIR = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function getReserves() view returns (uint112,uint112,uint32)',
  'function swap(uint256,uint256,address,bytes)',
  'function sync()',
]);
const ROUTER_ABI = parseAbi([
  'function buy(address pair, address quote, address token, uint256 qIn, uint256 feeBps)',
  'function sell(address pair, address quote, address token, uint256 amount, uint256 feeBps)',
  'function roundTrip(address pair, address quote, address token, uint256 qIn, uint256 feeBps)',
  'event Bought(bool ok, uint256 got)',
  'event Sold(bool ok, uint8 stage, uint256 amount, uint256 expectedOut, uint256 actualOut)',
]);
const SELL_STAGES = ['ok', 'reserves', 'transferFrom', 'nothing-arrived', 'swap', 'no-quote-received'];
const DEPLOYER = parseAbiItem('function deployer() view returns (address)');

const amountOut = (amountIn, rIn, rOut) => {
  if (amountIn <= 0n || rIn <= 0n || rOut <= 0n) return 0n;
  const inFee = amountIn * (10000n - ASSUMED_FEE_BPS);
  return (inFee * rOut) / (rIn * 10000n + inFee);
};

/** Simulation actors for `token` at the block with hash `blockHash` (reproducible given the block). */
export function deriveActors(blockHash, token) {
  const h = keccak256(concat([blockHash, getAddress(token)]));
  const r = keccak256(concat([h, toHex('router')]));
  return { holder: getAddress(`0x${h.slice(-40)}`), router: getAddress(`0x${r.slice(-40)}`) };
}

function argOptions(type, ctx) {
  const m = /^uint(\d*)$/.exec(type);
  if (m) {
    const bits = BigInt(m[1] || 256);
    const max = (1n << bits) - 1n;
    return [...new Set([0n, 99n, 100n, 10000n, max].map((v) => (v > max ? max : v)))];
  }
  if (type === 'address') return [ctx.pair, ctx.holder];
  if (type === 'bool') return [true, false];
  if (type === 'address[]') return [[ctx.holder, ctx.pair]];
  return null;
}

export function argVariants(signature, ctx) {
  const inner = signature.slice(signature.indexOf('(') + 1, -1);
  const types = inner === '' ? [] : inner.split(',');
  const opts = types.map((t) => argOptions(t, ctx));
  if (opts.some((o) => o === null)) return null;
  if (types.length === 0) return [[]];
  const product = opts.reduce((n, o) => n * o.length, 1);
  if (product <= MAX_COMBOS) {
    let acc = [[]];
    for (const o of opts) acc = acc.flatMap((prefix) => o.map((v) => [...prefix, v]));
    return acc;
  }
  const k = Math.max(...opts.map((o) => o.length));
  return Array.from({ length: k }, (_, i) => opts.map((o) => o[i % o.length]));
}

const word = (v) => BigInt(v).toString(16).padStart(64, '0');
/** ABI-less worst-case calldata for an unknown selector: four 32-byte words (extra words are ignored by solc). */
export function unknownCalldata(selector, pattern, ctx) {
  const W = {
    0: [0n, 0n, 0n, 0n], max: [maxUint256, maxUint256, maxUint256, maxUint256], 1: [1n, 1n, 1n, 1n],
    10000: [10000n, 10000n, 10000n, 10000n], holder: [ctx.holder, 1n, 1n, 1n], pair: [ctx.pair, 1n, 1n, 1n],
  }[pattern];
  if (!W) throw new Error(`unknown pattern ${pattern}`);
  return `${selector}${W.map(word).join('')}`;
}

const toJson = (v) => (typeof v === 'bigint' ? v.toString() : Array.isArray(v) ? v.map(toJson) : v);
const passes = (r) => !!r && r.ok && r.expected > 0n && r.actual * 2n >= r.expected;
const sellJson = (r) => (r ? {
  ok: r.ok, stage: r.stage, passes: passes(r), amount: r.amount.toString(), expectedOut: r.expected.toString(),
  actualOut: r.actual.toString(),
} : null);

export async function assertAnvil(client) {
  let v = '';
  try { v = String(await client.request({ method: 'web3_clientVersion' })); } catch { /* fallthrough */ }
  if (!/anvil/i.test(v)) throw new Error(`simulate: refusing non-anvil RPC (web3_clientVersion=${v || 'n/a'})`);
}

/**
 * Folds a simulation result into a scan result (mutates and returns `r`): flags are only ever raised.
 */
export function mergeSimulation(r, sim) {
  r.ownerCanTrap = !!(r.ownerCanTrap || sim.ownerCanTrap);
  r.dangerSetter = !!(r.dangerSetter || sim.dangerSetter);
  r.privileged = !!(r.privileged || sim.privileged);
  r.evidence.simulation = sim.evidence;
  if (sim.timing) r.evidence.simulationTiming = sim.timing;
  return r;
}

/**
 * simulate(forkRpc, token, pair, opts) -> { ownerCanTrap, dangerSetter, privileged, signals, evidence, timing }
 * opts: holder (override the derived holder; tests only), callers (extra privileged callers), budgetMs,
 * maxUnknown, unknown (false = skip the F-04 sweep).
 */
export async function simulate(forkRpc, token, pairAddr, opts = {}) {
  const t0 = Date.now();
  const client = createPublicClient({ transport: http(forkRpc) });
  await assertAnvil(client);
  const rpc = (method, params = []) => client.request({ method, params });
  token = getAddress(token);
  const pair = getAddress(pairAddr);
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  const maxUnknown = opts.maxUnknown ?? MAX_UNKNOWN_SELECTORS;
  const impersonated = new Set();
  const timing = {};

  const read = async (address, abi, functionName, args = []) => {
    const data = encodeFunctionData({ abi, functionName, args });
    const { data: ret } = await client.call({ to: address, data, gas: 1_000_000n });
    return decodeFunctionResult({ abi, functionName, data: ret });
  };
  const tryRead = async (...a) => { try { return await read(...a); } catch { return null; } };
  const impersonate = async (who) => {
    if (!impersonated.has(who)) {
      await rpc('anvil_impersonateAccount', [who]);
      impersonated.add(who);
    }
    await rpc('anvil_setBalance', [who, FUND]);
  };
  /** Sends a tx from an impersonated account; returns the receipt or null (rejected / reverted / not mined). */
  const sendTx = async (from, to, data, value = 0n) => {
    try {
      const hash = await rpc('eth_sendTransaction', [{
        from, to, data, gas: TX_GAS, value: `0x${value.toString(16)}`,
      }]);
      for (let i = 0; i < 400; i++) {
        const r = await rpc('eth_getTransactionReceipt', [hash]);
        if (r) return r.status === '0x1' ? r : null;
        await new Promise((res) => setTimeout(res, 10));
      }
      return null;
    } catch {
      return null; // node-side rejection (e.g. revert surfaced at submission)
    }
  };
  const send = async (...a) => (await sendTx(...a)) !== null;
  const snapshot = () => rpc('evm_snapshot');
  const revert = async (id) => {
    if (!(await rpc('evm_revert', [id]))) throw new Error(`simulate: evm_revert(${id}) failed`);
  };
  const inSnapshot = async (fn) => {
    const snap = await snapshot();
    try { return await fn(); } finally { await revert(snap); }
  };
  const advance = async (secs) => {
    if (secs > 0) await rpc('evm_increaseTime', [secs]);
    await rpc('evm_mine');
  };

  const initial = await snapshot();
  const run = async () => {
    const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
    const block = await client.getBlock({ blockNumber });
    const s = await scan(client, token, { blockNumber });
    const actors = deriveActors(block.hash, token);
    const holder = getAddress(opts.holder ?? actors.holder);
    const { router } = actors;
    await rpc('anvil_setCode', [router, SIM_ROUTER.runtime]);

    const [t0a, t1a] = [await read(pair, PAIR, 'token0'), await read(pair, PAIR, 'token1')];
    if (getAddress(t0a) !== token && getAddress(t1a) !== token) throw new Error('simulate: token not in pair');
    const tokenIs0 = getAddress(t0a) === token;
    const quote = getAddress(tokenIs0 ? t1a : t0a);

    // ---- privileged callers ----
    const callers = [];
    const exclude = new Set([token, pair, quote, holder, router]);
    const addCaller = (a) => {
      if (!isAddress20(a) || BigInt(a) <= 0xffffn) return;
      const g = getAddress(a);
      if (!exclude.has(g) && !callers.includes(g)) callers.push(g);
    };
    addCaller(s.evidence.owner);
    addCaller(await tryRead(token, [DEPLOYER], 'deployer'));
    addCaller(s.evidence.proxySlots.eip1967Admin);
    for (const c of opts.callers ?? []) addCaller(c);
    const storageCallers = [];
    for (let i = 0; i < STORAGE_CALLER_SLOTS && storageCallers.length < MAX_STORAGE_CALLERS; i++) {
      const w = BigInt(await client.getStorageAt({ address: token, slot: toHex(i, { size: 32 }), blockNumber }) ?? '0x0');
      if (w >> 160n !== 0n || w < 1n << 120n) continue; // not address-shaped (amounts, flags, packed words)
      const a = getAddress(`0x${w.toString(16).padStart(40, '0')}`);
      if (exclude.has(a) || callers.includes(a)) continue;
      storageCallers.push(a);
      callers.push(a);
    }

    const reserves = async () => {
      const [r0, r1] = await read(pair, PAIR, 'getReserves');
      return tokenIs0 ? { rT: r0, rQ: r1 } : { rT: r1, rQ: r0 };
    };
    const bal = async (t, who) => (await read(t, ERC20, 'balanceOf', [who]));
    const safeBal = async (t, who) => { try { return await bal(t, who); } catch { return null; } };
    const swapData = (outT, outQ, to) => encodeFunctionData({
      abi: PAIR, functionName: 'swap', args: [tokenIs0 ? outT : outQ, tokenIs0 ? outQ : outT, to, '0x'],
    });
    const routerLogs = (rc) => (rc?.logs ?? [])
      .filter((l) => getAddress(l.address) === router)
      .map((l) => { try { return decodeEventLog({ abi: ROUTER_ABI, data: l.data, topics: l.topics }); } catch { return null; } })
      .filter(Boolean);
    const soldOf = (rc) => {
      const e = routerLogs(rc).find((x) => x.eventName === 'Sold');
      if (!e) return { ok: false, stage: rc ? 'no-event' : 'reverted', amount: 0n, expected: 0n, actual: 0n };
      return {
        ok: e.args.ok, stage: SELL_STAGES[e.args.stage] ?? String(e.args.stage), amount: e.args.amount,
        expected: e.args.expectedOut, actual: e.args.actualOut,
      };
    };
    const approveRouter = (t) => send(holder, t, encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [router, maxUint256] }));

    await impersonate(holder);
    for (const c of callers) await impersonate(c);

    // ---- holder funding + position ----
    const fundQuote = async () => {
      const { rQ } = await reserves();
      const amt = (rQ * 3n) / 100n;
      if (amt === 0n) return 'none';
      if (await send(holder, quote, encodeFunctionData({ abi: ERC20, functionName: 'deposit' }), amt)) return 'deposit';
      await impersonate(pair);
      const ok = await send(pair, quote, encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [holder, amt] }));
      await send(holder, pair, encodeFunctionData({ abi: PAIR, functionName: 'sync' }));
      return ok ? 'pair-transfer' : 'none';
    };
    const funding = await fundQuote();
    await approveRouter(quote);
    let qIn = 0n;
    const acquire = async () => {
      const { rT, rQ } = await reserves();
      for (const div of [100n, 1000n, 10000n]) {
        const q = rQ / div;
        if (q === 0n) continue;
        const rc = await sendTx(holder, router, encodeFunctionData({
          abi: ROUTER_ABI, functionName: 'buy', args: [pair, quote, token, q, ASSUMED_FEE_BPS],
        }));
        const e = routerLogs(rc).find((x) => x.eventName === 'Bought');
        if (e?.args.ok && e.args.got > 0n) { qIn = q; return `buy-1/${div}`; }
      }
      await impersonate(pair);
      await send(pair, token, encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [holder, rT / 100n] }));
      await send(holder, pair, encodeFunctionData({ abi: PAIR, functionName: 'sync' }));
      return 'pair-transfer';
    };

    const routerSell = async () => soldOf(await sendTx(holder, router, encodeFunctionData({
      abi: ROUTER_ABI, functionName: 'sell', args: [pair, quote, token, 0n, ASSUMED_FEE_BPS],
    })));
    const transferSell = async () => {
      try {
        const amt = await bal(token, holder);
        if (amt === 0n) return { ok: false, stage: 'no-position', amount: 0n, expected: 0n, actual: 0n };
        const { rT, rQ } = await reserves();
        const expected = amountOut(amt, rT, rQ);
        const q0 = await bal(quote, holder);
        const fail = (stage) => ({ ok: false, stage, amount: amt, expected, actual: 0n });
        if (!(await send(holder, token, encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [pair, amt] })))) {
          return fail('transfer');
        }
        const actualIn = (await bal(token, pair)) - rT;
        const out = amountOut(actualIn, rT, rQ);
        if (out <= 0n) return fail('nothing-arrived');
        if (!(await send(holder, pair, swapData(0n, out, holder)))) return fail('swap');
        return { ok: true, stage: 'ok', amount: amt, expected, actual: (await bal(quote, holder)) - q0 };
      } catch {
        return { ok: false, stage: 'unreadable', amount: 0n, expected: 0n, actual: 0n };
      }
    };

    /** Full sell measurement from the current state; leaves the chain advanced to the baseline time. */
    const measureAll = async () => {
      let via = null;
      if (((await safeBal(token, holder)) ?? 0n) === 0n) via = await acquire();
      await approveRouter(token);
      const immediate = qIn > 0n
        ? await inSnapshot(async () => soldOf(await sendTx(holder, router, encodeFunctionData({
          abi: ROUTER_ABI, functionName: 'roundTrip', args: [pair, quote, token, qIn, ASSUMED_FEE_BPS],
        }))))
        : null; // could not buy through the router: no same-transaction measurement
      const delayed = [];
      for (const [label, secs] of DELAYS) {
        delayed.push({ label, ...(await inSnapshot(async () => { await advance(secs); return routerSell(); })) });
      }
      // move to the baseline time: +1 h, or +1 d when only that one passes
      const dl = Object.fromEntries(delayed.map((d) => [d.label, d]));
      const at = !passes(dl['+1h']) && passes(dl['+1d']) ? '+1d' : '+1h';
      await advance(at === '+1d' ? 86400 : 3600);
      const transfer = await inSnapshot(transferSell);
      return { via, immediate, delayed, transfer, baselineAt: at, baseline: dl[at] };
    };

    const evidence = {
      block: { number: blockNumber.toString(), hash: block.hash }, holder, holderDerived: !opts.holder, router,
      routerRuntimeHash: keccak256(SIM_ROUTER.runtime), callers, storageCallers, quote, funding,
      acquiredVia: null, position: '0', unlockedBy: [], baselineSellOk: false, baselineAt: null, expectedOut: '0',
      immediate: null, delayed: [], transferSell: null, signals: [], attempts: [], skipped: [],
      unknownAttempts: [], unknownSweep: null,
    };
    const record = (m) => {
      if (m.via) evidence.acquiredVia = m.via;
      evidence.immediate = sellJson(m.immediate);
      evidence.delayed = m.delayed.map((d) => ({ label: d.label, ...sellJson(d) }));
      evidence.transferSell = sellJson(m.transfer);
      evidence.baselineAt = m.baselineAt;
    };
    const anyPass = (m) => passes(m.immediate) || m.delayed.some(passes) || passes(m.transfer);

    let m = await measureAll();
    record(m);
    // Launch-pending tokens (trading disabled / paused / allow-listed buyer): let the owner unlock first so the
    // checks below run against the tradeable state. Unlock calls are cumulative.
    if (!passes(m.baseline) && !anyPass(m)) {
      const present = new Set(s.evidence.dangerous.map((d) => d.signature));
      for (const [signature, argsOf] of UNLOCKS) {
        if (!present.has(signature)) continue;
        const data = encodeFunctionData({
          abi: [parseAbiItem(`function ${signature}`)],
          functionName: signature.slice(0, signature.indexOf('(')),
          args: argsOf({ holder }),
        });
        let applied = false;
        for (const caller of callers) if ((applied = await send(caller, token, data))) break;
        if (!applied) continue;
        evidence.unlockedBy.push(signature);
        m = await measureAll();
        record(m);
        if (passes(m.baseline)) break;
      }
    }
    timing.sellsMs = Date.now() - t0;

    const pos = await safeBal(token, holder);
    evidence.position = pos === null ? 'unreadable' : pos.toString();
    evidence.baselineSellOk = !!m.baseline?.ok;
    evidence.expectedOut = (m.baseline?.actual ?? 0n).toString();

    const out = { ownerCanTrap: false, dangerSetter: false, privileged: false, signals: evidence.signals, evidence, timing };
    const signal = (name, flag) => {
      evidence.signals.push(name);
      out[flag] = true;
      out.privileged = true;
    };
    if (passes(m.immediate) && m.delayed.some((d) => !passes(d))) signal('delayed-sell-trap', 'dangerSetter');
    if (passes(m.transfer) && !passes(m.baseline)) signal('transferFrom-trap', 'ownerCanTrap');
    if (!anyPass(m)) {
      if (evidence.position === '0') evidence.note = 'no holder position';
      signal('baseline-sell-failed', 'ownerCanTrap');
    }
    if (!passes(m.baseline)) return out; // no baseline to compare owner actions against

    const baseline = m.baseline;
    const ctx = { pair, holder };
    const trappedBy = (r) => !r.ok || r.actual * 2n < baseline.actual;
    // After a good baseline, any failure to finish the owner-power sweeps is treated as a trap (fail closed).
    try {
      // ---- a. dangerous-list setters (typed args) ----
      const ta = Date.now();
      for (const { signature } of s.evidence.dangerous) {
        const variants = argVariants(signature, ctx);
        if (!variants) { evidence.skipped.push(signature); continue; }
        const abi = [parseAbiItem(`function ${signature}`)];
        const name = signature.slice(0, signature.indexOf('('));
        for (const args of variants) {
          const data = encodeFunctionData({ abi, functionName: name, args });
          if (data.slice(0, 10) !== toFunctionSelector(signature)) throw new Error('selector mismatch');
          for (const caller of callers) {
            const attempt = await inSnapshot(async () => {
              if (!(await send(caller, token, data))) return null;
              const r = await routerSell();
              return { signature, args: toJson(args), caller, sellOk: r.ok, out: r.actual.toString(), trapped: trappedBy(r) };
            });
            if (attempt) {
              evidence.attempts.push(attempt);
              if (attempt.trapped) out.ownerCanTrap = true;
              break; // one successful caller per variant is enough
            }
          }
        }
      }
      timing.dangerousMs = Date.now() - ta;

      // ---- b. F-04: unknown selectors, ABI-less worst-case words ----
      if (opts.unknown !== false) {
        const tb = Date.now();
        const dangerousSel = new Set(s.evidence.dangerous.map((d) => d.selector));
        const unknown = s.evidence.unknownSelectors.filter((x) => !DANGEROUS[x] && !dangerousSel.has(x));
        const todo = unknown.slice(0, maxUnknown);
        const sweep = {
          selectors: unknown.length, tried: 0, patterns: UNKNOWN_PATTERNS.length, calls: 0, complete: true,
          truncatedBy: null, callers: callers.length, trapped: [],
        };
        evidence.unknownSweep = sweep;
        if (unknown.length > maxUnknown) { sweep.complete = false; sweep.truncatedBy = `max-selectors(${maxUnknown})`; }
        if (callers.length) {
          outer: for (const selector of todo) {
            sweep.tried++;
            for (const pattern of UNKNOWN_PATTERNS) {
              if (Date.now() - t0 > budgetMs) {
                sweep.complete = false;
                sweep.truncatedBy = `budget(${budgetMs}ms)`;
                break outer;
              }
              const data = unknownCalldata(selector, pattern, ctx);
              for (const caller of callers) {
                sweep.calls++;
                const attempt = await inSnapshot(async () => {
                  if (!(await send(caller, token, data))) return null;
                  const r = await routerSell();
                  return { selector, pattern, caller, sellOk: r.ok, out: r.actual.toString(), trapped: trappedBy(r) };
                });
                if (!attempt) continue;
                if (attempt.trapped) {
                  evidence.unknownAttempts.push(attempt);
                  if (!sweep.trapped.includes(selector)) sweep.trapped.push(selector);
                  out.ownerCanTrap = true;
                }
                break; // first caller whose call succeeds
              }
            }
          }
          for (const sel of sweep.trapped) evidence.signals.push(`unknown-setter-trap:${sel}`);
          if (!sweep.complete) {
            evidence.signals.push('unknown-sweep-incomplete');
            out.ownerCanTrap = true;
          }
        } else if (unknown.length) {
          sweep.complete = false;
          sweep.truncatedBy = 'no-privileged-caller';
        }
        timing.unknownMs = Date.now() - tb;
      }
    } catch (e) {
      evidence.error = `simulate-error: ${e.shortMessage ?? e.message}`;
      evidence.signals.push('simulate-error');
      out.ownerCanTrap = true;
      out.privileged = true;
      return out;
    }
    if (evidence.attempts.some((a) => a.trapped)) evidence.signals.push('dangerous-setter-trap');
    out.privileged ||= out.ownerCanTrap;
    return out;
  };
  let result;
  let thrown = null;
  try {
    result = await run();
  } catch (e) {
    thrown = e;
  }
  // Always rewind; a failing rewind must not replace the result (it is recorded instead).
  let restoreError = null;
  try {
    await revert(initial);
  } catch (e) {
    restoreError = `evm_revert(initial) failed: ${e.shortMessage ?? e.message}`;
  }
  for (const who of impersonated) {
    try { await rpc('anvil_stopImpersonatingAccount', [who]); } catch { /* best effort */ }
  }
  if (thrown) throw thrown;
  if (restoreError) result.evidence.restoreError = restoreError;
  timing.totalMs = Date.now() - t0;
  result.timing = timing;
  return result;
}
