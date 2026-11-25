// Deploy RiskRegistry + ExitProofRouter on a LOCAL anvil fork of X Layer, wired to the processor/circuit that
// scripts/tapeout.mjs taped out (read from deployments/<network>.json), and merge the addresses into that file.
// Superseded: scripts/deploy.mjs is the canonical deployer (fork and mainnet, same code path). Kept for reference;
// this script refuses non-local RPCs.
//
//   forge build && RPC_URL=http://127.0.0.1:8549 DEPLOYER_KEY=0x… node scripts/deploy-fork.mjs
//
// The network is detected (anvil => "fork"); anything that is not an anvil node is refused.
// Env: DEPLOYER_KEY (required), RPC_URL (default http://127.0.0.1:8549),
//      FEE_RECIPIENT (default deployer), FEE_BPS (default 10), ATTESTER (extra attester; the deployer is always one).

import fs from 'node:fs';
import path from 'node:path';
import { createWalletClient, http, getAddress, encodeDeployData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ROOT, loadConstants, xlayerChain, detectNetwork, deploymentFile } from './lib/net.mjs';

const K = loadConstants();
const RPC_URL = process.env.RPC_URL || 'http://127.0.0.1:8549';
const WOKB = K.wokb;
const POTATO_FACTORY = K.potatoFactory;
const POTATO_FEE_BPS = K.potatoFeeBps;

main().catch((e) => { console.error('\nSTOPPED: ' + (e.shortMessage || e.message)); process.exit(1); });

function artifact(file, name) {
  const p = path.join(ROOT, 'out', file, name + '.json');
  if (!fs.existsSync(p)) throw new Error('missing ' + path.relative(ROOT, p) + ' — run forge build first');
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  return { abi: j.abi, bytecode: j.bytecode.object };
}

async function main() {
  const key = process.env.DEPLOYER_KEY;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('Set DEPLOYER_KEY=0x… in the environment');
  const account = privateKeyToAccount(key);
  const { network, pub, client } = await detectNetwork(RPC_URL, K);
  if (network !== 'fork') throw new Error('deploy-fork.mjs only targets an anvil fork; ' + RPC_URL + ' is "' + network + '" (client "' + client + '")');
  console.log('Network: fork (detected, client "' + client + '")');
  const OUT_FILE = deploymentFile(network);
  const wallet = createWalletClient({ chain: xlayerChain(RPC_URL, K), transport: http(RPC_URL), account });
  for (const [label, a] of [['PotatoSwap factory', POTATO_FACTORY], ['WOKB', WOKB]]) {
    const code = await pub.getCode({ address: a });
    if (!code || code === '0x') throw new Error(label + ' ' + a + ' has no code on this fork');
  }

  const dep = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
  if (!dep.processor || !dep.circuitId || !dep.verified) throw new Error(path.relative(ROOT, OUT_FILE) + ' has no verified circuit — run scripts/tapeout.mjs first');
  const feeRecipient = getAddress(process.env.FEE_RECIPIENT || account.address);
  const feeBps = Number(process.env.FEE_BPS || 10);
  const Registry = artifact('RiskRegistry.sol', 'RiskRegistry');
  const Router = artifact('ExitProofRouter.sol', 'ExitProofRouter');

  async function deploy(label, art, args) {
    const data = encodeDeployData({ abi: art.abi, bytecode: art.bytecode, args });
    await pub.call({ account: account.address, data }); // simulate the constructor
    console.log('  ✓ simulated  deploy ' + label);
    const hash = await wallet.deployContract({ abi: art.abi, bytecode: art.bytecode, args });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== 'success' || !r.contractAddress) throw new Error(label + ' deploy failed: ' + hash);
    console.log('    ' + label + ' ' + r.contractAddress + ' · gas ' + r.gasUsed);
    return { address: getAddress(r.contractAddress), hash, gas: r.gasUsed };
  }
  async function write(label, address, abi, functionName, args) {
    const { request } = await pub.simulateContract({ account, address, abi, functionName, args });
    const hash = await wallet.writeContract(request);
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== 'success') throw new Error(label + ' reverted: ' + hash);
    console.log('  ✓ ' + label + ' · gas ' + r.gasUsed);
    return r;
  }

  console.log('Deploying on ' + RPC_URL + ' as ' + account.address + ' (processor ' + dep.processor + ', circuit #' + dep.circuitId + ')');
  const okb0 = await pub.getBalance({ address: account.address });
  const reg = await deploy('RiskRegistry', Registry, []);
  await write('setAttester(deployer)', reg.address, Registry.abi, 'setAttester', [account.address, true]);
  if (process.env.ATTESTER) await write('setAttester(ATTESTER)', reg.address, Registry.abi, 'setAttester', [getAddress(process.env.ATTESTER), true]);
  const router = await deploy('ExitProofRouter', Router, [
    dep.processor, BigInt(dep.circuitId), reg.address, WOKB, feeRecipient, feeBps, [POTATO_FACTORY], [POTATO_FEE_BPS]
  ]);
  const rd = (fn) => pub.readContract({ address: router.address, abi: Router.abi, functionName: fn });
  const [p, c, r, w, f, b] = await Promise.all(['processor', 'circuitId', 'registry', 'wokb', 'feeRecipient', 'feeBps'].map(rd));
  if (getAddress(p) !== getAddress(dep.processor) || c !== BigInt(dep.circuitId) || getAddress(r) !== reg.address ||
    getAddress(w) !== getAddress(WOKB) || getAddress(f) !== feeRecipient || b !== feeBps) throw new Error('router immutables mismatch');
  console.log('  ✓ router immutables read back');
  const okb1 = await pub.getBalance({ address: account.address });

  Object.assign(dep, {
    registry: reg.address, router: router.address, wokb: getAddress(WOKB), factory: getAddress(POTATO_FACTORY),
    factoryFeeBps: POTATO_FEE_BPS, feeRecipient, feeBps, attester: account.address,
    registryTx: reg.hash, routerTx: router.hash,
    deploySpentOkb: (Number(okb0 - okb1) / 1e18).toString()
  });
  dep.gas = { ...(dep.gas || {}), 'deploy RiskRegistry': reg.gas.toString(), 'deploy ExitProofRouter': router.gas.toString() };
  fs.writeFileSync(OUT_FILE, JSON.stringify(dep, null, 2) + '\n');
  console.log('\nWrote ' + path.relative(ROOT, OUT_FILE) + ' · router ' + router.address + ' · registry ' + reg.address);
}
