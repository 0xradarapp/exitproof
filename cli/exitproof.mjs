#!/usr/bin/env node
// ExitProof CLI.
//   node cli/exitproof.mjs check <token> [--mode strict|balanced|permissive] [--amount 0.01] [--network fork|xlayer]
//   node cli/exitproof.mjs buy   <token> [--mode …] [--amount …] [--network …] [--slippage-bps 100] [--yes]
//   node cli/exitproof.mjs tx    <token> --wallet <address> [--mode …] [--amount …] [--network …]
//        no key: checks, then prints the buyETH transaction {to, inputData, amt} and the ready
//        `onchainos wallet contract-call` command for an OKX Agentic Wallet (see agent/SKILL.md)
//
// `check` is free: an eth_call of ExitProofRouter.inspect, which buys, probes the full sell-back, measures taxes and
// asks the TapeOut circuit, then always reverts with Report(...). Prints a JSON verdict.
// `buy` signs with EXITPROOF_KEY (environment only, never a file). It checks first, refuses when the check does not
// allow, and sends buyETH, which re-runs the same check on chain and reverts on deny. Without --yes it only prints
// the transaction it would send.
// Networks come from web/config.json (shared with the web app). RPC_URL overrides the configured RPC.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient, createWalletClient, http, defineChain, encodeFunctionData, decodeErrorResult, decodeEventLog,
  parseAbi, parseEther, formatEther, formatUnits, isAddress, getAddress, keccak256,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { MODES, ROUTER_ERRORS, decodeFacts, reasonText, errorText, TAX_RANGE } from '../web/verdict.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'web', 'config.json'), 'utf8'));

const ROUTER_ABI = parseAbi([
  'function inspect(address factory, address tokenIn, uint256 amountIn, address token, uint8 mode) payable',
  'function buyETH(address factory, address token, uint256 minOut, uint8 mode, address to, uint256 deadline) payable returns (uint256)',
  'event Checked(address indexed token, bytes32 indexed codehash, address indexed buyer, uint16 facts, bool allow, uint8 reason, uint256 amountIn, uint256 out)',
  ...ROUTER_ERRORS,
]);
const REGISTRY_ABI = parseAbi([
  'struct Flags { bool scanned; bool privileged; bool upgradeable; bool dangerSetter; bool ownerCanTrap; uint16 scannerVersion; }',
  'function flagsOf(bytes32 codehash) view returns (Flags)',
]);
const ERC20_ABI = parseAbi(['function symbol() view returns (string)', 'function decimals() view returns (uint8)']);
const PROBE_FROM = getAddress('0x00000000000000000000000000000000e21df00f'); // read-only checks: any address, balance overridden
const CALL_GAS = 10_000_000n; // the probe alone needs ~3.1M available; eth_call gas is free
const FALLBACK_GAS = 4_000_000n; // only when the wallet-side estimate fails without a revert reason (>= 3.5M rule)

function die(msg, code = 2) {
  console.log(JSON.stringify({ error: msg }, null, 2));
  process.exit(code);
}

function parseArgs(argv) {
  const [cmd, token, ...rest] = argv;
  const o = { cmd, token, mode: 'balanced', amount: '0.01', network: CONFIG.defaultNetwork || 'fork', slippageBps: 100, yes: false, wallet: null };
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i];
    const v = () => { if (rest[i + 1] === undefined) die(`missing value for ${k}`); return rest[++i]; };
    if (k === '--mode') o.mode = v();
    else if (k === '--amount') o.amount = v();
    else if (k === '--network') o.network = v();
    else if (k === '--slippage-bps') o.slippageBps = Number(v());
    else if (k === '--yes') o.yes = true;
    else if (k === '--wallet') o.wallet = v();
    else die(`unknown option ${k}`);
  }
  if (o.cmd === 'tx' && !(o.wallet && isAddress(o.wallet))) die('tx needs --wallet <address> (the wallet that signs and receives)');
  if (o.wallet) o.wallet = getAddress(o.wallet);
  if (!['check', 'buy', 'tx'].includes(o.cmd)) die('usage: exitproof.mjs check|buy|tx <token> [--mode strict|balanced|permissive] [--amount 0.01] [--network fork|xlayer]');
  if (!o.token || !isAddress(o.token)) die('token must be a 0x address');
  o.token = getAddress(o.token);
  if (!(o.mode in MODES)) die('--mode must be strict, balanced or permissive');
  try { o.value = parseEther(o.amount); } catch { die('--amount is not a number'); }
  if (o.value <= 0n) die('--amount must be above 0');
  if (!Number.isInteger(o.slippageBps) || o.slippageBps < 0 || o.slippageBps > 500) die('--slippage-bps must be 0..500 (max 5%)');
  return o;
}

