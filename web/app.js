// ExitProof web app. No build step: plain ES module + ethers v6 UMD (window.ethers) from vendor/ethers.min.js.
// Read-only checks talk JSON-RPC to the configured RPCs directly (no wallet), with failover to `rpcFallback`.
// Buying uses the injected wallet.
import {
  MODES, STRINGS, MODE_LABEL, LANGS, LOCALE, ROUTER_ABI, REGISTRY_ABI, PROCESSOR_ABI, CHECKED_EVENT, FIELDS,
  fill, factRows, reasonText, errorText, decodeFacts, isLoopbackUrl, isLoopbackHost, rpcList, policy, withMode,
  verdictState, cleanText, reportFields, named, isFlagged,
} from './verdict.js';

const { ethers } = window;
const $ = (s) => document.querySelector(s);
const ROUTER = new ethers.Interface(ROUTER_ABI);
const REGISTRY = new ethers.Interface(REGISTRY_ABI);
const PROCESSOR = new ethers.Interface(PROCESSOR_ABI);
const ERC20 = new ethers.Interface(['function symbol() view returns (string)', 'function decimals() view returns (uint8)']);
const FACTORY = new ethers.Interface(['function allPairsLength() view returns (uint256)', 'function allPairs(uint256) view returns (address)']);
const PAIR = new ethers.Interface(['function token0() view returns (address)', 'function token1() view returns (address)', 'function getReserves() view returns (uint112, uint112, uint32)']);
const MULTICALL = new ethers.Interface(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)']);
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11'; // same address on X Layer and its forks
const PROBE_FROM = '0x00000000000000000000000000000000e21df00f'; // read-only checks; its balance is overridden
const CALL_GAS = '0x989680'; // 10M for eth_call: the sell probe needs ~3.1M available
// Measured on X Layer (block gas limit 210M): the first buy of a ~24KB token costs ~4.82M gas (bytecode scan runs once per
// codehash, then cached); worst case, a 24KB token that also burns the full probe cap, costs 7.62M. So 4M was too low.
const FALLBACK_GAS = 8_000_000n; // wallet estimate failed without a reason
const MIN_GAS = 3_500_000n, MAX_GAS = 12_000_000n; // clamp for every gas limit we send
const clampGas = (g) => (g < MIN_GAS ? MIN_GAS : g > MAX_GAS ? MAX_GAS : g);
const RPC_TIMEOUT = 15_000;
// Totals since deployment, paged with eth_getLogs. Public X Layer RPCs cap a query at 100 blocks.
const LOG_WINDOW = 100;
const WINDOWS_PER_TICK = 16; // at most this many eth_getLogs per tick (2 in flight)
const TICK_MS = 30_000, CATCHUP_MS = 4_000, MAX_BACKOFF_MS = 300_000;
const RECENT_MAX = 10;
const PAIRS_SHOWN = 20, PAIRS_SCAN = 40, PAIRS_MS = 300_000;
const LOCAL_KEY = 'exitproof.checks.v1';

const storedLang = localStorage.getItem('exitproof.lang');
const state = {
  lang: LANGS.includes(storedLang) ? storedLang : 'en',
  cfg: null, netKey: null, mode: 'balanced', last: null, account: null,
  deployed: null, // true | false (router null or no code) | null (could not tell: RPC down)
  names: new Map(), // lowercased token address -> sanitized symbol
  rpcPref: {}, // network key -> index of the RPC that answered last
  gen: 0, // bumps on every network switch; background loops stop when it changes
  stats: null, statsLatest: null, statsErr: null, statsTimer: null, statsBackoff: 0,
  pairs: null, pairsErr: null, pairsTimer: null,
  x: (1 << 9) | 1, xCache: new Map(), xTimer: null, xResult: null, // explorer input: balanced, sold back = allow
};
const S = () => STRINGS[state.lang];
const net = () => state.cfg.networks[state.netKey];
const loc = () => LOCALE[state.lang];
const SEP = { en: [', ', ', '], tr: [', ', ', '], zh: ['、', '，'] }; // [list items, clauses]
const list = (a) => a.join(SEP[state.lang][0]);
const comma = () => SEP[state.lang][1];
const stop = () => (state.lang === 'zh' ? '。' : '. ');
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const lsGet = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* quota: cache only */ } };

