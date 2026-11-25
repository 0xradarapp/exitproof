// ExitProof shared verdict logic: fact decoding, reason codes, router error explanations, EN/TR strings.
// Plain ES module with no dependencies, so the browser (web/app.js) and Node (cli/exitproof.mjs) both import it.

/** True only for an exact loopback hostname: 127.a.b.c, localhost or [::1] (URL keeps the brackets for IPv6). */
export function isLoopbackHost(host) {
  return /^(127(\.\d{1,3}){3}|localhost|\[::1\])$/.test(String(host).toLowerCase());
}
export function isLoopbackUrl(url) {
  try { return isLoopbackHost(new URL(url).hostname); } catch { return false; }
}

export const MODES = { strict: 0, balanced: 1, permissive: 2 };
export const MODE_NAMES = ['strict', 'balanced', 'permissive', 'strict'];

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

export const TAX_RANGE = ['under 5%', '5-15%', '15-50%', '50% or more, or could not be measured'];
const TAX_RANGE_TR = ['%5 altı', '%5-15', '%15-50', '%50 veya üstü ya da ölçülemedi'];
const TAX_SHORT = ['under 5%', '5-15%', '15-50%', '50%+'];
const TAX_SHORT_TR = ['%5 altı', '%5-15', '%15-50', '%50+'];

/** Router custom errors we may meet, by name. Report and Blocked carry a verdict; the rest mean "cannot buy". */
export const ROUTER_ERRORS = [
  'error Blocked(uint8 reason, uint16 facts)',
  'error Report(uint16 facts, bool allow, uint8 reason, uint256 buyOut, uint256 sellOut)',
  'error BadPair()', 'error Expired()', 'error TooLittle()', 'error BadEval()', 'error BadConfig()',
  'error BadMode()', 'error BadTo()', 'error BadAmount()', 'error NotSelf()', 'error LowGas()', 'error Locked()',
  'error TransferFailed()', 'error SwapFailed()',
];

