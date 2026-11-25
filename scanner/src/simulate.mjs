// L3 sell + owner-power simulation (scanner v5). Runs ONLY against an anvil node (local or `anvil --fork-url`).
// Everything happens between evm_snapshot / evm_revert; the node is always rewound to the initial snapshot.
//
// Procedure:
//  1. Refuse unless web3_clientVersion contains "anvil".
//  2. Static scan (scan.mjs) at the fork block -> dangerous selectors, unknown selectors, owner().
//     Callers (impersonated + funded): owner(), deployer() (if exposed), the EIP-1967 admin slot, `opts.callers`
//     (the daemon passes the PairCreated sender), the addresses compared with CALLER in the code (immutable admins),
//     the token's creator (creation tx sender, first mint recipients) and up to 4 address-shaped words from storage
//     slots 0..15 (a hidden admin kept in a plain slot).
//     N-02: the fork's coinbase, gas limit and next base fee are set to the forked block's values first.
//  3. Actors are derived from the fork block hash and the token: holder = keccak(blockHash ++ token)[12:],
//     router = keccak(that ++ "router")[12:]. Reproducible given the block, unpredictable before it (a token cannot
//     whitelist the simulator). SimRouter (src/sim/SimRouter.sol) is installed at `router` with anvil_setCode: a V2
//     router stand-in that sells with approve + transferFrom(user, pair) + swap, as a wallet user on PotatoSwap does.
//  4. Position: the holder gets quote (WETH-style deposit(), else the pair transfers 3% of its quote reserve), approves
//     the router and buys 1% (then 0.1%, 0.01%) of the quote reserve through it. Fallback: the pair transfers 1% of
//     its token reserve to the holder (`acquiredVia: pair-transfer`).
//  5. Sells (each in its own snapshot):
//       immediate  = SimRouter.roundTrip: buy and sell back in ONE transaction (same block as receipt);
//       delayed    = router sell of the whole position after +1 block, +60 s, +1 h, +1 d, +7 d, +30 d;
//       transfer   = holder.transfer(pair) + swap (the old path) after +1 h;
//       interleaved = after +1 h, a third (random) address buys first, then the holder sells (N-03).
//     A sell "passes" when it executes and returns >= 50% of the no-tax V2 output for the amount sold.
//     Baseline = the +1 h router sell (or +1 d if only that passes). If nothing passes, owner "unlock" calls present
//     in the dispatcher (enableTrading/openTrading/.../setAuthorizedBuyer(holder)) are applied cumulatively and the
//     sells re-measured.
//  6. Signals (each makes the simulation verdict fail closed; all also set `privileged`, because balanced mode only
//     denies ownerActive & danger and the router's ownerActive is `fl.privileged || owner() != 0`):
//       delayed-sell-trap    immediate passes, some delayed sell fails           -> dangerSetter
//       transferFrom-trap    transfer path passes, router (transferFrom) fails   -> ownerCanTrap
//       baseline-sell-failed no sell passes at all, even after unlocks          -> ownerCanTrap
//       delayed-tax-jump     a later sell lands in a higher router tax bucket    -> dangerSetter
//       sequence-trap        baseline passes, the interleaved sell fails         -> dangerSetter
//  7. Owner sweeps against the baseline state (snapshot, call, router sell, revert; trapped = sell fails or returns
//     < 50% of the baseline):
//       a. dangerous-list setters with typed worst-case args (uintN 0/99/100/10000/max, address pair/holder,
//          bool, address[]), cartesian product <= 32 else index-aligned;
//       b. F-04 / N-01: every other dispatcher selector outside SAFE (ABI-less): four identical words for 0, max,
//          1, 10000, and [holder,1,1,1], [pair,1,1,1], plus [K,10000..] / [K,max..] for each constant K the selector's
//          code compares with (magic arguments). Then two-step pairs: each state-changing call (prestateTracer
//          diff) followed by every other unknown selector (MAX_PAIRS). At most MAX_UNKNOWN_SELECTORS and a
//          wall-clock budget. `complete` only when every selector was executed without revert by some identity;
//          an incomplete sweep on a token with an owner or a caller check fails closed (sweep-incomplete ->
//          dangerSetter).
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
export const DELAYS = Object.freeze([
  ['+1block', 0], ['+60s', 60], ['+1h', 3600], ['+1d', 86400], ['+7d', 7 * 86400], ['+30d', 30 * 86400],
]);
export const MAX_PAIRS = 120; // two-step sequences (first setter, second setter) per token
const TAX_BUCKETS = [500n, 1500n, 5000n]; // the router's sell-tax bucket edges (bps)
export const MAX_UNKNOWN_SELECTORS = 40;
export const UNKNOWN_PATTERNS = Object.freeze(['0', 'max', 'holder', 'pair', '1', '10000']);
export const DEFAULT_BUDGET_MS = 180_000;
const STORAGE_CALLER_SLOTS = 16;
const MAX_STORAGE_CALLERS = 8;
// byte offsets at which an address is tried inside a storage word (packed after bool/uint8/16/32/64/96)
const PACK_OFFSETS = [0, 1, 2, 4, 8, 12];
const MAX_HINT_PATTERNS = 32; // per selector: hint x argument position x {10000, max}

