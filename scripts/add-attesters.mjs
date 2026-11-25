// Register extra RiskRegistry attesters (for example one per backfill shard, so parallel shards never share a nonce)
// and give each a little OKB for gas. Sent by the registry owner.
//
//   ATTESTERS=0xA,0xB DEPLOYER_KEY=0x… node scripts/add-attesters.mjs                         dry run (sends nothing)
//   ATTESTERS=0xA,0xB DEPLOYER_KEY=0x… SEND=1 CONFIRM_MAINNET=yes node scripts/add-attesters.mjs mainnet
//
// Env: ATTESTERS (comma list of addresses), DEPLOYER_KEY (registry owner; environment only), REGISTRY (default:
//      deployments/<network>.json registry), FUND_OKB (default 0.001 per attester; 0 = no funding), RPC_URL (default
//      https://rpc.xlayer.tech), SEND=1, CONFIRM_MAINNET=yes (mainnet only). REMOVE=1 calls setAttester(a, false)
//      instead and sends no OKB.
// Each step is skipped when it is already done (attester already set, balance already at FUND_OKB), so a re-run is safe.

import fs from 'node:fs';
import { createWalletClient, http, getAddress, parseAbi, parseEther, formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { loadConstants, xlayerChain, detectNetwork, deploymentFile } from './lib/net.mjs';

const K = loadConstants();
const RPC_URL = process.env.RPC_URL || 'https://rpc.xlayer.tech';
const SEND = process.env.SEND === '1';
const REMOVE = process.env.REMOVE === '1';
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
  const list = (process.env.ATTESTERS || '').split(',').map((s) => s.trim()).filter(Boolean).map((a) => getAddress(a));
  if (!list.length) throw new Error('ATTESTERS=0x…,0x… is required');
  const fund = REMOVE ? 0n : parseEther(process.env.FUND_OKB ?? '0.001');

  const { network, pub } = await detectNetwork(RPC_URL, K);
  const MAINNET = network === 'xlayer';
  let registry = process.env.REGISTRY;
  if (!registry) {
    const f = deploymentFile(network);
    if (!fs.existsSync(f)) throw new Error('no REGISTRY and no ' + f);
    registry = JSON.parse(fs.readFileSync(f, 'utf8')).registry;
  }
  registry = getAddress(registry);
  const owner = getAddress(await pub.readContract({ address: registry, abi: ABI, functionName: 'owner' }));
  if (owner !== account.address) throw new Error('registry ' + registry + ' is owned by ' + owner + ', not ' + account.address);
  console.log('Network   ' + network + ' · registry ' + registry + ' · owner ' + owner);

  const plan = [];
  for (const a of list) {
    const on = await pub.readContract({ address: registry, abi: ABI, functionName: 'isAttester', args: [a] });
    if (on === REMOVE) plan.push({ kind: 'attester', a });
    if (fund > 0n) {
      const bal = await pub.getBalance({ address: a });
      if (bal < fund) plan.push({ kind: 'fund', a, value: fund - bal });
    }
  }
  for (const p of plan) console.log('  ' + (p.kind === 'attester' ? 'setAttester(' + p.a + ', ' + !REMOVE + ')' : 'send ' + formatEther(p.value) + ' OKB to ' + p.a));
  const total = plan.reduce((s, p) => s + (p.value || 0n), 0n);
  console.log('Plan      ' + plan.length + ' tx, ' + formatEther(total) + ' OKB in transfers + gas');
  if (!plan.length) { console.log('Nothing to do.'); return; }
  if (!SEND) { console.log('\nDRY RUN: nothing sent. When ready:  SEND=1' + (MAINNET ? ' CONFIRM_MAINNET=yes' : '') + ' node scripts/add-attesters.mjs'); return; }
  if (MAINNET) {
    console.log('\n' + '='.repeat(60) + '\n  X LAYER MAINNET: ' + plan.length + ' transactions from ' + account.address + '\n' + '='.repeat(60));
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
