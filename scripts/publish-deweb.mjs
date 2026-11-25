// Publish dist/deweb/ (node scripts/build-deweb.mjs) to TapeOut DeWEB: the files are stored in the ERC-6551 container
// of our circuit NFT (SiteRegistry), and the name <circuitId>.2.<processorIndex>.tape is activated (DomainBinding), so
// TapeKit gateways serve it at https://<circuitId>-2-<processorIndex>.tapekit.org/. Resumable: re-run the same command.
//
//   a. checks: the circuit (deployments/<network>.json from tapeout.mjs) is held by this wallet; the DeWEB contracts
//      are wired together and run the implementations TapeKit pins (else the gateway refuses to serve: "store-changed")
//   b. open the circuit's container through the Opener, once (fee read on chain: Opener.FEE())
//   c. authorize the uploader: SiteRegistry.canEdit(container, wallet) must be true. The NFT holder is the container
//      owner and can edit directly (proved on the fork), so no tx is needed when the holder publishes; a separate
//      uploader would need setOperator(container, uploader, ttl ≤ OPERATOR_TTL_MAX = 30 days) from the holder
//   d. upload every file: putFile(chunk 0) + appendChunk(1…) in 24,000-byte chunks, assets first and index.html last;
//      a file whose on-chain sha256 and chunk count already match is skipped, a half-uploaded one continues where it
//      stopped; every file is then read back with readRange and its SHA-256 compared with the local file
//   e. setFallback("index.html"), then bind(name, container, MONTHS) paying monthlyFee() × MONTHS (MONTHS defaults
//      to 1, the protocol minimum; renew or extend later with MONTHS=n)
//   f. resolve the name exactly as the TapeKit kernel does (cpuAt → accountOf/isOpened → ownerOf → isLive /
//      isContainerLive → pathCount/pathsRange/fallbackPath → fileInfo + readRange + sha256) and print the gateway URL
//
// The network is DETECTED (scripts/lib/net.mjs): an anvil node is "fork", any other chain-196 node is "xlayer".
// Progress: deployments/deweb-<network>.json (written only with SEND=1). A dry run sends and writes nothing.
//
//   node scripts/build-deweb.mjs && node scripts/publish-deweb.mjs                 dry run: names, fees, plan
//   RPC_URL=http://127.0.0.1:8549 SEND=1 node scripts/publish-deweb.mjs             rehearsal on a local anvil fork
//   SEND=1 CONFIRM_MAINNET=yes node scripts/publish-deweb.mjs                       mainnet (prints the exact spend first)
//
// Guards: fee caps (open ≤ 0.1 OKB, name ≤ 0.05 OKB, all fees ≤ 0.15 OKB; FEE_CAP_OKB=<n> replaces all three with n),
// the Opener's runtime code hash is pinned, dist/deweb.manifest.json must embed exactly the router/registry/processor/
// circuitId of deployments/<network>.json (no stale or "pending" build), one run at a time (lock file).
//
// Env: DEPLOYER_KEY (required, 0x + 64 hex; environment only; must hold the circuit NFT), RPC_URL (default
//      https://rpc.xlayer.tech), SEND=1, CONFIRM_MAINNET=yes (mainnet only), MONTHS (default 1), FEE_CAP_OKB,
//      PROCESSOR + CIRCUIT_ID (override deployments/<network>.json).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createWalletClient, http, parseAbi, formatEther, formatGwei, parseEther, getAddress, toHex, keccak256, toBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ROOT, loadConstants, xlayerChain, detectNetwork, deploymentFile } from './lib/net.mjs';

const K = loadConstants();
const FACTORY = K.tapeoutFactory;
// TapeOut DeWEB on X Layer (same addresses as TapeKit kernel/config.js L2_CONTRACTS, checked on chain below)
const OPENER = getAddress('0x536adD8F30f03b69f6fbF29d425A816A0dC50106');
const SITES = getAddress('0xd6EFb7adCc9c83dC4924Ad56f6a8E4e969b9ADB6');
const BINDING = getAddress('0x68809Fd2fb343aA57D0aeB7f33Defe477c9666f9');
// ERC-1967 implementations TapeKit pins (kernel/config.js expectedImpl): any other → the gateway shows "store-changed"
const EXPECTED_IMPL = { [SITES]: '0xa85c4143d1d4a77f54b8e4ecc9e6d1418afea45f', [BINDING]: '0x5ebf29b80789e548907c707530c3c7607c4347df' };
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
// The Opener is not a proxy (ERC-1967 implementation and beacon slots are empty, no owner()): pin its runtime code.
// FEE() is then whatever this exact code returns. Read on X Layer mainnet 2026-11-25.
const OPENER_CODEHASH = '0xf0c334d8d72983af1c38694dac7a1c83348c0c000cbb987467d2aedee06999fd';
// Fee caps (msg.value): checked against the on-chain fees before anything is sent, and again right before each payment
const CAP_ENV = process.env.FEE_CAP_OKB;
const CAPS = CAP_ENV !== undefined
  ? { open: parseEther(CAP_ENV), bind: parseEther(CAP_ENV), total: parseEther(CAP_ENV), from: 'FEE_CAP_OKB=' + CAP_ENV }
  : { open: parseEther('0.1'), bind: parseEther('0.05'), total: parseEther('0.15'), from: 'built-in' };