/** SWEEP_BUDGET_S (default 180): wall-clock budget of one token's simulation, in ms. Validated. */
export function sweepBudgetMs(env = process.env) {
  if (env.SWEEP_BUDGET_S === undefined || env.SWEEP_BUDGET_S === '') return DEFAULT_BUDGET_MS;
  const sec = Number(env.SWEEP_BUDGET_S);
  if (!(sec > 0)) throw new Error(`SWEEP_BUDGET_S must be a positive number of seconds (got ${env.SWEEP_BUDGET_S})`);
  return Math.round(sec * 1000);
}

/**
 * Address-shaped values inside a storage word. A word < 2^160 is a plain address. Otherwise two packings are tried:
 * the low 160 bits (address declared first, small values after it) and the address as the highest packed variable at
 * a byte offset 1, 2, 4, 8 or 12 (bool / uint8 / 16 / 32 / 64 / 96 declared before it). Values < 2^120 are ignored.
 */
export function packedAddresses(word) {
  const w = BigInt(word ?? 0);
  const M = (1n << 160n) - 1n;
  const out = [];
  const add = (v) => { if (v >= 1n << 120n) out.push(getAddress(`0x${v.toString(16).padStart(40, '0')}`)); };
  if (w <= M) { add(w); return out; }
  for (const off of PACK_OFFSETS.slice(1)) if (w >> BigInt(off * 8 + 160) === 0n) add((w >> BigInt(off * 8)) & M);
  add(w & M);
  return [...new Set(out)];
}

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

/**
 * owner() or getOwner() returns exactly one zero word at the pinned block (ownership renounced, as opposed to no
 * getter at all), and the storage slots that getter reads (prestateTracer of the call): only caller-vs-storage
 * checks on those slots belong to the renounced owner.
 */
async function ownerRenounced(client, rpc, token, blockNumber) {
  for (const data of ['0x8da5cb5b', '0x893d20e8']) {
    let ret;
    try {
      ({ data: ret } = await client.call({ to: token, data, gas: 100_000n, blockNumber }));
    } catch { continue; } // no such getter
    if (!ret || ret.length !== 66 || BigInt(ret) !== 0n) continue;
    let slots = [];
    try {
      const pre = await rpc('debug_traceCall', [{ to: token, data, gas: '0x186a0' }, toHex(blockNumber), { tracer: 'prestateTracer' }]);
      slots = Object.keys(pre?.[token.toLowerCase()]?.storage ?? {}).map((k) => `0x${BigInt(k).toString(16)}`);
    } catch { /* tracer unavailable: no slot is attributed to the owner (fail closed) */ }
    return { renounced: true, slots };
  }
  return { renounced: false, slots: [] };
}

