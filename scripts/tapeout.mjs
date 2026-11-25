// ExitProof tape-out on X Layer, in one resumable command.
//
//   0. re-verify circuit/netlist.json locally against circuit/truth.json (all 2048 inputs) — before any spending
//   a. find or create our processor on the TapeOut factory ("ExitProof Guard", BEM deployFee via exact approve)
//   b. BEM approvals: exactly what each step pulls, nothing more
//   c. mint the NAND transistors still needed (gates - balance)
//   d. tapeout(netlist, 11, 4) paying TAPEOUT_FEE in OKB
//   e. verify on chain: netlist bytes, circuitInfo == (11, 4, 0, gates), all 2048 evals == truth.json
//   f. write deployments/<network>.json {processor, transistors, circuitId, createTx, mintTx, tapeoutTx, ...}
//
// Every transaction is simulated against the chain right before it is sent. Progress is saved after every step
// (STATE, default deployments/<network>.json), so re-running continues where it stopped.
//
//   node scripts/tapeout.mjs                         dry run against X Layer mainnet (sends nothing)
//   SEND=1 node scripts/tapeout.mjs                  really send
//   RPC_URL=http://127.0.0.1:8549 SEND=1 node scripts/tapeout.mjs     rehearsal on a local anvil fork (network "fork")
//
// Env: DEPLOYER_KEY (required, 0x + 64 hex; read from the environment only), RPC_URL (default https://rpc.xlayer.tech),
//      SEND=1, NETWORK (default: "fork" for localhost RPCs, else "xlayer"), STATE (progress file),
//      CPU_SUFFIX (appended to the processor name/symbol if "ExitProof Guard" is taken),
//      PROCESSOR (adopt an existing processor you created instead of creating one).

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient, createWalletClient, http, parseAbi, formatEther, decodeEventLog, defineChain,
  decodeErrorResult, getAddress
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FACTORY = '0x1f09daefa827f02cbb40967cc91b259763760761';
const BEM = '0x60e62efa9405d6873c5deabd4e6cc91c25363952';
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const NAND = 0n;

const SEND = process.env.SEND === '1';
const RPC_URL = process.env.RPC_URL || 'https://rpc.xlayer.tech';
const LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)(:|\/|$)/.test(RPC_URL);
const NETWORK = process.env.NETWORK || (LOCAL ? 'fork' : 'xlayer');
const OUT_FILE = path.join(ROOT, 'deployments', NETWORK + '.json');
const STATE_FILE = process.env.STATE || OUT_FILE;
const SUFFIX = process.env.CPU_SUFFIX || '';
const CPU = {
  name: 'ExitProof Guard' + SUFFIX,
  symbol: 'EXITP' + SUFFIX.replace(/[^A-Za-z0-9]/g, '').toUpperCase(),
  story: 'ExitProof: don\'t buy what you can\'t sell. A buy router on X Layer swaps, then in the same transaction ' +
    'proves the whole position can be sold back through a fresh holder, and lets this 54-NAND circuit decide ' +
    'allow or deny from 11 facts (sellability, taxes, owner, upgradeability, danger, scan state, risk mode). ' +
    'If the circuit says no, the buy reverts and the money never moves.',
  supply: 10000n,
  mintPrice: 0n
};

