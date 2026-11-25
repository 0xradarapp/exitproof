# ExitProof demo video (≤ 3:00)

This is a screen capture with voiceover. The voiceover is in English, and a Turkish translation of every line follows
the table so you can rehearse it. Read slowly: the English voiceover is 289 words. At a calm 150 words a minute that is about 116 s, which leaves room for
pauses inside 3:00. Add captions, because judges often watch muted.

## Before recording

- **Mainnet live (preferred):** after `scripts/tapeout.mjs` and `scripts/deploy.mjs` have run on mainnet, the web app's X Layer network has a router.
  - Have a wallet with about 0.05 OKB.
  - Don't lower the wallet's suggested gas limit. A typical buy needs at least 3.5M available, and the first buy of a very large token up to about 5M.
- **Default network:** the CLI and the agent skill default to `--network xlayer` (mainnet). The fork is only for local demos: pass `--network fork` explicitly, and remember that `tx` is refused there.
- **Fork fallback:** if mainnet is not live yet, start anvil on port 8549 and run the three scripts as in the README (tapeout, deploy, demo-fork). Use the fork's demo tokens. Put a caption "local fork of X Layer mainnet" on every fork scene, and in the voiceover say "on a fork of X Layer mainnet" instead of "on mainnet" (the 1:00 mainnet scan is read-only and stays real).
- **Pick the live dangerous token on recording day.**
  - Run `node scanner/src/cli.mjs scan <token>` (read-only, mainnet RPC) on a few of the newest PotatoSwap pairs. Pick one that comes back `dangerSetter: true` and has a readable selector, such as `setTradingEnabled`.
  - The ledger's example is FUT `0xE204E5e33029023AbB90d16d67D774D89802ec64` (pair #27533). It scans as privileged + dangerSetter (setTradingEnabled, setPool, setTaxRates, setAuthorizedBuyer). On a fork, `simulate` shows the owner can trap holders with `setTradingEnabled(false)`.
  - Don't promise that this exact token is still trading on the day. Re-scan it first.
- Open the tabs in advance:
  1. the web app with `?token=<clean token>&mode=balanced&check=1`
  2. the same with the honeypot (on the fork: BlacklistOnBuy)
  3. a terminal at the repo root, font size ≥ 18
  4. the explorer page of the router and the circuit
- Know the addresses by heart, or keep them in a sticky note: processor, circuit ID, router.

## Script

| Time | On screen | Voiceover (EN) |
|---|---|---|
| 0:00–0:12 | Title card: "ExitProof: don't buy what you can't sell". Then the web app home. | "On X Layer, a honeypot is a token you can buy but never sell. ExitProof checks the way out before your buy is allowed to stand." |
| 0:12–0:35 | Paste a clean token, mode **Balanced**, press **Check**. The green "You can get out" plate appears; scroll slowly down the route stations. | "Paste a token and press Check. ExitProof really buys it on PotatoSwap, hands the tokens to a fresh wallet, and sells all of it back, inside one transaction that is then thrown away. Sell-back worked, taxes are low, no dangerous owner. Green." |
| 0:35–1:00 | Paste the honeypot (fork: BlacklistOnBuy, or a live one found that day). The red "Exit blocked, Reason 1" plate. Point at "sell-back: no, sell tax 50%+". | "Now a honeypot. The buy works, but the sell-back fails. Reason 1: you could buy, but not sell. If you pressed Buy now, the whole transaction would revert, and you would only pay the gas of that reverted transaction." |
| 1:00–1:25 | Terminal: `node scanner/src/cli.mjs scan 0xE204…ec64` (or the token picked that day) against mainnet. Highlight `dangerSetter: true` and `setTradingEnabled(bool)` in the evidence. If mainnet is live, also run `node cli/exitproof.mjs check <token> --network xlayer` and show the reason it actually returns (reason 6 while the token is unscanned with an active owner, reason 5 after the attestation, reason 1 if trading is already off). Don't say a reason number in the voiceover that the screen doesn't show. | "Some tokens sell fine today and trap you tomorrow. This is a real PotatoSwap token on mainnet, right now. Our scanner reads its bytecode: the owner can switch trading off. In a fork simulation, that switch traps every holder. In balanced mode, ExitProof blocks this kind of token." |
| 1:25–1:50 | Web app: the "How the check works" list, then the explorer showing the processor and circuit ID. Flash `2048/2048` from the tape-out log. | "Who decides? Not a Solidity if-statement, but a TapeOut circuit: 54 NAND gates, taped out on our own processor. The router feeds it eleven facts and does what it answers. We checked every one of its 2048 possible inputs on chain." |
| 1:50–2:15 | Connect the wallet and buy 0.01 OKB of the clean token. The wallet popup shows the gas limit (≥ 3.5M). Confirmed; tokens arrive; the feed shows "Allowed buy". | "Buying is the same check, enforced. One transaction: buy, prove the exit, ask the circuit, deliver. The fee is 0.1%, capped at 0.3% forever in the contract." |
| 2:15–2:40 | Terminal: `node cli/exitproof.mjs check <token> --network xlayer` prints JSON with `verdict` and `reason`; then `tx … --wallet <agent>` prints the `onchainos wallet contract-call` line. | "AI agents get the same thing as JSON. Our OKX Agentic Wallet skill checks first, then prepares the buy for the agent's wallet. If the exit check fails, the agent's buy reverts on chain, whatever the agent was told." |
| 2:40–2:55 | README judges table, then the limitations section for a second. | "It's open source, with fork tests on real PotatoSwap pools and a real TapeOut processor. The limits are listed honestly in the README." |
| 2:55–3:00 | End card: the app URL and "ExitProof". | "ExitProof. Don't buy what you can't sell." |