const taxBucket = (r) => {
  if (!r || r.expected === 0n) return 3;
  if (r.actual >= r.expected) return 0;
  const bps = ((r.expected - r.actual) * 10000n + r.expected - 1n) / r.expected;
  return TAX_BUCKETS.findIndex((edge) => bps < edge) === -1 ? 3 : TAX_BUCKETS.findIndex((edge) => bps < edge);
};

/**
 * N-02: make the fork's block environment look like the chain it forks. anvil mines with coinbase 0x0 and its own
 * base fee / gas limit; X Layer's coinbase is 0x4200...0011. Values come from the fork block (anvil_nodeInfo
 * forkConfig), or from the latest block on a plain node. PREVRANDAO cannot be set on anvil (residual, see README).
 */
async function neutralizeEnv(client, rpc, blockNumber) {
  let forkBlock = null;
  try { forkBlock = (await rpc('anvil_nodeInfo'))?.forkConfig?.forkBlockNumber ?? null; } catch { /* not exposed */ }
  const ref = await client.getBlock({ blockNumber: forkBlock !== null ? BigInt(forkBlock) : blockNumber });
  const env = {
    refBlock: Number(ref.number), coinbase: getAddress(ref.miner), gasLimit: ref.gasLimit.toString(),
    baseFee: ref.baseFeePerGas?.toString() ?? null, chainId: await client.getChainId(), prevrandao: 'not settable on anvil',
  };
  await rpc('anvil_setCoinbase', [env.coinbase]);
  await rpc('evm_setBlockGasLimit', [toHex(ref.gasLimit)]);
  if (ref.baseFeePerGas !== undefined && ref.baseFeePerGas !== null) {
    await rpc('anvil_setNextBlockBaseFeePerGas', [toHex(ref.baseFeePerGas)]);
  }
  return env;
}

/**
 * The token's creator: ots_getContractCreator (anvil answers it for contracts created on the node), else the
 * creation block found by bisecting eth_getCode, whose transaction senders (bounded) are taken. Plus the recipients
 * of mints (Transfer from 0x0) in the creation block. Best effort: errors give an empty list.
 */
