// ExitProof web app. No build step: plain ES module + ethers v6 UMD (window.ethers) from the pinned CDN script.
// Read-only checks talk JSON-RPC to the configured RPC directly (no wallet). Buying uses the injected wallet.
import { MODES, ROUTER_ERRORS, STRINGS, MODE_LABEL, fill, factRows, reasonText, errorText, decodeFacts } from './verdict.js';

const { ethers } = window;
const $ = (s) => document.querySelector(s);
const ROUTER = new ethers.Interface([
  'function inspect(address factory, address tokenIn, uint256 amountIn, address token, uint8 mode) payable',
  'function buyETH(address factory, address token, uint256 minOut, uint8 mode, address to, uint256 deadline) payable returns (uint256)',
  'event Checked(address indexed token, bytes32 indexed codehash, address indexed buyer, uint16 facts, bool allow, uint8 reason, uint256 amountIn, uint256 out)',
  ...ROUTER_ERRORS,
]);
const REGISTRY = new ethers.Interface([
  'event Attested(bytes32 indexed codehash, tuple(bool scanned, bool privileged, bool upgradeable, bool dangerSetter, bool ownerCanTrap, uint16 scannerVersion) f, string reportURI, address attester)',
  'function flagsOf(bytes32 codehash) view returns (tuple(bool scanned, bool privileged, bool upgradeable, bool dangerSetter, bool ownerCanTrap, uint16 scannerVersion))',
]);
const ERC20 = new ethers.Interface(['function symbol() view returns (string)', 'function decimals() view returns (uint8)']);
const PROBE_FROM = '0x00000000000000000000000000000000e21df00f'; // read-only checks; its balance is overridden
const CALL_GAS = '0x989680'; // 10M for eth_call: the sell probe needs ~3.1M available
const FALLBACK_GAS = 4_000_000n; // wallet estimate failed without a reason: never below 3.5M
const FEED_WINDOW = 100; // blocks per eth_getLogs
const FEED_SPAN = 2000; // look back at most this far
const FEED_MAX = 12;
const LOCAL_KEY = 'exitproof.checks.v1';