const AREA = 2; // TapeKit area code of X Layer
const CHUNK = 24_000;
const READ = 24_000; // readRange window (TapeKit reads in the same size)
const FALLBACK = 'index.html';
// Gas model for the plan, from the fork rehearsal (2026-11-25, 673,977 bytes in 35 txs = 153.6M gas): a full
// 24,000-byte chunk costs 5.37M gas (~224 gas/byte, code-storage style), open 167k, setFallback 114k, bind 185k.
// Rounded up a little; the real gas of every tx is printed and kept in the state file.
const GAS = { open: 200_000n, perByte: 225n, perTx: 120_000n, fallback: 130_000n, bind: 200_000n };

const SEND = process.env.SEND === '1';
const RPC_URL = process.env.RPC_URL || 'https://rpc.xlayer.tech';
const MONTHS = BigInt(process.env.MONTHS || 1); // DomainBinding accepts 1 (fork-tested); 0 reverts
const DIST = path.join(ROOT, 'dist', 'deweb');
const MANIFEST = path.join(ROOT, 'dist', 'deweb.manifest.json');
const ZERO = '0x0000000000000000000000000000000000000000';
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

const ABI = parseAbi([
  'function cpuCount() view returns (uint256)',
  'function cpuAt(uint256) view returns (address)',
  'function isCPU(address) view returns (bool)',
  'function ownerOf(uint256) view returns (address)',
  'function name() view returns (string)',
  // Opener
  'function FEE() view returns (uint256)',
  'function accountOf(address circuits, uint256 tokenId) view returns (address)',
  'function isOpened(address circuits, uint256 tokenId) view returns (bool)',
  'function open(address circuits, uint256 tokenId) payable returns (address)',
  // ERC-6551 account
  'function token() view returns (uint256 chainId, address tokenContract, uint256 tokenId)',
  // SiteRegistry
  'function opener() view returns (address)',
  'function isOpenedContainer(address container) view returns (bool)',
  'function isOwner(address container, address account) view returns (bool)',
  'function canEdit(address container, address account) view returns (bool)',
  'function operatorOf(address container) view returns (address)',
  'function operatorUntil(address container) view returns (uint256)',
  'function OPERATOR_TTL_MAX() view returns (uint256)',
  'function setOperator(address container, address operator, uint256 ttl)',
  'function CHUNK_MAX() view returns (uint256)',
  'function CHUNKS_MAX() view returns (uint256)',
  'function fileInfo(address container, string path) view returns (uint32 size, string contentType, bytes32 sha256Hash, uint40 updatedAt, uint256 chunkCount)',
  'function readRange(address container, string path, uint256 offset, uint256 len) view returns (bytes)',
  'function pathCount(address container) view returns (uint256)',
  'function pathsRange(address container, uint256 from, uint256 count) view returns (string[])',
  'function fallbackPath(address container) view returns (string)',
  'function putFile(address container, string path, string contentType, bytes32 sha256Hash, bytes data)',
  'function appendChunk(address container, string path, uint256 expectIndex, bytes data)',
  'function setFallback(address container, string path)',
  // DomainBinding
  'function registry() view returns (address)',
  'function monthlyFee() view returns (uint256)',
  'function MAX_AHEAD() view returns (uint256)',
  'function isLive(string name, address container) view returns (bool)',
  'function isContainerLive(address container) view returns (bool)',
  'function paidUntil(bytes32 nameHash, address container) view returns (uint256)',
  'function bind(string name, address container, uint256 months) payable'
]);

const TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8', svg: 'image/svg+xml', woff2: 'font/woff2', txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8', png: 'image/png' };
const sha256 = (b) => '0x' + crypto.createHash('sha256').update(b).digest('hex');

main().catch((err) => {
  console.error('\nSTOPPED: ' + (err.shortMessage || err.message));
  console.error(SEND ? 'Progress is saved (on chain and in deployments/deweb-<network>.json). Fix the issue and run the same command again.'
    : 'Dry run: nothing was sent or written.');
  process.exit(1);
});

