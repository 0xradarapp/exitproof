// Deploy RiskRegistry + ExitProofRouter on X Layer (or a local anvil fork of it), wired to the processor and circuit
// that scripts/tapeout.mjs taped out and verified. This is the canonical deployer; scripts/deploy-fork.mjs is the
// older fork-only variant, kept for reference.
//
//   1. read deployments/<network>.json (written by tapeout.mjs); refuse unless processor + circuitId are present and
//      verified 2048/2048, and the on-chain netlist/circuitInfo still match circuit/netlist.json
//   2. print the exact constructor arguments and the estimated OKB (gas estimate x gas price)
//   3. deploy RiskRegistry → setAttester(deployer, true) → deploy ExitProofRouter (each simulated right before sending)
//   4. read every router immutable back, write addresses + tx hashes into deployments/<network>.json and the network's
//      entry in web/config.json (router, registry, processor, circuitId; buyEnabled is left as it is)
//   5. print source-verification commands (Sourcify, OKLink); nothing is verified automatically
//
// The network is DETECTED (scripts/lib/net.mjs): an anvil node is "fork", any other chain-196 node is "xlayer" mainnet.
//
//   node scripts/deploy.mjs                                          dry run (sends nothing, writes nothing)
//   RPC_URL=http://127.0.0.1:8549 SEND=1 node scripts/deploy.mjs     on a local anvil fork
//   SEND=1 CONFIRM_MAINNET=yes node scripts/deploy.mjs               mainnet (prints the banner first)
//
// Env: DEPLOYER_KEY (0x + 64 hex; environment only; optional for a dry run, which then uses the deployer recorded by
//      tapeout.mjs), RPC_URL (default https://rpc.xlayer.tech), SEND=1, CONFIRM_MAINNET=yes (mainnet only),
//      FEE_RECIPIENT (default: the deployer). Fee is 10 bps; factories = [PotatoSwap] with fee [25].
//
// Re-running is safe. Before each deploy the nonce and predicted address are recorded, and the tx hash right after
// sending. A re-run first resolves that record (receipt, or code at the predicted address checked against this build)
// and never sends while a recorded transaction may still land. Every deploy uses its recorded nonce explicitly.

import fs from 'node:fs';
import path from 'node:path';
import {
  createWalletClient, http, getAddress, encodeDeployData, encodeAbiParameters, formatEther, getContractAddress, parseAbi, keccak256
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ROOT, loadConstants, xlayerChain, detectNetwork, deploymentFile } from './lib/net.mjs';

const K = loadConstants();
const RPC_URL = process.env.RPC_URL || 'https://rpc.xlayer.tech';
const SEND = process.env.SEND === '1';
const FEE_BPS = 10;
const FACTORIES = [K.potatoFactory];
const FACTORY_FEES = [25];
const SET_ATTESTER_GAS = 60_000n; // measured 47,781; estimated before the registry exists
const CONFIG_FILE = path.join(ROOT, 'web', 'config.json');
const PROC_ABI = parseAbi([
  'function netlist(uint256 id) view returns (bytes)',
  'function circuitInfo(uint256 id) view returns (uint32 nIn, uint32 nOut, uint32 nState, uint32 gateCount)'
]);
const FACTORY_ABI = parseAbi(['function isCPU(address) view returns (bool)']);
const ROUTER_CTOR = [
  { type: 'address' }, { type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'address' },
  { type: 'uint16' }, { type: 'address[]' }, { type: 'uint16[]' }
];

main().catch((e) => {
  console.error('\nSTOPPED: ' + (e.shortMessage || e.message));
  console.error(SEND ? 'Anything already sent is recorded in deployments/. Fix the issue and run the same command again.'
    : 'Dry run: nothing was sent or written.');
  process.exit(1);
});

function artifact(file, name) {
  const p = path.join(ROOT, 'out', file, name + '.json');
  if (!fs.existsSync(p)) throw new Error('missing ' + path.relative(ROOT, p) + ': run forge build first');
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  return { abi: j.abi, bytecode: j.bytecode.object, deployed: j.deployedBytecode.object };
}