export const STRINGS = {
  en: {
    tagline: "Don't buy what you can't sell.",
    lede: 'ExitProof buys the token and tries to sell all of it back in the same transaction. A TapeOut circuit on X Layer reads the result. If it says no, the whole buy is undone and your OKB never leaves your wallet.',
    tokenLabel: 'Token address',
    tokenHint: 'A token with an OKB pool on PotatoSwap.',
    modeLabel: 'How careful',
    mode_strict: 'Strict',
    mode_balanced: 'Balanced',
    mode_permissive: 'Permissive',
    modeHint_strict: 'Only clean tokens: no tax, no active owner, scanned by ExitProof.',
    modeHint_balanced: 'Sellable, low tax, not upgradeable, and no active owner with dangerous powers.',
    modeHint_permissive: 'Only asks: can you sell it all back, and is the tax under 15%?',
    amountLabel: 'Amount (OKB)',
    check: 'Check for free',
    checking: 'Buying and selling back in a simulation…',
    checkNote: 'Free. Runs as a simulation, nothing is sent and no wallet is needed.',
    demoTokens: 'Try a demo token',
    allowTitle: 'You can get out',
    denyTitle: 'Exit blocked',
    cannotTitle: 'Cannot buy safely',
    allowBody: 'ExitProof bought this token and sold all of it back in a simulation. The circuit allows this buy in {mode} mode.',
    denyBody: 'If you buy through ExitProof, the transaction reverts and your OKB stays with you.',
    youGet: 'You would get',
    sellBack: 'Selling it all back right away returns',
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
    fact_owner_1: 'Someone still controls this token (an owner or a privileged role).',
    fact_owner_0: 'No active owner found.',
    fact_upg_1: 'The token can change its code later (proxy or delegatecall).',
    fact_upg_0: 'Fixed code, it cannot be upgraded.',
    fact_danger_1: 'The owner can change fees, block wallets or stop trading.',
    fact_danger_0: 'No dangerous owner switches known.',
    fact_scan_1: 'Not scanned yet, so hidden owner powers are unknown.',
    fact_scan_0: 'Scanned. The registry has an entry for this exact code.',
    fact_circuit_allow: 'Allowed in {mode} mode.',
    fact_circuit_deny: 'Denied in {mode} mode.',
    buyTitle: 'Buy through ExitProof',
    buyBody: 'The same check runs again inside your real transaction. If anything changed, it reverts and nothing moves.',
    connect: 'Connect wallet',
    connected: 'Connected {addr}',
    buy: 'Buy {amount} OKB of this token',
    buying: 'Waiting for your wallet…',
    bought: 'Bought. You received {out}.',
    buyBlocked: 'Blocked by ExitProof before anything moved: {reason}',
    buyNeedsCheck: 'Run a check that allows the buy first.',
    noWallet: 'No browser wallet found. Install OKX Wallet or MetaMask to buy. Checks work without one.',
    wrongChain: 'Switch your wallet to X Layer (chain 196). Nothing was sent.',
    routerMissing: 'Your wallet\'s network has no ExitProof router at this address. Nothing was sent.',
    buyDisabled: 'Buying is switched off for this network.',
    buyOffFork: 'Buying is off on the local fork: a wallet on real X Layer would send OKB to an address that only exists on the fork. The check above is still exact.',
    pending: 'Mainnet deployment pending. Switch the network to Local fork to try checks; buying there is off in the browser.',
    feedTitle: 'On chain right now',
    feedBody: 'Allowed buys through ExitProof and fresh scanner verdicts. Blocked buys revert, so they never show up here.',
    feedEmpty: 'Nothing in the last {n} blocks.',
    feedLoading: 'Reading recent blocks…',
    feedChecked: 'Allowed buy',
    feedAttested: 'Scanner verdict',
    feedNoFlags: 'no dangerous flags',
    flags: { privileged: 'owner powers', upgradeable: 'upgradeable code', dangerSetter: 'fee or blacklist switches', ownerCanTrap: 'owner can trap holders' },
    circuitAllow: 'allow', circuitDeny: 'deny',
    localTitle: 'Checks you ran here',
    localEmpty: 'Your checks show up here. They stay in this browser.',
    network: 'Network',
    netFork: 'Local fork',
    netXlayer: 'X Layer',
    slippage: 'Slippage',
    badAddress: 'That is not a token address. It should start with 0x and have 40 more characters.',
    rpcDown: 'Could not reach {rpc}. This is a connection problem, not a verdict on the token.',
    howTitle: 'How the check works',
    how1: 'Your OKB buys the token on PotatoSwap.',
    how2: 'The tokens move to a brand-new wallet, which sells every one of them back.',
    how3: 'Taxes and owner powers are measured and read from the ExitProof registry.',
    how4: 'A NAND circuit taped out on X Layer decides. A no reverts the whole transaction.',
    footer: 'Contracts have no owner and no admin. Not financial advice: ExitProof proves the token sells now, through this router.',
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
      TooLittle: 'This amount buys nothing, or less than the minimum you set. Try a larger amount.',
      SwapFailed: 'The pool refused to sell this token. The token blocks buys.',
      TransferFailed: 'The token refused a transfer or balance check, so it cannot be traded safely.',
      LowGas: 'Not enough gas for the sell test. ExitProof needs about 3.5 million gas.',
      Locked: 'The router was called again while it was busy. The token tried to reenter.',
      Expired: 'The deadline passed before the transaction was mined. Nothing moved.',
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
    lede: 'ExitProof tokeni satın alır ve aynı işlemde tamamını geri satmayı dener. X Layer üzerindeki bir TapeOut devresi sonucu okur. Devre hayır derse alım tamamen geri alınır ve OKB\'n cüzdanından hiç çıkmaz.',
    tokenLabel: 'Token adresi',
    tokenHint: 'PotatoSwap\'ta OKB havuzu olan bir token.',
    modeLabel: 'Ne kadar dikkatli',
    mode_strict: 'Sıkı',
    mode_balanced: 'Dengeli',
    mode_permissive: 'Esnek',
    modeHint_strict: 'Sadece temiz tokenler: vergi yok, aktif sahip yok, ExitProof taramasından geçmiş.',
    modeHint_balanced: 'Satılabilir, düşük vergili, yükseltilemez ve tehlikeli yetkileri olan aktif sahibi yok.',
    modeHint_permissive: 'Sadece sorar: tamamını geri satabilir misin ve vergi %15\'in altında mı?',
    amountLabel: 'Miktar (OKB)',
    check: 'Ücretsiz kontrol et',
    checking: 'Simülasyonda alınıp geri satılıyor…',
    checkNote: 'Ücretsiz. Simülasyon olarak çalışır, hiçbir şey gönderilmez, cüzdan gerekmez.',
    demoTokens: 'Bir demo token dene',
    allowTitle: 'Çıkabilirsin',
    denyTitle: 'Çıkış kapalı',
    cannotTitle: 'Güvenle alınamaz',
    allowBody: 'ExitProof bu tokeni aldı ve simülasyonda tamamını geri sattı. Devre {mode} modda bu alıma izin veriyor.',
    denyBody: 'ExitProof üzerinden alırsan işlem geri döner ve OKB\'n sende kalır.',
    youGet: 'Alacağın miktar',
    sellBack: 'Hemen tamamını geri satarsan dönen',
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
    fact_owner_1: 'Bu tokeni hâlâ biri kontrol ediyor (sahip ya da yetkili rol).',
    fact_owner_0: 'Aktif sahip bulunamadı.',
    fact_upg_1: 'Token kodunu sonradan değiştirebilir (proxy veya delegatecall).',
    fact_upg_0: 'Kod sabit, yükseltilemez.',
    fact_danger_1: 'Sahip vergiyi değiştirebilir, cüzdanları engelleyebilir ya da alım satımı durdurabilir.',
    fact_danger_0: 'Bilinen tehlikeli sahip yetkisi yok.',
    fact_scan_1: 'Henüz taranmadı, gizli sahip yetkileri bilinmiyor.',
    fact_scan_0: 'Tarandı. Kayıtta bu kodun kaydı var.',
    fact_circuit_allow: '{mode} modda izin verildi.',
    fact_circuit_deny: '{mode} modda reddedildi.',
    buyTitle: 'ExitProof üzerinden al',
    buyBody: 'Aynı kontrol gerçek işleminin içinde tekrar çalışır. Bir şey değiştiyse işlem geri döner ve hiçbir şey hareket etmez.',
    connect: 'Cüzdanı bağla',
    connected: 'Bağlı: {addr}',
    buy: 'Bu tokenden {amount} OKB\'lik al',
    buying: 'Cüzdanın bekleniyor…',
    bought: 'Alındı. Gelen miktar: {out}.',
    buyBlocked: 'ExitProof hiçbir şey hareket etmeden engelledi: {reason}',
    buyNeedsCheck: 'Önce alıma izin veren bir kontrol çalıştır.',
    noWallet: 'Tarayıcı cüzdanı bulunamadı. Almak için OKX Wallet veya MetaMask kur. Kontroller cüzdansız çalışır.',
    wrongChain: 'Cüzdanını X Layer ağına (zincir 196) geçir. Hiçbir şey gönderilmedi.',
    routerMissing: 'Cüzdanının ağında bu adreste ExitProof router yok. Hiçbir şey gönderilmedi.',
    buyDisabled: 'Bu ağda alım kapalı.',
    buyOffFork: 'Yerel fork üzerinde alım kapalı: gerçek X Layer\'daki bir cüzdan OKB\'yi sadece fork\'ta var olan bir adrese gönderirdi. Yukarıdaki kontrol yine de birebir doğru.',
    pending: 'Ana ağ dağıtımı bekleniyor. Kontrolleri denemek için ağı Yerel fork yap; orada tarayıcıdan alım kapalı.',
    feedTitle: 'Şu an zincirde',
    feedBody: 'ExitProof üzerinden izin verilen alımlar ve yeni tarayıcı kararları. Engellenen alımlar geri döndüğü için burada görünmez.',
    feedEmpty: 'Son {n} blokta bir şey yok.',
    feedLoading: 'Son bloklar okunuyor…',
    feedChecked: 'İzin verilen alım',
    feedAttested: 'Tarayıcı kararı',
    feedNoFlags: 'tehlikeli işaret yok',
    flags: { privileged: 'sahip yetkileri', upgradeable: 'yükseltilebilir kod', dangerSetter: 'vergi veya kara liste anahtarları', ownerCanTrap: 'sahip tutucuları kilitleyebilir' },
    circuitAllow: 'izin', circuitDeny: 'ret',
    localTitle: 'Burada yaptığın kontroller',
    localEmpty: 'Kontrollerin burada görünür. Bu tarayıcıda kalırlar.',
    network: 'Ağ',
    netFork: 'Yerel fork',
    netXlayer: 'X Layer',
    slippage: 'Kayma',
    badAddress: 'Bu bir token adresi değil. 0x ile başlayıp 40 karakter daha içermeli.',
    rpcDown: '{rpc} adresine ulaşılamadı. Bu bir bağlantı sorunu, token hakkında bir karar değil.',
    howTitle: 'Kontrol nasıl çalışır',
    how1: 'OKB\'n PotatoSwap\'ta tokeni alır.',
    how2: 'Tokenler yepyeni bir cüzdana geçer ve o cüzdan hepsini geri satar.',
    how3: 'Vergiler ve sahip yetkileri ölçülür, ExitProof kaydından okunur.',
    how4: 'X Layer\'da üretilmiş bir NAND devresi karar verir. Hayır cevabı tüm işlemi geri alır.',
    footer: 'Sözleşmelerin sahibi ve yöneticisi yok. Yatırım tavsiyesi değildir: ExitProof tokenin şu an bu router üzerinden satılabildiğini kanıtlar.',
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
      TooLittle: 'Bu miktarla hiçbir şey ya da belirlediğin asgariden azı alınıyor. Daha büyük bir miktar dene.',
      SwapFailed: 'Havuz bu tokeni satmayı reddetti. Token alımları engelliyor.',
      TransferFailed: 'Token bir transferi ya da bakiye sorgusunu reddetti, güvenle alınıp satılamaz.',
      LowGas: 'Satış testi için yeterli gas yok. ExitProof yaklaşık 3,5 milyon gas ister.',
      Locked: 'Router meşgulken tekrar çağrıldı. Token yeniden girmeye çalıştı.',
      Expired: 'İşlem onaylanmadan süre doldu. Hiçbir şey hareket etmedi.',
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
};

export const MODE_LABEL = {
  en: { strict: 'strict', balanced: 'balanced', permissive: 'permissive' },
  tr: { strict: 'sıkı', balanced: 'dengeli', permissive: 'esnek' },
};

export function fill(s, vars = {}) {
  return String(s).replace(/\{(\w+)\}/g, (_, k) => (k in vars ? vars[k] : `{${k}}`));
}

/** Plain-language text for a reason code. Reason 6 reads differently in strict mode (any unscanned token). */
export function reasonText(reason, mode, lang = 'en') {
  const S = STRINGS[lang];
  if (Number(reason) === 6 && mode === 'strict') return S.reasonsStrict6;
  return S.reasons[Number(reason)] ?? fill(S.errors.other, { name: `reason ${reason}` });
}

/** Plain-language text for a non-Report router revert (always "cannot buy safely", never "unknown"). */
export function errorText(name, lang = 'en') {
  const E = STRINGS[lang].errors;
  if (!name) return E.empty;
  return E[name] ?? fill(E.other, { name });
}

/** One row per fact: { key, label, value, text, bad }. */
export function factRows(facts, lang = 'en') {
  const S = STRINGS[lang];
  const d = decodeFacts(facts);
  const range = lang === 'tr' ? TAX_RANGE_TR : TAX_RANGE;
  const shortR = lang === 'tr' ? TAX_SHORT_TR : TAX_SHORT;
  return [
    { key: 'sell', label: S.step_sell, bad: !d.sellOk, value: d.sellOk ? S.yes : S.no, text: d.sellOk ? S.fact_sellOk_1 : S.fact_sellOk_0 },
    { key: 'sellTax', label: S.step_sellTax, bad: d.sellTax >= 2, warn: d.sellTax === 1, value: shortR[d.sellTax], text: fill(S.fact_tax, { range: range[d.sellTax] }) },
    { key: 'buyTax', label: S.step_buyTax, bad: d.buyTax >= 2, warn: d.buyTax === 1, value: shortR[d.buyTax], text: fill(S.fact_tax, { range: range[d.buyTax] }) },
    { key: 'owner', label: S.step_owner, warn: d.ownerActive, value: d.ownerActive ? S.yes : S.no, text: d.ownerActive ? S.fact_owner_1 : S.fact_owner_0 },
    { key: 'upg', label: S.step_upg, bad: d.upgradeable, value: d.upgradeable ? S.yes : S.no, text: d.upgradeable ? S.fact_upg_1 : S.fact_upg_0 },
    { key: 'danger', label: S.step_danger, bad: d.danger, value: d.danger ? S.yes : S.no, text: d.danger ? S.fact_danger_1 : S.fact_danger_0 },
    { key: 'scan', label: S.step_scan, warn: d.unscanned, value: d.unscanned ? S.no : S.yes, text: d.unscanned ? S.fact_scan_1 : S.fact_scan_0 },
  ];
}