const state = {
  lang: localStorage.getItem('exitproof.lang') || 'en',
  cfg: null, netKey: null, mode: 'balanced', last: null, account: null,
  names: new Map(), // lowercased address or codehash -> symbol
  feedTimer: null,
};
const S = () => STRINGS[state.lang];
const net = () => state.cfg.networks[state.netKey];
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ------------------------------------------------------------------ JSON-RPC (configured RPC, no wallet)
class RpcDown extends Error {}
async function rpc(method, params) {
  let res;
  try {
    res = await fetch(net().rpc, { signal: AbortSignal.timeout(20_000), method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  } catch { throw new RpcDown(net().rpc); }
  if (!res.ok) throw new RpcDown(net().rpc);
  return res.json(); // { result } | { error: { code, message, data } }
}
async function rpcResult(method, params) {
  const r = await rpc(method, params);
  if (r.error) throw Object.assign(new Error(r.error.message), { rpcError: r.error });
  return r.result;
}

function decodeRevert(data) {
  if (!data || data === '0x') return { name: null };
  try {
    const e = ROUTER.parseError(data);
    return e ? { name: e.name, args: e.args } : { name: `revert ${data.slice(0, 10)}` };
  } catch { return { name: `revert ${data.slice(0, 10)}` }; }
}
/** Revert data from an ethers/EIP-1193 error object, wherever the wallet put it. */
function walletRevertData(e) {
  const seen = new Set();
  const walk = (x, depth) => {
    if (!x || typeof x !== 'object' || seen.has(x) || depth > 6) return null;
    seen.add(x);
    if (typeof x.data === 'string' && /^0x[0-9a-f]*$/i.test(x.data) && x.data.length >= 10) return x.data;
    for (const k of ['data', 'error', 'info', 'cause', 'revert']) { const r = walk(x[k], depth + 1); if (r) return r; }
    return null;
  };
  return walk(e, 0);
}

// ------------------------------------------------------------------ the free check
async function tokenMeta(token) {
  const code = await rpcResult('eth_getCode', [token, 'latest']);
  if (!code || code === '0x') return null;
  const call = async (iface, fn) => {
    const r = await rpc('eth_call', [{ to: token, data: iface.encodeFunctionData(fn, []) }, 'latest']);
    if (r.error || !r.result || r.result === '0x') return null;
    try { return iface.decodeFunctionResult(fn, r.result)[0]; } catch { return null; }
  };
  const [symbol, decimals] = await Promise.all([call(ERC20, 'symbol'), call(ERC20, 'decimals')]);
  return { codehash: ethers.keccak256(code), symbol: symbol ? String(symbol).slice(0, 24) : null, decimals: decimals == null ? 18 : Number(decimals) };
}

async function inspect(token, mode, amount) {
  const n = net();
  const data = ROUTER.encodeFunctionData('inspect', [n.factory, n.wokb, amount, token, MODES[mode]]);
  const tx = { from: PROBE_FROM, to: n.router, data, value: ethers.toQuantity(amount), gas: CALL_GAS };
  let r = await rpc('eth_call', [tx, 'latest', { [PROBE_FROM]: { balance: ethers.toQuantity(amount + ethers.parseEther('1')) } }]);
  // node without state overrides: retry from the connected wallet (needs the OKB) if there is one
  if (r.error && !r.error.data && /override|param/i.test(r.error.message || '') && state.account) {
    r = await rpc('eth_call', [{ ...tx, from: state.account }, 'latest']);
  }
  if (!r.error) return { kind: 'error', name: 'NoRevert' };
  return decodeRevert(r.error.data);
}

async function runCheck(ev) {
  ev?.preventDefault();
  const token = $('#token').value.trim();
  const mode = state.mode;
  if (!ethers.isAddress(token)) return showMessage(S().badAddress);
  let amount;
  try { amount = ethers.parseEther($('#amount').value.trim() || '0'); } catch { amount = 0n; }
  if (amount <= 0n) return showMessage(S().errors.TooLittle);
  const btn = $('#check');
  btn.disabled = true; btn.textContent = S().checking;
  try {
    const addr = ethers.getAddress(token);
    const meta = await tokenMeta(addr);
    let last;
    if (!meta) {
      last = { kind: 'error', name: 'BadPair', token: addr, mode, amount };
    } else {
      const flags = await rpc('eth_call', [{ to: net().registry, data: REGISTRY.encodeFunctionData('flagsOf', [meta.codehash]) }, 'latest'])
        .then((r) => (r.result ? REGISTRY.decodeFunctionResult('flagsOf', r.result)[0] : null)).catch(() => null);
      const r = await inspect(addr, mode, amount);
      if (meta.symbol) { state.names.set(addr.toLowerCase(), meta.symbol); state.names.set(meta.codehash, meta.symbol); }
      last = r.name === 'Report'
        ? { kind: 'report', token: addr, mode, amount, meta, flags, facts: Number(r.args[0]), allow: r.args[1], reason: Number(r.args[2]), buyOut: r.args[3], sellOut: r.args[4] }
        : { kind: 'error', name: r.name, token: addr, mode, amount, meta };
    }
    last.net = state.netKey;
    state.last = last;
    remember(last);
    render();
    const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    $('#result').scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
  } catch (e) {
    if (e instanceof RpcDown) showMessage(fill(S().rpcDown, { rpc: net().rpc }));
    else showMessage(fill(S().errors.other, { name: e.message }));
  } finally {
    btn.disabled = false; btn.textContent = S().check;
  }
}

// ------------------------------------------------------------------ rendering
function showMessage(text) {
  state.last = null;
  $('#result').innerHTML = `<p class="notice">${esc(text)}</p>`;
  $('#buybox').hidden = true;
}

function render() {
  const L = S();
  const r = state.last;
  const out = $('#result');
  if (!r) { out.innerHTML = ''; $('#buybox').hidden = true; return; }
  const modeName = MODE_LABEL[state.lang][r.mode];
  const name = r.meta?.symbol ? `${esc(r.meta.symbol)} ` : '';
  if (r.kind === 'error') {
    out.innerHTML = `
      <div class="plate deny" role="status">
        <svg class="plate-icon" aria-hidden="true"><use href="#i-stop"/></svg>
        <p class="plate-title">${esc(L.cannotTitle)}</p>
        <p class="plate-why">${esc(errorText(r.name, state.lang))}</p>
      </div>
      <p class="plate-sub">${name}<span class="hex">${esc(short(r.token))}</span>. ${esc(L.cannotLead)}</p>`;
    $('#buybox').hidden = true;
    return;
  }
  const allow = r.allow;
  const dec = r.meta?.decimals ?? 18;
  const fmt = (v, d) => {
    const s = ethers.formatUnits(v, d);
    const [i, f = ''] = s.split('.');
    return f ? `${Number(i).toLocaleString(state.lang)}${state.lang === 'tr' ? ',' : '.'}${f.slice(0, 4)}` : Number(i).toLocaleString(state.lang);
  };
  const rows = factRows(r.facts, state.lang);
  const stations = [
    { label: L.step_buy, value: L.yes, text: `${fmt(r.buyOut, dec)} ${r.meta?.symbol ?? ''}`, cls: '' },
    ...rows.map((x) => ({ label: x.label, value: x.value, text: x.text, cls: x.bad ? 'bad' : x.warn ? 'warn' : '' })),
    {
      label: L.step_circuit, value: allow ? L.circuitAllow : `${L.circuitDeny}, ${fill(L.reasonPrefix, { n: r.reason }).toLowerCase()}`,
      text: fill(allow ? L.fact_circuit_allow : L.fact_circuit_deny, { mode: modeName }), cls: allow ? '' : 'bad',
    },
  ];
  out.innerHTML = `
    <div class="plate ${allow ? 'allow' : 'deny'}" role="status">
      <svg class="plate-icon" aria-hidden="true"><use href="#i-${allow ? 'exit' : 'stop'}"/></svg>
      <p class="plate-title">${esc(allow ? L.allowTitle : L.denyTitle)}</p>
      <p class="plate-why">${allow ? esc(fill(L.allowBody, { mode: modeName }))
        : `<span class="plate-code">${esc(fill(L.reasonPrefix, { n: r.reason }))}</span>${esc(reasonText(r.reason, r.mode, state.lang))}`}</p>
    </div>
    <p class="plate-sub">${name}<span class="hex" title="${esc(r.token)}">${esc(short(r.token))}</span>${allow ? '' : `. ${esc(L.denyBody)}`}</p>
    <dl class="amounts">
      <div><dt>${esc(L.youGet)}</dt><dd>${fmt(r.buyOut, dec)} ${esc(r.meta?.symbol ?? '')}</dd></div>
      <div><dt>${esc(L.sellBack)}</dt><dd>${r.sellOut > 0n ? fmt(r.sellOut, 18) : '0'} OKB</dd></div>
    </dl>
    <section class="route" aria-label="${esc(L.route)}">
      <h2>${esc(L.route)}</h2>
      <ol>${stations.map((s) => `
        <li class="${s.cls}"><span class="dot" aria-hidden="true"></span>
          <span class="step-label">${esc(s.label)}</span><span class="step-value">${esc(s.value)}</span>
          <span class="step-text">${esc(s.text)}</span></li>`).join('')}
      </ol>
    </section>`;
  $('#buybox').hidden = !allow;
  if (allow) $('#buy').textContent = fill(L.buy, { amount: ethers.formatEther(r.amount) });
  $('#buy-status').textContent = '';
}

function applyLang() {
  const L = S();
  document.documentElement.lang = state.lang;
  document.querySelectorAll('[data-i18n]').forEach((el) => { const v = L[el.dataset.i18n]; if (typeof v === 'string') el.textContent = v; });
  document.querySelectorAll('[data-lang]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === state.lang)));
  $('#mode-hint').textContent = L[`modeHint_${state.mode}`];
  if (state.account) $('#connect').textContent = fill(L.connected, { addr: short(state.account) });
  const sel = $('#net');
  [...sel.options].forEach((o) => { o.textContent = o.value === 'fork' ? L.netFork : o.value === 'xlayer' ? L.netXlayer : o.value; });
  render();
  renderLocal();
  renderFeed(state.feedItems);
}

// ------------------------------------------------------------------ local history (this browser only)
function remember(r) {
  const list = JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]');
  list.unshift({ token: r.token, symbol: r.meta?.symbol ?? null, mode: r.mode, net: r.net, allow: r.kind === 'report' && r.allow, reason: r.reason ?? null, error: r.kind === 'error' ? (r.name ?? '') : null, at: Date.now() });
  localStorage.setItem(LOCAL_KEY, JSON.stringify(list.slice(0, 20)));
  renderLocal();
}
function renderLocal() {
  const L = S();
  const list = JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]').filter((x) => x.net === state.netKey);
  const ul = $('#local');
  if (!list.length) { ul.innerHTML = `<li class="empty">${esc(L.localEmpty)}</li>`; return; }
  ul.innerHTML = list.slice(0, 8).map((x) => {
    const verdict = x.allow ? L.allowTitle : x.error !== null ? L.cannotTitle : `${L.denyTitle}, ${fill(L.reasonPrefix, { n: x.reason }).toLowerCase()}`;
    const t = new Date(x.at).toLocaleTimeString(state.lang, { hour: '2-digit', minute: '2-digit' });
    return `<li><span class="tag ${x.allow ? '' : 'bad'}">${esc(verdict)}</span>
      <span>${esc(x.symbol ?? '')} <span class="hex">${esc(short(x.token))}</span></span>
      <span class="meta">${esc(MODE_LABEL[state.lang][x.mode])}, ${esc(t)}</span></li>`;
  }).join('');
}

// ------------------------------------------------------------------ feed: allowed buys + scanner verdicts
async function loadFeed() {
  const n = net();
  if (!n.router) { state.feedItems = null; renderFeed(null); return; }
  if (!state.feedItems) $('#feed').innerHTML = `<li class="empty">${esc(S().feedLoading)}</li>`;
  try {
    const latest = Number(await rpcResult('eth_blockNumber', []));
    // a fork has no history of its own before its fork block: do not page through mainnet history there
    const floor = Math.max(0, latest - FEED_SPAN + 1, Number(n.feedStartBlock || 0));
    const topics = [[ROUTER.getEvent('Checked').topicHash, REGISTRY.getEvent('Attested').topicHash]];
    const items = [];
    for (let to = latest; to >= floor && items.length < FEED_MAX; to -= FEED_WINDOW) {
      const from = Math.max(floor, to - FEED_WINDOW + 1);
      const logs = await rpcResult('eth_getLogs', [{ address: [n.router, n.registry], topics, fromBlock: ethers.toQuantity(from), toBlock: ethers.toQuantity(to) }]);
      logs.sort((a, b) => Number(b.blockNumber) - Number(a.blockNumber) || Number(b.logIndex) - Number(a.logIndex));
      for (const l of logs) {
        const iface = l.address.toLowerCase() === n.router.toLowerCase() ? ROUTER : REGISTRY;
        try { items.push({ log: l, ev: iface.parseLog(l) }); } catch { /* foreign event */ }
      }
    }
    state.feedItems = items.slice(0, FEED_MAX);
    state.feedLatest = latest;
    renderFeed(state.feedItems);
  } catch (e) {
    $('#feed').innerHTML = `<li class="empty">${esc(e instanceof RpcDown ? fill(S().rpcDown, { rpc: n.rpc }) : e.message)}</li>`;
  }
}
function renderFeed(items) {
  const L = S();
  const ul = $('#feed');
  if (!net().router) { ul.innerHTML = `<li class="empty">${esc(L.pending)}</li>`; return; }
  if (!items) return;
  if (!items.length) { ul.innerHTML = `<li class="empty">${esc(fill(L.feedEmpty, { n: FEED_SPAN }))}</li>`; return; }
  ul.innerHTML = items.map(({ log, ev }) => {
    const block = Number(log.blockNumber).toLocaleString(state.lang);
    if (ev.name === 'Checked') {
      const tok = ev.args.token;
      const sym = state.names.get(tok.toLowerCase()) ?? short(tok);
      const d = decodeFacts(ev.args.facts);
      return `<li><span class="tag">${esc(L.feedChecked)}</span>
        <span>${esc(ethers.formatEther(ev.args.amountIn))} OKB → ${esc(sym)} <span class="meta">(${esc(MODE_LABEL[state.lang][d.mode])})</span></span>
        <span class="meta">${esc(short(ev.args.buyer))}, block ${block}</span></li>`;
    }
    const f = ev.args.f;
    const bad = ['privileged', 'upgradeable', 'dangerSetter', 'ownerCanTrap'].filter((k) => f[k]);
    const sym = state.names.get(ev.args.codehash) ?? `code ${ev.args.codehash.slice(0, 10)}`;
    const danger = f.dangerSetter || f.ownerCanTrap || f.upgradeable;
    return `<li><span class="tag ${danger ? 'bad' : bad.length ? 'warn' : ''}">${esc(L.feedAttested)}</span>
      <span>${esc(sym)}: ${esc(bad.length ? bad.map((k) => L.flags[k]).join(', ') : L.feedNoFlags)}</span>
      <span class="meta">block ${block}</span></li>`;
  }).join('');
}

// ------------------------------------------------------------------ wallet + buy
async function connect() {
  const eth = window.ethereum;
  if (!eth) { $('#buy-status').textContent = S().noWallet; $('#buy-status').className = 'buy-status bad'; return null; }
  const [acct] = await eth.request({ method: 'eth_requestAccounts' });
  state.account = ethers.getAddress(acct);
  $('#connect').textContent = fill(S().connected, { addr: short(state.account) });
  const chainId = await eth.request({ method: 'eth_chainId' });
  if (Number(chainId) !== net().chainId) {
    try { await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: ethers.toQuantity(net().chainId) }] }); }
    catch { $('#buy-status').textContent = S().wrongChain; $('#buy-status').className = 'buy-status bad'; return null; }
  }
  return state.account;
}