async function main() {
  const key = process.env.DEPLOYER_KEY;
  if (key !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('DEPLOYER_KEY must be 0x + 64 hex chars');
  if (SEND && !key) throw new Error('SEND=1 needs DEPLOYER_KEY=0x… in the environment');
  const account = key ? privateKeyToAccount(key) : null;

  const { network, pub, chainId, client } = await detectNetwork(RPC_URL, K);
  const MAINNET = network === 'xlayer';
  const STATE_FILE = deploymentFile(network);
  const rel = path.relative(ROOT, STATE_FILE);
  console.log('Network        ' + network + ' (detected: chain ' + chainId + ', client "' + client + '", ' + RPC_URL + ')');

  // ---- 1. the circuit must exist, be ours, and be verified
  if (!fs.existsSync(STATE_FILE)) throw new Error(rel + ' does not exist: run scripts/tapeout.mjs (SEND=1) on this network first');
  const dep = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  const missing = (v) => v === undefined || v === null || v === '';
  if (missing(dep.processor) || missing(dep.circuitId)) throw new Error(rel + ' has no processor/circuitId: finish scripts/tapeout.mjs first');
  if (!dep.verified || dep.verified.evals !== '2048/2048') throw new Error(rel + ' circuit #' + dep.circuitId + ' is not verified 2048/2048: re-run scripts/tapeout.mjs');
  if (!dep.deployer) throw new Error(rel + ' has no deployer field');
  const deployer = account ? account.address : getAddress(dep.deployer);
  if (getAddress(dep.deployer) !== deployer) throw new Error(rel + ' belongs to ' + dep.deployer + ', not ' + deployer);
  if (!account) console.log('Note           no DEPLOYER_KEY: dry run as the recorded deployer ' + deployer);
  // State is written only when sending. In a dry run every change stays in memory.
  const save = () => { if (SEND) fs.writeFileSync(STATE_FILE, JSON.stringify(dep, null, 2) + '\n'); };

  const C = JSON.parse(fs.readFileSync(path.join(ROOT, 'circuit', 'netlist.json'), 'utf8'));
  const processor = getAddress(dep.processor);
  const circuitId = BigInt(dep.circuitId);
  if (!(await pub.readContract({ address: K.tapeoutFactory, abi: FACTORY_ABI, functionName: 'isCPU', args: [processor] }))) {
    throw new Error('processor ' + processor + ' is not a TapeOut processor on this node (stale ' + rel + '? fresh anvil?)');
  }
  const nl = (await pub.readContract({ address: processor, abi: PROC_ABI, functionName: 'netlist', args: [circuitId] })).toLowerCase();
  if (nl !== C.netlist.toLowerCase()) throw new Error('on-chain netlist of circuit #' + circuitId + ' differs from circuit/netlist.json');
  const info = await pub.readContract({ address: processor, abi: PROC_ABI, functionName: 'circuitInfo', args: [circuitId] });
  if (info[0] !== C.nIn || info[1] !== C.nOut || info[2] !== 0 || info[3] !== C.gates) throw new Error('circuitInfo mismatch: ' + info.join(','));
  console.log('Circuit        #' + circuitId + ' on ' + processor + ' · ' + C.gates + ' NAND · netlist identical · verified ' + dep.verified.evals + ' (' + dep.verified.at + ')');

  // ---- deployer: plain EOA, enough OKB
  const code = await pub.getCode({ address: deployer });
  if (code && code !== '0x') throw new Error('deployer ' + deployer + ' has contract code (EIP-7702 delegation): use a plain EOA');
  for (const [label, a] of [['PotatoSwap factory', K.potatoFactory], ['WOKB', K.wokb]]) {
    const c = await pub.getCode({ address: a });
    if (!c || c === '0x') throw new Error(label + ' ' + a + ' has no code on this node');
  }
  const feeRecipient = getAddress(dep.feeRecipient || process.env.FEE_RECIPIENT || deployer);
  if (dep.feeRecipient && process.env.FEE_RECIPIENT && getAddress(process.env.FEE_RECIPIENT) !== feeRecipient) {
    throw new Error(rel + ' already fixes feeRecipient ' + dep.feeRecipient + ' for a pending/finished deploy; FEE_RECIPIENT differs');
  }
  const Registry = artifact('RiskRegistry.sol', 'RiskRegistry');
  const Router = artifact('ExitProofRouter.sol', 'ExitProofRouter');
  const hasCode = async (a) => { const c = await pub.getCode({ address: a }); return !!c && c !== '0x'; };
  const nonces = async () => {
    const [latest, pending] = await Promise.all([
      pub.getTransactionCount({ address: deployer, blockTag: 'latest' }),
      pub.getTransactionCount({ address: deployer, blockTag: 'pending' })
    ]);
    return { latest, pending };
  };
  // Receipt lookup that survives flaky RPCs (CloudFront 403s, timeouts). null = not found after all attempts.
  async function receiptOf(hash, attempts = 6) {
    for (let i = 0; i < attempts; i++) {
      try { return await pub.getTransactionReceipt({ hash }); } catch { /* not mined yet, or RPC error */ }
      await new Promise((r) => setTimeout(r, 3000));
    }
    return null;
  }
  async function waitMined(label, hash) {
    let r = null;
    for (let i = 0; i < 5 && !r; i++) {
      try { r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000, retryCount: 10 }); } catch (e) {
        console.log('    waiting    ' + label + ' receipt: ' + (e.shortMessage || e.message).split('\n')[0] + ' (retrying)');
      }
    }
    if (!r) throw new Error(label + ' tx ' + hash + ' has no receipt yet. It is recorded in ' + rel + '; re-run later, nothing will be sent twice');
    return r;
  }

  // Bytecode checks for adopting a contract found at a recorded address.
  const keccakHex = (h) => keccak256(h.toLowerCase());
  async function verifyRegistry(a) {
    const rt = await pub.getCode({ address: a });
    if (!rt || keccakHex(rt) !== keccakHex(Registry.deployed)) throw new Error('code at ' + a + ' is not this build of RiskRegistry; refusing to adopt it');
    const owner = getAddress(await pub.readContract({ address: a, abi: Registry.abi, functionName: 'owner' }));
    if (owner !== deployer) throw new Error('registry ' + a + ' is owned by ' + owner + ', not ' + deployer);
  }
  async function verifyRouter(a, registry) {
    const rt = await pub.getCode({ address: a });
    // immutables change bytes, not length
    if (!rt || rt.length !== Router.deployed.length) throw new Error('code at ' + a + ' is not this build of ExitProofRouter (length differs); refusing to adopt it');
    const rd = (fn) => pub.readContract({ address: a, abi: Router.abi, functionName: fn });
    const [p, c, r, w, f, b] = await Promise.all(['processor', 'circuitId', 'registry', 'wokb', 'feeRecipient', 'feeBps'].map(rd));
    if (getAddress(p) !== processor || c !== circuitId || getAddress(r) !== getAddress(registry) || getAddress(w) !== K.wokb ||
      getAddress(f) !== feeRecipient || Number(b) !== FEE_BPS) throw new Error('router ' + a + ' immutables differ from the expected constructor args');
  }

  // ---- resume: resolve a deploy that was sent (or maybe sent) by an interrupted run. Never sends.
  dep.pending = dep.pending || {};
  async function resolvePending(name, verify) {
    const p = dep.pending[name];
    if (!p) return;
    console.log('Resume         ' + name + ': recorded nonce ' + p.nonce + ' → ' + p.address + (p.tx ? ' · tx ' + p.tx : ' · no tx hash recorded'));
    let address = null;
    if (p.tx) {
      const r = await receiptOf(p.tx);
      if (r && r.status === 'success') {
        address = getAddress(r.contractAddress);
        dep.gas = dep.gas || {};
        dep.gas['deploy ' + (name === 'registry' ? 'RiskRegistry' : 'ExitProofRouter')] = r.gasUsed.toString();
      }
      else if (r) {
        delete dep.pending[name]; save();
        throw new Error(name + ' tx ' + p.tx + ' reverted on chain (nonce consumed). Cleared it; re-run to deploy again');
      }
    }
    if (!address && await hasCode(p.address)) address = getAddress(p.address);
    if (!address) {
      // A recorded tx is only given up when the node POSITIVELY says it does not know it. An RPC error, or a tx the
      // node still knows (pending), means it may still land: refuse. (Nonce counts alone are not enough: on an L2 RPC
      // "pending" can equal "latest" while the sequencer still holds the tx.)
      if (p.tx) {
        let known;
        try { known = await pub.getTransaction({ hash: p.tx }); } catch (e) {
          if (e && e.name === 'TransactionNotFoundError') known = null;
          else throw new Error('could not look up ' + name + ' tx ' + p.tx + ' (' + (e.shortMessage || e.message).split('\n')[0] + '): it may still land, so nothing was sent. Re-run later');
        }
        if (known) throw new Error(name + ' tx ' + p.tx + ' is known to the node but not mined yet: wait for it, then re-run. Nothing was sent');
      }
      const n = await nonces();
      if (n.pending > p.nonce || n.latest > p.nonce) {
        throw new Error('nonce ' + p.nonce + ' is used or pending but ' + p.address + ' has no code yet: wait for that transaction (check the explorer), then re-run. Nothing was sent');
      }
      console.log('               ' + (p.tx ? 'tx not found on the node and ' : '') + 'nonce ' + p.nonce + ' unused: the earlier send did not reach the chain; it will be sent again with exactly nonce ' + p.nonce);
      dep.clearedNonce = dep.clearedNonce || {};
      dep.clearedNonce[name] = p.nonce;
      delete dep.pending[name]; save();
      return;
    }
    await verify(address);
    dep[name] = address;
    if (p.tx) dep[name + 'Tx'] = p.tx;
    delete dep.pending[name]; save();
    console.log('  ✓ adopted    ' + name + ' ' + address + ' (verified against this build)');
  }
  await resolvePending('registry', verifyRegistry);
  if (dep.registry) await resolvePending('router', (a) => verifyRouter(a, dep.registry));
  else if (dep.pending.router) throw new Error(rel + ' has a pending router but no registry: inspect it by hand');

  const writeConfig = () => {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    const net = cfg.networks && cfg.networks[network];
    if (!net) { console.log('Note           web/config.json has no "' + network + '" network; not changed'); return false; }
    const want = { router: dep.router, registry: dep.registry, processor, circuitId: circuitId.toString() };
    if (Object.keys(want).every((k) => net[k] === want[k])) return false;
    if (!SEND) { console.log('Note           web/config.json networks.' + network + ' is out of date (a SEND=1 run re-syncs it)'); return false; }
    Object.assign(net, want); // buyEnabled untouched
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n');
    console.log('Wrote          web/config.json (networks.' + network + ')');
    return true;
  };

  const routerArgsOf = () => [processor, circuitId, getAddress(dep.registry), K.wokb, feeRecipient, FEE_BPS, FACTORIES, FACTORY_FEES];
  const fillRecord = () => Object.assign(dep, {
    wokb: K.wokb, factory: K.potatoFactory, factoryFeeBps: FACTORY_FEES[0], feeRecipient, feeBps: FEE_BPS,
    routerConstructorArgs: encodeAbiParameters(ROUTER_CTOR, routerArgsOf())
  });

  // ---- what already exists
  if (dep.router) {
    if (!(await hasCode(dep.router))) throw new Error(rel + ' lists router ' + dep.router + ' but it has no code on this node (stale state; fresh anvil?)');
    await verifyRouter(dep.router, dep.registry);
    console.log('Already deployed: router ' + dep.router + ' · registry ' + dep.registry + ' (recorded in ' + rel + '). Nothing to send.');
    if (!dep.routerConstructorArgs || !dep.feeBps) { fillRecord(); delete dep.pending; save(); } // e.g. a router adopted on resume
    writeConfig();
    printVerify(network, dep);
    return;
  }
  let registry = null;
  if (dep.registry) {
    if (!(await hasCode(dep.registry))) throw new Error(rel + ' lists registry ' + dep.registry + ' with no code on this node (stale state)');
    await verifyRegistry(dep.registry);
    registry = getAddress(dep.registry);
  }

  // ---- 2. plan: exact constructor args + estimated OKB
  const [n0, balance, gasPrice] = await Promise.all([nonces(), pub.getBalance({ address: deployer }), pub.getGasPrice()]);
  if (n0.pending !== n0.latest) throw new Error('deployer has a pending transaction (nonce ' + n0.latest + '..' + (n0.pending - 1) + '): wait for it, then re-run');
  const nonce = n0.latest;
  const predictedRegistry = registry || getContractAddress({ from: deployer, nonce: BigInt(nonce) });
  const routerArgs = [processor, circuitId, predictedRegistry, K.wokb, feeRecipient, FEE_BPS, FACTORIES, FACTORY_FEES];
  const regData = encodeDeployData({ abi: Registry.abi, bytecode: Registry.bytecode, args: [] });
  const routerData = encodeDeployData({ abi: Router.abi, bytecode: Router.bytecode, args: routerArgs });
  // constructors are simulated here (eth_estimateGas executes them); setAttester is estimated after the registry exists
  const gRegistry = registry ? 0n : await pub.estimateGas({ account: deployer, data: regData });
  const attesterSet = registry ? await pub.readContract({ address: registry, abi: Registry.abi, functionName: 'isAttester', args: [deployer] }) : false;
  const gAttester = attesterSet ? 0n : SET_ATTESTER_GAS;
  const gRouter = await pub.estimateGas({ account: deployer, data: routerData });
  const gasTotal = gRegistry + gAttester + gRouter;
  const estOkb = gasTotal * gasPrice;
  const steps = [!registry && 'deploy RiskRegistry', !attesterSet && 'setAttester(' + deployer + ', true)', 'deploy ExitProofRouter'].filter(Boolean);

  const argLines = [
    'processor     ' + processor,
    'circuitId     ' + circuitId,
    'registry      ' + predictedRegistry + (registry ? ' (existing)' : ' (predicted, nonce ' + nonce + ')'),
    'wokb          ' + K.wokb,
    'feeRecipient  ' + feeRecipient + (process.env.FEE_RECIPIENT ? ' (FEE_RECIPIENT)' : ' (deployer)'),
    'feeBps        ' + FEE_BPS + ' (hard cap 30 in the contract)',
    'factories     [' + FACTORIES.join(', ') + '] (PotatoSwap V2)',
    'factoryFeeBps [' + FACTORY_FEES.join(', ') + ']'
  ];
  console.log('Deployer       ' + deployer + ' · nonce ' + nonce + ' · ' + formatEther(balance) + ' OKB');
  console.log('Plan           ' + steps.join(' → '));
  console.log('Router args    ' + argLines.join('\n               '));
  console.log('Gas estimate   registry ' + gRegistry + ' + setAttester ≤' + gAttester + ' + router ' + gRouter + ' = ' + gasTotal +
    ' @ ' + (Number(gasPrice) / 1e9) + ' gwei ≈ ' + formatEther(estOkb) + ' OKB');
  if (balance < estOkb * 12n / 10n) throw new Error('Not enough OKB: need ≈' + formatEther(estOkb * 12n / 10n) + ' (estimate +20%), have ' + formatEther(balance));

  if (SEND && MAINNET) {
    console.log('\n' + '='.repeat(72));
    console.log('  X LAYER MAINNET — real funds');
    console.log('  deployer   ' + deployer);
    console.log('  steps      ' + steps.join(' → '));
    console.log('  ExitProofRouter constructor:');
    for (const l of argLines) console.log('    ' + l);
    console.log('  estimated  ' + formatEther(estOkb) + ' OKB gas (' + gasTotal + ' gas @ ' + (Number(gasPrice) / 1e9) + ' gwei)');
    console.log('='.repeat(72));
    if (process.env.CONFIRM_MAINNET !== 'yes') throw new Error('mainnet send needs CONFIRM_MAINNET=yes in addition to SEND=1 (nothing was sent)');
  }
  if (!SEND) {
    console.log('\nDRY RUN OK: constructors simulated, nothing sent, nothing written.');
    console.log('When ready:  SEND=1' + (MAINNET ? ' CONFIRM_MAINNET=yes' : '') + ' node scripts/deploy.mjs');
    return;
  }
  console.log('\nSENDING' + (MAINNET ? ' on MAINNET' : ' on the fork') + '.\n');

  // ---- 3. send. Each deploy: record {nonce, predicted address} → simulate → send with that exact nonce →
  //         record the tx hash → wait. An interrupted run is resolved by resolvePending() above, never re-sent blindly.
  const wallet = createWalletClient({ chain: xlayerChain(RPC_URL, K), transport: http(RPC_URL), account });
  const okb0 = balance;
  dep.gas = dep.gas || {};
  dep.feeRecipient = feeRecipient;
  if (!dep.deployStartOkb) dep.deployStartOkb = balance.toString(); // spend is measured across resumed runs
  async function deploy(name, label, art, args) {
    const n = await nonces();
    if (n.pending !== n.latest) throw new Error('deployer has a pending transaction: wait for it, then re-run (nothing sent for ' + label + ')');
    const cleared = dep.clearedNonce && dep.clearedNonce[name];
    if (cleared !== undefined && n.latest !== cleared) {
      throw new Error(label + ': a cleared earlier send used nonce ' + cleared + ', but the next nonce is now ' + n.latest + ' (something else was sent): inspect ' + rel + ' and the explorer by hand. Nothing was sent');
    }
    const address = getContractAddress({ from: deployer, nonce: BigInt(n.latest) });
    const data = encodeDeployData({ abi: art.abi, bytecode: art.bytecode, args });
    await pub.call({ account: account.address, data });
    console.log('  ✓ simulated  deploy ' + label + ' → ' + address + ' (nonce ' + n.latest + ')');
    dep.pending[name] = { nonce: n.latest, address };
    save();
    const hash = await wallet.deployContract({ abi: art.abi, bytecode: art.bytecode, args, nonce: n.latest });
    dep.pending[name].tx = hash;
    save();
    console.log('    sent       ' + hash);
    const r = await waitMined(label, hash);
    if (r.status !== 'success' || !r.contractAddress) {
      delete dep.pending[name]; save();
      throw new Error(label + ' deploy reverted: ' + hash);
    }
    console.log('    mined      ' + r.contractAddress + ' · block ' + r.blockNumber + ' · gas ' + r.gasUsed);
    dep.gas['deploy ' + label] = r.gasUsed.toString();
    dep[name] = getAddress(r.contractAddress);
    dep[name + 'Tx'] = hash;
    delete dep.pending[name];
    if (dep.clearedNonce) { delete dep.clearedNonce[name]; if (!Object.keys(dep.clearedNonce).length) delete dep.clearedNonce; }
    save();
    return dep[name];
  }
  if (!registry) registry = await deploy('registry', 'RiskRegistry', Registry, []);
  if (!(await pub.readContract({ address: registry, abi: Registry.abi, functionName: 'isAttester', args: [deployer] }))) {
    // idempotent: a second setAttester(deployer, true) after an interrupted run changes nothing
    const { request } = await pub.simulateContract({ account, address: registry, abi: Registry.abi, functionName: 'setAttester', args: [deployer, true] });
    console.log('  ✓ simulated  setAttester(' + deployer + ', true)');
    const hash = await wallet.writeContract(request);
    dep.attesterTx = hash; save();
    const r = await waitMined('setAttester', hash);
    if (r.status !== 'success') throw new Error('setAttester reverted: ' + hash);
    console.log('    mined      setAttester · gas ' + r.gasUsed);
    dep.attester = deployer;
    dep.gas.setAttester = r.gasUsed.toString();
    save();
  }
  const finalArgs = [processor, circuitId, registry, K.wokb, feeRecipient, FEE_BPS, FACTORIES, FACTORY_FEES];
  const router = await deploy('router', 'ExitProofRouter', Router, finalArgs);

  // ---- 4. read back, record
  await verifyRouter(router, registry);
  if (!(await pub.readContract({ address: registry, abi: Registry.abi, functionName: 'isAttester', args: [deployer] }))) throw new Error('deployer is not an attester');
  console.log('  ✓ router immutables read back · deployer is attester');
  const okb1 = await pub.getBalance({ address: deployer });
  fillRecord();
  Object.assign(dep, { attester: deployer, deploySpentOkb: formatEther(BigInt(dep.deployStartOkb) - okb1) });
  delete dep.pending;
  save();
  console.log('Wrote          ' + rel);
  writeConfig();
  console.log('Spent          ' + dep.deploySpentOkb + ' OKB (since the first deploy run; this run ' + formatEther(okb0 - okb1) + ')');
  console.log('\nROUTER=' + router + ' REGISTRY=' + registry);
  printVerify(network, dep);
}