// ------------------------------------------------------------------ JSON-RPC with failover (configured RPCs, no wallet)
class RpcDown extends Error {}
const RETRYABLE = /rate limit|too many requests|exceeded|temporarily|unavailable|timeout/i;
async function rpcOn(key, method, params, { timeout = RPC_TIMEOUT } = {}) {
  const urls = rpcList(state.cfg.networks[key]);
  const start = state.rpcPref[key] ?? 0;
  for (let k = 0; k < urls.length; k++) {
    const i = (start + k) % urls.length;
    try {
      const res = await fetch(urls[i], { signal: AbortSignal.timeout(timeout), method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`); // 403 / 429 / 5xx from a public RPC: try the next one
      const j = await res.json();
      if (j.error && !j.error.data && RETRYABLE.test(j.error.message || '') && k < urls.length - 1) throw new Error(j.error.message);
      state.rpcPref[key] = i;
      return j; // { result } | { error: { code, message, data } }
    } catch { /* next RPC */ }
  }
  throw new RpcDown(urls[0]);
}
async function resultOn(key, method, params, opts) {
  const r = await rpcOn(key, method, params, opts);
  if (r.error) throw Object.assign(new Error(r.error.message), { rpcError: r.error });
  return r.result;
}
const rpc = (m, p, o) => rpcOn(state.netKey, m, p, o);
const rpcResult = (m, p, o) => resultOn(state.netKey, m, p, o);

/** Multicall3 aggregate3 (allowFailure) in chunks: [{ to, data }] -> [{ ok, data }]. */
async function multicall(key, calls) {
  const out = [];
  for (let i = 0; i < calls.length; i += 60) {
    const chunk = calls.slice(i, i + 60);
    const data = MULTICALL.encodeFunctionData('aggregate3', [chunk.map((c) => [c.to, true, c.data])]);
    const res = await resultOn(key, 'eth_call', [{ to: state.cfg.networks[key].multicall3 || MULTICALL3, data }, 'latest']);
    out.push(...MULTICALL.decodeFunctionResult('aggregate3', res)[0].map((r) => ({ ok: r.success, data: r.returnData })));
  }
  return out;
}
const dec1 = (iface, fn, r) => { if (!r?.ok || r.data === '0x') return null; try { return iface.decodeFunctionResult(fn, r.data); } catch { return null; } };

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

/** true: router configured and has code; false: not deployed here; null: could not tell (RPC unreachable). */
async function deployedOn(key, timeout) {
  const n = state.cfg.networks[key];
  if (!n?.router) return false;
  try {
    const code = await resultOn(key, 'eth_getCode', [n.router, 'latest'], { timeout });
    return Boolean(code && code !== '0x');
  } catch { return null; }
}

// ------------------------------------------------------------------ formatting
function fmtUnits(v, d, frac = 4) {
  const [i, f = ''] = ethers.formatUnits(v, d).split('.');
  const sep = (1.5).toLocaleString(loc()).charAt(1);
  // small amounts keep 4 significant digits instead of rounding to 0
  const keep = i === '0' ? Math.max(frac, (f.match(/^0*/)[0].length) + 4) : frac;
  const fr = f.slice(0, keep).replace(/0+$/, '');
  return `${BigInt(i).toLocaleString(loc())}${fr ? sep + fr : ''}`;
}
const fmtInt = (n) => Number(n).toLocaleString(loc());
const symOf = (addr) => state.names.get(String(addr).toLowerCase()) ?? null;
function addrLink(addr, label) {
  const ex = net().explorer;
  const text = esc(label ?? short(addr));
  return ex ? `<a class="hex" href="${esc(`${ex}/address/${addr}`)}" target="_blank" rel="noopener noreferrer" title="${esc(addr)}">${text}</a>`
    : `<span class="hex" title="${esc(addr)}">${text}</span>`;
}

// ------------------------------------------------------------------ the free check
async function tokenMeta(token) {
  const code = await rpcResult('eth_getCode', [token, 'latest']);
  if (!code || code === '0x') return null;
  const call = async (fn) => {
    const r = await rpc('eth_call', [{ to: token, data: ERC20.encodeFunctionData(fn, []) }, 'latest']);
    if (r.error || !r.result || r.result === '0x') return null;
    try { return ERC20.decodeFunctionResult(fn, r.result)[0]; } catch { return null; }
  };
  const [symbol, decimals] = await Promise.all([call('symbol'), call('decimals')]);
  const d = decimals == null ? 18 : Number(decimals);
  return { codehash: ethers.keccak256(code), symbol: cleanText(symbol, 24), decimals: d <= 36 ? d : 18 };
}

async function registryFlags(token) {
  const n = net();
  if (!n.registry) return null;
  const r = await rpc('eth_call', [{ to: n.registry, data: REGISTRY.encodeFunctionData('flagsOf', [token]) }, 'latest']).catch(() => null);
  try { return r?.result ? REGISTRY.decodeFunctionResult('flagsOf', r.result)[0] : null; } catch { return null; }
}

async function inspect(token, mode, amount) {
  const n = net();
  const data = ROUTER.encodeFunctionData('inspect', [n.factory, n.wokb, amount, token, MODES[mode]]);
  const tx = { from: PROBE_FROM, to: n.router, data, value: ethers.toQuantity(amount), gas: CALL_GAS };
  let r = await rpc('eth_call', [tx, 'latest', { [PROBE_FROM]: { balance: ethers.toQuantity(amount + ethers.parseEther('1')) } }]);
  // node without state overrides: retry from the connected wallet (needs the OKB) if there is one
  if (r.error && !walletRevertData(r.error) && /override|param/i.test(r.error.message || '') && state.account) {
    r = await rpc('eth_call', [{ ...tx, from: state.account }, 'latest']);
  }
  if (!r.error) return { name: 'NoRevert' };
  return decodeRevert(walletRevertData(r.error));
}

async function runCheck(ev) {
  ev?.preventDefault();
  const token = $('#token').value.trim();
  const mode = state.mode;
  if (state.deployed === false) return showMessage(S().notDeployedShort);
  if (!ethers.isAddress(token)) return showMessage(S().badAddress);
  let amount;
  try { amount = ethers.parseEther($('#amount').value.trim() || '0'); } catch { amount = 0n; }
  if (amount <= 0n) return showMessage(S().errors.TooLittle);
  const btn = $('#check');
  const gen = state.gen;
  btn.disabled = true; btn.textContent = S().checking;
  try {
    const addr = ethers.getAddress(token);
    const meta = await tokenMeta(addr);
    let last;
    if (!meta) {
      last = { kind: 'error', name: 'NoCode', token: addr, mode, amount };
    } else {
      if (meta.symbol) state.names.set(addr.toLowerCase(), meta.symbol);
      const [flags, r] = await Promise.all([registryFlags(addr), inspect(addr, mode, amount)]);
      if (r.name === 'Report') {
        last = { kind: 'report', token: addr, mode, amount, meta, flags, ...reportFields(r.args) };
      } else {
        // a router without code answers every call with "no revert": that is a deployment problem, not a verdict
        if (r.name === 'NoRevert' || r.name === null) {
          const dep = await deployedOn(state.netKey);
          if (dep === false) { state.deployed = false; applyDeployed(); return showMessage(S().notDeployedShort); }
        }
        last = { kind: 'error', name: r.name, token: addr, mode, amount, meta };
      }
    }
    if (gen !== state.gen) return;
    last.net = state.netKey;
    state.last = last;
    remember(last);
    render();
    const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    $('#result').scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
  } catch (e) {
    if (e instanceof RpcDown) showMessage(fill(S().rpcDown, { rpc: rpcList(net()).join(', ') }));
    else showMessage(fill(S().errors.other, { name: e.message }));
  } finally {
    btn.disabled = state.deployed === false; btn.textContent = S().check;
  }
}

// ------------------------------------------------------------------ rendering: the verdict
function showMessage(text) {
  state.last = null;
  $('#result').innerHTML = `<p class="notice">${esc(text)}</p>`;
  $('#buybox').hidden = true;
}

const ICON = { allow: 'i-exit', policy: 'i-caution', deny: 'i-stop' };
function render() {
  const L = S();
  const r = state.last;
  const out = $('#result');
  if (!r) { out.innerHTML = ''; $('#buybox').hidden = true; return; }
  const modeName = MODE_LABEL[state.lang][r.mode];
  const name = r.meta?.symbol ? `${esc(r.meta.symbol)} ` : '';
  const tokenRef = addrLink(r.token);
  if (r.kind === 'error') {
    out.innerHTML = `
      <div class="plate deny" role="status">
        <svg class="plate-icon" aria-hidden="true"><use href="#i-stop"/></svg>
        <p class="plate-title">${esc(L.cannotTitle)}</p>
        <p class="plate-why">${esc(errorText(r.name, state.lang))}</p>
      </div>
      <p class="plate-sub">${name}${tokenRef}${stop()}${esc(L.cannotLead)}</p>`;
    $('#buybox').hidden = true;
    return;
  }
  const vs = verdictState(r.allow, r.reason);
  const allow = vs === 'allow';
  const dec = r.meta?.decimals ?? 18;
  const sym = esc(r.meta?.symbol ?? '');
  const rows = factRows(r.facts, state.lang);
  const hop = r.buyOut > 0n && r.delivered < r.buyOut ? Number((r.buyOut - r.delivered) * 10_000n / r.buyOut) / 100 : 0;
  const stations = [
    { label: L.step_buy, value: L.yes, text: `${fmtUnits(r.buyOut, dec)} ${r.meta?.symbol ?? ''}`, cls: '' },
    ...rows.map((x) => ({ label: x.label, value: x.value, text: x.key === 'buyTax' && hop > 0 ? `${x.text} ${fill(L.hopLoss, { pct: `${hop.toLocaleString(loc())}%` })}` : x.text, cls: x.bad ? 'bad' : x.warn ? 'warn' : '' })),
    {
      label: L.step_circuit, value: allow ? L.circuitAllow : `${L.circuitDeny}${comma()}${fill(L.reasonPrefix, { n: r.reason }).toLowerCase()}`,
      text: fill(allow ? L.fact_circuit_allow : L.fact_circuit_deny, { mode: modeName }), cls: allow ? '' : vs === 'policy' ? 'warn' : 'bad',
    },
  ];
  const title = { allow: L.allowTitle, policy: L.policyTitle, deny: L.denyTitle }[vs];
  const why = allow ? esc(fill(L.allowBody, { mode: modeName }))
    : `<span class="plate-code">${esc(fill(L.reasonPrefix, { n: r.reason }))}</span>${esc(reasonText(r.reason, r.mode, state.lang))}`;
  let sub = '';
  if (vs === 'deny') sub = `${stop()}${esc(L.denyBody)}`;
  if (vs === 'policy') {
    sub = `${stop()}${esc(fill(L.policyBody, { mode: modeName }))}`;
    if (r.mode !== 'permissive' && policy(withMode(r.facts, 'permissive')).allow) sub += `${state.lang === 'zh' ? '' : ' '}${esc(L.policyLooser)}`;
  }
  out.innerHTML = `
    <div class="plate ${vs}" role="status">
      <svg class="plate-icon" aria-hidden="true"><use href="#${ICON[vs]}"/></svg>
      <p class="plate-title">${esc(title)}</p>
      <p class="plate-why">${why}</p>
    </div>
    <p class="plate-sub">${name}${tokenRef}${sub}</p>
    <dl class="amounts">
      <div><dt>${esc(L.youGet)}</dt><dd>${fmtUnits(r.delivered, dec)} ${sym}</dd></div>
      <div><dt>${esc(L.sellBack)}</dt><dd>${r.sellOut > 0n ? fmtUnits(r.sellOut, 18) : '0'} OKB</dd></div>
    </dl>
    <section class="route" aria-label="${esc(L.route)}">
      <h2>${esc(L.route)}</h2>
      <ol>${stations.map((s) => `
        <li class="${s.cls}"><span class="dot" aria-hidden="true"></span>
          <span class="step-label">${esc(s.label)}</span><span class="step-value">${esc(s.value)}</span>
          <span class="step-text">${esc(s.text)}</span></li>`).join('')}
      </ol>
    </section>
    <p class="result-tools"><button type="button" class="btn-link" data-act="replay">${esc(L.openExplorer)}</button>
      <button type="button" class="btn-link" data-act="share">${esc(L.copyLink)}</button><span class="meta" id="share-status" aria-live="polite"></span></p>`;
  $('#buybox').hidden = !allow || !canBuy();
  if (allow && !canBuy()) out.insertAdjacentHTML('beforeend', `<p class="notice buy-off">${esc(isLoopbackUrl(net().rpc) ? L.buyOffFork : L.buyDisabled)}</p>`);
  if (allow) $('#buy').textContent = fill(L.buy, { amount: ethers.formatEther(r.amount) });
  $('#buy-status').textContent = '';
}

function shareUrl(r) {
  const u = new URL(location.href);
  u.search = new URLSearchParams({ network: state.netKey, token: r.token, mode: r.mode, amount: ethers.formatEther(r.amount), check: '1' }).toString();
  u.hash = '';
  return u.toString();
}

function applyLang() {
  const L = S();
  document.documentElement.lang = state.lang === 'zh' ? 'zh-CN' : state.lang;
  document.querySelectorAll('[data-i18n]').forEach((el) => { const v = L[el.dataset.i18n]; if (typeof v === 'string') el.textContent = v; });
  document.querySelectorAll('[data-lang]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === state.lang)));
  $('#mode-hint').textContent = L[`modeHint_${state.mode}`];
  if (state.account) $('#connect').textContent = fill(L.connected, { addr: short(state.account) });
  const sel = $('#net');
  [...sel.options].forEach((o) => { o.textContent = o.value === 'fork' ? L.netFork : o.value === 'xlayer' ? L.netXlayer : o.value; });
  $('#check').textContent = L.check;
  if (!state.netKey) return; // boot: the network is still being picked
  render();
  renderLocal();
  renderStats();
  renderPairs();
  renderExplorer();
  renderContracts();
}

// ------------------------------------------------------------------ local history (this browser only)
function remember(r) {
  const list = lsGet(LOCAL_KEY) || [];
  list.unshift({ token: r.token, symbol: r.meta?.symbol ?? null, mode: r.mode, net: r.net, allow: r.kind === 'report' && r.allow, reason: r.reason ?? null, error: r.kind === 'error' ? (r.name ?? '') : null, at: Date.now() });
  lsSet(LOCAL_KEY, list.slice(0, 20));
  renderLocal();
}
function renderLocal() {
  const L = S();
  const list = (lsGet(LOCAL_KEY) || []).filter((x) => x.net === state.netKey);
  const ul = $('#local');
  if (!list.length) { ul.innerHTML = `<li class="empty">${esc(L.localEmpty)}</li>`; return; }
  ul.innerHTML = list.slice(0, 8).map((x) => {
    const vs = x.error !== null ? 'deny' : verdictState(x.allow, x.reason);
    const verdict = x.error !== null ? L.cannotTitle : vs === 'allow' ? L.allowTitle
      : `${vs === 'policy' ? L.policyTitle : L.denyTitle}${comma()}${fill(L.reasonPrefix, { n: x.reason }).toLowerCase()}`;
    const t = new Date(x.at).toLocaleTimeString(loc(), { hour: '2-digit', minute: '2-digit' });
    return `<li><span class="tag ${vs === 'allow' ? '' : vs === 'policy' ? 'warn' : 'bad'}">${esc(verdict)}</span>
      <span>${esc(cleanText(x.symbol) ?? '')} <span class="hex">${esc(short(x.token))}</span></span>
      <span class="meta">${esc(MODE_LABEL[state.lang][x.mode] ?? x.mode)}, ${esc(t)}</span></li>`;
  }).join('');
}

// ------------------------------------------------------------------ totals since deployment (incremental, cached)
const statsKey = (key, n) => `exitproof.stats.v2:${key}:${n.router.toLowerCase()}:${n.registry.toLowerCase()}`;
const sameDeploy = (s, n) => s && s.router?.toLowerCase() === n.router.toLowerCase() && s.registry?.toLowerCase() === n.registry.toLowerCase();

/** First block of the deployment: config `deployBlock`, else a cached or binary-searched first block with registry code. */
async function deployBlockOf(key, n) {
  if (n.deployBlock != null) return Number(n.deployBlock);
  const ck = `exitproof.deployBlock:${key}:${n.registry.toLowerCase()}`;
  const cached = lsGet(ck);
  if (Number.isInteger(cached)) return cached;
  let lo = Number(n.feedStartBlock || 0), hi = Number(await resultOn(key, 'eth_blockNumber', []));
  const has = async (b) => { const c = await resultOn(key, 'eth_getCode', [n.registry, ethers.toQuantity(b)]); return c && c !== '0x'; };
  if (await has(lo)) { lsSet(ck, lo); return lo; }
  while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (await has(mid)) hi = mid; else lo = mid; }
  lsSet(ck, hi);
  return hi;
}

/** Applies one page of Checked/Attested logs (any order) to the totals. Same shape as `exitproof.mjs stats`. */
function applyLogs(s, logs, n) {
  logs.sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber) || Number(a.logIndex) - Number(b.logIndex));
  for (const l of logs) {
    const fromRouter = l.address.toLowerCase() === n.router.toLowerCase();
    let ev;
    try { ev = (fromRouter ? ROUTER : REGISTRY).parseLog(l); } catch { continue; }
    if (!ev) continue;
    const b = Number(l.blockNumber);
    if (ev.name === 'Checked') {
      const a = named(CHECKED_EVENT, ev.args);
      s.buys += 1;
      s.okb = (BigInt(s.okb) + BigInt(a.amountIn)).toString();
      s.recent.unshift({ k: 'buy', b, token: a.token, buyer: a.buyer, facts: Number(a.facts), amt: a.amountIn.toString() });
    } else if (ev.name === 'Attested') {
      const f = ev.args.f;
      const bits = ['privileged', 'upgradeable', 'dangerSetter', 'ownerCanTrap'].filter((k) => f[k]);
      s.tokens[ev.args.token.toLowerCase()] = isFlagged(f) ? 1 : 0;
      s.recent.unshift({ k: 'att', b, token: ev.args.token, bits });
    }
  }
  s.recent = s.recent.slice(0, RECENT_MAX);
}

async function statsTick(gen) {
  const key = state.netKey, n = net();
  if (!n.router || !n.registry || state.deployed === false) return 'off';
  if (!state.stats) {
    const cached = lsGet(statsKey(key, n));
    const snap = sameDeploy(n.statsSnapshot, n) ? n.statsSnapshot : null;
    let s = sameDeploy(cached, n) ? cached : null;
    if (snap && (!s || snap.cursor > s.cursor)) s = structuredClone(snap);
    if (!s) {
      const from = await deployBlockOf(key, n);
      s = { router: n.router, registry: n.registry, from, cursor: from - 1, tokens: {}, buys: 0, okb: '0', recent: [] };
    }
    if (gen !== state.gen) return 'stale';
    state.stats = s;
  }
  const s = state.stats;
  const latest = Number(await resultOn(key, 'eth_blockNumber', []));
  const wins = [];
  for (let a = s.cursor + 1; a <= latest && wins.length < WINDOWS_PER_TICK; a += LOG_WINDOW) wins.push([a, Math.min(latest, a + LOG_WINDOW - 1)]);
  const topics = [[ROUTER.getEvent('Checked').topicHash, REGISTRY.getEvent('Attested').topicHash]];
  for (let i = 0; i < wins.length; i += 2) {
    const pair = wins.slice(i, i + 2);
    const pages = await Promise.all(pair.map(([a, b]) => resultOn(key, 'eth_getLogs', [{ address: [n.router, n.registry], topics, fromBlock: ethers.toQuantity(a), toBlock: ethers.toQuantity(b) }])));
    if (gen !== state.gen) return 'stale';
    pages.forEach((logs, j) => { applyLogs(s, logs, n); s.cursor = pair[j][1]; });
  }
  state.statsLatest = latest;
  state.statsErr = null;
  lsSet(statsKey(key, n), s);
  await nameTokens(key, s.recent.map((x) => x.token));
  if (gen !== state.gen) return 'stale';
  renderStats();
  return s.cursor < latest ? 'behind' : 'ok';
}

function scheduleStats(gen, ms) {
  clearTimeout(state.statsTimer);
  state.statsTimer = setTimeout(async () => {
    if (gen !== state.gen) return;
    if (document.hidden) return scheduleStats(gen, TICK_MS);
    try {
      const r = await statsTick(gen);
      if (r === 'stale' || r === 'off') return;
      state.statsBackoff = 0;
      scheduleStats(gen, r === 'behind' ? CATCHUP_MS : TICK_MS);
    } catch (e) {
      if (gen !== state.gen) return;
      state.statsErr = e;
      state.statsBackoff = Math.min(state.statsBackoff + 1, 4);
      renderStats();
      scheduleStats(gen, Math.min(TICK_MS * 2 ** state.statsBackoff, MAX_BACKOFF_MS));
    }
  }, ms);
}

/** Symbols for token addresses we have not named yet (one multicall), sanitized. */
async function nameTokens(key, tokens) {
  const todo = [...new Set(tokens.map((t) => t.toLowerCase()))].filter((t) => !state.names.has(t));
  if (!todo.length) return;
  try {
    const res = await multicall(key, todo.map((t) => ({ to: t, data: ERC20.encodeFunctionData('symbol', []) })));
    todo.forEach((t, i) => { const s = cleanText(dec1(ERC20, 'symbol', res[i])?.[0], 24); if (s) state.names.set(t, s); });
  } catch { /* names are cosmetic */ }
}

function renderStats() {
  const L = S();
  const box = $('#stats'), ul = $('#feed'), note = $('#stats-note');
  const n = net();
  if (!n.router || state.deployed === false) {
    box.innerHTML = ''; note.textContent = L.notDeployedShort; ul.innerHTML = ''; return;
  }
  const s = state.stats;
  if (!s) {
    note.textContent = state.statsErr instanceof RpcDown ? fill(L.rpcDown, { rpc: rpcList(n).join(', ') }) : L.statsLoading;
    box.innerHTML = ''; ul.innerHTML = ''; return;
  }
  const vals = Object.values(s.tokens);
  const tiles = [
    [L.stat_tokens, fmtInt(vals.length)], [L.stat_flagged, fmtInt(vals.filter((v) => v === 1).length)],
    [L.stat_buys, fmtInt(s.buys)], [L.stat_okb, fmtUnits(BigInt(s.okb), 18, 3)],
  ];
  box.innerHTML = tiles.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
  const latest = state.statsLatest ?? s.cursor;
  const behind = latest - s.cursor > LOG_WINDOW;
  const pct = Math.floor(((s.cursor - s.from + 1) / Math.max(1, latest - s.from + 1)) * 100);
  note.textContent = behind ? fill(L.statsCatchup, { from: fmtInt(s.from), pct: Math.min(99, Math.max(0, pct)) })
    : fill(L.statsSince, { from: fmtInt(s.from), to: fmtInt(s.cursor) });
  if (state.statsErr instanceof RpcDown) note.textContent += ` ${fill(L.rpcDown, { rpc: rpcList(n).join(', ') })}`;
  if (!s.recent.length) { ul.innerHTML = `<li class="empty">${esc(L.feedEmpty)}</li>`; return; }
  ul.innerHTML = s.recent.map((x) => {
    const sym = symOf(x.token) ?? short(x.token);
    const block = fill(L.block, { n: fmtInt(x.b) });
    if (x.k === 'buy') {
      return `<li><span class="tag">${esc(L.feedChecked)}</span>
        <span>${esc(fmtUnits(BigInt(x.amt), 18))} OKB → ${esc(sym)} <span class="meta">(${esc(MODE_LABEL[state.lang][decodeFacts(x.facts).mode])})</span></span>
        <span class="meta">${esc(short(x.buyer))}, ${esc(block)}</span></li>`;
    }
    const danger = x.bits.some((k) => k !== 'privileged');
    return `<li><span class="tag ${danger ? 'bad' : x.bits.length ? 'warn' : ''}">${esc(L.feedAttested)}</span>
      <span>${esc(sym)}: ${esc(x.bits.length ? list(x.bits.map((k) => L.flags[k])) : L.feedNoFlags)}</span>
      <span class="meta">${esc(block)}</span></li>`;
  }).join('');
}

// ------------------------------------------------------------------ New on PotatoSwap
async function loadPairs(gen) {
  const key = state.netKey, n = net();
  const ck = `exitproof.pairs.v1:${key}:${n.factory.toLowerCase()}`;
  const cache = lsGet(ck) || { byIndex: {} };
  const [lenR] = await multicall(key, [{ to: n.factory, data: FACTORY.encodeFunctionData('allPairsLength', []) }]);
  const len = Number(dec1(FACTORY, 'allPairsLength', lenR)?.[0] ?? 0);
  const idx = [];
  for (let i = len - 1; i >= 0 && idx.length < PAIRS_SCAN; i--) idx.push(i);
  const miss = idx.filter((i) => !cache.byIndex[i]);
  if (miss.length) {
    const addrs = await multicall(key, miss.map((i) => ({ to: n.factory, data: FACTORY.encodeFunctionData('allPairs', [i]) })));
    const pairs = miss.map((i, j) => ({ i, pair: dec1(FACTORY, 'allPairs', addrs[j])?.[0] })).filter((p) => p.pair);
    const tk = await multicall(key, pairs.flatMap((p) => [{ to: p.pair, data: PAIR.encodeFunctionData('token0', []) }, { to: p.pair, data: PAIR.encodeFunctionData('token1', []) }]));
    pairs.forEach((p, j) => {
      const t0 = dec1(PAIR, 'token0', tk[2 * j])?.[0], t1 = dec1(PAIR, 'token1', tk[2 * j + 1])?.[0];
      if (!t0 || !t1) return;
      const w = n.wokb.toLowerCase();
      const okb0 = t0.toLowerCase() === w;
      cache.byIndex[p.i] = okb0 || t1.toLowerCase() === w ? { pair: p.pair, token: okb0 ? t1 : t0, okb0 } : { skip: true };
    });
    for (const k of Object.keys(cache.byIndex)) if (Number(k) < len - PAIRS_SCAN * 3) delete cache.byIndex[k];
    lsSet(ck, cache);
  }
  const list = idx.map((i) => ({ i, ...cache.byIndex[i] })).filter((p) => p.pair && !p.skip).slice(0, PAIRS_SHOWN);
  // live part, every refresh: reserves, registry flags, missing symbols (one multicall)
  const calls = list.flatMap((p) => [
    { to: p.pair, data: PAIR.encodeFunctionData('getReserves', []) },
    n.registry ? { to: n.registry, data: REGISTRY.encodeFunctionData('flagsOf', [p.token]) } : { to: p.pair, data: '0x' },
  ]);
  const res = calls.length ? await multicall(key, calls) : [];
  await nameTokens(key, list.map((p) => p.token));
  if (gen !== state.gen) return;
  state.pairs = list.map((p, j) => {
    const rv = dec1(PAIR, 'getReserves', res[2 * j]);
    const fl = n.registry ? dec1(REGISTRY, 'flagsOf', res[2 * j + 1])?.[0] : null;
    return { ...p, okb: rv ? BigInt(rv[p.okb0 ? 0 : 1]) : null, flags: fl ? { scanned: fl.scanned, privileged: fl.privileged, upgradeable: fl.upgradeable, dangerSetter: fl.dangerSetter, ownerCanTrap: fl.ownerCanTrap } : null };
  });
  state.pairs = state.pairs.filter((p) => p.okb !== 0n); // drained or never-funded pools are noise
  state.pairsErr = null;
  renderPairs();
}

function schedulePairs(gen, ms) {
  clearTimeout(state.pairsTimer);
  state.pairsTimer = setTimeout(async () => {
    if (gen !== state.gen) return;
    if (!document.hidden) {
      try { await loadPairs(gen); } catch (e) { if (gen === state.gen) { state.pairsErr = e; renderPairs(); } }
    }
    if (gen === state.gen) schedulePairs(gen, PAIRS_MS);
  }, ms);
}

function renderPairs() {
  const L = S();
  const ul = $('#pairs');
  if (state.pairsErr && !state.pairs) { ul.innerHTML = `<li class="empty">${esc(state.pairsErr instanceof RpcDown ? fill(L.rpcDown, { rpc: rpcList(net()).join(', ') }) : state.pairsErr.message)}</li>`; return; }
  if (!state.pairs) { ul.innerHTML = `<li class="empty">${esc(L.pairsLoading)}</li>`; return; }
  if (!state.pairs.length) { ul.innerHTML = `<li class="empty">${esc(L.pairsEmpty)}</li>`; return; }
  const canCheck = state.deployed !== false;
  ul.innerHTML = state.pairs.map((p) => {
    const f = p.flags;
    let cls = 'none', text = L.pairUnscanned;
    if (f?.scanned) {
      const bad = ['privileged', 'upgradeable', 'dangerSetter', 'ownerCanTrap'].filter((k) => f[k]);
      cls = isFlagged(f) ? 'bad' : bad.length ? 'warn' : '';
      text = bad.length ? fill(L.pairFlagged, { flags: list(bad.map((k) => L.flags[k])) }) : L.pairScanned;
    }
    const sym = symOf(p.token) ?? short(p.token);
    return `<li class="pair"><span class="pair-main"><span class="pair-sym">${esc(sym)}</span> ${addrLink(p.token)}
        <span class="meta">${p.okb != null ? `${esc(fmtUnits(p.okb, 18, 2))} OKB · ` : ''}${esc(fill(L.pairNo, { n: fmtInt(p.i) }))}</span></span>
      <span class="tag ${cls}">${esc(text)}</span>
      ${canCheck ? `<button type="button" class="btn-small" data-check="${esc(p.token)}">${esc(L.pairCheck)}</button>` : ''}</li>`;
  }).join('');
}

// ------------------------------------------------------------------ circuit explorer
const XBITS = [ // [field, bit within the field] for input wires 0..10
  ['sellOk', 0], ['sellTax', 0], ['sellTax', 1], ['buyTax', 0], ['buyTax', 1], ['ownerActive', 0],
  ['upgradeable', 0], ['danger', 0], ['unscanned', 0], ['mode', 0], ['mode', 1],
];
function xFieldValue(x, f) { const [s, w] = FIELDS[f]; return (x >> s) & ((1 << w) - 1); }

function renderExplorer() {
  const L = S();
  const x = state.x;
  $('#xbits').innerHTML = XBITS.map(([f, k], i) => {
    const on = (x >> i) & 1;
    const width = FIELDS[f][1];
    const label = `${L.xBits[f]}${width > 1 ? ` ·${k + 1}` : ''}`;
    return `<button type="button" class="xbit${on ? ' on' : ''}" data-bit="${i}" aria-pressed="${on ? 'true' : 'false'}" aria-label="${esc(`${label}: ${on}`)}">
      <span class="xbit-v" aria-hidden="true">${on}</span><span class="xbit-l">${esc(label)}</span><span class="xbit-n" aria-hidden="true">x${i}</span></button>`;
  }).join('');
  const T = factRows(x, state.lang);
  const d = decodeFacts(x);
  $('#xmode').value = String(xFieldValue(x, 'mode'));
  [...$('#xmode').options].forEach((o) => { o.textContent = o.value === '3' ? `${MODE_LABEL[state.lang].strict} (3)` : MODE_LABEL[state.lang][['strict', 'balanced', 'permissive'][Number(o.value)]]; });
  $('#xdecoded').textContent = `${T[1].label} ${T[1].value} · ${T[2].label} ${T[2].value}`;
  const local = policy(x);
  const fmtV = (v) => (v.allow ? `${L.circuitAllow}` : `${L.circuitDeny}${comma()}${fill(L.reasonPrefix, { n: v.reason }).toLowerCase()}`);
  const hex = `0x${x.toString(16).padStart(3, '0')}`;
  const bytes = `0x${(x & 0xff).toString(16).padStart(2, '0')}${(x >> 8).toString(16).padStart(2, '0')}`;
  const ch = state.xResult;
  let chainTxt, badge = '';
  if (ch?.x !== x || ch.pending) chainTxt = L.xPending;
  else if (ch.offline) chainTxt = L.xOffline;
  else if (ch.error) chainTxt = fill(L.xError, { msg: ch.error });
  else {
    chainTxt = fmtV(ch);
    const ok = ch.allow === local.allow && ch.reason === local.reason;
    badge = `<span class="xbadge ${ok ? 'ok' : 'bad'}">${ok ? '✓' : '✗'} ${esc(ok ? L.xMatch : L.xMismatch)}</span>`;
  }
  const vs = verdictState(local.allow, local.reason);
  $('#xout').innerHTML = `
    <div><dt>${esc(L.xInput)}</dt><dd class="hex">${esc(hex)} <span class="meta">eval(…, ${esc(bytes)})</span></dd></div>
    <div><dt>${esc(L.xChain)}</dt><dd>${esc(chainTxt)}</dd></div>
    <div><dt>${esc(L.xLocal)}</dt><dd><span class="tag ${vs === 'allow' ? '' : vs === 'policy' ? 'warn' : 'bad'}">${esc(fmtV(local))}</span></dd></div>
    <div class="xbadge-cell">${badge}</div>`;
  $('#xreason').textContent = local.allow ? fill(L.fact_circuit_allow, { mode: MODE_LABEL[state.lang][d.mode] }) : reasonText(local.reason, d.mode, state.lang);
  const n = net();
  $('#xproc').innerHTML = n.processor ? esc(fill(L.xProcessor, { addr: '\u0000', id: n.circuitId })).replace('\u0000', addrLink(n.processor)) : '';
}

function evalLive() {
  clearTimeout(state.xTimer);
  const x = state.x, key = state.netKey, n = net(), gen = state.gen;
  if (!n.processor || n.circuitId == null || state.deployed === false) { state.xResult = { x, offline: true }; renderExplorer(); return; }
  const hit = state.xCache.get(`${key}:${x}`);
  if (hit) { state.xResult = { x, ...hit }; renderExplorer(); return; }
  state.xResult = { x, pending: true };
  renderExplorer();
  state.xTimer = setTimeout(async () => {
    let out;
    try {
      const data = PROCESSOR.encodeFunctionData('eval', [BigInt(n.circuitId), new Uint8Array([x & 0xff, x >> 8])]);
      const raw = await resultOn(key, 'eth_call', [{ to: n.processor, data }, 'latest']);
      const bytes = ethers.getBytes(PROCESSOR.decodeFunctionResult('eval', raw)[0]);
      if (!bytes.length) throw new Error('empty output');
      out = { allow: (bytes[0] & 1) === 1, reason: (bytes[0] >> 1) & 7 };
      state.xCache.set(`${key}:${x}`, out);
    } catch (e) { out = { error: e instanceof RpcDown ? 'RPC' : (e.shortMessage || e.message || 'error').slice(0, 80) }; }
    if (gen !== state.gen || state.x !== x) return;
    state.xResult = { x, ...out };
    renderExplorer();
  }, 200);
}
function setX(x) { state.x = x & 0x7ff; evalLive(); }

// ------------------------------------------------------------------ wallet + buy
/** Buying is allowed only where config says so: never by default on a loopback fork RPC, where a wallet on real
 *  X Layer (same chain id 196) would send OKB to an address that only exists on the fork. */
const canBuy = () => Boolean(net().router) && state.deployed !== false && net().buyEnabled === true;

function walletReset() {
  state.account = null;
  $('#connect').textContent = S().connect;
  $('#buy-status').textContent = '';
}

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

/** Exact amount the wallet would receive: eth_call of buyETH itself (minOut = 1) on the configured RPC. The router
 *  delivers to `to` before the circuit decides and returns the measured delivery, so every hop's tax is inside it. */
async function simulateBuy(n, r, account, deadline) {
  const data = ROUTER.encodeFunctionData('buyETH', [n.factory, r.token, 1n, MODES[r.mode], account, deadline]);
  const res = await rpc('eth_call', [{ from: account, to: n.router, data, value: ethers.toQuantity(r.amount), gas: CALL_GAS }, 'latest',
    { [account]: { balance: ethers.toQuantity(r.amount + ethers.parseEther('1')) } }]);
  if (res.error) return { revert: decodeRevert(walletRevertData(res.error)) };
  return { out: ROUTER.decodeFunctionResult('buyETH', res.result)[0] };
}

async function buy() {
  const L = S();
  const st = $('#buy-status');
  const r = state.last;
  st.className = 'buy-status';
  const fail = (text) => { st.className = 'buy-status bad'; st.textContent = text; };
  if (!canBuy()) return fail(L.buyDisabled);
  if (!r || r.kind !== 'report' || !r.allow || r.net !== state.netKey) { st.textContent = L.buyNeedsCheck; return; }
  try {
    const account = state.account ?? (await connect());
    if (!account) return;
    st.textContent = L.buying;
    const n = net();
    const provider = new ethers.BrowserProvider(window.ethereum);
    // every send: the wallet must be on the configured chain AND see the router's code on ITS network
    const walletChain = Number(await window.ethereum.request({ method: 'eth_chainId' }));
    if (walletChain !== n.chainId) return fail(L.wrongChain);
    const code = await provider.getCode(n.router);
    if (!code || code === '0x') return fail(L.routerMissing);

    const head = await rpcResult('eth_getBlockByNumber', ['latest', false]);
    const deadline = BigInt(head.timestamp) + 600n;
    const sim = await simulateBuy(n, r, account, deadline);
    if (sim.revert) {
      const d = sim.revert;
      return fail(d.name === 'Blocked' ? fill(L.buyBlocked, { reason: reasonText(d.args[0], r.mode, state.lang) }) : errorText(d.name, state.lang));
    }
    // minOut = simulated delivered amount minus the user's slippage (default 1%, max 5%); no extra tax discount
    const slip = BigInt(Math.min(500, Math.max(0, Number($('#slip').value) || 100)));
    let minOut = sim.out * (10_000n - slip) / 10_000n;
    if (minOut === 0n) minOut = 1n;
    const data = ROUTER.encodeFunctionData('buyETH', [n.factory, r.token, minOut, MODES[r.mode], account, deadline]);
    const signer = await provider.getSigner();
    const tx = { from: account, to: n.router, data, value: r.amount };
    let gasLimit;
    try {
      gasLimit = clampGas((await provider.estimateGas(tx)) * 12n / 10n);
    } catch (e) {
      const d = decodeRevert(walletRevertData(e));
      if (d.name === 'Blocked') return fail(fill(L.buyBlocked, { reason: reasonText(d.args[0], r.mode, state.lang) }));
      if (d.name) return fail(errorText(d.name, state.lang));
      gasLimit = clampGas(FALLBACK_GAS); // no reason given: send with room for the probe; the router still reverts on deny
    }
    // re-check right before signing: the user may have switched networks while we were estimating
    if (Number(await window.ethereum.request({ method: 'eth_chainId' })) !== n.chainId) return fail(L.wrongChain);
    const sent = await signer.sendTransaction({ ...tx, gasLimit });
    const rc = await sent.wait();
    const ev = rc.logs.map((l) => { try { return ROUTER.parseLog(l); } catch { return null; } }).find((x) => x?.name === 'Checked');
    st.textContent = rc.status === 1 && ev
      ? fill(L.bought, { out: `${fmtUnits(named(CHECKED_EVENT, ev.args).out, r.meta?.decimals ?? 18)} ${r.meta?.symbol ?? ''}` })
      : errorText(null, state.lang);
    scheduleStats(state.gen, 2_000);
  } catch (e) {
    const d = decodeRevert(walletRevertData(e));
    fail(d.name === 'Blocked' ? fill(L.buyBlocked, { reason: reasonText(d.args[0], r.mode, state.lang) })
      : d.name ? errorText(d.name, state.lang) : (e.shortMessage || e.message));
  }
}

// ------------------------------------------------------------------ network
function renderContracts() {
  const n = net(), L = S();
  $('#contracts').innerHTML = n.router && state.deployed !== false
    ? `${esc(L.contracts)}: Router ${addrLink(n.router, n.router)} · Registry ${addrLink(n.registry, n.registry)} · TapeOut processor ${addrLink(n.processor, n.processor)}, circuit #${esc(n.circuitId)}`
    : '';
}

function applyDeployed() {
  const live = state.deployed !== false;
  $('#pending').hidden = live;
  $('#check').disabled = !live;
  $('#connect').hidden = !canBuy();
  renderContracts();
  renderStats();
  renderPairs();
}

async function switchNet(key) {
  state.gen += 1;
  const gen = state.gen;
  state.netKey = key;
  $('#net').value = key;
  localStorage.setItem('exitproof.net', key);
  const q = new URLSearchParams(location.search);
  if (q.get('network') !== key) { q.set('network', key); history.replaceState(null, '', `${location.pathname}?${q}`); }
  clearTimeout(state.statsTimer); clearTimeout(state.pairsTimer);
  Object.assign(state, { stats: null, statsLatest: null, statsErr: null, statsBackoff: 0, pairs: null, pairsErr: null, last: null, xResult: null });
  const n = net();
  walletReset();
  render();
  const demo = n.demoTokens || [];
  $('#demo').hidden = !demo.length;
  $('#demo-list').innerHTML = demo.map((t) => `<button type="button" data-addr="${esc(t.address)}">${esc(t.name)}</button>`).join('');
  demo.forEach((t) => state.names.set(t.address.toLowerCase(), t.symbol || t.name));
  state.deployed = n.router ? null : false;
  applyDeployed();
  renderLocal();
  if (n.router) {
    state.deployed = await deployedOn(key);
    if (gen !== state.gen) return;
    applyDeployed();
  }
  evalLive();
  scheduleStats(gen, 0);
  schedulePairs(gen, 300);
}

/** ?network= wins. On a loopback page with a running fork deployment, prefer the fork over a network where ExitProof
 *  is not deployed (a fresh browser otherwise lands on mainnet-pending). Else the saved choice, else the default. */
async function pickNetwork(q) {
  const nets = state.cfg.networks;
  const p = q.get('network');
  if (p && nets[p]) return p;
  const saved = nets[localStorage.getItem('exitproof.net')] ? localStorage.getItem('exitproof.net') : null;
  const local = isLoopbackHost(location.hostname) || location.protocol === 'file:';
  if (local && nets.fork) {
    if (saved && saved !== 'fork' && (await deployedOn(saved, 4000))) return saved;
    if (await deployedOn('fork', 2500)) return 'fork';
  }
  return saved ?? state.cfg.defaultNetwork;
}

// ------------------------------------------------------------------ boot
async function boot() {
  state.cfg = await (await fetch('./config.json', { cache: 'no-store' })).json();
  const sel = $('#net');
  sel.innerHTML = Object.keys(state.cfg.networks).map((k) => `<option value="${esc(k)}">${esc(state.cfg.networks[k].label)}</option>`).join('');
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
  $('#pairs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-check]');
    if (!b) return;
    $('#token').value = b.dataset.check;
    runCheck();
  });
  $('#result').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-act]');
    const r = state.last;
    if (!b || !r || r.kind !== 'report') return;
    if (b.dataset.act === 'replay') {
      setX(r.facts);
      $('#explorer').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    } else {
      // the clipboard can refuse or stall (page not focused): then show the link to copy by hand
      const copy = navigator.clipboard?.writeText(shareUrl(r)) ?? Promise.reject();
      const ok = await Promise.race([copy.then(() => true, () => false), new Promise((res) => setTimeout(() => res(false), 1500))]);
      $('#share-status').textContent = ok ? S().copied : shareUrl(r);
    }
  });
  $('#xbits').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-bit]');
    if (b) setX(state.x ^ (1 << Number(b.dataset.bit)));
  });
  $('#xmode').addEventListener('change', (e) => setX((state.x & 0x1ff) | (Number(e.target.value) << 9)));
  $('#form').addEventListener('submit', runCheck);
  $('#connect').addEventListener('click', () => connect().catch((e) => { $('#buy-status').textContent = e.shortMessage || e.message; }));
  $('#buy').addEventListener('click', buy);
  if (window.ethereum?.on) {
    // a different account or chain invalidates the connection and any half-finished buy
    window.ethereum.on('accountsChanged', walletReset);
    window.ethereum.on('chainChanged', walletReset);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && state.netKey) scheduleStats(state.gen, 500); });
  const q = new URLSearchParams(location.search);
  if (q.get('token')) $('#token').value = q.get('token');
  if (q.get('amount') && /^\d+(\.\d+)?$/.test(q.get('amount'))) $('#amount').value = q.get('amount');
  if (q.get('mode') && q.get('mode') in MODES) { state.mode = q.get('mode'); document.querySelector(`input[name="mode"][value="${state.mode}"]`).checked = true; }
  applyLang();
  await switchNet(await pickNetwork(q));
  applyLang();
  // ?check=1 runs only where ExitProof is deployed: never a false verdict from a network without the router
  if (q.get('check') === '1' && q.get('token') && state.deployed !== false) runCheck();
}

boot().catch((e) => { document.body.insertAdjacentHTML('afterbegin', `<p class="notice">${esc(e.message)}</p>`); });
