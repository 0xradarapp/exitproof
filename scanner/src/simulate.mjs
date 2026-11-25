// L3 owner-power simulation. Runs ONLY against an anvil node (local or `anvil --fork-url`): it impersonates the
// owner, calls every matched dangerous setter with worst-case arguments and re-tries a holder's full sell.
// Everything happens between evm_snapshot / evm_revert; the node is always rewound to the initial snapshot.
//
// Procedure:
//  1. Refuse unless web3_clientVersion contains "anvil".
//  2. Static scan (scan.mjs) -> dangerous selectors (token + EIP-1967 implementation) and owner().
//     Callers = owner(), deployer() (if the token exposes one), EIP-1967 admin slot: impersonated + funded.
//  3. Holder: a fixed synthetic address buys ~1% of the quote reserve on `pair` (quote = the other pair token,
//     funded via WETH-style deposit()). If the quote has no deposit(), fallback: the pair (impersonated) transfers
//     1% of its token reserve to the holder and the pair is sync()ed.
//  4. Baseline: holder sells its whole balance to the pair (transfer + swap, assuming a 1% pool fee so the K check
//     passes on any <=1% fee fork). Quote received = `expected`. If the baseline fails, owner "unlock" calls present
//     in the dispatcher (enableTrading/openTrading/startTrading/unpause/setTradingEnabled(true)/...,
//     setAuthorizedBuyer(holder)) are applied cumulatively, re-buying if needed, until the baseline succeeds
//     (launch-pending tokens are scanned at PairCreated time, before trading opens). If it still fails the token is
//     untradeable now (the router's live probe catches that): no setter attempts, ownerCanTrap=false.
//  5. For each dangerous setter (selector order) x argument variant x caller: snapshot, call setter (skip if it
//     reverts), sell again, revert. trapped = sell reverts OR returns < 50% of `expected`.
//     Arg variants per type: uintN -> 0, 99, 100, 10000, 2^N-1 (clamped); address -> pair, holder;
//     bool -> true, false; address[] -> [holder, pair]. Full cartesian product if <= 32 combos, else
//     index-aligned variants (all args take their k-th option). Signatures with other types are skipped.
//  6. ownerCanTrap = any attempt trapped.
import {
  createPublicClient, http, encodeFunctionData, decodeFunctionResult, parseAbiItem, getAddress, toFunctionSelector,
} from 'viem';
import { scan } from './scan.mjs';
import { isAddress20 } from './proxy.mjs';

export const HOLDER = '0x000000000000000000000000000000000000E417';
const TX_GAS = '0x2dc6c0'; // 3,000,000
const FUND = '0x3635c9adc5dea00000'; // 1000 ether
const ASSUMED_FEE_BPS = 100n;
const MAX_COMBOS = 32;
/** Owner "unlock" calls tried (in this order) when the baseline sell fails, e.g. trading not yet enabled. */
const UNLOCKS = [
  ['enableTrading()', () => []], ['openTrading()', () => []], ['startTrading()', () => []], ['unpause()', () => []],
  ['enableTrading(bool)', () => [true]], ['setTradingEnabled(bool)', () => [true]], ['setTrading(bool)', () => [true]],
  ['setTradingOpen(bool)', () => [true]], ['tradingStatus(bool)', () => [true]], ['setPaused(bool)', () => [false]],
  ['setAuthorizedBuyer(address)', (c) => [c.holder]],
];

const ERC20 = [
  parseAbiItem('function balanceOf(address) view returns (uint256)'),
  parseAbiItem('function transfer(address,uint256) returns (bool)'),
  parseAbiItem('function deposit() payable'),
];
const PAIR = [
  parseAbiItem('function token0() view returns (address)'),
  parseAbiItem('function token1() view returns (address)'),
  parseAbiItem('function getReserves() view returns (uint112,uint112,uint32)'),
  parseAbiItem('function swap(uint256,uint256,address,bytes)'),
  parseAbiItem('function sync()'),
];
const DEPLOYER = parseAbiItem('function deployer() view returns (address)');