function printVerify(network, dep) {
  const args = dep.routerConstructorArgs || encodeAbiParameters(ROUTER_CTOR, [
    getAddress(dep.processor), BigInt(dep.circuitId), getAddress(dep.registry), K.wokb,
    getAddress(dep.feeRecipient || dep.deployer), Number(dep.feeBps ?? FEE_BPS), FACTORIES, FACTORY_FEES
  ]);
  const common = '--chain 196 --compiler-version 0.8.24 --optimizer-runs 200 --evm-version cancun';
  const oklink = '--verifier oklink --verifier-url https://www.oklink.com/api/v5/explorer/contract/verify-source-code-plugin/XLAYER';
  console.log('\nSource verification (not run automatically' + (network === 'fork' ? '; only meaningful on mainnet' : '') + '):');
  console.log('  forge verify-contract ' + dep.registry + ' contracts/RiskRegistry.sol:RiskRegistry ' + common + ' --verifier sourcify');
  console.log('  forge verify-contract ' + dep.router + ' contracts/ExitProofRouter.sol:ExitProofRouter ' + common + ' --constructor-args ' + args + ' --verifier sourcify');
  console.log('  OKLink: the same two commands with  ' + oklink + '  (add --verifier-api-key if OKLink asks for one)');
  console.log('  Check:  https://repo.sourcify.dev/196/' + dep.router + '  ·  https://www.oklink.com/xlayer/address/' + dep.router + '#code');
}
