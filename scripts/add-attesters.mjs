// Register extra RiskRegistry attesters (for example one per backfill shard, so parallel shards never share a nonce)
// and give each a little OKB for gas. Sent by the registry owner.
//
//   ATTESTERS=0xA,0xB DEPLOYER_KEY=0x… node scripts/add-attesters.mjs                         dry run (sends nothing)
//   ATTESTERS=0xA,0xB DEPLOYER_KEY=0x… SEND=1 CONFIRM_MAINNET=yes node scripts/add-attesters.mjs mainnet
//
// Env: ATTESTERS (comma list of addresses; checksummed and de-duplicated), DEPLOYER_KEY (registry owner; environment
//      only), REGISTRY (default: deployments/<network>.json registry), FUND_OKB (default 0.001 per attester; 0 = no
//      funding, e.g. for a re-run or cleanup), FUND_CAP_OKB (replaces both funding caps: 0.01 OKB per address and
//      0.05 OKB in total), RPC_URL (default https://rpc.xlayer.tech), SEND=1, CONFIRM_MAINNET=yes (mainnet only).
//      REMOVE=1 calls setAttester(a, false) instead and sends no OKB; it refuses the deployer/owner and the main
//      attester recorded in deployments/<network>.json unless ALLOW_REVOKE_MAIN=1.
// Refused always: the zero address, the registry, the router. Refused when adding: the owner/deployer and the main
// attester (they are already set up by deploy.mjs). Each step is skipped when it is already done (attester already
// in the wanted state, balance already at FUND_OKB), so a re-run is safe.