const amountOut = (amountIn, rIn, rOut) => {
  if (amountIn <= 0n || rIn <= 0n || rOut <= 0n) return 0n;
  const inFee = amountIn * (10000n - ASSUMED_FEE_BPS);
  return (inFee * rOut) / (rIn * 10000n + inFee);
};

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

const toJson = (v) => (typeof v === 'bigint' ? v.toString() : Array.isArray(v) ? v.map(toJson) : v);

export async function assertAnvil(client) {
  let v = '';
  try { v = String(await client.request({ method: 'web3_clientVersion' })); } catch { /* fallthrough */ }
  if (!/anvil/i.test(v)) throw new Error(`simulate: refusing non-anvil RPC (web3_clientVersion=${v || 'n/a'})`);
}

export async function simulate(forkRpc, token, pairAddr, opts = {}) {
  const client = createPublicClient({ transport: http(forkRpc) });
  await assertAnvil(client);
  const rpc = (method, params = []) => client.request({ method, params });
  token = getAddress(token);
  const pair = getAddress(pairAddr);
  const holder = getAddress(opts.holder ?? HOLDER);
  const impersonated = new Set();

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
  const send = async (from, to, data, value = 0n) => {
    try {
      const hash = await rpc('eth_sendTransaction', [{
        from, to, data, gas: TX_GAS, value: `0x${value.toString(16)}`,
      }]);
      for (let i = 0; i < 200; i++) {
        const r = await rpc('eth_getTransactionReceipt', [hash]);
        if (r) return r.status === '0x1';
        await new Promise((res) => setTimeout(res, 10));
      }
      return false;
    } catch {
      return false; // node-side rejection (e.g. revert surfaced at submission)
    }
  };
  const snapshot = () => rpc('evm_snapshot');
  const revert = async (id) => {
    if (!(await rpc('evm_revert', [id]))) throw new Error(`simulate: evm_revert(${id}) failed`);
  };

  const initial = await snapshot();
  const run = async () => {
    const s = await scan(client, token, { blockNumber: await client.getBlockNumber({ cacheTime: 0 }) });
    const setters = s.evidence.dangerous;

    const callers = [];
    const addCaller = (a) => { if (isAddress20(a) && BigInt(a) !== 0n && !callers.includes(getAddress(a))) callers.push(getAddress(a)); };
    addCaller(s.evidence.owner);
    addCaller(await tryRead(token, [DEPLOYER], 'deployer'));
    addCaller(s.evidence.proxySlots.eip1967Admin);

    const [t0, t1] = [await read(pair, PAIR, 'token0'), await read(pair, PAIR, 'token1')];
    if (getAddress(t0) !== token && getAddress(t1) !== token) throw new Error('simulate: token not in pair');
    const tokenIs0 = getAddress(t0) === token;
    const quote = getAddress(tokenIs0 ? t1 : t0);
    const reserves = async () => {
      const [r0, r1] = await read(pair, PAIR, 'getReserves');
      return tokenIs0 ? { rT: r0, rQ: r1 } : { rT: r1, rQ: r0 };
    };
    const bal = async (t, who) => (await read(t, ERC20, 'balanceOf', [who]));
    const safeBal = async (t, who) => { try { return await bal(t, who); } catch { return null; } };
    const swapData = (outT, outQ, to) => encodeFunctionData({
      abi: PAIR, functionName: 'swap', args: [tokenIs0 ? outT : outQ, tokenIs0 ? outQ : outT, to, '0x'],
    });

    // ---- acquire a holder position ----
    await impersonate(holder);
    for (const c of callers) await impersonate(c);
    const acquire = async () => {
      const { rT, rQ } = await reserves();
      const qIn = rQ / 100n;
      const funded = qIn > 0n
        && await send(holder, quote, encodeFunctionData({ abi: ERC20, functionName: 'deposit' }), qIn)
        && await send(holder, quote, encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [pair, qIn] }));
      const out = amountOut(qIn, rQ, rT);
      let via = 'buy';
      if (!funded || out === 0n || !(await send(holder, pair, swapData(out, 0n, holder)))) {
        via = 'pair-transfer';
        await impersonate(pair);
        await send(pair, token, encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [holder, rT / 100n] }));
        await send(holder, pair, encodeFunctionData({ abi: PAIR, functionName: 'sync' }));
      }
      await rpc('evm_increaseTime', [3600]);
      await rpc('evm_mine');
      return via;
    };

    const sell = async () => {
      try {
        return await sellOnce();
      } catch {
        return { ok: false, out: 0n }; // e.g. balanceOf no longer decodes after a hostile upgrade
      }
    };
    const sellOnce = async () => {
      const amt = await bal(token, holder);
      if (amt === 0n) return { ok: false, out: 0n };
      const q0 = await bal(quote, holder);
      if (!(await send(holder, token, encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [pair, amt] })))) {
        return { ok: false, out: 0n };
      }
      const { rT, rQ } = await reserves();
      const actualIn = (await bal(token, pair)) - rT;
      const out = amountOut(actualIn, rT, rQ);
      if (out === 0n || !(await send(holder, pair, swapData(0n, out, holder)))) return { ok: false, out: 0n };
      return { ok: true, out: (await bal(quote, holder)) - q0 };
    };

    const measure = async () => {
      const snap = await snapshot();
      const r = await sell();
      await revert(snap);
      return r;
    };

    const evidence = {
      callers, holder, quote, acquiredVia: await acquire(), position: '0', unlockedBy: [],
      baselineSellOk: false, expectedOut: '0', attempts: [], skipped: [],
    };
    let baseline = await measure();

    // Launch-pending tokens (trading disabled / paused / allow-listed buyer) are scanned at PairCreated time: let
    // the owner unlock first so the trap attempts below run against the tradeable state. Unlock calls are
    // cumulative (each successful one is kept) until the baseline sell succeeds.
    if (!baseline.ok) {
      const present = new Set(setters.map((d) => d.signature));
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
        if ((await safeBal(token, holder)) === 0n) evidence.acquiredVia = await acquire();
        baseline = await measure();
        if (baseline.ok && baseline.out > 0n) break;
      }
    }
    const pos = await safeBal(token, holder);
    evidence.position = pos === null ? 'unreadable' : pos.toString();
    evidence.baselineSellOk = baseline.ok;
    evidence.expectedOut = baseline.out.toString();
    if (!baseline.ok || baseline.out === 0n) {
      if (evidence.position === '0') evidence.note = 'no holder position';
      return { ownerCanTrap: false, evidence };
    }

    const ctx = { pair, holder };
    let trappedAny = false;
    // After a good baseline, any failure to finish the owner-power sweep is treated as a trap (fail closed).
    try {
      for (const { signature } of setters) {
        const variants = argVariants(signature, ctx);
        if (!variants) { evidence.skipped.push(signature); continue; }
        const abi = [parseAbiItem(`function ${signature}`)];
        const name = signature.slice(0, signature.indexOf('('));
        for (const args of variants) {
          const data = encodeFunctionData({ abi, functionName: name, args });
          if (data.slice(0, 10) !== toFunctionSelector(signature)) throw new Error('selector mismatch');
          for (const caller of callers) {
            const snap = await snapshot();
            const setOk = await send(caller, token, data);
            let attempt = null;
            if (setOk) {
              const r = await sell();
              const trapped = !r.ok || r.out * 2n < baseline.out;
              trappedAny ||= trapped;
              attempt = { signature, args: toJson(args), caller, sellOk: r.ok, out: r.out.toString(), trapped };
            }
            await revert(snap);
            if (attempt) {
              evidence.attempts.push(attempt);
              break; // one successful caller per variant is enough
            }
          }
        }
      }
    } catch (e) {
      evidence.error = `simulate-error: ${e.shortMessage ?? e.message}`;
      return { ownerCanTrap: true, evidence };
    }
    return { ownerCanTrap: trappedAny, evidence };
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
  return result;
}