/** Finds revert data anywhere in a viem error chain. */
function revertData(e) {
  for (let x = e, i = 0; x && i < 12; x = x.cause, i++) {
    if (typeof x.data === 'string' && x.data.startsWith('0x')) return x.data;
    if (typeof x.data?.data === 'string') return x.data.data;
  }
  return null;
}

function isNetworkError(e) {
  for (let x = e, i = 0; x && i < 12; x = x.cause, i++) {
    if (x.name === 'HttpRequestError' || x.name === 'TimeoutError' || /fetch failed|ECONNREFUSED/.test(x.message || '')) return true;
  }
  return false;
}

function decodeRevert(data) {
  if (!data || data === '0x') return { name: null };
  try {
    const d = decodeErrorResult({ abi: ROUTER_ABI, data });
    return { name: d.errorName, args: d.args };
  } catch {
    return { name: `unrecognized revert ${data.slice(0, 10)}` };
  }
}

function verdictFromReport(args, o, extra) {
  const [facts, allow, reason, buyOut, sellOut] = args;
  const d = decodeFacts(facts);
  return {
    token: o.token, network: o.network, mode: o.mode, amountOKB: o.amount,
    verdict: allow ? 'allow' : 'blocked',
    allow, reason: Number(reason), reasonText: allow ? null : reasonText(reason, o.mode),
    facts: Number(facts),
    decoded: {
      sellOk: d.sellOk,
      sellTax: { bucket: d.sellTax, range: TAX_RANGE[d.sellTax] },
      buyTax: { bucket: d.buyTax, range: TAX_RANGE[d.buyTax] },
      ownerActive: d.ownerActive, upgradeable: d.upgradeable, danger: d.danger, unscanned: d.unscanned, mode: d.mode,
    },
    buyOut: buyOut.toString(), sellOut: sellOut.toString(),
    ...extra,
  };
}