import fs from 'node:fs';
import { createWalletClient, http, getAddress, parseAbi, parseEther, formatEther, zeroAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { loadConstants, xlayerChain, detectNetwork, deploymentFile } from './lib/net.mjs';

const K = loadConstants();
const RPC_URL = process.env.RPC_URL || 'https://rpc.xlayer.tech';
const SEND = process.env.SEND === '1';
const REMOVE = process.env.REMOVE === '1';
const ALLOW_REVOKE_MAIN = process.env.ALLOW_REVOKE_MAIN === '1';
const PER_ADDRESS_CAP = parseEther(process.env.FUND_CAP_OKB ?? '0.01');
const TOTAL_CAP = parseEther(process.env.FUND_CAP_OKB ?? '0.05');
const GAS = { attester: 60_000n, fund: 21_000n }; // setAttester measured 47,782; a plain transfer is 21,000
const ABI = parseAbi([
  'function owner() view returns (address)',
  'function isAttester(address) view returns (bool)',
  'function setAttester(address a, bool on)'
]);

main().catch((e) => { console.error('\nSTOPPED: ' + (e.shortMessage || e.message)); process.exit(1); });

async function main() {
  const key = process.env.DEPLOYER_KEY;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('DEPLOYER_KEY=0x + 64 hex is required in the environment');
  const account = privateKeyToAccount(key);
  const raw = (process.env.ATTESTERS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!raw.length) throw new Error('ATTESTERS=0x…,0x… is required');
  const list = [];
  for (const r of raw) {
    let a;
    try { a = getAddress(r); } catch { throw new Error('not an address: ' + r); }
    if (!list.includes(a)) list.push(a); // dedupe after checksumming
  }
  if (list.length !== raw.length) console.log('Note      ' + (raw.length - list.length) + ' duplicate address(es) dropped');
  let fund = 0n;
  if (!REMOVE) {
    if (!/^\d+(\.\d+)?$/.test(process.env.FUND_OKB ?? '0.001')) throw new Error('FUND_OKB must be a decimal number of OKB');
    fund = parseEther(process.env.FUND_OKB ?? '0.001');
  }
  if (fund > PER_ADDRESS_CAP) throw new Error('FUND_OKB ' + formatEther(fund) + ' is above the per-address cap of ' + formatEther(PER_ADDRESS_CAP) + ' OKB (FUND_CAP_OKB overrides it). Nothing was sent');

  const { network, pub } = await detectNetwork(RPC_URL, K);
  const MAINNET = network === 'xlayer';
  const depFile = deploymentFile(network);
  const dep = fs.existsSync(depFile) ? JSON.parse(fs.readFileSync(depFile, 'utf8')) : {};
  const registry = getAddress(process.env.REGISTRY || dep.registry || zeroAddress);
  if (registry === zeroAddress) throw new Error('no REGISTRY and no registry in ' + depFile);
  const owner = getAddress(await pub.readContract({ address: registry, abi: ABI, functionName: 'owner' }));
  if (owner !== account.address) throw new Error('registry ' + registry + ' is owned by ' + owner + ', not ' + account.address);
  const router = dep.router ? getAddress(dep.router) : null;
  const main = new Set([owner, account.address, ...(dep.deployer ? [getAddress(dep.deployer)] : []), ...(dep.attester ? [getAddress(dep.attester)] : [])]);
  console.log('Network   ' + network + ' · registry ' + registry + ' · owner ' + owner + (router ? ' · router ' + router : ''));

  for (const a of list) {
    if (a === zeroAddress) throw new Error('refusing the zero address. Nothing was sent');
    if (a === registry) throw new Error('refusing ' + a + ': it is the registry. Nothing was sent');
    if (router && a === router) throw new Error('refusing ' + a + ': it is the router. Nothing was sent');
    if (main.has(a)) {
      if (!REMOVE) throw new Error('refusing ' + a + ': it is the owner/deployer or the main attester, which deploy.mjs already set up. Nothing was sent');
      if (!ALLOW_REVOKE_MAIN) throw new Error('refusing to revoke ' + a + ': it is the owner/deployer or the main attester (ALLOW_REVOKE_MAIN=1 overrides). Nothing was sent');
    }
  }

  const plan = [];
  for (const a of list) {
    const on = await pub.readContract({ address: registry, abi: ABI, functionName: 'isAttester', args: [a] });
    if (on === REMOVE) plan.push({ kind: 'attester', a });
    if (fund > 0n) {
      const bal = await pub.getBalance({ address: a });
      if (bal < fund) plan.push({ kind: 'fund', a, value: fund - bal });
    }
  }
  const total = plan.reduce((s, p) => s + (p.value || 0n), 0n);
  const lines = plan.map((p) => p.kind === 'attester' ? 'setAttester(' + p.a + ', ' + !REMOVE + ')' : 'send ' + formatEther(p.value) + ' OKB to ' + p.a);
  for (const l of lines) console.log('  ' + l);
  console.log('Plan      ' + plan.length + ' tx, ' + formatEther(total) + ' OKB in transfers + gas');
  if (total > TOTAL_CAP) throw new Error('total funding ' + formatEther(total) + ' OKB is above the cap of ' + formatEther(TOTAL_CAP) + ' OKB (FUND_CAP_OKB overrides it). Nothing was sent');
  if (!plan.length) { console.log('Nothing to do.'); return; }

  const [balance, gasPrice] = await Promise.all([pub.getBalance({ address: account.address }), pub.getGasPrice()]);
  const gasOkb = plan.reduce((s, p) => s + GAS[p.kind], 0n) * gasPrice * 12n / 10n;
  console.log('Deployer  ' + account.address + ' · ' + formatEther(balance) + ' OKB · needs ≈' + formatEther(total + gasOkb) + ' OKB (transfers + gas +20%)');
  if (balance < total + gasOkb) throw new Error('not enough OKB on ' + account.address + ': need ≈' + formatEther(total + gasOkb) + ', have ' + formatEther(balance) + '. Nothing was sent');

  if (!SEND) { console.log('\nDRY RUN: nothing sent. When ready:  SEND=1' + (MAINNET ? ' CONFIRM_MAINNET=yes' : '') + ' node scripts/add-attesters.mjs'); return; }
  if (MAINNET) {
    console.log('\n' + '='.repeat(72));
    console.log('  X LAYER MAINNET — real funds, from ' + account.address);
    for (const l of lines) console.log('    ' + l);
    console.log('  total      ' + formatEther(total) + ' OKB in transfers + ≈' + formatEther(gasOkb) + ' OKB gas, ' + plan.length + ' tx');
    console.log('='.repeat(72));
    if (process.env.CONFIRM_MAINNET !== 'yes') throw new Error('mainnet send needs CONFIRM_MAINNET=yes in addition to SEND=1 (nothing was sent)');
  }
  const wallet = createWalletClient({ chain: xlayerChain(RPC_URL, K), transport: http(RPC_URL), account });
  for (const p of plan) {
    let hash;
    if (p.kind === 'attester') {
      const { request } = await pub.simulateContract({ account, address: registry, abi: ABI, functionName: 'setAttester', args: [p.a, !REMOVE] });
      hash = await wallet.writeContract(request);
    } else {
      hash = await wallet.sendTransaction({ to: p.a, value: p.value });
    }
    const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (r.status !== 'success') throw new Error(p.kind + ' ' + p.a + ' reverted: ' + hash);
    console.log('  ✓ ' + p.kind.padEnd(8) + ' ' + p.a + ' · ' + hash);
  }
  console.log('Done.');
}