const ABI = parseAbi([
  'function deployFee() view returns (uint256)',
  'function cpuCount() view returns (uint256)',
  'function cpuAt(uint256) view returns (address)',
  'function isCPU(address) view returns (bool)',
  'function createCPU(string name, string symbol, string story, uint256 transistorSupply, uint256 mintPrice) payable returns (address, address)',
  'event CPUCreated(address indexed circuits, address indexed transistors, address indexed creator, string name, uint256 supply, uint256 mintPrice)',
  'function name() view returns (string)',
  'function factory() view returns (address)',
  'function transistors() view returns (address)',
  'function TAPEOUT_FEE() view returns (uint256)',
  'function tapeout(bytes nl, uint32 nIn, uint32 nOut) payable returns (uint256)',
  'event TapedOut(uint256 indexed circuitId, address indexed author, uint32 gateCount, uint32 nState)',
  'function eval(uint256 id, bytes inputs) view returns (bytes)',
  'function netlist(uint256 id) view returns (bytes)',
  'function circuitInfo(uint256 id) view returns (uint32 nIn, uint32 nOut, uint32 nState, uint32 gateCount)',
  'function ownerOf(uint256) view returns (address)',
  'function mint(uint256 id, uint256 amount) payable',
  'function balanceOf(address account, uint256 id) view returns (uint256)',
  'function protocolFee() view returns (uint256)',
  'function mintPrice() view returns (uint256)'
]);
const ERC20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)'
]);
const ALLOWANCE_ERR = parseAbi(['error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)']);

const bem = (x) => (x === undefined || x === null ? '?' : (Number(x) / 1e8).toString());

main().catch((err) => {
  console.error('\nSTOPPED: ' + (err.shortMessage || err.message));
  console.error('Progress so far is saved in ' + path.relative(ROOT, STATE_FILE) + '. Fix the issue and run the same command again.');
  process.exit(1);
});

