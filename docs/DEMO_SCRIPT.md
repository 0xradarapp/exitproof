# ExitProof demo video (≤ 3:00)

A screen capture with voiceover, in six scenes. The voiceover is in English; a Turkish translation follows the table
so you can rehearse it. Read slowly: the English voiceover is 292 words (count it again after any edit), about
117 s at a calm 150 words a minute, which leaves room for pauses inside 3:00. Add captions, because judges often
watch muted.

## Before recording

- **Mainnet live (preferred):** after `scripts/tapeout.mjs` and `scripts/deploy.mjs` have run on mainnet, the web
  app's X Layer network has a router. Have a wallet with about 0.05 OKB. Don't lower the wallet's suggested gas limit.
- **Fork fallback:** if mainnet is not live yet, run the fork as in the README ("Web app against the fork"), but fork
  the **latest** block (drop `--fork-block-number`), so the real tokens below exist. Open
  `http://127.0.0.1:8765/?network=fork`. Put a caption "local fork of X Layer mainnet" on every fork scene, and say
  "on a fork of X Layer mainnet" instead of "on mainnet". On the fork the web Buy button is hidden on purpose.
- **The two real tokens** (checked against the final router on a fork of block 76,876,829; re-check both on the day
  with `node cli/exitproof.mjs check <token>`):
  - red: OKS `0xfDd1f2103f566fc4aAb4a8d95b29dEeEc45eD2a5`, a honeypot nobody can sell (reason 1 in every mode);
  - amber advisory: 羊屎蛋 `0x7e97D98e5103dA0F28C03E92A545dDFFED277777`, a Flap launchpad token that sells fine
    (3% tax). Permissive (the default) is green; the owner-risk advisory shows balanced and strict blocking it with
    reason 4 (a proxy) while unscanned and reason 5 once the scanner has attested it.
  - For a clean green, use a token with an empty owner-risk advisory on the day (on the fork, the demo token CleanToken).
- **The reverted honeypot buy (scene 1)** must exist before recording.
  - Mainnet: send one 0.01 OKB buy of the red token through the router, on purpose, from your wallet or with
    `cast send <router> 'buyETH(address,address,uint256,uint8,address,uint256)' 0x630DB8E822805c82Ca40a54daE02dd5aC31f7fcF 0xfDd1f2103f566fc4aAb4a8d95b29dEeEc45eD2a5 1 1 <you> <deadline> --value 0.01ether --gas-limit 8000000`
    (the CLI and the app refuse to send it, which is the point). It reverts with `Blocked(1, …)` and costs only gas:
    2,445,681 gas on the fork, about 0.00005 OKB at 0.02 gwei. Open the transaction on OKLink.
  - Fork: the same `cast send` with `--rpc-url http://127.0.0.1:8549 --from <anvil #3> --unlocked`; show the
    terminal: `status 0 (failed)`, then `cast call` of the same buy prints the `Blocked` revert, and the buyer's
    token balance is 0.
- **Census numbers (scene 2):** read the headline from the latest [docs/CENSUS.md](CENSUS.md) and put it in the
  voiceover. At block 76,868,206 it said 31.1% of 740 buyable live tokens could not be sold back.
- Open the tabs in advance: the explorer (or terminal) with the reverted buy; `docs/CENSUS.md` with the chart; the web
  app three times (`?token=<green>&check=1`, the same for amber and red); the app's circuit explorer;
  a terminal at the repo root, font size ≥ 18; the README's first screen.

## Script