async function findCreator(client, rpc, token, blockNumber) {
  const from = new Set();
  const txs = new Set();
  let createdAt = null;
  let via = 'none';
  try {
    const c = await rpc('ots_getContractCreator', [token]);
    if (c?.creator) {
      from.add(getAddress(c.creator));
      const tx = await client.getTransaction({ hash: c.hash });
      from.add(getAddress(tx.from));
      createdAt = tx.blockNumber;
      txs.add(c.hash);
      via = 'ots';
    }
  } catch { /* not supported */ }
  try {
    if (createdAt === null) {
      let lo = 0n;
      let hi = blockNumber; // code at hi, find the first block with code
      for (let i = 0; i < 64 && lo < hi; i++) {
        const mid = (lo + hi) / 2n;
        const code = await client.getCode({ address: token, blockNumber: mid });
        if (code && code !== '0x') hi = mid; else lo = mid + 1n;
      }
      createdAt = hi;
      // the creating transaction: the one whose receipt created the token or carries the token's logs (its mint)
      const b = await client.getBlock({ blockNumber: hi, includeTransactions: true });
      let receipts = null;
      try { receipts = await rpc('eth_getBlockReceipts', [toHex(hi)]); } catch { /* not supported */ }
      const lc = token.toLowerCase();
      const creating = (receipts ?? []).filter((r) => r.contractAddress?.toLowerCase() === lc
        || r.logs?.some((l) => l.address.toLowerCase() === lc));
      for (const r of creating) txs.add(r.transactionHash);
      const senders = creating.length ? creating.map((r) => r.from) : b.transactions.slice(0, 10).map((tx) => tx.from);
      for (const f of senders) if (f && !/^0xdeaddeaddeaddeaddeaddeaddeaddeaddead/i.test(f)) from.add(getAddress(f));
      via = creating.length ? 'bisect+receipt' : 'bisect';
    }
    const mints = await client.getLogs({
      address: token, fromBlock: createdAt, toBlock: createdAt,
      event: parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)'),
      args: { from: '0x0000000000000000000000000000000000000000' },
    });
    for (const l of mints) if (l.args.to) from.add(getAddress(l.args.to));
  } catch { /* best effort */ }
  return { via, block: createdAt === null ? null : Number(createdAt), from: [...from].sort(), txs: [...txs].sort() };
}

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
 * maxUnknown, unknown (false = skip the F-04 sweep); tests only: noHints, hintPositions.
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
    const chainEnv = await neutralizeEnv(client, rpc, blockNumber);
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
    // v6 (N-01): immutable / constant admins compared with CALLER, and the token's creator (creation tx sender and
    // the first mint's recipients): a mapping admin is usually whoever deployed the token.
    for (const a of s.evidence.callerLiterals ?? []) addCaller(a);
    const creator = opts.creator ? { from: [getAddress(opts.creator)], via: 'opts' } : await findCreator(client, rpc, token, blockNumber);
    for (const a of creator.from) addCaller(a);
    // v7 (I-1): address-shaped values at the usual packing offsets of slots 0..15 and of every slot the
    // constructor wrote (prestateTracer diff of the creation transaction, when the node can trace it)
    const storageCallers = [];
    const words = [];
    for (let i = 0; i < STORAGE_CALLER_SLOTS; i++) {
      words.push(await client.getStorageAt({ address: token, slot: toHex(i, { size: 32 }), blockNumber }) ?? '0x0');
    }
    for (const h of creator.txs ?? []) {
      try {
        const d = await rpc('debug_traceTransaction', [h, { tracer: 'prestateTracer', tracerConfig: { diffMode: true } }]);
        words.push(...Object.values(d?.post?.[token.toLowerCase()]?.storage ?? {}).slice(0, 64));
      } catch { /* historic tx not traceable on this node */ }
    }
    for (const w of words) {
      for (const a of packedAddresses(w)) {
        if (storageCallers.length >= MAX_STORAGE_CALLERS) break;
        if (exclude.has(a) || callers.includes(a)) continue;
        storageCallers.push(a);
        callers.push(a);
      }
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

    const third = getAddress(`0x${keccak256(concat([keccak256(concat([block.hash, token])), toHex('third')])).slice(-40)}`);
    exclude.add(third);
    /** Another (random) address buys a little on the pair through the router (funded from the holder's quote). */
    const thirdPartyBuy = async (q) => {
      await impersonate(third);
      if (!(await send(holder, quote, encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [third, q] })))) return false;
      await send(third, quote, encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [router, maxUint256] }));
      const rc = await sendTx(third, router, encodeFunctionData({
        abi: ROUTER_ABI, functionName: 'buy', args: [pair, quote, token, q, ASSUMED_FEE_BPS],
      }));
      return !!routerLogs(rc).find((x) => x.eventName === 'Bought' && x.args.ok);
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
        // price the swap on the post-transfer reserves (a swap-back inside the transfer moves them)
        const post = await reserves();
        const actualIn = (await bal(token, pair)) - post.rT;
        const out = amountOut(actualIn, post.rT, post.rQ);
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
      // N-03: a third party trades between the holder's receipt and the sell (state-sequence traps)
      const interleaved = qIn > 0n ? await inSnapshot(async () => {
        if (!(await thirdPartyBuy(qIn / 10n || 1n))) return null;
        return routerSell();
      }) : null;
      return { via, immediate, delayed, transfer, interleaved, baselineAt: at, baseline: dl[at] };
    };

    const evidence = {
      block: { number: blockNumber.toString(), hash: block.hash }, holder, holderDerived: !opts.holder, router,
      routerRuntimeHash: keccak256(SIM_ROUTER.runtime), env: chainEnv, creator, third, callers, storageCallers, quote, funding,
      acquiredVia: null, position: '0', unlockedBy: [], baselineSellOk: false, baselineAt: null, expectedOut: '0',
      immediate: null, delayed: [], transferSell: null, signals: [], attempts: [], skipped: [],
      unknownAttempts: [], unknownSweep: null,
    };
    const record = (m) => {
      if (m.via) evidence.acquiredVia = m.via;
      evidence.immediate = sellJson(m.immediate);
      evidence.delayed = m.delayed.map((d) => ({ label: d.label, ...sellJson(d) }));
      evidence.transferSell = sellJson(m.transfer);
      evidence.interleavedSell = sellJson(m.interleaved);
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
    // N-05: a later sell lands in a higher router tax bucket than the immediate one (under the 50% pass line)
    if (passes(m.immediate) && m.delayed.some((d) => d.ok && taxBucket(d) > taxBucket(m.immediate))) {
      signal('delayed-tax-jump', 'dangerSetter');
    }
    // N-03: passes alone, fails once someone else traded in between
    if (passes(m.baseline) && m.interleaved && !passes(m.interleaved)) signal('sequence-trap', 'dangerSetter');
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

      // ---- b. F-04 / N-01: unknown selectors, ABI-less worst-case words, magic constants, two-step pairs ----
      if (opts.unknown !== false) {
        const tb = Date.now();
        const dangerousSel = new Set(s.evidence.dangerous.map((d) => d.selector));
        const unknown = s.evidence.unknownSelectors.filter((x) => !DANGEROUS[x] && !dangerousSel.has(x));
        const todo = unknown.slice(0, maxUnknown);
        const hints = opts.noHints ? {} : (s.evidence.selectorHints ?? {});
        const sweep = {
          selectors: unknown.length, tried: 0, patterns: UNKNOWN_PATTERNS.length, calls: 0, complete: true,
          truncatedBy: null, callers: callers.length, exercised: [], unexercised: [], stateChanging: [],
          pairs: 0, pairsTruncated: false, trapped: [],
        };
        evidence.unknownSweep = sweep;
        const overBudget = () => Date.now() - t0 > budgetMs;
        const patternsFor = (sel) => [
          ...UNKNOWN_PATTERNS.map((p) => [p, unknownCalldata(sel, p, ctx)]),
          // v7 (I-2): every hint in every argument position, over a 10000 or a max background (bounded)
          ...(hints[sel] ?? []).flatMap((k) => (opts.hintPositions ?? [0, 1, 2, 3]).flatMap((pos) => [10000n, maxUint256].map((bg) => {
            const w = [bg, bg, bg, bg];
            w[pos] = BigInt(k);
            return [`magic:${k}@${pos}/${bg === 10000n ? '10000' : 'max'}`, `${sel}${w.map(word).join('')}`];
          }))).slice(0, MAX_HINT_PATTERNS),
        ];
        const trap = (attempt) => {
          evidence.unknownAttempts.push(attempt);
          if (!sweep.trapped.includes(attempt.selector)) sweep.trapped.push(attempt.selector);
          out.ownerCanTrap = true;
        };
        const changesTokenState = async (rc) => {
          try {
            const d = await rpc('debug_traceTransaction', [rc.transactionHash, { tracer: 'prestateTracer', tracerConfig: { diffMode: true } }]);
            const post = d?.post?.[token.toLowerCase()];
            return !!post?.storage && Object.keys(post.storage).length > 0;
          } catch {
            return true; // tracer unavailable: treat as state-changing (more pairs, never fewer)
          }
        };
        const firstSteps = []; // { selector, pattern, data, caller } of state-changing successful calls
        if (unknown.length > maxUnknown) { sweep.complete = false; sweep.truncatedBy = `max-selectors(${maxUnknown})`; }
        outer: for (const selector of todo) {
          sweep.tried++;
          let exercised = false;
          let firstStep = null;
          // v7 (I-2): a selector with compared constants only counts as exercised once a call changed token storage
          // (`if (key != K) return;` succeeds without doing anything)
          const needsChange = (hints[selector] ?? []).length > 0;
          for (const [pattern, data] of patternsFor(selector)) {
            if (overBudget()) { sweep.complete = false; sweep.truncatedBy = `budget(${budgetMs}ms)`; break outer; }
            for (const caller of callers) {
              sweep.calls++;
              const attempt = await inSnapshot(async () => {
                const rc = await sendTx(caller, token, data);
                if (!rc) return null;
                const changed = (needsChange && !exercised)
                  || (firstStep === null && (pattern === 'max' || pattern === '10000' || pattern.startsWith('magic:')))
                  ? await changesTokenState(rc) : false;
                const r = await routerSell();
                return { selector, pattern, caller, sellOk: r.ok, out: r.actual.toString(), trapped: trappedBy(r), changed };
              });
              if (!attempt) continue;
              if (!needsChange || attempt.changed) exercised = true;
              if (attempt.changed && firstStep === null) firstStep = { selector, pattern, data, caller };
              if (attempt.trapped) trap(attempt);
              break; // first caller whose call succeeds
            }
          }
          (exercised ? sweep.exercised : sweep.unexercised).push(selector);
          if (firstStep) { firstSteps.push(firstStep); sweep.stateChanging.push(selector); }
        }
        // two-step: a state-changing call first (e.g. raise a cap), then every other unknown selector
        pairs: for (const f of firstSteps) {
          for (const selector of todo) {
            if (selector === f.selector) continue;
            if (sweep.pairs >= MAX_PAIRS || overBudget()) { sweep.pairsTruncated = true; break pairs; }
            sweep.pairs++;
            const second = patternsFor(selector).filter(([p]) => p === '10000' || p === 'max' || p.startsWith('magic:'));
            for (const [pattern, data] of second) {
              const attempt = await inSnapshot(async () => {
                if (!(await send(f.caller, token, f.data))) return null;
                for (const caller of [f.caller, ...callers.filter((c) => c !== f.caller)]) {
                  sweep.calls++;
                  if (!(await send(caller, token, data))) continue;
                  const r = await routerSell();
                  return {
                    selector: `${f.selector}+${selector}`, pattern: `${f.pattern}+${pattern}`, caller,
                    sellOk: r.ok, out: r.actual.toString(), trapped: trappedBy(r),
                  };
                }
                return null;
              });
              if (attempt?.trapped) { trap(attempt); break; }
            }
          }
        }
        if (sweep.unexercised.length) {
          sweep.complete = false;
          sweep.truncatedBy ??= `unexercised(${sweep.unexercised.length})`;
        }
        for (const sel of sweep.trapped) evidence.signals.push(`unknown-setter-trap:${sel}`);
        // fail closed when an admin exists that the sweep could not fully exercise
        // A caller-vs-storage gate on a token whose owner()/getOwner() explicitly returns 0 (renounced) is taken to be
        // the renounced owner's: its functions revert for everyone by design (hidden second admin: README residual).
        // v7 (I-1): only when EVERY caller-vs-storage check compares a literal slot that owner() itself reads.
        const own = await ownerRenounced(client, rpc, token, blockNumber);
        const ownerSlots = new Set(own.slots.map((x) => BigInt(x)));
        const checkSlots = s.evidence.callerCheckSlots ?? [null];
        const onlyOwnerChecks = own.renounced && checkSlots.length > 0
          && checkSlots.every((x) => x !== null && ownerSlots.has(BigInt(x)));
        const why = [
          s.evidence.owner !== null && 'owner-active',
          s.evidence.reasons.includes('access-control') && 'access-control',
          s.evidence.reasons.includes('caller-vs-literal') && 'caller-vs-literal',
          s.evidence.reasons.includes('caller-vs-storage') && !onlyOwnerChecks && 'caller-vs-storage',
        ].filter(Boolean);
        sweep.ownerRenounced = own.renounced;
        sweep.ownerSlots = own.slots;
        sweep.callerCheckSlots = checkSlots;
        if (!sweep.complete) sweep.failClosedBecause = why;
        if (!sweep.complete && why.length) {
          evidence.signals.push('sweep-incomplete');
          out.dangerSetter = true;
          out.privileged = true;
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