async function main() {
  // ---- 0. local verification: never spend on a wrong netlist
  const C = loadCircuit();
  console.log('Netlist        ' + C.gates + ' NAND, ' + C.nIn + ' in, ' + C.nOut + ' out, sha256 ' + C.sha256.slice(0, 16) + '…');
  console.log('Local check    all ' + C.truth.length + ' inputs match circuit/truth.json ✓');

  const key = process.env.DEPLOYER_KEY;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('Set DEPLOYER_KEY=0x… (64 hex chars) in the environment');
  const account = privateKeyToAccount(key);
  const chain = defineChain({
    id: 196, name: 'X Layer', nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 },
    rpcUrls: { default: { http: [RPC_URL] } }, contracts: { multicall3: { address: MULTICALL3 } }
  });
  const pub = createPublicClient({ chain, transport: http(RPC_URL, { timeout: 60_000 }) });
  const wallet = createWalletClient({ chain, transport: http(RPC_URL), account });
  const chainId = await pub.getChainId();
  if (chainId !== 196) throw new Error('RPC is chain ' + chainId + ', expected 196 (X Layer or a fork of it)');
  const read = (address, functionName, args = []) => pub.readContract({ address, abi: ABI, functionName, args });
  const bemOf = (a) => pub.readContract({ address: BEM, abi: ERC20, functionName: 'balanceOf', args: [a] });

  const state = fs.existsSync(STATE_FILE) && fs.readFileSync(STATE_FILE, 'utf8').trim()
    ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
  const save = () => {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
  };
  if (state.deployer && getAddress(state.deployer) !== account.address) {
    throw new Error(path.relative(ROOT, STATE_FILE) + ' belongs to ' + state.deployer + ', not ' + account.address);
  }

  const code = await pub.getCode({ address: account.address });
  if (code && code !== '0x') {
    throw new Error('wallet ' + account.address + ' has contract code (EIP-7702); NAND mint would fail with ERC1155InvalidReceiver. Use a plain EOA.');
  }
  const [okb0, bem0, deployFee, cpuCount] = await Promise.all([
    pub.getBalance({ address: account.address }), bemOf(account.address), read(FACTORY, 'deployFee'), read(FACTORY, 'cpuCount')
  ]);
  if (state.start === undefined) {
    state.network = NETWORK; state.chainId = chainId; state.deployer = account.address;
    state.start = { okb: okb0.toString(), bem: bem0.toString(), block: (await pub.getBlockNumber()).toString() };
  }
  console.log('Network        ' + NETWORK + ' (chain ' + chainId + ', ' + RPC_URL + ')');
  console.log('Deployer       ' + account.address);
  console.log('Balances       ' + formatEther(okb0) + ' OKB · ' + bem(bem0) + ' BEM');
  console.log('Factory        ' + FACTORY + ' · ' + cpuCount + ' processors · createCPU fee ' + bem(deployFee) + ' BEM');
  console.log('State          ' + path.relative(ROOT, STATE_FILE));
  // TAPEOUT_FEE is read from the processor once it exists; 0.0013 OKB on every processor so far (Nov 2026).
  const okbNeed = state.circuitId ? 0n : 1_300_000_000_000_000n + 2_000_000_000_000_000n;
  if (okb0 < okbNeed) throw new Error('Not enough OKB: need about ' + formatEther(okbNeed) + ' (tapeout fee + gas), have ' + formatEther(okb0));
  console.log(SEND ? '\nSENDING for real.\n' : '\nDRY RUN — simulating only. Run with SEND=1 to send.\n');

  // ---- tx helpers: simulate -> (send) -> receipt
  const sim = (address, abi, functionName, args, value = 0n) =>
    pub.simulateContract({ account, address, abi, functionName, args, value });
  const allowanceAsk = (err) => {
    for (let c = err; c; c = c.cause) {
      const data = typeof c.data === 'string' ? c.data : (c.data && c.data.data);
      if (typeof data === 'string' && data.startsWith('0xfb8f41b2')) {
        const d = decodeErrorResult({ abi: ALLOWANCE_ERR, data });
        return { spender: d.args[0], needed: d.args[2] };
      }
      if (c.data && c.data.errorName === 'ERC20InsufficientAllowance') return { spender: c.data.args[0], needed: c.data.args[2] };
    }
    return null;
  };
  async function sendReq(label, request) {
    if (!SEND) return null;
    const hash = await wallet.writeContract(request);
    console.log('    sent       ' + hash);
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== 'success') throw new Error(label + ' reverted on chain: ' + hash);
    console.log('    mined      block ' + r.blockNumber + ' · gas ' + r.gasUsed);
    state.gas = state.gas || {};
    state.gas[label] = r.gasUsed.toString();
    return r;
  }
  // Approve exactly `amount` of BEM to `spender` if the current allowance is short. Returns false in a dry run when
  // an approval is needed (later steps cannot be simulated before it exists).
  async function ensureBem(label, spender, amount) {
    if (amount === 0n) return true;
    const allowance = await pub.readContract({ address: BEM, abi: ERC20, functionName: 'allowance', args: [account.address, spender] });
    if (allowance >= amount) { console.log('  ✓ BEM        allowance ' + bem(allowance) + ' ≥ ' + bem(amount) + ' for ' + label); return true; }
    const have = await bemOf(account.address);
    if (have < amount) throw new Error('Not enough BEM for ' + label + ': need ' + bem(amount) + ', have ' + bem(have) + ' (token ' + BEM + ')');
    const { request } = await sim(BEM, ERC20, 'approve', [spender, amount]);
    console.log('  ✓ simulated  approve exactly ' + bem(amount) + ' BEM to ' + spender + ' (' + label + ')');
    if (!SEND) return false;
    await sendReq('approve BEM ' + label, request);
    return true;
  }
  // Simulate then send; if the chain asks for a (different) BEM allowance, approve exactly that and retry once.
  async function send(label, address, functionName, args, value = 0n) {
    let request;
    try {
      ({ request } = await sim(address, ABI, functionName, args, value));
    } catch (err) {
      const ask = allowanceAsk(err);
      if (!ask) throw new Error(label + ' would revert: ' + reason(err));
      console.log('  ' + label + ' asks for a BEM allowance of ' + bem(ask.needed) + ' to ' + ask.spender);
      if (!(await ensureBem(label, ask.spender, ask.needed))) return null;
      ({ request } = await sim(address, ABI, functionName, args, value));
    }
    console.log('  ✓ simulated  ' + label + (value ? ' (' + formatEther(value) + ' OKB)' : ''));
    return sendReq(label, request);
  }
  const findEvent = (receipt, name) => receipt.logs.map((l) => {
    try { return decodeEventLog({ abi: ABI, data: l.data, topics: l.topics }); } catch { return null; }
  }).find((e) => e && e.eventName === name);
  const dryEnd = (why) => {
    console.log('\nDry run OK up to here. ' + why);
    console.log('When ready:  SEND=1 node scripts/tapeout.mjs');
  };

  // ---- a. processor
  if (!state.processor && process.env.PROCESSOR) {
    const p = getAddress(process.env.PROCESSOR);
    if (!(await read(FACTORY, 'isCPU', [p]))) throw new Error('PROCESSOR ' + p + ' is not a TapeOut processor');
    state.processor = p; state.transistors = await read(p, 'transistors'); state.cpuName = await read(p, 'name');
    state.adopted = true; save();
    console.log('Step a  adopted processor ' + p + ' ("' + state.cpuName + '")');
  }
  if (!state.processor) {
    console.log('Step a  create processor "' + CPU.name + '" (' + CPU.symbol + ')');
    const names = await pub.multicall({
      contracts: Array.from({ length: Number(cpuCount) }, (_, i) => ({ address: FACTORY, abi: ABI, functionName: 'cpuAt', args: [BigInt(i)] })),
      allowFailure: false
    }).then((addrs) => pub.multicall({ contracts: addrs.map((a) => ({ address: a, abi: ABI, functionName: 'name' })) })
      .then((ns) => ns.map((n, i) => ({ addr: addrs[i], name: n.result }))));
    const clash = names.find((n) => n.name === CPU.name);
    if (clash) {
      throw new Error('a processor named "' + CPU.name + '" already exists at ' + clash.addr +
        '. If it is yours, run with PROCESSOR=' + clash.addr + '; otherwise set CPU_SUFFIX (e.g. CPU_SUFFIX=" 2").');
    }
    console.log('  ✓ name free  among ' + names.length + ' processors');
    if (!(await ensureBem('createCPU', FACTORY, deployFee))) return dryEnd('createCPU is simulated once the approval exists.');
    const r = await send('createCPU', FACTORY, 'createCPU', [CPU.name, CPU.symbol, CPU.story, CPU.supply, CPU.mintPrice], 0n);
    if (!r) return dryEnd('Steps c–e need the processor.');
    const ev = findEvent(r, 'CPUCreated');
    if (!ev) throw new Error('no CPUCreated event in ' + r.transactionHash);
    // do not trust the event's argument order: the processor answers TAPEOUT_FEE() and its transistors() is the other one
    let processor = null;
    for (const [a, b] of [[ev.args.circuits, ev.args.transistors], [ev.args.transistors, ev.args.circuits]]) {
      try { if (getAddress(await read(a, 'transistors')) === getAddress(b)) { await read(a, 'TAPEOUT_FEE'); processor = a; break; } } catch { /* not it */ }
    }
    if (!processor) throw new Error('could not identify the processor in ' + r.transactionHash);
    state.processor = getAddress(processor);
    state.transistors = getAddress(await read(processor, 'transistors'));
    state.cpuName = CPU.name; state.cpuSymbol = CPU.symbol;
    state.createTx = r.transactionHash;
    save();
  }
  if (!(await read(FACTORY, 'isCPU', [state.processor]))) throw new Error('factory.isCPU(' + state.processor + ') is false');
  console.log('  processor    ' + state.processor + ' · transistors ' + state.transistors);

  // Never tape out twice: if this exact netlist already lives on our processor (owned by us), use it.
  if (!state.circuitId) {
    for (let i = 1n, misses = 0; i < 1000n && misses < 3; i++) {
      let nl;
      try { nl = (await read(state.processor, 'netlist', [i])).toLowerCase(); } catch { misses++; continue; }
      if (!nl || nl === '0x') { misses++; continue; }
      misses = 0;
      if (nl === C.netlist && getAddress(await read(state.processor, 'ownerOf', [i])) === account.address) {
        console.log('  netlist already taped out as circuit #' + i + ' — skipping mint and tapeout');
        state.circuitId = i.toString(); state.found = true; save(); break;
      }
    }
  }

  // ---- b+c. NAND
  if (!state.circuitId) {
    const have = await read(state.transistors, 'balanceOf', [account.address, NAND]);
    const need = BigInt(C.gates);
    if (have < need) {
      const amount = need - have;
      const [pfee, price] = await Promise.all([
        read(state.transistors, 'protocolFee').catch(() => 0n), read(state.transistors, 'mintPrice').catch(() => 0n)
      ]);
      console.log('Step c  mint ' + amount + ' NAND (have ' + have + ') · protocol fee ' + bem(pfee) + ' BEM · mint price ' + formatEther(price * amount) + ' OKB');
      if (!(await ensureBem('NAND mint', state.transistors, pfee))) return dryEnd('The mint is simulated once the approval exists.');
      const r = await send('mint ' + amount + ' NAND', state.transistors, 'mint', [NAND, amount], price * amount);
      if (!r) return dryEnd('tapeout needs the NAND first.');
      state.mintTx = r.transactionHash; save();
    } else {
      console.log('Step c  NAND balance ' + have + ' ≥ ' + need + ' ✓');
    }
  }

  // ---- d. tapeout
  if (!state.circuitId) {
    const fee = await read(state.processor, 'TAPEOUT_FEE');
    console.log('Step d  tapeout(netlist, ' + C.nIn + ', ' + C.nOut + ') · fee ' + formatEther(fee) + ' OKB');
    const r = await send('tapeout', state.processor, 'tapeout', [C.netlist, C.nIn, C.nOut], fee);
    if (!r) return dryEnd('verification needs the circuit.');
    const ev = findEvent(r, 'TapedOut');
    if (!ev) throw new Error('no TapedOut event in ' + r.transactionHash);
    state.circuitId = ev.args.circuitId.toString();
    state.tapeoutTx = r.transactionHash;
    save();
  }
  const id = BigInt(state.circuitId);
  console.log('  circuit      #' + id);

  // ---- e. verify on chain
  console.log('Step e  verify circuit #' + id + ' on chain');
  const nl = (await read(state.processor, 'netlist', [id])).toLowerCase();
  if (nl !== C.netlist) throw new Error('on-chain netlist differs from circuit/netlist.json');
  console.log('  ✓ netlist    bytes identical (' + (nl.length - 2) / 2 + ' bytes)');
  const info = await read(state.processor, 'circuitInfo', [id]);
  if (info[0] !== C.nIn || info[1] !== C.nOut || info[2] !== 0 || info[3] !== C.gates) {
    throw new Error('circuitInfo mismatch: ' + info.join(','));
  }
  console.log('  ✓ info       (' + info.join(', ') + ')');
  const owner = getAddress(await read(state.processor, 'ownerOf', [id]));
  console.log('  ✓ owner      ' + owner + (owner === account.address ? ' (deployer)' : ' (NOT the deployer)'));
  let ok = 0;
  const CHUNK = 64; // ~137k gas per eval: keep each multicall well under RPC eth_call gas caps
  for (let start = 0; start < C.truth.length; start += CHUNK) {
    const xs = Array.from({ length: Math.min(CHUNK, C.truth.length - start) }, (_, i) => start + i);
    const outs = await pub.multicall({
      contracts: xs.map((x) => ({ address: state.processor, abi: ABI, functionName: 'eval', args: [id, inputBytes(x)] })),
      allowFailure: false
    });
    xs.forEach((x, i) => {
      const o = outs[i];
      if (o.length !== 4) throw new Error('eval(0x' + x.toString(16) + ') returned ' + o + ', expected 1 byte');
      if (parseInt(o.slice(2, 4), 16) !== C.truth[x]) throw new Error('eval mismatch at input ' + x + ': chain ' + o + ' vs truth ' + C.truth[x]);
      ok++;
    });
  }
  console.log('  ✓ eval       ' + ok + '/' + C.truth.length + ' ✓');
  state.verified = { netlistSha256: C.sha256, evals: ok + '/' + C.truth.length, at: new Date().toISOString() };

  // ---- f. artifact
  const [okb1, bem1] = await Promise.all([pub.getBalance({ address: account.address }), bemOf(account.address)]);
  state.spent = {
    okb: formatEther(BigInt(state.start.okb) - okb1),
    bem: bem(BigInt(state.start.bem) - bem1)
  };
  Object.assign(state, { tapeoutFactory: FACTORY, bem: BEM, nIn: C.nIn, nOut: C.nOut, gates: C.gates });
  save();
  if (STATE_FILE !== OUT_FILE) {
    const out = fs.existsSync(OUT_FILE) ? JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')) : {};
    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.writeFileSync(OUT_FILE, JSON.stringify({ ...out, ...state }, null, 2) + '\n');
  }
  console.log('\nSpent          ' + state.spent.okb + ' OKB (fees + gas) · ' + state.spent.bem + ' BEM');
  console.log('Wrote          ' + path.relative(ROOT, OUT_FILE));
  console.log('\nPROCESSOR=' + state.processor + ' CIRCUIT_ID=' + state.circuitId);
}