| Time | On screen | Voiceover (EN) |
|---|---|---|
| 0:00–0:25 | Title card "ExitProof: don't buy what you can't sell" (2 s). Then the reverted buy of OKS on OKLink (or the fork terminal): status failed, the `Blocked` error, token balance 0. Caption: "a real honeypot on X Layer". | "This is a real buy of a real X Layer honeypot, through ExitProof. It failed on purpose. ExitProof bought the token, tried to sell all of it back inside the same transaction, the sale failed, and the whole buy reverted. The buyer lost only the gas." |
| 0:25–0:45 | `docs/CENSUS.md`: the headline and the chart. | "How common is this? We ran ExitProof over hundreds of live PotatoSwap tokens on a mainnet fork. About [31] percent could not be sold back at all. Many more have an owner who can flip a switch later." |
| 0:45–1:30 | Web app, default mode (permissive). Green token: "You can get out", the two amounts and the route stations. Then 羊屎蛋: green verdict plus the amber owner-risk advisory (balanced/strict, reason 5 or 4) and its "Buy in balanced mode" button. Then red OKS: "Exit blocked", reason 1. | "Paste a token and press Check. It's free: the router runs the real buy and the real sell-back on the pool, then throws the transaction away. Green means you can get out right now: that is the proof. This one also sells, but our scanner warns that the owner can still change the rules. That's advice, and one click makes the router enforce it. Red means no way out. Same honeypot as before." |
| 1:30–2:05 | Circuit explorer: click a few fact bits (sellOk off, then a tax bucket), the answer from `processor.eval` updates with "✓ matches". Then the processor and circuit ID on OKLink. Flash `2048/2048` from the tape-out log. | "Who decides? Not a Solidity if-statement, but a TapeOut circuit: 54 NAND gates, taped out on our own processor. The router feeds it eleven facts and does what it answers. This explorer calls the chip live. We checked all 2048 inputs on chain before deploying." |
| 2:05–2:40 | Terminal: `node cli/exitproof.mjs check 0x7e97D98e5103dA0F28C03E92A545dDFFED277777 --network xlayer` (scroll to `state`, `modes` and `ownerRisk`), then `node cli/exitproof.mjs tx <green token> --wallet <agent> --amount 0.01 --network xlayer` prints the `onchainos wallet contract-call` line. | "AI agents get the same check as JSON: the exit proof, plus the owner-risk advice they must pass on. Our OKX Agentic Wallet skill checks first, then prepares the buy for the agent's wallet. Token names are passed as untrusted text, and if the exit fails, the agent's buy reverts on chain, whatever it was told." |
| 2:40–3:00 | README first screen: "What one transaction can prove, and what it can't". End card: the app URL and "ExitProof". | "One transaction can prove you can sell now. It can't prove tomorrow, so our scanner watches for that, and the README says exactly where the limits are. ExitProof. Don't buy what you can't sell." |

## Voiceover in Turkish (for rehearsal)

| Time | TR |
|---|---|
| 0:00–0:25 | "Bu, gerçek bir X Layer honeypot'unun ExitProof üzerinden yapılmış gerçek bir alımı. Bilerek başarısız oldu. ExitProof token'ı aldı, aynı işlemin içinde hepsini geri satmayı denedi, satış başarısız oldu ve alımın tamamı geri alındı. Alıcı yalnızca gas'ı kaybetti." |
| 0:25–0:45 | "Bu ne kadar yaygın? ExitProof'u bir mainnet fork'unda yüzlerce canlı PotatoSwap token'ı üzerinde çalıştırdık. Yaklaşık yüzde [31]'i hiç geri satılamıyordu. Çok daha fazlasının, sonradan bir anahtarı çevirebilecek bir owner'ı var." |
| 0:45–1:30 | "Token'ı yapıştır, Kontrol Et'e bas. Ücretsiz: router havuzda gerçek alımı ve gerçek geri satışı çalıştırır, sonra işlemi çöpe atar. Yeşil, şu anda çıkabileceğin demek: kanıt bu. Bu da satılıyor, ama scanner'ımız owner'ın kuralları hâlâ değiştirebileceği konusunda uyarıyor. Bu bir tavsiye ve tek tıkla router onu da zorunlu kılar. Kırmızı, çıkış yok demek. Az önceki honeypot." |
| 1:30–2:05 | "Kararı kim veriyor? Bir Solidity if'i değil, bir TapeOut devresi: kendi işlemcimizde üretilmiş 54 NAND kapısı. Router ona on bir bilgi veriyor ve verdiği cevaba uyuyor. Bu gezgin çipi canlı çağırıyor. Yayına almadan önce 2048 girdinin hepsini zincir üstünde kontrol ettik." |
| 2:05–2:40 | "Yapay zekâ ajanları aynı kontrolü JSON olarak alır: çıkış kanıtı ve iletmeleri gereken owner riski tavsiyesi. OKX Agentic Wallet becerimiz önce kontrol eder, sonra alımı ajanın cüzdanı için hazırlar. Token adları güvenilmeyen metin olarak geçer ve çıkış başarısız olursa, ajana ne söylenmiş olursa olsun, ajanın alımı zincir üstünde geri alınır." |
| 2:40–3:00 | "Tek bir işlem, şimdi satabileceğini kanıtlayabilir. Yarını kanıtlayamaz; onun için scanner'ımız izler ve README sınırların tam olarak nerede olduğunu söyler. ExitProof. Satamayacağın şeyi alma." |

## Recording notes

- **Scene 1 is the hook.** Don't cut to the app before the failed transaction is readable. If you use the explorer,
  zoom to the status and the error line.
- **Scene 2:** replace `[31]` with the headline of the latest `docs/CENSUS.md`, rounded, in both languages. Don't say
  a number the screen doesn't show.
- **Scene 3:** run the three checks before recording so the fork has cached state; each check then answers in about a
  second. If the amber token's advisory is empty on the day, swap in another token whose check shows an owner-risk
  advisory (most tokens on the "New on PotatoSwap" list do).
- **Don't press Buy on the red token on camera.** Scene 1 already shows what happens.
- **Final length:** trim pauses to land under 3:00. The form rejects videos longer than 3 minutes.
