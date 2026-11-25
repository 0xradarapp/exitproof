// ExitProof shared verdict logic: fact decoding, the circuit policy (JS port of circuit/spec.py), reason codes, router
// error explanations, the untrusted-text sanitizer and the EN/TR/ZH strings.
// Plain ES module with no dependencies, so the browser (web/app.js) and Node (cli/exitproof.mjs) both import it.

/** True only for an exact loopback hostname: 127.a.b.c, localhost or [::1] (URL keeps the brackets for IPv6). */
export function isLoopbackHost(host) {
  return /^(127(\.\d{1,3}){3}|localhost|\[::1\])$/.test(String(host).toLowerCase());
}
export function isLoopbackUrl(url) {
  try { return isLoopbackHost(new URL(url).hostname); } catch { return false; }
}

/** Every RPC of a network config entry, primary first: `rpc`, then `rpcFallback` (a string or a list). */
export function rpcList(net) {
  const extra = net?.rpcFallback == null ? [] : [].concat(net.rpcFallback);
  return [...new Set([net?.rpc, ...extra].filter((u) => typeof u === 'string' && u))];
}

export const MODES = { strict: 0, balanced: 1, permissive: 2 };
export const MODE_NAMES = ['strict', 'balanced', 'permissive', 'strict'];

/** Bit layout of the 11-bit circuit input (circuit/spec.py FIELDS): name -> [shift, width]. */
export const FIELDS = {
  sellOk: [0, 1], sellTax: [1, 2], buyTax: [3, 2], ownerActive: [5, 1],
  upgradeable: [6, 1], danger: [7, 1], unscanned: [8, 1], mode: [9, 2],
};

/** Decodes the 11-bit circuit input that the router packs (spec: "Circuit interface"). */
export function decodeFacts(facts) {
  const f = Number(facts);
  return {
    sellOk: (f & 1) === 1,
    sellTax: (f >> 1) & 3,
    buyTax: (f >> 3) & 3,
    ownerActive: ((f >> 5) & 1) === 1,
    upgradeable: ((f >> 6) & 1) === 1,
    danger: ((f >> 7) & 1) === 1,
    unscanned: ((f >> 8) & 1) === 1,
    mode: MODE_NAMES[(f >> 9) & 3],
  };
}

/** The policy the taped-out NAND circuit implements, bit for bit (port of circuit/spec.py `policy`).
 *  Returns { allow, reason } for an 11-bit input. cli/test checks it against circuit/truth.json on all 2048 inputs. */
export function policy(x) {
  const n = Number(x);
  const bit = (s) => (n >> s) & 1;
  let mode = (n >> 9) & 3;
  if (mode === 3) mode = 0;
  const st = (n >> 1) & 3, bt = (n >> 3) & 3;
  const owner = bit(5), upg = bit(6), dng = bit(7), uns = bit(8);
  const maxTax = mode === 0 ? 0 : 1;
  const no = (reason) => ({ allow: false, reason });
  if (!bit(0)) return no(1);
  if (st > maxTax) return no(2);
  if (bt > maxTax) return no(3);
  if (mode === 2) return { allow: true, reason: 0 };
  if (upg) return no(4);
  if (mode === 1) {
    if (owner && dng) return no(5);
    if (owner && uns) return no(6);
    return { allow: true, reason: 0 };
  }
  if (dng) return no(5);
  if (uns) return no(6);
  if (owner) return no(7);
  return { allow: true, reason: 0 };
}

/** Same facts, another mode (bits 9-10 replaced). */
export function withMode(facts, mode) {
  return (Number(facts) & 0x1ff) | (MODES[mode] << 9);
}

/** Three verdict states. Reasons 1-3 are about the exit itself (cannot sell, or the tax eats it): red.
 *  Reasons 4-7 mean the full sell-back WORKED but the owner/upgrade/scan policy of the mode says no: amber. */
export function verdictState(allow, reason) {
  if (allow) return 'allow';
  return Number(reason) >= 4 ? 'policy' : 'deny';
}

/** Token-controlled text (symbol, name) is attacker data. Drops control/format characters (newlines, bidi overrides,
 *  zero-width), collapses whitespace, caps the length. Returns null when nothing printable is left. */