## Voiceover in Turkish (for rehearsal)

| Time | TR |
|---|---|
| 0:00–0:12 | "X Layer'da honeypot, alabildiğin ama asla satamadığın bir token'dır. ExitProof, alımın geçerli olmasına izin vermeden önce çıkış yolunu kontrol eder." |
| 0:12–0:35 | "Token'ı yapıştır, Kontrol Et'e bas. ExitProof onu PotatoSwap'te gerçekten alır, token'ları yeni bir cüzdana verir ve hepsini geri satar; hepsi tek bir işlemin içinde, sonra bu işlem çöpe atılır. Geri satış çalıştı, vergiler düşük, tehlikeli bir owner yok. Yeşil." |
| 0:35–1:00 | "Şimdi bir honeypot. Alım çalışıyor ama geri satış başarısız. Sebep 1: alabilirdin ama satamazdın. Şimdi Satın Al'a bassaydın, işlemin tamamı geri alınırdı ve yalnızca geri alınan işlemin gas'ını öderdin." |
| 1:00–1:25 | "Bazı token'lar bugün sorunsuz satılır, yarın seni kapana kıstırır. Bu, şu anda mainnet'te olan gerçek bir PotatoSwap token'ı. Scanner'ımız bytecode'unu okuyor: owner alım satımı kapatabiliyor. Fork simülasyonunda bu anahtar bütün sahipleri kapana kıstırıyor. Balanced modda ExitProof bu tür token'ları engeller." |
| 1:25–1:50 | "Kararı kim veriyor? Bir Solidity if'i değil, bir TapeOut devresi: kendi işlemcimizde üretilmiş 54 NAND kapısı. Router ona on bir bilgi veriyor ve verdiği cevaba uyuyor. Devrenin 2048 olası girdisinin hepsini zincir üstünde kontrol ettik." |
| 1:50–2:15 | "Satın almak da aynı kontrol, ama zorunlu. Tek işlem: al, çıkışı kanıtla, devreye sor, teslim et. Ücret yüzde 0,1; sözleşmede sonsuza kadar en fazla yüzde 0,3." |
| 2:15–2:40 | "Yapay zekâ ajanları aynı şeyi JSON olarak alır. OKX Agentic Wallet becerimiz önce kontrol eder, sonra alımı ajanın cüzdanı için hazırlar. Çıkış kontrolü başarısız olursa, ajana ne söylenmiş olursa olsun, ajanın alımı zincir üstünde geri alınır." |
| 2:40–2:55 | "Açık kaynak; gerçek PotatoSwap havuzları ve gerçek bir TapeOut işlemcisiyle fork testleri var. Sınırlar README'de dürüstçe yazılı." |
| 2:55–3:00 | "ExitProof. Satamayacağın şeyi alma." |

## Recording notes

- **Mainnet scan at 1:00.** It is read-only and costs nothing. If the RPC is slow, pre-run the command and scroll back to its output instead of waiting on camera.
- **On the fork,** the web app hides Buy (`buyEnabled: false`) on purpose. For the 1:50 scene on the fork, show the CLI buy instead (`EXITPROOF_KEY=<anvil #3> node cli/exitproof.mjs buy <clean> --network fork --yes`), or record that scene after the mainnet deploy.
- **Don't show the honeypot "Buy" being pressed with real funds.** The check already shows the revert reason, and an on-chain revert costs only gas, but there's no need to spend it on camera.
- **Final length:** trim pauses to land under 3:00. The form rejects videos longer than 3 minutes.
