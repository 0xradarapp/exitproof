#!/usr/bin/env node
// Demo tokens for the ExitProof web app / CLI on the local anvil fork.
// Deploys fixture tokens from test/fixtures/Tokens.sol (artifacts in out/, run `forge build` first), gives each a real
// PotatoSwap pair with liquidity, then makes one allowed buy of CleanToken through the router (so the feed shows a
// Checked event). Writes deployments/fork-demo.json and the fork demoTokens list in web/config.json.
//
// Fork only (refuses any non-anvil node). Env:
//   DEPLOYER_KEY  required, environment only (anvil account #2 for the standard rehearsal)
//   BUYER_KEY     optional, default anvil account #3 (no EIP-7702 code on X Layer at the pinned block)
//   RPC_URL       default http://127.0.0.1:8549
import fs from 'node:fs';
import path from 'node:path';
import { createWalletClient, http, parseEther, getAddress, parseAbi, decodeEventLog } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ROOT, loadConstants, xlayerChain, detectNetwork, deploymentFile } from './lib/net.mjs';

const RPC_URL = process.env.RPC_URL || 'http://127.0.0.1:8549';
const BUYER_KEY = process.env.BUYER_KEY || '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6';
const SUPPLY = parseEther('1000000');
const LIQ_TOKENS = parseEther('500000');
const LIQ_OKB = parseEther('5');

// name in out/Tokens.sol, constructor args, what the demo should show
const TOKENS = [
  { name: 'CleanToken', args: [SUPPLY], expect: 'allow (permissive; strict after a scan)' },
  { name: 'BlacklistOnBuy', args: [SUPPLY], expect: 'blocked, reason 1 (cannot sell)', pairAware: true },
  { name: 'SellTax99', args: [SUPPLY], expect: 'blocked, reason 2 (sell tax)', pairAware: true },
  { name: 'TimeBombToken', args: [SUPPLY], expect: 'balanced: reason 6, then reason 5 after a scan', pairAware: true },
  { name: 'SecondHopTrap', args: [SUPPLY], expect: 'blocked, reason 1 (trap on the hop to the buyer)', pairAware: true },
  { name: 'FeeToken', args: [SUPPLY, 500n], expect: '5% tax both ways: allow in permissive, strict says 2' },
];

const ERC20 = parseAbi([
  'function transfer(address,uint256) returns (bool)',
  'function initPair(address)',
  'function symbol() view returns (string)',
]);
const WOKB = parseAbi(['function deposit() payable', 'function transfer(address,uint256) returns (bool)']);
const FACTORY = parseAbi([
  'function createPair(address,address) returns (address)',
  'function getPair(address,address) view returns (address)',
]);
const PAIR = parseAbi(['function mint(address) returns (uint256)']);

const artifact = (file, name) => JSON.parse(fs.readFileSync(path.join(ROOT, 'out', file, name + '.json'), 'utf8'));