export function cleanText(s, max = 24) {
  if (s == null) return null;
  const t = String(s).replace(/[\p{C}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const chars = [...t];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : t;
}

const TAX = {
  en: { long: ['under 5%', '5-15%', '15-50%', '50% or more, or could not be measured'], short: ['under 5%', '5-15%', '15-50%', '50%+'] },
  tr: { long: ['%5 altı', '%5-15', '%15-50', '%50 veya üstü ya da ölçülemedi'], short: ['%5 altı', '%5-15', '%15-50', '%50+'] },
  zh: { long: ['低于 5%', '5%-15%', '15%-50%', '50% 及以上，或无法测量'], short: ['低于 5%', '5%-15%', '15%-50%', '50%+'] },
};
export const TAX_RANGE = TAX.en.long;
export const TAX_SHORT = (lang = 'en') => (TAX[lang] || TAX.en).short;

/** Router custom errors we may meet, by name. Report and Blocked carry a verdict; the rest mean "cannot buy". */
export const ROUTER_ERRORS = [
  'error Blocked(uint8 reason, uint16 facts)',
  'error Report(uint16 facts, bool allow, uint8 reason, uint256 buyOut, uint256 sellOut, uint256 delivered)',
  'error BadPair()', 'error Expired()', 'error TooLittle()', 'error BadEval()', 'error BadConfig()',
  'error BadMode()', 'error BadTo()', 'error BadAmount()', 'error NotSelf()', 'error LowGas()', 'error Locked()',
  'error TransferFailed()', 'error SwapFailed()',
];

/** Human-readable ABIs, valid for both ethers v6 (web) and viem parseAbi (CLI). */
export const FLAGS_T = '(bool scanned, bool privileged, bool upgradeable, bool dangerSetter, bool ownerCanTrap, uint16 scannerVersion)';
export const CHECKED_EVENT = 'event Checked(address indexed token, bytes32 indexed codehash, address indexed buyer, uint16 facts, bool allow, uint8 reason, uint256 amountIn, uint256 out)';
export const ROUTER_ABI = [
  'function inspect(address factory, address tokenIn, uint256 amountIn, address token, uint8 mode) payable',
  'function buyETH(address factory, address token, uint256 minOut, uint8 mode, address to, uint256 deadline) payable returns (uint256)',
  CHECKED_EVENT,
  ...ROUTER_ERRORS,
];
export const REGISTRY_ABI = [
  `event Attested(address indexed token, bytes32 indexed codehash, ${FLAGS_T} f, string reportURI, address attester)`,
  `function flagsOf(address token) view returns (${FLAGS_T} f, bytes32 codehash)`,
];
export const PROCESSOR_ABI = ['function eval(uint256 circuitId, bytes input) view returns (bytes)'];

/** Positional args of an ABI item -> { name: value }, by the parameter names in its signature. */
export function named(sig, args) {
  const names = sig.slice(sig.indexOf('(') + 1, sig.lastIndexOf(')')).split(',').map((p) => p.trim().split(/\s+/).pop());
  return Object.fromEntries(names.map((n, i) => [n, args[i]]));
}
const REPORT_SIG = ROUTER_ERRORS.find((e) => e.startsWith('error Report('));
/** Report(...) args -> { facts, allow, reason, buyOut, sellOut, delivered }. `delivered` = what reached the caller's
 *  wallet after the router's last hop (falls back to buyOut for a router that does not report it). */
export function reportFields(args) {
  const r = named(REPORT_SIG, args);
  return { ...r, facts: Number(r.facts), reason: Number(r.reason), delivered: r.delivered ?? r.buyOut };
}
/** Flag bits of an attestation that make the scanner call a token dangerous. */
export const isFlagged = (f) => Boolean(f && (f.dangerSetter || f.ownerCanTrap || f.upgradeable));

export const LANGS = ['en', 'tr', 'zh'];
export const LOCALE = { en: 'en-US', tr: 'tr-TR', zh: 'zh-CN' };

export const STRINGS = {
  en: {
    tagline: "Don't buy what you can't sell.",
    lede: 'ExitProof buys the token and tries to sell all of it back in the same transaction. A TapeOut circuit on X Layer reads the result. If it says no, the buy reverts; only the gas is spent.',
    tokenLabel: 'Token address',
    tokenHint: 'A token with an OKB pool on PotatoSwap.',
    modeLabel: 'Buy mode',
    mode_strict: 'Strict',
    mode_balanced: 'Balanced',
    mode_permissive: 'Permissive',
    modeHint_strict: 'Only clean tokens: no tax, no active owner, scanned by ExitProof.',
    modeHint_balanced: 'Sellable, low tax, not upgradeable, and no active owner with dangerous powers.',
    modeHint_permissive: 'Default. The exit proof: you can sell it all back right now, and the tax is under 15%. Owner risks show as an advisory.',
    amountLabel: 'Amount (OKB)',
    check: 'Check for free',
    checking: 'Buying and selling back in a simulation…',
    checkNote: 'Free. Runs as a simulation, nothing is sent and no wallet is needed.',
    demoTokens: 'Try a demo token',
    allowTitle: 'You can get out',
    denyTitle: 'Exit blocked',
    policyTitle: 'Sells now, but risky',
    cannotTitle: 'Cannot buy safely',
    allowBody: 'ExitProof bought this token and sold all of it back in a simulation. The circuit allows this buy in {mode} mode.',
    denyBody: 'If you buy through ExitProof, the buy reverts; only the gas is spent.',
    policyBody: 'The full sell-back worked, but {mode} mode does not accept this risk. A buy through ExitProof in this mode reverts; only the gas is spent.',
    policyLooser: 'Permissive mode would allow it, if you accept the risk above.',
    youGet: 'You would receive',
    sellBack: 'Selling it all back right away returns',
    hopLoss: 'The token kept {pct} on the last hop to your wallet. That loss counts as buy tax.',
    reasonPrefix: 'Reason {n}',
    route: 'What happened in the simulation',
    step_buy: 'Bought from the PotatoSwap pool',
    step_sell: 'Handed to a fresh wallet and sold back in full',
    step_sellTax: 'Sell tax',
    step_buyTax: 'Buy tax',
    step_owner: 'Owner',
    step_upg: 'Code can be swapped',
    step_danger: 'Dangerous owner switches',
    step_scan: 'Checked by the ExitProof scanner',
    step_circuit: 'TapeOut circuit decision',
    yes: 'yes', no: 'no',
    fact_sellOk_1: 'The whole position sold back.',
    fact_sellOk_0: 'Selling the whole position back failed.',
    fact_tax: 'Measured at {range}.',
    fact_buyTax: 'Measured at {range}, including the hop to your wallet.',
    fact_owner_1: 'Someone still controls this token (an owner or a privileged role).',
    fact_owner_0: 'No active owner found.',
    fact_upg_1: 'The token can change its code later (proxy or delegatecall).',
    fact_upg_0: 'Fixed code, it cannot be upgraded.',
    fact_danger_1: 'The owner can change fees, block wallets or stop trading.',
    fact_danger_0: 'No dangerous owner switches known.',
    fact_scan_1: 'Not scanned yet, so hidden owner powers are unknown.',
    fact_scan_0: 'Scanned. The registry has an entry for this token.',
    fact_circuit_allow: 'Allowed in {mode} mode.',
    fact_circuit_deny: 'Denied in {mode} mode.',
    advTitle: 'Owner-risk advisory',
    advBody: 'The verdict above is the exit proof (permissive mode). Balanced and strict also judge the owner, upgrades and the scan. Your buy uses the mode you pick here.',
    advAllows: '{mode}: allows',
    advBlocks: '{mode}: blocks',
    advExitProof: 'Exit proof: the whole position sells back now and the tax is within bounds.',
    advNoRisk: 'No owner risk this mode objects to.',
    advReason: '{text} (reason {n})',
    advUse: 'Buy in {mode} mode',
    advInUse: 'Buy mode',
    buyModeLine: 'Buy mode: {mode}. The router re-runs the check in this mode inside your transaction.',
    buyModeBlocked: '{mode} mode blocks this buy: {reason} Pick another buy mode above, or don\'t buy.',
    openExplorer: 'Replay these facts in the circuit explorer',
    copyLink: 'Copy link to this check',
    copied: 'Link copied.',
    buyTitle: 'Buy through ExitProof',
    buyBody: 'The same check runs again inside your real transaction. If anything changed, the buy reverts; only the gas is spent.',
    connect: 'Connect wallet',
    connected: 'Connected {addr}',
    buy: 'Buy {amount} OKB of this token',
    buying: 'Waiting for your wallet…',
    bought: 'Bought. You received {out}.',
    buyBlocked: 'ExitProof blocks this buy: {reason}',
    buyNeedsCheck: 'Run a check that allows the buy first.',
    noWallet: 'No browser wallet found. Install OKX Wallet or MetaMask to buy. Checks work without one.',
    wrongChain: 'Switch your wallet to X Layer (chain 196). Nothing was sent.',
    routerMissing: 'Your wallet\'s network has no ExitProof router at this address. Nothing was sent.',
    buyDisabled: 'Buying is switched off for this network.',
    buyOffFork: 'Buying is off on the local fork: a wallet on real X Layer would send OKB to an address that only exists on the fork. The check above is still exact.',
    notDeployed: 'ExitProof is not deployed on this network yet. Switch the network to Local fork to try checks; buying there is off in the browser.',
    notDeployedShort: 'ExitProof is not deployed on this network yet.',
    statsTitle: 'Since launch',
    statsBody: 'Totals read from the router and the registry since they were deployed. Blocked buys revert, so they never show up here.',
    stat_tokens: 'Tokens scanned',
    stat_flagged: 'Flagged by the scanner',
    stat_buys: 'Guarded buys',
    stat_okb: 'OKB routed',
    statsSince: 'Since block {from}, counted through block {to}.',
    statsCatchup: 'Counting from block {from}: {pct}% done.',
    statsLoading: 'Reading the chain…',
    recentTitle: 'Latest on chain',
    feedEmpty: 'No buys or scanner verdicts yet.',
    feedChecked: 'Guarded buy',
    feedAttested: 'Scanner verdict',
    feedNoFlags: 'no dangerous flags',
    block: 'block {n}',
    flags: { privileged: 'owner powers', upgradeable: 'upgradeable code', dangerSetter: 'fee or blacklist switches', ownerCanTrap: 'owner can trap holders' },
    circuitAllow: 'allow', circuitDeny: 'deny',
    pairsTitle: 'New on PotatoSwap',
    pairsBody: 'The newest OKB pools and what the ExitProof scanner has on file. Click Check for the full live test.',
    pairsLoading: 'Reading the newest pools…',
    pairsEmpty: 'No OKB pools found.',
    pairScanned: 'scanned, no dangerous flags',
    pairFlagged: 'flagged: {flags}',
    pairUnscanned: 'not scanned yet',
    pairCheck: 'Check',
    pairNo: 'pool #{n}',
    xTitle: 'Circuit explorer',
    xBody: 'Flip the 11 input wires of the policy chip. The answer comes live from the TapeOut processor on chain, next to the local truth table.',
    xMode: 'Mode',
    xInput: 'Input',
    xChain: 'On chain',
    xLocal: 'Truth table',
    xMatch: 'matches',
    xMismatch: 'does not match',
    xPending: 'asking the chip…',
    xOffline: 'not deployed on this network, truth table only',
    xError: 'chip call failed: {msg}',
    xProcessor: 'Processor {addr}, circuit #{id}',
    xBits: { sellOk: 'sold back', sellTax: 'sell tax', buyTax: 'buy tax', ownerActive: 'owner', upgradeable: 'upgrades', danger: 'danger', unscanned: 'unscanned', mode: 'mode' },
    localTitle: 'Checks you ran here',
    localEmpty: 'Your checks show up here. They stay in this browser.',
    network: 'Network',
    netFork: 'Local fork',
    netXlayer: 'X Layer',
    slippage: 'Slippage',
    badAddress: 'That is not a token address. It should start with 0x and have 40 more characters.',
    rpcDown: 'Could not reach {rpc}. This is a connection problem, not a verdict on the token.',
    howTitle: 'How the check works',
    how1: 'Your OKB buys the token on PotatoSwap and the tokens go to your wallet.',
    how2: 'A brand-new wallet gets the same tokens and sells every one of them back.',
    how3: 'Taxes and owner powers are measured and read from the ExitProof registry.',
    how4: 'A NAND circuit taped out on X Layer decides. A no reverts the whole transaction; only the gas is spent.',
    footer: 'Contracts have no owner and no admin. Not financial advice: ExitProof proves the token sells now, through this router.',
    contracts: 'Contracts',
    reasons: {
      1: 'You could buy, but you could not sell all of it back.',
      2: 'The sell tax is too high for this mode.',
      3: 'The buy tax is too high for this mode.',
      4: 'The token can swap its code after you buy.',
      5: 'The owner holds switches that can trap your tokens later, such as raising the fee.',
      6: 'The token has not been scanned, and an owner is still active.',
      7: 'An owner is still active. Strict mode only allows tokens without one.',
    },
    reasonsStrict6: 'The token has not been scanned yet. Strict mode needs a scan.',
    errors: {
      BadPair: 'There is no PotatoSwap pool for this token and OKB, or this address is not a token.',
      NoCode: 'This address has no contract code, so it is not a token.',
      TooLittle: 'This amount buys nothing, or less than the minimum you set. Try a larger amount.',
      SwapFailed: 'The pool refused to sell this token. The token blocks buys.',
      TransferFailed: 'The token refused a transfer or balance check, so it cannot be traded safely.',
      LowGas: 'Not enough gas for the sell test. ExitProof needs about 3.5 million gas.',
      Locked: 'The router was called again while it was busy. The token tried to reenter.',
      Expired: 'The deadline passed before the transaction was mined, so it reverted; only the gas is spent.',
      BadMode: 'Unknown mode.',
      BadTo: 'Invalid receiving address.',
      BadAmount: 'The amount does not match the OKB sent.',
      BadEval: 'The circuit gave an invalid answer, so the router refused.',
      BadConfig: 'Router configuration error.',
      NotSelf: 'Internal probe call was rejected.',
      empty: 'The check failed without a reason. The token likely breaks the buy itself. Treat it as unsafe.',
      other: 'The check failed ({name}). Treat this token as unsafe.',
    },
    cannotLead: 'ExitProof could not complete the buy, so you could not have bought this safely.',
  },
  tr: {
    tagline: 'Satamayacağın şeyi alma.',
    lede: 'ExitProof tokeni satın alır ve aynı işlemde tamamını geri satmayı dener. X Layer üzerindeki bir TapeOut devresi sonucu okur. Devre hayır derse alım geri döner; sadece gas harcanır.',
    tokenLabel: 'Token adresi',
    tokenHint: 'PotatoSwap\'ta OKB havuzu olan bir token.',
    modeLabel: 'Alım modu',
    mode_strict: 'Sıkı',
    mode_balanced: 'Dengeli',
    mode_permissive: 'Esnek',
    modeHint_strict: 'Sadece temiz tokenler: vergi yok, aktif sahip yok, ExitProof taramasından geçmiş.',
    modeHint_balanced: 'Satılabilir, düşük vergili, yükseltilemez ve tehlikeli yetkileri olan aktif sahibi yok.',
    modeHint_permissive: 'Varsayılan. Çıkış kanıtı: tamamını şu an geri satabilirsin ve vergi %15\'in altında. Sahip riskleri uyarı olarak gösterilir.',
    amountLabel: 'Miktar (OKB)',
    check: 'Ücretsiz kontrol et',
    checking: 'Simülasyonda alınıp geri satılıyor…',
    checkNote: 'Ücretsiz. Simülasyon olarak çalışır, hiçbir şey gönderilmez, cüzdan gerekmez.',
    demoTokens: 'Bir demo token dene',
    allowTitle: 'Çıkabilirsin',
    denyTitle: 'Çıkış kapalı',
    policyTitle: 'Şu an satılıyor ama riskli',
    cannotTitle: 'Güvenle alınamaz',
    allowBody: 'ExitProof bu tokeni aldı ve simülasyonda tamamını geri sattı. Devre {mode} modda bu alıma izin veriyor.',
    denyBody: 'ExitProof üzerinden alırsan alım geri döner; sadece gas harcanır.',
    policyBody: 'Tamamını geri satmak işe yaradı, ama {mode} mod bu riski kabul etmiyor. Bu modda ExitProof üzerinden alım geri döner; sadece gas harcanır.',
    policyLooser: 'Yukarıdaki riski kabul edersen Esnek mod izin verirdi.',
    youGet: 'Cüzdanına gelecek',
    sellBack: 'Hemen tamamını geri satarsan dönen',
    hopLoss: 'Token, cüzdanına giden son adımda {pct} kesti. Bu kayıp alış vergisine sayılır.',
    reasonPrefix: 'Sebep {n}',
    route: 'Simülasyonda ne oldu',
    step_buy: 'PotatoSwap havuzundan alındı',
    step_sell: 'Yeni bir cüzdana verildi ve tamamı geri satıldı',
    step_sellTax: 'Satış vergisi',
    step_buyTax: 'Alış vergisi',
    step_owner: 'Sahip',
    step_upg: 'Kod değiştirilebilir',
    step_danger: 'Tehlikeli sahip yetkileri',
    step_scan: 'ExitProof tarayıcısı kontrol etti',
    step_circuit: 'TapeOut devre kararı',
    yes: 'evet', no: 'hayır',
    fact_sellOk_1: 'Pozisyonun tamamı geri satıldı.',
    fact_sellOk_0: 'Pozisyonun tamamını geri satmak başarısız oldu.',
    fact_tax: 'Ölçülen: {range}.',
    fact_buyTax: 'Ölçülen: {range}, cüzdanına giden adım dahil.',
    fact_owner_1: 'Bu tokeni hâlâ biri kontrol ediyor (sahip ya da yetkili rol).',
    fact_owner_0: 'Aktif sahip bulunamadı.',
    fact_upg_1: 'Token kodunu sonradan değiştirebilir (proxy veya delegatecall).',
    fact_upg_0: 'Kod sabit, yükseltilemez.',
    fact_danger_1: 'Sahip vergiyi değiştirebilir, cüzdanları engelleyebilir ya da alım satımı durdurabilir.',
    fact_danger_0: 'Bilinen tehlikeli sahip yetkisi yok.',
    fact_scan_1: 'Henüz taranmadı, gizli sahip yetkileri bilinmiyor.',
    fact_scan_0: 'Tarandı. Kayıtta bu tokenin kaydı var.',
    fact_circuit_allow: '{mode} modda izin verildi.',
    fact_circuit_deny: '{mode} modda reddedildi.',
    advTitle: 'Sahip riski uyarısı',
    advBody: 'Yukarıdaki karar çıkış kanıtıdır (esnek mod). Dengeli ve sıkı modlar ayrıca sahibi, yükseltmeleri ve taramayı değerlendirir. Alımın burada seçtiğin modu kullanır.',
    advAllows: '{mode}: izin veriyor',
    advBlocks: '{mode}: engelliyor',
    advExitProof: 'Çıkış kanıtı: pozisyonun tamamı şu an geri satılıyor ve vergi sınırlar içinde.',
    advNoRisk: 'Bu modun itiraz ettiği bir sahip riski yok.',
    advReason: '{text} (sebep {n})',
    advUse: '{Mode} modda al',
    advInUse: 'Alım modu',
    buyModeLine: 'Alım modu: {mode}. Router, işleminin içinde kontrolü bu modda yeniden çalıştırır.',
    buyModeBlocked: '{mode} mod bu alımı engelliyor: {reason} Yukarıdan başka bir alım modu seç ya da alma.',
    openExplorer: 'Bu bilgileri devre gezgininde tekrar oynat',
    copyLink: 'Bu kontrolün bağlantısını kopyala',
    copied: 'Bağlantı kopyalandı.',
    buyTitle: 'ExitProof üzerinden al',
    buyBody: 'Aynı kontrol gerçek işleminin içinde tekrar çalışır. Bir şey değiştiyse alım geri döner; sadece gas harcanır.',
    connect: 'Cüzdanı bağla',
    connected: 'Bağlı: {addr}',
    buy: 'Bu tokenden {amount} OKB\'lik al',
    buying: 'Cüzdanın bekleniyor…',
    bought: 'Alındı. Gelen miktar: {out}.',
    buyBlocked: 'ExitProof bu alımı engelliyor: {reason}',
    buyNeedsCheck: 'Önce alıma izin veren bir kontrol çalıştır.',
    noWallet: 'Tarayıcı cüzdanı bulunamadı. Almak için OKX Wallet veya MetaMask kur. Kontroller cüzdansız çalışır.',
    wrongChain: 'Cüzdanını X Layer ağına (zincir 196) geçir. Hiçbir şey gönderilmedi.',
    routerMissing: 'Cüzdanının ağında bu adreste ExitProof router yok. Hiçbir şey gönderilmedi.',
    buyDisabled: 'Bu ağda alım kapalı.',
    buyOffFork: 'Yerel fork üzerinde alım kapalı: gerçek X Layer\'daki bir cüzdan OKB\'yi sadece fork\'ta var olan bir adrese gönderirdi. Yukarıdaki kontrol yine de birebir doğru.',
    notDeployed: 'ExitProof bu ağda henüz kurulu değil. Kontrolleri denemek için ağı Yerel fork yap; orada tarayıcıdan alım kapalı.',
    notDeployedShort: 'ExitProof bu ağda henüz kurulu değil.',
    statsTitle: 'Başlangıçtan beri',
    statsBody: 'Router ve kayıt sözleşmesi kurulduğundan beri zincirden okunan toplamlar. Engellenen alımlar geri döndüğü için burada görünmez.',
    stat_tokens: 'Taranan token',
    stat_flagged: 'Tarayıcının işaretlediği',
    stat_buys: 'Korumalı alım',
    stat_okb: 'Yönlendirilen OKB',
    statsSince: '{from} numaralı bloktan beri, {to} numaralı bloka kadar sayıldı.',
    statsCatchup: '{from} numaralı bloktan sayılıyor: %{pct} tamam.',
    statsLoading: 'Zincir okunuyor…',
    recentTitle: 'Zincirdeki son olaylar',
    feedEmpty: 'Henüz alım ya da tarayıcı kararı yok.',
    feedChecked: 'Korumalı alım',
    feedAttested: 'Tarayıcı kararı',
    feedNoFlags: 'tehlikeli işaret yok',
    block: 'blok {n}',
    flags: { privileged: 'sahip yetkileri', upgradeable: 'yükseltilebilir kod', dangerSetter: 'vergi veya kara liste anahtarları', ownerCanTrap: 'sahip tutucuları kilitleyebilir' },
    circuitAllow: 'izin', circuitDeny: 'ret',
    pairsTitle: 'PotatoSwap\'ta yeni',
    pairsBody: 'En yeni OKB havuzları ve ExitProof tarayıcısının kayıtları. Canlı testin tamamı için Kontrol et\'e bas.',
    pairsLoading: 'En yeni havuzlar okunuyor…',
    pairsEmpty: 'OKB havuzu bulunamadı.',
    pairScanned: 'tarandı, tehlikeli işaret yok',
    pairFlagged: 'işaretli: {flags}',
    pairUnscanned: 'henüz taranmadı',
    pairCheck: 'Kontrol et',
    pairNo: 'havuz #{n}',
    xTitle: 'Devre gezgini',
    xBody: 'Politika çipinin 11 giriş telini değiştir. Cevap canlı olarak zincirdeki TapeOut işlemcisinden gelir, yanında yerel doğruluk tablosu.',
    xMode: 'Mod',
    xInput: 'Giriş',
    xChain: 'Zincirde',
    xLocal: 'Doğruluk tablosu',
    xMatch: 'eşleşiyor',
    xMismatch: 'eşleşmiyor',
    xPending: 'çipe soruluyor…',
    xOffline: 'bu ağda kurulu değil, sadece doğruluk tablosu',
    xError: 'çip çağrısı başarısız: {msg}',
    xProcessor: 'İşlemci {addr}, devre #{id}',
    xBits: { sellOk: 'geri satıldı', sellTax: 'satış vergisi', buyTax: 'alış vergisi', ownerActive: 'sahip', upgradeable: 'yükseltme', danger: 'tehlike', unscanned: 'taranmadı', mode: 'mod' },
    localTitle: 'Burada yaptığın kontroller',
    localEmpty: 'Kontrollerin burada görünür. Bu tarayıcıda kalırlar.',
    network: 'Ağ',
    netFork: 'Yerel fork',
    netXlayer: 'X Layer',
    slippage: 'Kayma',
    badAddress: 'Bu bir token adresi değil. 0x ile başlayıp 40 karakter daha içermeli.',
    rpcDown: '{rpc} adresine ulaşılamadı. Bu bir bağlantı sorunu, token hakkında bir karar değil.',
    howTitle: 'Kontrol nasıl çalışır',
    how1: 'OKB\'n PotatoSwap\'ta tokeni alır ve tokenler cüzdanına gider.',
    how2: 'Yepyeni bir cüzdan aynı tokenleri alır ve hepsini geri satar.',
    how3: 'Vergiler ve sahip yetkileri ölçülür, ExitProof kaydından okunur.',
    how4: 'X Layer\'da üretilmiş bir NAND devresi karar verir. Hayır cevabı tüm işlemi geri alır; sadece gas harcanır.',
    footer: 'Sözleşmelerin sahibi ve yöneticisi yok. Yatırım tavsiyesi değildir: ExitProof tokenin şu an bu router üzerinden satılabildiğini kanıtlar.',
    contracts: 'Sözleşmeler',
    reasons: {
      1: 'Alabilirdin ama tamamını geri satamazdın.',
      2: 'Satış vergisi bu mod için çok yüksek.',
      3: 'Alış vergisi bu mod için çok yüksek.',
      4: 'Token, sen aldıktan sonra kodunu değiştirebilir.',
      5: 'Sahibin elinde tokenlerini sonradan kilitleyebilecek yetkiler var, örneğin vergiyi yükseltmek.',
      6: 'Token taranmamış ve aktif bir sahibi var.',
      7: 'Aktif bir sahip var. Sıkı mod sadece sahipsiz tokenlere izin verir.',
    },
    reasonsStrict6: 'Token henüz taranmadı. Sıkı mod tarama ister.',
    errors: {
      BadPair: 'Bu token ile OKB için PotatoSwap havuzu yok ya da bu adres bir token değil.',
      NoCode: 'Bu adreste sözleşme kodu yok, yani bir token değil.',
      TooLittle: 'Bu miktarla hiçbir şey ya da belirlediğin asgariden azı alınıyor. Daha büyük bir miktar dene.',
      SwapFailed: 'Havuz bu tokeni satmayı reddetti. Token alımları engelliyor.',
      TransferFailed: 'Token bir transferi ya da bakiye sorgusunu reddetti, güvenle alınıp satılamaz.',
      LowGas: 'Satış testi için yeterli gas yok. ExitProof yaklaşık 3,5 milyon gas ister.',
      Locked: 'Router meşgulken tekrar çağrıldı. Token yeniden girmeye çalıştı.',
      Expired: 'İşlem onaylanmadan süre doldu, bu yüzden geri döndü; sadece gas harcanır.',
      BadMode: 'Bilinmeyen mod.',
      BadTo: 'Geçersiz alıcı adresi.',
      BadAmount: 'Miktar gönderilen OKB ile uyuşmuyor.',
      BadEval: 'Devre geçersiz bir cevap verdi, router reddetti.',
      BadConfig: 'Router yapılandırma hatası.',
      NotSelf: 'Dahili test çağrısı reddedildi.',
      empty: 'Kontrol sebepsiz başarısız oldu. Token büyük ihtimalle alımı kendisi bozuyor. Güvensiz say.',
      other: 'Kontrol başarısız oldu ({name}). Bu tokeni güvensiz say.',
    },
    cannotLead: 'ExitProof alımı tamamlayamadı, yani bu tokeni güvenle alamazdın.',
  },
  zh: {
    tagline: '卖不掉的，就别买。',
    lede: 'ExitProof 会先买入代币，并在同一笔交易里尝试把它全部卖回。X Layer 上的 TapeOut 电路读取结果。电路说不行，这笔买入就会回滚，你只花掉 gas。',
    tokenLabel: '代币地址',
    tokenHint: '在 PotatoSwap 上有 OKB 池子的代币。',
    modeLabel: '买入模式',
    mode_strict: '严格',
    mode_balanced: '平衡',
    mode_permissive: '宽松',
    modeHint_strict: '只放行干净的代币：无税、无活跃所有者、已经过 ExitProof 扫描。',
    modeHint_balanced: '能卖出、税低、合约不可升级，且没有握有危险权限的活跃所有者。',
    modeHint_permissive: '默认模式。退出证明：此刻可以全部卖回，且税率低于 15%。所有者风险以提示形式显示。',
    amountLabel: '金额（OKB）',
    check: '免费检测',
    checking: '正在模拟买入并卖回…',
    checkNote: '免费。以模拟方式运行，不发送任何交易，也不需要钱包。',
    demoTokens: '试试演示代币',
    allowTitle: '可以安全退出',
    denyTitle: '无法退出',
    policyTitle: '现在能卖，但有风险',
    cannotTitle: '无法安全买入',
    allowBody: 'ExitProof 在模拟中买入了这个代币，并把它全部卖回。电路在{mode}模式下允许这笔买入。',
    denyBody: '如果通过 ExitProof 买入，这笔交易会回滚，你只花掉 gas。',
    policyBody: '全部卖回是成功的，但{mode}模式不接受这种风险。在这个模式下通过 ExitProof 买入会回滚，你只花掉 gas。',
    policyLooser: '如果你接受上述风险，宽松模式会放行。',
    youGet: '你将收到',
    sellBack: '立刻全部卖回可得',
    hopLoss: '代币在转到你钱包的最后一步扣留了 {pct}。这部分损失计入买入税。',
    reasonPrefix: '原因 {n}',
    route: '模拟过程',
    step_buy: '从 PotatoSwap 池子买入',
    step_sell: '转给一个全新钱包并全部卖回',
    step_sellTax: '卖出税',
    step_buyTax: '买入税',
    step_owner: '所有者',
    step_upg: '代码可被替换',
    step_danger: '危险的所有者开关',
    step_scan: '已经过 ExitProof 扫描',
    step_circuit: 'TapeOut 电路判定',
    yes: '是', no: '否',
    fact_sellOk_1: '整笔仓位已全部卖回。',
    fact_sellOk_0: '整笔仓位无法全部卖回。',
    fact_tax: '实测：{range}。',
    fact_buyTax: '实测：{range}，包括转到你钱包的那一步。',
    fact_owner_1: '仍有人控制这个代币（所有者或特权角色）。',
    fact_owner_0: '未发现活跃的所有者。',
    fact_upg_1: '代币以后可以更换代码（代理合约或 delegatecall）。',
    fact_upg_0: '代码固定，无法升级。',
    fact_danger_1: '所有者可以改税、拉黑钱包或暂停交易。',
    fact_danger_0: '未发现危险的所有者开关。',
    fact_scan_1: '尚未扫描，隐藏的所有者权限未知。',
    fact_scan_0: '已扫描。登记合约里有这个代币的记录。',
    fact_circuit_allow: '{mode}模式下允许。',
    fact_circuit_deny: '{mode}模式下拒绝。',
    advTitle: '所有者风险提示',
    advBody: '上面的结论是退出证明（宽松模式）。平衡和严格模式还会评估所有者、合约升级和扫描结果。买入时使用你在这里选择的模式。',
    advAllows: '{mode}：允许',
    advBlocks: '{mode}：拦截',
    advExitProof: '退出证明：整笔仓位此刻可以全部卖回，且税率在范围内。',
    advNoRisk: '没有此模式会反对的所有者风险。',
    advReason: '{text}（原因 {n}）',
    advUse: '用{mode}模式买入',
    advInUse: '买入模式',
    buyModeLine: '买入模式：{mode}。路由合约会在你的交易中按此模式重新检测。',
    buyModeBlocked: '{mode}模式拦截了这笔买入：{reason}请在上方换一个买入模式，或者不要买。',
    openExplorer: '在电路浏览器中重放这些条件',
    copyLink: '复制本次检测的链接',
    copied: '链接已复制。',
    buyTitle: '通过 ExitProof 买入',
    buyBody: '同样的检测会在你的真实交易中再跑一遍。如果情况有变，买入会回滚，你只花掉 gas。',
    connect: '连接钱包',
    connected: '已连接 {addr}',
    buy: '用 {amount} OKB 买入该代币',
    buying: '等待钱包确认…',
    bought: '买入成功。你收到了 {out}。',
    buyBlocked: 'ExitProof 拦截了这笔买入：{reason}',
    buyNeedsCheck: '请先完成一次允许买入的检测。',
    noWallet: '未检测到浏览器钱包。买入需要安装 OKX Wallet 或 MetaMask。检测不需要钱包。',
    wrongChain: '请把钱包切换到 X Layer（链 ID 196）。没有发送任何交易。',
    routerMissing: '你钱包所在的网络上，这个地址没有 ExitProof 路由合约。没有发送任何交易。',
    buyDisabled: '此网络已关闭买入。',
    buyOffFork: '本地分叉上不能买入：真实 X Layer 上的钱包会把 OKB 发到一个只存在于分叉上的地址。上面的检测结果依然准确。',
    notDeployed: 'ExitProof 尚未部署到这个网络。把网络切换到“本地分叉”即可试用检测；在那里浏览器不能买入。',
    notDeployedShort: 'ExitProof 尚未部署到这个网络。',
    statsTitle: '上线以来',
    statsBody: '自路由合约和登记合约部署以来，从链上读取的累计数据。被拦截的买入会回滚，所以不会出现在这里。',
    stat_tokens: '已扫描代币',
    stat_flagged: '被扫描器标记',
    stat_buys: '受保护的买入',
    stat_okb: '经路由的 OKB',
    statsSince: '自区块 {from} 起，已统计到区块 {to}。',
    statsCatchup: '正在从区块 {from} 开始统计：已完成 {pct}%。',
    statsLoading: '正在读取链上数据…',
    recentTitle: '链上最新动态',
    feedEmpty: '暂时还没有买入或扫描结果。',
    feedChecked: '受保护的买入',
    feedAttested: '扫描结果',
    feedNoFlags: '无危险标记',
    block: '区块 {n}',
    flags: { privileged: '所有者权限', upgradeable: '可升级代码', dangerSetter: '改税或拉黑开关', ownerCanTrap: '所有者可锁住持币人' },
    circuitAllow: '允许', circuitDeny: '拒绝',
    pairsTitle: 'PotatoSwap 新池',
    pairsBody: '最新的 OKB 池子，以及 ExitProof 扫描器的记录。点“检测”运行完整的实时测试。',
    pairsLoading: '正在读取最新池子…',
    pairsEmpty: '没有找到 OKB 池子。',
    pairScanned: '已扫描，无危险标记',
    pairFlagged: '已标记：{flags}',
    pairUnscanned: '尚未扫描',
    pairCheck: '检测',
    pairNo: '第 {n} 号池',
    xTitle: '电路浏览器',
    xBody: '拨动策略芯片的 11 根输入线。答案实时来自链上的 TapeOut 处理器，旁边是本地真值表。',
    xMode: '模式',
    xInput: '输入',
    xChain: '链上',
    xLocal: '真值表',
    xMatch: '一致',
    xMismatch: '不一致',
    xPending: '正在询问芯片…',
    xOffline: '此网络尚未部署，仅显示真值表',
    xError: '芯片调用失败：{msg}',
    xProcessor: '处理器 {addr}，电路 #{id}',
    xBits: { sellOk: '已卖回', sellTax: '卖出税', buyTax: '买入税', ownerActive: '所有者', upgradeable: '可升级', danger: '危险', unscanned: '未扫描', mode: '模式' },
    localTitle: '你在这里做过的检测',
    localEmpty: '你的检测记录会显示在这里，只保存在本浏览器中。',
    network: '网络',
    netFork: '本地分叉',
    netXlayer: 'X Layer',
    slippage: '滑点',
    badAddress: '这不是代币地址。地址应以 0x 开头，后面再跟 40 个字符。',
    rpcDown: '无法连接 {rpc}。这是网络连接问题，不是对代币的判定。',
    howTitle: '检测原理',
    how1: '你的 OKB 在 PotatoSwap 上买入代币，代币转到你的钱包。',
    how2: '一个全新的钱包拿到同样数量的代币，并把它们全部卖回。',
    how3: '测量买卖税，并从 ExitProof 登记合约读取所有者权限。',
    how4: '在 X Layer 上流片的 NAND 电路做出判定。判定为否，整笔交易回滚，你只花掉 gas。',
    footer: '合约没有所有者，也没有管理员。不构成投资建议：ExitProof 证明的是这个代币此刻可以通过本路由卖出。',
    contracts: '合约',
    reasons: {
      1: '你能买入，但无法把它全部卖回。',
      2: '卖出税超过了此模式的上限。',
      3: '买入税超过了此模式的上限。',
      4: '你买入之后，代币可以更换自己的代码。',
      5: '所有者握有日后可以锁住你代币的开关，比如调高税率。',
      6: '代币尚未扫描，而且仍有活跃的所有者。',
      7: '仍有活跃的所有者。严格模式只放行没有所有者的代币。',
    },
    reasonsStrict6: '代币尚未扫描。严格模式要求先扫描。',
    errors: {
      BadPair: '这个代币和 OKB 在 PotatoSwap 上没有池子，或者这个地址不是代币。',
      NoCode: '这个地址上没有合约代码，所以不是代币。',
      TooLittle: '这个金额买不到代币，或少于你设定的最低数量。请试试更大的金额。',
      SwapFailed: '池子拒绝卖出这个代币。该代币阻止买入。',
      TransferFailed: '代币拒绝了一次转账或余额查询，无法安全交易。',
      LowGas: 'gas 不足，无法完成卖出测试。ExitProof 大约需要 350 万 gas。',
      Locked: '路由合约在忙碌时被再次调用。代币试图重入。',
      Expired: '交易上链前已超过截止时间，因此回滚，你只花掉 gas。',
      BadMode: '未知模式。',
      BadTo: '接收地址无效。',
      BadAmount: '金额与发送的 OKB 不一致。',
      BadEval: '电路给出了无效答案，路由合约拒绝执行。',
      BadConfig: '路由合约配置错误。',
      NotSelf: '内部测试调用被拒绝。',
      empty: '检测失败且没有给出原因。很可能是代币本身破坏了买入。请视为不安全。',
      other: '检测失败（{name}）。请把这个代币视为不安全。',
    },
    cannotLead: 'ExitProof 无法完成这笔买入，所以你无法安全地买入它。',
  },
};

export const MODE_LABEL = {
  en: { strict: 'strict', balanced: 'balanced', permissive: 'permissive' },
  tr: { strict: 'sıkı', balanced: 'dengeli', permissive: 'esnek' },
  zh: { strict: '严格', balanced: '平衡', permissive: '宽松' },
};

export function fill(s, vars = {}) {
  return String(s).replace(/\{(\w+)\}/g, (_, k) => (k in vars ? vars[k] : `{${k}}`));
}

/** Plain-language text for a reason code. Reason 6 reads differently in strict mode (any unscanned token). */
export function reasonText(reason, mode, lang = 'en') {
  const S = STRINGS[lang] || STRINGS.en;
  if (Number(reason) === 6 && mode === 'strict') return S.reasonsStrict6;
  return S.reasons[Number(reason)] ?? fill(S.errors.other, { name: `reason ${reason}` });
}

/** Plain-language text for a non-Report router revert (always "cannot buy safely", never "unknown"). */
export function errorText(name, lang = 'en') {
  const E = (STRINGS[lang] || STRINGS.en).errors;
  if (!name) return E.empty;
  return E[name] ?? fill(E.other, { name });
}

/** One row per fact: { key, label, value, text, bad, warn }. */
export function factRows(facts, lang = 'en') {
  const S = STRINGS[lang] || STRINGS.en;
  const d = decodeFacts(facts);
  const T = TAX[lang] || TAX.en;
  return [
    { key: 'sell', label: S.step_sell, bad: !d.sellOk, value: d.sellOk ? S.yes : S.no, text: d.sellOk ? S.fact_sellOk_1 : S.fact_sellOk_0 },
    { key: 'sellTax', label: S.step_sellTax, bad: d.sellTax >= 2, warn: d.sellTax === 1, value: T.short[d.sellTax], text: fill(S.fact_tax, { range: T.long[d.sellTax] }) },
    { key: 'buyTax', label: S.step_buyTax, bad: d.buyTax >= 2, warn: d.buyTax === 1, value: T.short[d.buyTax], text: fill(S.fact_buyTax, { range: T.long[d.buyTax] }) },
    { key: 'owner', label: S.step_owner, warn: d.ownerActive, value: d.ownerActive ? S.yes : S.no, text: d.ownerActive ? S.fact_owner_1 : S.fact_owner_0 },
    { key: 'upg', label: S.step_upg, bad: d.upgradeable, value: d.upgradeable ? S.yes : S.no, text: d.upgradeable ? S.fact_upg_1 : S.fact_upg_0 },
    { key: 'danger', label: S.step_danger, bad: d.danger, value: d.danger ? S.yes : S.no, text: d.danger ? S.fact_danger_1 : S.fact_danger_0 },
    { key: 'scan', label: S.step_scan, warn: d.unscanned, value: d.unscanned ? S.no : S.yes, text: d.unscanned ? S.fact_scan_1 : S.fact_scan_0 },
  ];
}