// TapeOut input encoding: bit i of the input word = byte i/8, bit i%8 (little-endian).
function inputBytes(x) {
  return '0x' + (x & 0xff).toString(16).padStart(2, '0') + ((x >> 8) & 0xff).toString(16).padStart(2, '0');
}

// Loads circuit/netlist.json + truth.json and evaluates the netlist with TapeOut semantics on every input:
// wire 0 = 0, wire 1 = 1, wires 2.. = inputs, then one wire per NAND gate; outputs = the last nOut gates,
// packed bit i = output i. Throws on any disagreement.
function loadCircuit() {
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'circuit', 'netlist.json'), 'utf8'));
  const truth = JSON.parse(fs.readFileSync(path.join(ROOT, 'circuit', 'truth.json'), 'utf8'));
  const netlist = j.netlist.toLowerCase();
  const hex = netlist.slice(2);
  if (hex.length % 14) throw new Error('netlist length is not a multiple of 7 bytes');
  const sha = createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex');
  if (j.sha256 && sha !== j.sha256) throw new Error('netlist sha256 mismatch');
  const gates = [];
  for (let i = 0; i < hex.length; i += 14) {
    if (hex.slice(i, i + 2) !== '00') throw new Error('non-NAND element in netlist');
    gates.push([parseInt(hex.slice(i + 2, i + 8), 16), parseInt(hex.slice(i + 8, i + 14), 16)]);
  }
  if (gates.length !== j.gates) throw new Error('gate count mismatch');
  if (truth.length !== 1 << j.nIn) throw new Error('truth.json has ' + truth.length + ' entries, expected ' + (1 << j.nIn));
  for (let x = 0; x < truth.length; x++) {
    const s = [0, 1];
    for (let i = 0; i < j.nIn; i++) s.push((x >> i) & 1);
    for (const [a, b] of gates) {
      if (a >= s.length || b >= s.length) throw new Error('wire out of range');
      s.push(1 - (s[a] & s[b]));
    }
    const o = s.slice(-j.nOut).reduce((acc, bit, i) => acc | (bit << i), 0);
    if (o !== truth[x]) throw new Error('netlist disagrees with truth.json at input ' + x + ': ' + o + ' vs ' + truth[x]);
  }
  return { netlist, nIn: j.nIn, nOut: j.nOut, gates: j.gates, sha256: sha, truth };
}

function reason(err) {
  const parts = [];
  for (let e = err; e; e = e.cause) {
    if (e.data && e.data.errorName) parts.push(e.data.errorName + (e.data.args ? '(' + e.data.args.map(String).join(', ') + ')' : ''));
    if (typeof e.data === 'string' && e.data.length > 2) parts.push('data ' + e.data.slice(0, 74));
    if (e.reason) parts.push(e.reason);
  }
  const raw = String(err.details || err.shortMessage || err.message || err).split('\n')[0];
  return [...new Set(parts)].concat(raw).join(' · ');
}