async function buy() {
  const L = S();
  const st = $('#buy-status');
  const r = state.last;
  st.className = 'buy-status';
  if (!r || r.kind !== 'report' || !r.allow || r.net !== state.netKey) { st.textContent = L.buyNeedsCheck; return; }
  try {
    const account = state.account ?? (await connect());
    if (!account) return;
    st.textContent = L.buying;
    const n = net();
    const slip = BigInt($('#slip').value);
    const taxAllow = [500n, 1500n, 5000n, 9999n][decodeFacts(r.facts).buyTax];
    let minOut = r.buyOut * (10_000n - slip) / 10_000n * (10_000n - taxAllow) / 10_000n;
    if (minOut === 0n) minOut = 1n;
    const head = await rpcResult('eth_getBlockByNumber', ['latest', false]);
    const deadline = BigInt(head.timestamp) + 600n;
    const data = ROUTER.encodeFunctionData('buyETH', [n.factory, r.token, minOut, MODES[r.mode], account, deadline]);
    const provider = new ethers.BrowserProvider(window.ethereum);
    const signer = await provider.getSigner();
    const tx = { from: account, to: n.router, data, value: r.amount };
    let gasLimit;
    try {
      gasLimit = (await provider.estimateGas(tx)) * 12n / 10n;
    } catch (e) {
      const d = decodeRevert(walletRevertData(e));
      if (d.name === 'Blocked') { st.className = 'buy-status bad'; st.textContent = fill(L.buyBlocked, { reason: reasonText(d.args[0], r.mode, state.lang) }); return; }
      if (d.name) { st.className = 'buy-status bad'; st.textContent = errorText(d.name, state.lang); return; }
      gasLimit = FALLBACK_GAS; // no reason given: send with room for the probe; the router still reverts on deny
    }
    const sent = await signer.sendTransaction({ ...tx, gasLimit });
    const rc = await sent.wait();
    const ev = rc.logs.map((l) => { try { return ROUTER.parseLog(l); } catch { return null; } }).find((x) => x?.name === 'Checked');
    st.textContent = rc.status === 1 && ev
      ? fill(L.bought, { out: `${ethers.formatUnits(ev.args.out, r.meta?.decimals ?? 18)} ${r.meta?.symbol ?? ''}` })
      : errorText(null, state.lang);
    loadFeed();
  } catch (e) {
    const d = decodeRevert(walletRevertData(e));
    st.className = 'buy-status bad';
    st.textContent = d.name === 'Blocked' ? fill(L.buyBlocked, { reason: reasonText(d.args[0], r.mode, state.lang) })
      : d.name ? errorText(d.name, state.lang) : (e.shortMessage || e.message);
  }
}