async function main() {
  const K = loadConstants();
  const { network, pub } = await detectNetwork(RPC_URL, K);
  if (network !== 'fork') throw new Error(`refusing: ${RPC_URL} is "${network}", demo-fork.mjs is fork-only`);
  if (!process.env.DEPLOYER_KEY) throw new Error('DEPLOYER_KEY is required (environment only)');
  const dep = JSON.parse(fs.readFileSync(deploymentFile('fork'), 'utf8'));
  if (!dep.router) throw new Error('deployments/fork.json has no router: run scripts/deploy-fork.mjs first');
  if ((await pub.getCode({ address: dep.router })) === undefined) throw new Error('router has no code on this node (fresh anvil?): replay tapeout.mjs + deploy-fork.mjs');

  const chain = xlayerChain(RPC_URL, K);
  const me = privateKeyToAccount(process.env.DEPLOYER_KEY);
  const w = createWalletClient({ chain, transport: http(RPC_URL), account: me });
  const send = async (label, p) => {
    const hash = await w.writeContract(p);
    const rc = await pub.waitForTransactionReceipt({ hash });
    if (rc.status !== 'success') throw new Error(label + ' reverted');
    return rc;
  };

  const out = { network: 'fork', router: dep.router, registry: dep.registry, factory: K.potatoFactory, tokens: {} };
  // enough WOKB for every pair
  await send('wrap', { address: K.wokb, abi: WOKB, functionName: 'deposit', value: LIQ_OKB * BigInt(TOKENS.length) });

  for (const t of TOKENS) {
    const a = artifact('Tokens.sol', t.name);
    const hash = await w.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args: t.args });
    const rc = await pub.waitForTransactionReceipt({ hash });
    const token = getAddress(rc.contractAddress);
    await send('createPair', { address: K.potatoFactory, abi: FACTORY, functionName: 'createPair', args: [token, K.wokb] });
    const pair = await pub.readContract({ address: K.potatoFactory, abi: FACTORY, functionName: 'getPair', args: [token, K.wokb] });
    if (t.pairAware) await send('initPair', { address: token, abi: ERC20, functionName: 'initPair', args: [pair] });
    await send('liq token', { address: token, abi: ERC20, functionName: 'transfer', args: [pair, LIQ_TOKENS] });
    await send('liq wokb', { address: K.wokb, abi: WOKB, functionName: 'transfer', args: [pair, LIQ_OKB] });
    await send('mint', { address: pair, abi: PAIR, functionName: 'mint', args: [me.address] });
    const symbol = await pub.readContract({ address: token, abi: ERC20, functionName: 'symbol' });
    out.tokens[t.name] = { address: token, pair: getAddress(pair), symbol, expect: t.expect };
    console.log(`${t.name.padEnd(15)} ${token}  pair ${pair}  (${t.expect})`);
  }

  // one allowed buy so the feed has a Checked event
  const R = artifact('ExitProofRouter.sol', 'ExitProofRouter');
  const buyer = privateKeyToAccount(BUYER_KEY);
  if ((await pub.getCode({ address: buyer.address })) !== undefined) throw new Error('BUYER_KEY account has code (EIP-7702?)');
  await pub.request({ method: 'anvil_setBalance', params: [buyer.address, '0x56BC75E2D63100000'] });
  const bw = createWalletClient({ chain, transport: http(RPC_URL), account: buyer });
  const clean = out.tokens.CleanToken.address;
  const deadline = (await pub.getBlock()).timestamp + 3600n; // the fork's clock, not the host's
  const args = [K.potatoFactory, clean, 1n, 2, buyer.address, deadline];
  const gas = await pub.estimateContractGas({ address: dep.router, abi: R.abi, functionName: 'buyETH', args, value: parseEther('0.05'), account: buyer });
  const bh = await bw.writeContract({ address: dep.router, abi: R.abi, functionName: 'buyETH', args, value: parseEther('0.05'), gas: gas * 12n / 10n });
  const brc = await pub.waitForTransactionReceipt({ hash: bh });
  if (brc.status !== 'success') throw new Error('demo buy reverted');
  const ev = brc.logs.map((l) => { try { return decodeEventLog({ abi: R.abi, ...l }); } catch { return null; } }).find((e) => e?.eventName === 'Checked');
  out.demoBuy = { token: clean, buyer: buyer.address, tx: bh, block: brc.blockNumber.toString(), gas: brc.gasUsed.toString(), out: ev?.args.out.toString() };
  console.log(`demo buy       CleanToken 0.05 OKB permissive -> ${ev?.args.out} (gas ${brc.gasUsed}) tx ${bh}`);

  fs.writeFileSync(path.join(ROOT, 'deployments', 'fork-demo.json'), JSON.stringify(out, null, 2) + '\n');
  const cfgPath = path.join(ROOT, 'web', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.networks.fork.demoTokens = Object.entries(out.tokens).map(([name, t]) => ({ name, symbol: t.symbol, address: t.address }));
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  console.log('Wrote deployments/fork-demo.json and web/config.json (fork demoTokens)');
}

main().catch((e) => { console.error('STOPPED:', e.shortMessage || e.message); process.exit(1); });