async function setup(o) {
  const net = CONFIG.networks[o.network];
  if (!net) die(`unknown network ${o.network} (config has ${Object.keys(CONFIG.networks).join(', ')})`);
  if (!net.router) die(`ExitProof is not deployed on ${o.network} yet (mainnet deployment pending); use --network fork`);
  const rpc = process.env.RPC_URL || net.rpc;
  const chain = defineChain({ id: net.chainId, name: net.label, nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  const pub = createPublicClient({ chain, transport: http(rpc, { timeout: 60_000 }) });
  return { net, rpc, chain, pub };
}

async function tokenInfo(pub, token) {
  const code = await pub.getCode({ address: token });
  if (!code || code === '0x') return null;
  const [symbol, decimals] = await Promise.all([
    pub.readContract({ address: token, abi: ERC20_ABI, functionName: 'symbol' }).catch(() => null),
    pub.readContract({ address: token, abi: ERC20_ABI, functionName: 'decimals' }).catch(() => 18),
  ]);
  return { codehash: keccak256(code), symbol, decimals: Number(decimals) };
}

async function check(o, ctx, from) {
  const { net, pub, rpc } = ctx;
  let info;
  try { info = await tokenInfo(pub, o.token); } catch (e) {
    if (isNetworkError(e)) die(`could not reach ${rpc} (connection problem, not a verdict)`, 3);
    throw e;
  }
  if (!info) return { token: o.token, network: o.network, mode: o.mode, verdict: 'cannot-buy', allow: false, reason: null, error: 'NoCode', reasonText: 'This address has no contract code, so it is not a token.' };
  const flags = await pub.readContract({ address: net.registry, abi: REGISTRY_ABI, functionName: 'flagsOf', args: [info.codehash] }).catch(() => null);
  const data = encodeFunctionData({ abi: ROUTER_ABI, functionName: 'inspect', args: [net.factory, net.wokb, o.value, o.token, MODES[o.mode]] });
  const req = { account: from ?? PROBE_FROM, to: net.router, data, value: o.value, gas: CALL_GAS };
  let err;
  try {
    // read-only: give the caller address enough OKB for the call; fall back if the node lacks state overrides
    await pub.call({ ...req, stateOverride: [{ address: req.account, balance: o.value + parseEther('1') }] });
    return die('inspect returned without reverting (unexpected router)', 4);
  } catch (e) {
    err = e;
    if (!revertData(e) && /override/i.test(e.message || '')) {
      try { await pub.call(req); } catch (e2) { err = e2; }
    }
  }
  if (isNetworkError(err)) die(`could not reach ${rpc} (connection problem, not a verdict)`, 3);
  const r = decodeRevert(revertData(err));
  const extra = {
    symbol: info.symbol, decimals: info.decimals, codehash: info.codehash,
    registry: flags ? { scanned: flags.scanned, privileged: flags.privileged, upgradeable: flags.upgradeable, dangerSetter: flags.dangerSetter, ownerCanTrap: flags.ownerCanTrap, scannerVersion: flags.scannerVersion } : null,
  };
  if (r.name === 'Report') {
    const v = verdictFromReport(r.args, o, extra);
    v.buyOutFormatted = formatUnits(BigInt(v.buyOut), info.decimals);
    v.sellOutOKB = formatEther(BigInt(v.sellOut));
    return v;
  }
  // any other revert means the buy itself cannot go through safely
  return {
    token: o.token, network: o.network, mode: o.mode, amountOKB: o.amount,
    verdict: 'cannot-buy', allow: false, reason: null, error: r.name ?? 'EmptyRevert', reasonText: errorText(r.name),
    ...extra,
  };
}

/** Checks from `address`, then builds buyETH(minOut, deadline) for it. Exits non-zero (nothing to sign) on a no. */
async function prepareBuy(o, ctx, address) {
  const { net, pub } = ctx;
  const v = await check(o, ctx, address);
  if (!v.allow) {
    console.log(JSON.stringify({ sent: false, why: 'the check does not allow this buy', check: v }, null, 2));
    process.exit(1);
  }
  // minOut: ExitProofRouter._settle compares minOut to `out` = the balance increase of `to` AFTER the router forwards
  // the tokens (fee-on-transfer aware). buyETH returns exactly that, so simulate buyETH itself (minOut = 1) and take
  // the user's slippage (default 1%, max 5%) off the simulated delivery. No extra tax discount.
  const deadline = (await pub.getBlock()).timestamp + 600n;
  const sim = [net.factory, o.token, 1n, MODES[o.mode], address, deadline];
  let delivered;
  try {
    ({ result: delivered } = await pub.simulateContract({
      address: net.router, abi: ROUTER_ABI, functionName: 'buyETH', args: sim, value: o.value, account: address, gas: CALL_GAS,
      stateOverride: [{ address, balance: o.value + parseEther('1') }],
    }));
  } catch (e) {
    if (isNetworkError(e)) die(`could not reach ${ctx.rpc} (connection problem, not a verdict)`, 3);
    const r = decodeRevert(revertData(e));
    console.log(JSON.stringify({ sent: false, why: r.name ?? 'EmptyRevert', reasonText: r.name === 'Blocked' ? reasonText(r.args[0], o.mode) : errorText(r.name), check: v }, null, 2));
    process.exit(1);
  }
  let minOut = delivered * (10_000n - BigInt(o.slippageBps)) / 10_000n;
  if (minOut === 0n) minOut = 1n;
  const args = [net.factory, o.token, minOut, MODES[o.mode], address, deadline];
  return { v, args, data: encodeFunctionData({ abi: ROUTER_ABI, functionName: 'buyETH', args }) };
}

/** Wallet-side gas: estimate (+20%). A decodable revert stops the buy; an undecodable failure gets 4M (>= 3.5M). */
async function gasFor(o, ctx, account, args) {
  try {
    const g = await ctx.pub.estimateContractGas({ address: ctx.net.router, abi: ROUTER_ABI, functionName: 'buyETH', args, value: o.value, account });
    return g * 12n / 10n;
  } catch (e) {
    const r = decodeRevert(revertData(e));
    if (r.name === 'Blocked') {
      console.log(JSON.stringify({ sent: false, why: 'blocked', reason: Number(r.args[0]), reasonText: reasonText(r.args[0], o.mode), facts: Number(r.args[1]) }, null, 2));
      process.exit(1);
    }
    if (r.name) {
      console.log(JSON.stringify({ sent: false, why: r.name, reasonText: errorText(r.name) }, null, 2));
      process.exit(1);
    }
    return FALLBACK_GAS;
  }
}

async function txFor(o, ctx) {
  const { v, args, data } = await prepareBuy(o, ctx, o.wallet);
  const amt = o.value.toString();
  console.log(JSON.stringify({
    check: v,
    transactions: [{
      description: `Buy ${v.symbol ?? o.token} with ${o.amount} OKB through ExitProof (${o.mode}); reverts in full if the on-chain check says no`,
      chain: ctx.net.chainId, to: ctx.net.router, inputData: data, amt,
      onchainos: `onchainos wallet contract-call --to ${ctx.net.router} --chain ${ctx.net.chainId} --input-data ${data} --amt ${amt}`,
      validUntil: args[5].toString(),
    }],
  }, null, 2));
}

async function buy(o, ctx) {
  const key = process.env.EXITPROOF_KEY;
  if (!key) die('buy needs EXITPROOF_KEY in the environment');
  let account;
  try { account = privateKeyToAccount(key); } catch { die('invalid EXITPROOF_KEY'); }
  const { net, pub, chain, rpc } = ctx;
  const { v, args } = await prepareBuy(o, ctx, account.address);
  const gas = await gasFor(o, ctx, account, args);
  const tx = { to: net.router, function: 'buyETH', args: args.map(String), valueOKB: o.amount, gas: gas.toString(), from: account.address };
  if (!o.yes) {
    console.log(JSON.stringify({ sent: false, dryRun: true, note: 'add --yes to send', check: v, tx }, null, 2));
    return;
  }
  const live = await pub.getChainId();
  if (live !== net.chainId) die(`RPC is chain ${live}, config says ${net.chainId}: refusing to sign`);
  const w = createWalletClient({ chain, transport: http(rpc), account });
  const hash = await w.writeContract({ address: net.router, abi: ROUTER_ABI, functionName: 'buyETH', args, value: o.value, gas });
  const rc = await pub.waitForTransactionReceipt({ hash });
  const ev = rc.logs.map((l) => { try { return decodeEventLog({ abi: ROUTER_ABI, ...l }); } catch { return null; } }).find((e) => e?.eventName === 'Checked');
  console.log(JSON.stringify({
    sent: true, tx: hash, status: rc.status, block: rc.blockNumber.toString(), gasUsed: rc.gasUsed.toString(),
    received: ev ? ev.args.out.toString() : null, receivedFormatted: ev ? formatUnits(ev.args.out, v.decimals) : null,
    check: v,
  }, null, 2));
  if (rc.status !== 'success') process.exit(1);
}

const o = parseArgs(process.argv.slice(2));
const ctx = await setup(o);
try {
  if (o.cmd === 'check') {
    const v = await check(o, ctx);
    console.log(JSON.stringify(v, null, 2));
    process.exit(v.allow ? 0 : 1);
  } else if (o.cmd === 'tx') {
    await txFor(o, ctx);
  } else {
    await buy(o, ctx);
  }
} catch (e) {
  if (isNetworkError(e)) die(`could not reach ${ctx.rpc} (connection problem, not a verdict)`, 3);
  die(e.shortMessage || e.message, 4);
}