// ------------------------------------------------------------------ boot
async function switchNet(key) {
  state.netKey = key;
  localStorage.setItem('exitproof.net', key);
  const n = net();
  const live = Boolean(n.router);
  $('#pending').hidden = live;
  $('#check').disabled = !live;
  $('#connect').hidden = !live;
  state.last = null;
  state.feedItems = null;
  render();
  const demo = n.demoTokens || [];
  $('#demo').hidden = !demo.length;
  $('#demo-list').innerHTML = demo.map((t) => `<button type="button" data-addr="${esc(t.address)}">${esc(t.name)}</button>`).join('');
  demo.forEach((t) => state.names.set(t.address.toLowerCase(), t.symbol || t.name));
  $('#contracts').innerHTML = live
    ? `Router <span class="hex">${esc(n.router)}</span><br>Registry <span class="hex">${esc(n.registry)}</span><br>TapeOut processor <span class="hex">${esc(n.processor)}</span>, circuit #${esc(n.circuitId)}`
    : '';
  renderLocal();
  if (live) {
    // name scanner verdicts in the feed by codehash for the demo tokens
    await Promise.all(demo.map(async (t) => {
      try { const code = await rpcResult('eth_getCode', [t.address, 'latest']); if (code && code !== '0x') state.names.set(ethers.keccak256(code), t.symbol || t.name); } catch { /* offline */ }
    }));
  }
  loadFeed();
}