function loadSite() {
  if (!fs.existsSync(path.join(DIST, FALLBACK))) throw new Error('dist/deweb/index.html missing: run node scripts/build-deweb.mjs first');
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      const rel = path.relative(DIST, full).split(path.sep).join('/');
      const ext = rel.split('.').pop().toLowerCase();
      if (!TYPES[ext]) throw new Error('no content type for ' + rel);
      const bytes = fs.readFileSync(full);
      if (!bytes.length) throw new Error(rel + ' is empty');
      const chunks = [];
      for (let i = 0; i < bytes.length; i += CHUNK) chunks.push(bytes.subarray(i, i + CHUNK));
      files.push({ path: rel, bytes, size: bytes.length, sha: sha256(bytes), type: TYPES[ext], chunks });
    }
  };
  walk(DIST);
  // index.html last: the page only references files that are already stored
  files.sort((a, b) => (a.path === FALLBACK) - (b.path === FALLBACK) || a.path.localeCompare(b.path));
  const html = fs.readFileSync(path.join(DIST, FALLBACK), 'utf8');
  if (/127\.0\.0\.1|localhost:|\[::1\]/.test((html.match(/Content-Security-Policy" content="([^"]*)"/) || [])[1] || '') ||
      /"rpc":"http:\/\//.test(html)) throw new Error('dist/deweb/index.html points at a local RPC: rebuild with node scripts/build-deweb.mjs');
  if (!fs.existsSync(MANIFEST)) throw new Error('dist/deweb.manifest.json missing: rebuild with node scripts/build-deweb.mjs');
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const listed = Object.keys(manifest.files || {}).sort().join('\n');
  if (listed !== files.map((f) => f.path).sort().join('\n')) throw new Error('dist/deweb does not hold exactly the files of dist/deweb.manifest.json: rebuild');
  for (const f of files) if ('0x' + manifest.files[f.path] !== f.sha) throw new Error('dist/deweb/' + f.path + ' changed after the build: rebuild');
  return { files, manifest };
}

/** The build must embed exactly this network's deployment: no "pending" page, no stale addresses. */
function checkManifest(manifest, network, dep, depName) {
  const e = manifest.embedded || {};
  if (manifest.network !== network) throw new Error('dist/deweb was built for "' + manifest.network + '" but this RPC is "' + network + '": rebuild with DEPLOYMENT=' + network);
  const bad = [];
  for (const k of ['router', 'registry', 'processor', 'circuitId']) {
    if (e[k] === null || e[k] === undefined || e[k] === '') { bad.push(k + ' is empty in the build ("pending" page)'); continue; }
    if (dep[k] === undefined || dep[k] === null) { bad.push(k + ' is missing in ' + depName); continue; }
    if (String(e[k]).toLowerCase() !== String(dep[k]).toLowerCase()) bad.push(k + ' ' + e[k] + ' ≠ ' + depName + ' ' + dep[k]);
  }
  if (bad.length) throw new Error('refusing to publish a stale build: ' + bad.join('; ') + '. Run node scripts/build-deweb.mjs' + (network === 'fork' ? ' with DEPLOYMENT=fork' : '') + ' after deploy.mjs.');
}

async function main() {
  const { files, manifest } = loadSite();
  const totalBytes = files.reduce((s, f) => s + f.size, 0);
  const totalChunks = files.reduce((s, f) => s + f.chunks.length, 0);
  console.log('Site           ' + files.length + ' files, ' + totalBytes.toLocaleString('en-US') + ' bytes, ' + totalChunks + ' chunks of ≤' + CHUNK + ' bytes (dist/deweb)');

  const key = process.env.DEPLOYER_KEY;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('Set DEPLOYER_KEY=0x… (64 hex chars) in the environment');
  const account = privateKeyToAccount(key);
  const { network: NETWORK, pub, chainId, client } = await detectNetwork(RPC_URL, K);
  const MAINNET = NETWORK === 'xlayer';
  const wallet = createWalletClient({ chain: xlayerChain(RPC_URL, K), transport: http(RPC_URL, { timeout: 120_000 }), account });
  const read = (address, functionName, args = []) => pub.readContract({ address, abi: ABI, functionName, args });
  const tryRead = (address, functionName, args = []) => read(address, functionName, args).then((v) => ({ ok: true, v }), () => ({ ok: false }));

  console.log('Network        ' + NETWORK + ' (detected: chain ' + chainId + ', client "' + client + '", ' + RPC_URL + ')');
  console.log('Wallet         ' + account.address);

  // ---- the circuit (from tapeout.mjs) and the state file
  const dep = fs.existsSync(deploymentFile(NETWORK)) ? JSON.parse(fs.readFileSync(deploymentFile(NETWORK), 'utf8')) : {};
  const processor = getAddress(process.env.PROCESSOR || dep.processor || '0x0000000000000000000000000000000000000000');
  const circuitId = BigInt(process.env.CIRCUIT_ID || dep.circuitId || 0);
  if (!circuitId || processor === '0x0000000000000000000000000000000000000000') {
    throw new Error(path.relative(ROOT, deploymentFile(NETWORK)) + ' has no processor/circuitId: run scripts/tapeout.mjs on this network first (or set PROCESSOR and CIRCUIT_ID)');
  }
  checkManifest(manifest, NETWORK, dep, path.relative(ROOT, deploymentFile(NETWORK)));
  if (getAddress(manifest.embedded.processor) !== processor || BigInt(manifest.embedded.circuitId) !== circuitId) {
    throw new Error('the build embeds processor ' + manifest.embedded.processor + ' #' + manifest.embedded.circuitId + ', but this publish is for ' + processor + ' #' + circuitId);
  }
  console.log('Build          dist/deweb.manifest.json: ' + NETWORK + ' router ' + manifest.embedded.router + ', registry ' + manifest.embedded.registry + ' = ' + path.relative(ROOT, deploymentFile(NETWORK)) + ' ✓');
  const STATE_FILE = path.join(ROOT, 'deployments', 'deweb-' + NETWORK + '.json');
  const LOCK = STATE_FILE.replace(/\.json$/, '.lock');
  if (SEND) {
    // one run at a time: two runs would race on chunk indexes and nonces
    try { fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' }); } catch {
      const other = Number(fs.readFileSync(LOCK, 'utf8'));
      let alive = false; try { process.kill(other, 0); alive = true; } catch { /* gone */ }
      if (alive) throw new Error('another publish-deweb run (pid ' + other + ') holds ' + path.relative(ROOT, LOCK));
      fs.writeFileSync(LOCK, String(process.pid));
      console.log('Lock           took over the stale lock of pid ' + other);
    }
    process.on('exit', () => { try { if (fs.readFileSync(LOCK, 'utf8') === String(process.pid)) fs.unlinkSync(LOCK); } catch { /* already gone */ } });
  }
  const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
  if (state.processor && (getAddress(state.processor) !== processor || state.circuitId !== circuitId.toString())) {
    throw new Error(path.relative(ROOT, STATE_FILE) + ' is for ' + state.processor + ' #' + state.circuitId + ', not ' + processor + ' #' + circuitId);
  }
  const save = () => { // atomic: write a temp file, then rename over the state file
    if (!SEND) return;
    const tmp = STATE_FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
    fs.renameSync(tmp, STATE_FILE);
  };
  Object.assign(state, { network: NETWORK, chainId, processor, circuitId: circuitId.toString(), wallet: account.address });
  state.txs ||= []; state.files ||= {};

  const code = await pub.getCode({ address: account.address });
  if (code && code !== '0x') throw new Error('wallet ' + account.address + ' has contract code (EIP-7702); use a plain EOA');
  await reconcile(pub, account.address, state, save);

  // ---- a. checks
  if (!(await read(FACTORY, 'isCPU', [processor]))) throw new Error(processor + ' is not a TapeOut processor');
  const holder = getAddress(await read(processor, 'ownerOf', [circuitId]));
  if (holder !== account.address) throw new Error('circuit #' + circuitId + ' is held by ' + holder + ', not by this wallet ' + account.address);
  const cpuIndex = await findCpuIndex(pub, processor, state.cpuIndex);
  state.cpuIndex = cpuIndex.toString();
  const NAME = `${circuitId}.${AREA}.${cpuIndex}.tape`;
  const URL_ = `https://${circuitId}-${AREA}-${cpuIndex}.tapekit.org/`;
  const [regOpener, bindReg, chunkMax, chunksMax, ...impls] = await Promise.all([
    read(SITES, 'opener'), read(BINDING, 'registry'), read(SITES, 'CHUNK_MAX'), read(SITES, 'CHUNKS_MAX'),
    ...Object.keys(EXPECTED_IMPL).map((a) => pub.getStorageAt({ address: a, slot: IMPL_SLOT }))
  ]);
  if (getAddress(regOpener) !== OPENER) throw new Error('SiteRegistry.opener() is ' + regOpener + ', expected ' + OPENER);
  if (getAddress(bindReg) !== SITES) throw new Error('DomainBinding.registry() is ' + bindReg + ', expected ' + SITES);
  Object.keys(EXPECTED_IMPL).forEach((a, i) => {
    const impl = '0x' + impls[i].slice(-40);
    if (impl.toLowerCase() !== EXPECTED_IMPL[a]) throw new Error(a + ' implementation is ' + impl + ', TapeKit pins ' + EXPECTED_IMPL[a] + ' (the gateway would refuse to serve)');
  });
  const openerCode = await pub.getCode({ address: OPENER });
  const openerHash = openerCode ? keccak256(openerCode) : '0x';
  const openerImpl = '0x' + (await pub.getStorageAt({ address: OPENER, slot: IMPL_SLOT })).slice(-40);
  if (openerHash !== OPENER_CODEHASH) throw new Error('Opener runtime code hash is ' + openerHash + ', pinned ' + OPENER_CODEHASH + ' (code changed: re-check FEE() before trusting it)');
  if (BigInt(CHUNK) > chunkMax) throw new Error('CHUNK_MAX is ' + chunkMax + ' < ' + CHUNK);
  for (const f of files) if (BigInt(f.chunks.length) > chunksMax) throw new Error(f.path + ' needs ' + f.chunks.length + ' chunks, CHUNKS_MAX is ' + chunksMax);

  const [opened, container, openFee, monthlyFee, maxAhead, gasPrice, okb0] = await Promise.all([
    read(OPENER, 'isOpened', [processor, circuitId]), read(OPENER, 'accountOf', [processor, circuitId]), read(OPENER, 'FEE'),
    read(BINDING, 'monthlyFee'), read(BINDING, 'MAX_AHEAD'), pub.getGasPrice(), pub.getBalance({ address: account.address })
  ]);
  if (MONTHS < 1n || MONTHS * 2_592_000n > maxAhead) throw new Error('MONTHS must be 1…' + maxAhead / 2_592_000n);
  state.container = getAddress(container); state.name = NAME; state.url = URL_;
  if (!state.start) state.start = { okb: okb0.toString(), block: (await pub.getBlockNumber()).toString() };
  console.log('Circuit        #' + circuitId + ' on processor ' + processor + ' (index ' + cpuIndex + ' in the TapeOut factory) · holder = wallet ✓');
  console.log('Name           ' + NAME + '  →  ' + URL_);
  console.log('Container      ' + container + ' (ERC-6551 account of the circuit NFT) · opened: ' + opened);
  console.log('Contracts      Opener ' + OPENER + ' (code hash pinned ✓, ERC-1967 slot ' + openerImpl + ') · SiteRegistry ' + SITES + ' · DomainBinding ' + BINDING + ' (implementations = TapeKit pins ✓)');

  // ---- what is already on chain
  const editable = opened ? await read(SITES, 'canEdit', [container, account.address]) : false;
  const remote = {};
  if (opened) {
    for (const f of files) {
      const r = await tryRead(SITES, 'fileInfo', [container, f.path]);
      remote[f.path] = r.ok ? { size: Number(r.v[0]), type: r.v[1], sha: r.v[2], chunks: Number(r.v[4]) } : null;
    }
  }
  const fbNow = opened ? await read(SITES, 'fallbackPath', [container]).catch(() => '') : '';
  const live = opened ? await read(BINDING, 'isLive', [NAME, container]).catch(() => false) : false;
  const todo = files.map((f) => {
    const r = remote[f.path];
    if (r && r.sha === f.sha && r.size === f.size && r.chunks === f.chunks.length && r.type === f.type) return { f, from: f.chunks.length };
    if (r && r.sha === f.sha && r.type === f.type && r.chunks >= 1 && r.chunks < f.chunks.length) return { f, from: r.chunks };
    return { f, from: 0 };
  });
  const sendChunks = todo.flatMap(({ f, from }) => f.chunks.slice(from));
  const plan = {
    fees: (opened ? 0n : openFee) + (live ? 0n : monthlyFee * MONTHS),
    gas: (opened ? 0n : GAS.open) +
      sendChunks.reduce((s, c) => s + GAS.perTx + GAS.perByte * BigInt(c.length), 0n) +
      (fbNow === FALLBACK ? 0n : GAS.fallback) + (live ? 0n : GAS.bind)
  };
  const steps = [
    !opened && 'open container (' + formatEther(openFee) + ' OKB)',
    opened && !editable && 'STOP: wallet cannot edit the container (see step c)',
    sendChunks.length && 'upload ' + todo.filter((t) => t.from < t.f.chunks.length).length + ' files in ' + sendChunks.length + ' txs (' +
      sendChunks.reduce((s, c) => s + c.length, 0).toLocaleString('en-US') + ' bytes)',
    fbNow !== FALLBACK && 'setFallback(' + FALLBACK + ')',
    !live && 'bind ' + NAME + ' for ' + MONTHS + ' month(s) (' + formatEther(monthlyFee * MONTHS) + ' OKB)'
  ].filter(Boolean);
  const gasOkb = plan.gas * gasPrice;
  const bindTotal = monthlyFee * MONTHS;
  console.log('Fees           open ' + formatEther(openFee) + ' OKB (once) · name ' + formatEther(monthlyFee) + ' OKB/month × ' + MONTHS + ' month(s) · gas price ' + formatGwei(gasPrice) + ' gwei · BEM: none');
  console.log('Fee caps       open ≤ ' + formatEther(CAPS.open) + ' · name ≤ ' + formatEther(CAPS.bind) + ' · all fees ≤ ' + formatEther(CAPS.total) + ' OKB (' + CAPS.from + ')');
  console.log('Plan           ' + (steps.length ? steps.join(' → ') : 'nothing to send; verify only'));
  console.log('Will spend     ' + formatEther(plan.fees) + ' OKB fees (exact) + ≈' + formatEther(gasOkb) + ' OKB gas (estimated, ≈' + plan.gas.toLocaleString('en-US') + ' gas) = ≈' +
    formatEther(plan.fees + gasOkb) + ' OKB · 0 BEM · balance ' + formatEther(okb0) + ' OKB');
  const capErr = [];
  if (!opened && openFee > CAPS.open) capErr.push('open fee ' + formatEther(openFee) + ' > cap ' + formatEther(CAPS.open));
  if (!live && bindTotal > CAPS.bind) capErr.push('name fee ' + formatEther(bindTotal) + ' > cap ' + formatEther(CAPS.bind));
  if (plan.fees > CAPS.total) capErr.push('total fees ' + formatEther(plan.fees) + ' > cap ' + formatEther(CAPS.total));
  if (capErr.length) throw new Error('fee cap exceeded, nothing sent: ' + capErr.join('; ') + '. Check the fees on chain; to accept them set FEE_CAP_OKB=<OKB>.');
  if (okb0 < plan.fees + gasOkb + gasOkb / 4n) throw new Error('Not enough OKB: need ≈' + formatEther(plan.fees + gasOkb + gasOkb / 4n) + ' (incl. 25% gas margin), have ' + formatEther(okb0));

  if (SEND && MAINNET && steps.length) {
    console.log('\n' + '='.repeat(72));
    console.log('  X LAYER MAINNET — real funds');
    console.log('  wallet     ' + account.address + ' (holds circuit #' + circuitId + ')');
    console.log('  container  ' + container);
    console.log('  name       ' + NAME + '  →  ' + URL_);
    console.log('  steps      ' + steps.join(' → '));
    console.log('  name for   ' + MONTHS + ' month(s) (renew: MONTHS=n, free while monthlyFee() is 0)');
    console.log('  opener     code hash ' + openerHash + ' (pinned) · ERC-1967 impl slot ' + openerImpl);
    console.log('  spend      ' + formatEther(plan.fees) + ' OKB fees (exact) + ≈' + formatEther(gasOkb) + ' OKB gas (estimated) · 0 BEM');
    console.log('  caps       open ≤ ' + formatEther(CAPS.open) + ' · name ≤ ' + formatEther(CAPS.bind) + ' · all fees ≤ ' + formatEther(CAPS.total) + ' OKB (' + CAPS.from + ')');
    console.log('='.repeat(72));
    if (process.env.CONFIRM_MAINNET !== 'yes') throw new Error('mainnet send needs CONFIRM_MAINNET=yes in addition to SEND=1 (nothing was sent)');
  }
  console.log(SEND ? '\nSENDING' + (MAINNET ? ' on MAINNET' : ' on the fork') + '.\n' : '\nDRY RUN — simulating only. Run with SEND=1 to send.\n');

  // ---- tx helper: simulate → send → receipt; gas and hash recorded in the state file
  async function send(label, address, functionName, args, value = 0n) {
    let request;
    try {
      ({ request } = await pub.simulateContract({ account, address, abi: ABI, functionName, args, value }));
    } catch (err) { throw new Error(label + ' would revert: ' + (err.shortMessage || err.message).split('\n')[0]); }
    if (!SEND) { console.log('  ✓ simulated  ' + label + (value ? ' (' + formatEther(value) + ' OKB)' : '')); return null; }
    const gas = await pub.estimateContractGas({ account, address, abi: ABI, functionName, args, value });
    const nonce = await pub.getTransactionCount({ address: account.address, blockTag: 'pending' });
    const entry = { label, nonce, value: value.toString(), sentAt: new Date().toISOString() };
    state.txs.push(entry); save(); // recorded before the broadcast: a crash here leaves a nonce to reconcile
    const hash = await wallet.writeContract({ ...request, gas: gas + gas / 5n, nonce });
    entry.hash = hash; save();
    const r = await pub.waitForTransactionReceipt({ hash, timeout: 300_000 });
    Object.assign(entry, { block: r.blockNumber.toString(), gas: r.gasUsed.toString(), gasPrice: r.effectiveGasPrice.toString(), status: r.status });
    save();
    if (r.status !== 'success') throw new Error(label + ' reverted on chain: ' + hash);
    console.log('  ✓ ' + label.padEnd(44) + ' gas ' + String(r.gasUsed).padStart(9) + '  ' + hash);
    return r;
  }
  const dryStop = (why) => {
    console.log('\nDry run OK up to here (nothing sent, nothing written). ' + why);
    console.log('When ready:  SEND=1' + (MAINNET ? ' CONFIRM_MAINNET=yes' : '') + ' node scripts/publish-deweb.mjs');
  };

  // ---- b. open the container
  if (!opened) {
    console.log('Step b  open container of circuit #' + circuitId + ' (' + formatEther(openFee) + ' OKB)');
    // re-read right before paying: another run (or a late tx) may have opened it, or the fee may have changed
    const [stillClosed, feeNow] = await Promise.all([read(OPENER, 'isOpened', [processor, circuitId]).then((x) => !x), read(OPENER, 'FEE')]);
    if (!stillClosed) throw new Error('the container was opened in the meantime: run again (nothing was paid by this run)');
    if (feeNow !== openFee) throw new Error('Opener FEE() changed from ' + formatEther(openFee) + ' to ' + formatEther(feeNow) + ' OKB: run again to see the new plan');
    const r = await send('open container', OPENER, 'open', [processor, circuitId], openFee);
    if (!r) return dryStop('Upload, fallback and bind are simulated once the container is open.');
    if (!(await read(OPENER, 'isOpened', [processor, circuitId]))) throw new Error('isOpened is still false after open');
  } else console.log('Step b  container already open ✓');
  const tk = await read(container, 'token');
  if (tk[0] !== BigInt(chainId) || getAddress(tk[1]) !== processor || tk[2] !== circuitId) throw new Error('container.token() is ' + tk.join(',') + ', not this circuit');
  if (!(await read(SITES, 'isOpenedContainer', [container]))) throw new Error('SiteRegistry does not see the container as opened');

  // ---- c. authorize the uploader (the holder is the container owner: canEdit without any grant)
  const [canEdit, isOwner] = await Promise.all([read(SITES, 'canEdit', [container, account.address]), read(SITES, 'isOwner', [container, account.address])]);
  if (!canEdit) {
    throw new Error('SiteRegistry.canEdit(' + container + ', ' + account.address + ') is false (isOwner ' + isOwner + '). The holder of circuit #' +
      circuitId + ' must grant upload rights first: setOperator(' + container + ', ' + account.address + ', ttl ≤ 2592000) on ' + SITES);
  }
  console.log('Step c  uploader ' + account.address + ' can edit the container ✓ (' + (isOwner ? 'container owner = NFT holder, no grant needed' : 'operator') + ')');

  // ---- d. upload, then read back and compare SHA-256
  console.log('Step d  upload ' + files.length + ' files');
  for (const { f, from } of todo) {
    if (from === 0) {
      const r = await send(`putFile ${f.path} 1/${f.chunks.length}`, SITES, 'putFile', [container, f.path, f.type, f.sha, toHex(f.chunks[0])]);
      if (!r) return dryStop('appendChunk needs the file to exist on chain.');
    } else if (from < f.chunks.length) console.log('  resume       ' + f.path + ' at chunk ' + (from + 1) + '/' + f.chunks.length);
    for (let i = Math.max(from, 1); i < f.chunks.length; i++) {
      await send(`appendChunk ${f.path} ${i + 1}/${f.chunks.length}`, SITES, 'appendChunk', [container, f.path, BigInt(i), toHex(f.chunks[i])]);
    }
    if (!SEND && from < f.chunks.length) continue;
    await verifyFile(read, container, f);
    state.files[f.path] = { sha256: f.sha, size: f.size, chunks: f.chunks.length, verified: true };
    save();
    console.log('  ✓ verified   ' + f.path.padEnd(40) + ' ' + String(f.size).padStart(8) + ' bytes, on-chain sha256 = local ✓');
  }

  // ---- e. fallback + name
  if ((await read(SITES, 'fallbackPath', [container])) !== FALLBACK) await send('setFallback ' + FALLBACK, SITES, 'setFallback', [container, FALLBACK]);
  else console.log('Step e  fallback is ' + FALLBACK + ' ✓');
  if (!(await read(BINDING, 'isLive', [NAME, container]))) {
    const feeNow = (await read(BINDING, 'monthlyFee')) * MONTHS;
    if (feeNow !== bindTotal || feeNow > CAPS.bind) throw new Error('DomainBinding fee changed to ' + formatEther(feeNow) + ' OKB for ' + MONTHS + ' month(s): run again to see the new plan');
    await send('bind ' + NAME + ' ' + MONTHS + ' month(s)', BINDING, 'bind', [NAME, container, MONTHS], monthlyFee * MONTHS);
  } else console.log('Step e  ' + NAME + ' is live ✓');
  if (!SEND) return dryStop('');

  // ---- f. resolve like the TapeKit kernel
  console.log('Step f  resolve ' + NAME + ' as the TapeKit gateway does');
  await gatewayCheck(pub, read, { NAME, cpuIndex, processor, circuitId, container, files, holder: account.address });
  const okb1 = await pub.getBalance({ address: account.address });
  const mined = state.txs.filter((t) => t.gas); // gas is paid by reverted txs too; value only moves on success
  const totalGas = mined.reduce((s, t) => s + BigInt(t.gas), 0n);
  const gasPaid = mined.reduce((s, t) => s + BigInt(t.gas) * BigInt(t.gasPrice), 0n);
  const feesPaid = mined.filter((t) => t.status === 'success').reduce((s, t) => s + BigInt(t.value || 0), 0n);
  state.spent = { okb: formatEther(BigInt(state.start.okb) - okb1), gas: totalGas.toString(), gasOkb: formatEther(gasPaid), feesOkb: formatEther(feesPaid) };
  state.done = new Date().toISOString();
  save();
  console.log('\nSpent          ' + totalGas.toLocaleString('en-US') + ' gas over ' + mined.length + ' txs (all runs) = ' + formatEther(gasPaid) + ' OKB gas + ' +
    formatEther(feesPaid) + ' OKB fees · balance down ' + state.spent.okb + ' OKB since the first run');
  console.log('Wrote          ' + path.relative(ROOT, STATE_FILE));
  console.log('\nDONE  ' + URL_ + '   (tape://' + NAME + '/)');
}

/** Index of our processor in the factory (TapeKit's name uses it): newest first, batched. */
async function findCpuIndex(pub, processor, cached) {
  if (cached !== undefined) {
    const a = await pub.readContract({ address: FACTORY, abi: ABI, functionName: 'cpuAt', args: [BigInt(cached)] });
    if (getAddress(a) === processor) return BigInt(cached);
  }
  const n = await pub.readContract({ address: FACTORY, abi: ABI, functionName: 'cpuCount' });
  for (let hi = n; hi > 0n; hi -= 100n) {
    const idx = []; for (let i = hi - 1n; i >= 0n && i >= hi - 100n; i--) idx.push(i);
    const addrs = await pub.multicall({ contracts: idx.map((i) => ({ address: FACTORY, abi: ABI, functionName: 'cpuAt', args: [i] })), allowFailure: false });
    const hit = addrs.findIndex((a) => getAddress(a) === processor);
    if (hit >= 0) return idx[hit];
  }
  throw new Error('processor ' + processor + ' not found in the TapeOut factory');
}

/** Reads the whole file back in READ-byte windows and compares size, type, chunk count and SHA-256. */
async function verifyFile(read, container, f) {
  const info = await read(SITES, 'fileInfo', [container, f.path]);
  if (Number(info[0]) !== f.size || info[1] !== f.type || info[2] !== f.sha || Number(info[4]) !== f.chunks.length) {
    throw new Error(f.path + ': fileInfo (' + info.join(', ') + ') does not match the local file');
  }
  const parts = [];
  for (let off = 0; off < f.size; off += READ) parts.push(Buffer.from((await read(SITES, 'readRange', [container, f.path, BigInt(off), BigInt(READ)])).slice(2), 'hex'));
  const back = Buffer.concat(parts);
  if (back.length !== f.size || sha256(back) !== f.sha) throw new Error(f.path + ': read back ' + back.length + ' bytes, sha256 ' + sha256(back) + ' ≠ local ' + f.sha);
}

/** The TapeKit kernel's resolve + manifest + file reads (kernel/identity.js, kernel.js, path.js), against this RPC. */
async function gatewayCheck(pub, read, { NAME, cpuIndex, processor, circuitId, container, files, holder }) {
  const m = NAME.match(/^([1-9][0-9]*)\.2\.(0|[1-9][0-9]*)\.tape$/);
  if (!m || BigInt(m[1]) !== circuitId || BigInt(m[2]) !== cpuIndex) throw new Error('name ' + NAME + ' does not parse as <id>.2.<cpu>.tape');
  const circuits = getAddress(await read(FACTORY, 'cpuAt', [cpuIndex]));
  if (circuits !== processor) throw new Error('cpuAt(' + cpuIndex + ') = ' + circuits + ', not our processor');
  const [acct, opened, owner] = await Promise.all([read(OPENER, 'accountOf', [circuits, circuitId]), read(OPENER, 'isOpened', [circuits, circuitId]), read(circuits, 'ownerOf', [circuitId])]);
  if (getAddress(acct) !== getAddress(container) || !opened) throw new Error('accountOf/isOpened do not give the container');
  const [live, until, cLive] = await Promise.all([read(BINDING, 'isLive', [NAME, container]), read(BINDING, 'paidUntil', [keccak256(toBytes(NAME)), container]), read(BINDING, 'isContainerLive', [container])]);
  if (!live) throw new Error('isLive(' + NAME + ', container) is false: the name is not bound (isContainerLive ' + cLive + '); not claiming DONE');
  const count = Number(await read(SITES, 'pathCount', [container]));
  const paths = [];
  for (let from = 0; from < count; from += 200) paths.push(...(await read(SITES, 'pathsRange', [container, BigInt(from), BigInt(Math.min(200, count - from))])));
  if (paths.length !== count) throw new Error('pathsRange returned ' + paths.length + ' of ' + count + ' paths');
  const fb = await read(SITES, 'fallbackPath', [container]);
  const missing = files.filter((f) => !paths.includes(f.path)).map((f) => f.path);
  if (missing.length) throw new Error('not in pathsRange: ' + missing.join(', '));
  const extra = paths.filter((p) => !files.some((f) => f.path === p));
  for (const f of files) await verifyFile(read, container, f);
  console.log('  ✓ name       ' + NAME + ' → cpuAt(' + cpuIndex + ') = ' + circuits + ' → #' + circuitId + ' → container ' + container);
  console.log('  ✓ holder     ' + getAddress(owner) + (getAddress(owner) === holder ? ' (this wallet)' : ''));
  console.log('  ✓ paid       isLive ' + live + ' · isContainerLive ' + cLive + ' · paidUntil ' + new Date(Number(until) * 1000).toISOString());
  console.log('  ✓ manifest   ' + count + ' paths, fallback "' + fb + '", every local file listed and read back with matching sha256' +
    (extra.length ? ' · NOTE extra on-chain paths not in dist/deweb: ' + extra.join(', ') : ''));
  console.log('  ✓ "/"        resolves to index.html (TapeKit path rules: "/" → index.html, extension-less paths → fallback)');
}

/**
 * Txs an interrupted run recorded but never saw mined. Decided by nonce, never by a single "not found":
 *   receipt exists → record it; tx known but pending → wait; unknown → poll the latest nonce: once it passes ours,
 *   the receipt (if this hash landed) decides, else that nonce went to another tx; if it stays ≤ ours after
 *   N polls, nothing landed and the entry is cleared (moved to state.cleared).
 */
async function reconcile(pub, me, state, save) {
  const open = state.txs.filter((t) => !t.gas && !t.replaced);
  for (const t of open) {
    const rec = (r, seen) => Object.assign(t, { block: r.blockNumber.toString(), gas: r.gasUsed.toString(), gasPrice: r.effectiveGasPrice.toString(), status: r.status, value: t.value ?? (seen?.value || 0n).toString() });
    const receipt = () => (t.hash ? pub.getTransactionReceipt({ hash: t.hash }).catch(() => null) : Promise.resolve(null));
    let r = await receipt();
    if (r) { rec(r); console.log('Earlier tx     ' + t.label + ' mined (' + r.status + ')'); save(); continue; }
    const seen = t.hash ? await pub.getTransaction({ hash: t.hash }).catch(() => null) : null;
    if (seen) { console.log('Earlier tx     waiting for ' + t.label + ' ' + t.hash); rec(await pub.waitForTransactionReceipt({ hash: t.hash, timeout: 300_000 }), seen); save(); continue; }
    if (t.nonce === undefined) throw new Error('state has an unmined tx without a nonce (' + t.label + '): check ' + (t.hash || 'it') + ' on the explorer');
    let decided = false;
    for (let i = 0; i < 6 && !decided; i++) {
      const latest = await pub.getTransactionCount({ address: me, blockTag: 'latest' });
      if (latest > t.nonce) {
        for (let j = 0; j < 5 && !r; j++) { r = await receipt(); if (!r) await sleep(2000); }
        if (r) { rec(r); console.log('Earlier tx     ' + t.label + ' mined (' + r.status + ')'); }
        else { t.replaced = true; console.log('Earlier tx     ' + t.label + ': nonce ' + t.nonce + ' was used by another tx; this one never landed'); }
        decided = true;
      } else if (i < 5) { console.log('Earlier tx     ' + t.label + ' (nonce ' + t.nonce + ') not seen yet; latest nonce ' + latest + ', re-checking in 10 s'); await sleep(10_000); }
    }
    if (!decided) {
      console.log('Earlier tx     ' + t.label + ' (nonce ' + t.nonce + ') did not land: cleared');
      state.cleared = [...(state.cleared || []), { ...t, clearedAt: new Date().toISOString() }];
      state.txs = state.txs.filter((x) => x !== t);
    }
    save();
  }
}