async function boot() {
  state.cfg = await (await fetch('./config.json', { cache: 'no-store' })).json();
  const sel = $('#net');
  sel.innerHTML = Object.keys(state.cfg.networks).map((k) => `<option value="${k}">${esc(state.cfg.networks[k].label)}</option>`).join('');
  const saved = localStorage.getItem('exitproof.net');
  const key = saved && state.cfg.networks[saved] ? saved : state.cfg.defaultNetwork;
  sel.value = key;
  sel.addEventListener('change', () => switchNet(sel.value));
  document.querySelectorAll('[data-lang]').forEach((b) => b.addEventListener('click', () => {
    state.lang = b.dataset.lang; localStorage.setItem('exitproof.lang', state.lang); applyLang();
  }));
  document.querySelectorAll('input[name="mode"]').forEach((i) => i.addEventListener('change', () => {
    state.mode = i.value; $('#mode-hint').textContent = S()[`modeHint_${state.mode}`];
  }));
  $('#demo-list').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-addr]');
    if (b) { $('#token').value = b.dataset.addr; $('#token').focus(); }
  });
  $('#form').addEventListener('submit', runCheck);
  $('#connect').addEventListener('click', () => connect().catch((e) => { $('#buy-status').textContent = e.shortMessage || e.message; }));
  $('#buy').addEventListener('click', buy);
  const q = new URLSearchParams(location.search);
  if (q.get('token')) $('#token').value = q.get('token');
  if (q.get('mode') && q.get('mode') in MODES) { state.mode = q.get('mode'); document.querySelector(`input[name="mode"][value="${state.mode}"]`).checked = true; }
  await switchNet(key);
  applyLang();
  state.feedTimer = setInterval(() => { if (!document.hidden) loadFeed(); }, 20_000);
  if (q.get('check') === '1' && q.get('token')) runCheck();
}

boot().catch((e) => { document.body.insertAdjacentHTML('afterbegin', `<p class="notice">${esc(e.message)}</p>`); });
