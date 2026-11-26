# ExitProof Token Safety Census

Snapshot: X Layer block **76875879** (2026-11-25T22:15:15.000Z). Venue: PotatoSwap V2 (factory `0x630DB8E822805c82Ca40a54daE02dd5aC31f7fcF`), WOKB pairs.
Every number below was measured by ExitProof itself: the real `ExitProofRouter.inspect()` with the real taped-out
policy circuit, run on a local anvil fork of X Layer mainnet at that block, plus the ExitProof static scanner (v10, which sets the static flags behind the balanced and strict verdicts).

## Headline

- **12.4%** of 740 buyable live tokens are blocked by ExitProof **even in permissive mode** (cannot sell all back, or a tax of 15% or more).
- **6.6%** cannot be sold back at all (reason 1, honeypot).
- **79.5%** have an active owner holding dangerous switches (a listed fee / blacklist / pause / limit setter, or since scanner v10 any setter gated by a caller check): time bombs that look fine today.
- ExitProof allows **87.6%** in permissive (the default mode), **20.5%** in balanced and **11.6%** in strict mode.
- A further 60 of 800 sampled live tokens (7.5%) cannot be bought through ExitProof at all right now (58 of 58 cannot be bought by a plain wallet either: trading closed or buys disabled); they are reported apart and are not counted above.

![Census chart](census.svg)

## Summary

| metric | value |
|---|---|
| PotatoSwap pairs at snapshot | 27534 (26996 paired with WOKB) |
| skipped: WOKB reserve under 0.01 OKB (never funded, drained or rugged) | 26043 of 26996 WOKB pairs (96.5%); 1356 hold no WOKB at all |
| dust among the 600 newest WOKB pairs | 562 (93.7%) |
| live WOKB pools (the population sampled) | 953 holding 28783.3 OKB of WOKB in total |
| sample drawn from the live pools | 600 most recent + 200 random older (seed 196) |
| tokens checked | 800 |
| measured (inspect Report + scan) | 740 |
| cannot buy at all (inspect reverted) | 60 (SwapFailed 58, TooLittle 2) |
| excluded (RPC errors) | 0 |
| can't sell (reason 1) | 6.6% (49) |
| sell tax >= 15% | 5.1% (38) |
| buy tax >= 15% | 4.7% (35) |
| any sell tax >= 5% / buy tax >= 5% | 15.8% / 16.8% |
| active owner (owner() non-zero or privileged code) | 88.4% (owner() non-zero: 42.3%) |
| dangerous owner switches (active owner + dangerSetter) | 79.5% (588) |
| a listed dangerous setter selector present | 38% |
| upgradeable (proxy / live delegatecall) | 0.9% (7) |
| privileged via unknown selector (allowlist model) | 88.4% (654) |
| allowed: permissive / balanced / strict | 87.6% / 20.5% / 11.6% |
| allowed before the scanner attests (unscanned) | 87.6% / 45.3% / 0% |

All percentages use the measured (buyable) tokens as the base. Tokens that cannot be bought are listed apart:
ExitProof blocks them too (the buy reverts), but a closed or drained pool is not a honeypot.

### Cross-check with a plain wallet

Every "cannot sell" and "cannot buy" token was re-tried on the same fork without ExitProof: a fresh impersonated EOA
buys through PotatoSwap's own V2 router, and in the next block approves it and sells its whole balance through it
(`swapExactTokensForETHSupportingFeeOnTransferTokens`), exactly as a wallet user does.

| ExitProof finding | checked | plain wallet agrees | plain wallet differs |
|---|---|---|---|
| cannot sell (reason 1) | 49 | 44 buy but cannot sell, 1 cannot even buy | 4 sell fine |
| cannot buy (inspect reverted) | 58 | 58 cannot buy either | 0 can buy |

Where the plain wallet differs, the token treats contracts (the router or the fresh probe holder) differently from
wallets, or the same block differently from the next one. ExitProof still blocks such buys: a token that
discriminates by caller can do the same to any holder later, so ExitProof fails closed.

### Block reasons per mode (first failing check, as the circuit reports it)

| reason | permissive | balanced | strict |
|---|---|---|---|
| 0 allowed | 648 | 152 | 86 |
| 1 cannot sell | 49 | 49 | 49 |
| 2 sell tax too high | 38 | 38 | 117 |
| 3 buy tax too high | 5 | 5 | 24 |
| 4 upgradeable | 0 | 5 | 4 |
| 5 dangerous owner powers | 0 | 491 | 394 |
| 7 owner still active | 0 | 0 | 66 |
| cannot buy (inspect reverted) | 60 | 60 | 60 |

### Recent launches vs older pairs

| group | measured | cannot buy | can't sell | blocked in permissive | allowed permissive / balanced / strict |
|---|---|---|---|---|---|
| recent | 547 | 53 (8.8%) | 7.7% | 14.3% | 85.7% / 25.6% / 14.4% |
| older | 193 | 7 (3.5%) | 3.6% | 7.3% | 92.7% / 6.2% / 3.6% |

## v1 → v2 router

The first census (commit 41ece32, block 76868206, scanner v4) ran the v1 router. This one runs the final router (measured delivery, sell-side `transferFrom` from a code-less holder, post-transfer reserve read in the probe swap, eval backstop, registry keyed by token) and scanner v10, at a later block, with the same sampling method and seed.

800 tokens were classified in both runs (the same 800 tokens: no pair was created and no pool crossed the dust line between the two blocks).

| change on the common tokens | count |
|---|---|
| cannot sell (v1) → sells (v2) | 182 (5 of them Flap `…7777` tokens) |
| sells (v1) → cannot sell (v2) | 1 |
| cannot buy (v1) → buyable (v2) / buyable → cannot buy | 0 / 0 |
| dynamic facts changed (sellOk, buy/sell tax buckets) | 202 |
| static facts changed (owner, upgradeable, danger: scanner v4 → v10) | 306 |
| permissive: blocked → allowed / allowed → blocked / other block reason | 146 / 1 / 36 |
| balanced: blocked → allowed / allowed → blocked / other block reason | 0 / 215 / 183 |
| strict: blocked → allowed / allowed → blocked / other block reason | 2 / 0 / 389 |

**Why the permissive numbers moved (router).** The change in sellability is entirely dynamic. The v1 probe computed the sell-back amountOut from pair reserves read *before* the token transfer. Many tax tokens swap their collected tax through the same pair inside that transfer (swap-back / liquify; the Flap `…7777` template does the same), which moves the reserves, so the precomputed swap failed the pair's K check and v1 reported 'cannot sell'. The v2 router reads the reserves after the transfer, like PotatoSwap's `swapExactTokensForETHSupportingFeeOnTransferTokens`, and these 182 tokens now sell, most of them with a measured 5-50% sell tax that the census now reports instead. Only 5 of the 182 carry the Flap `…7777` vanity suffix, so the fix matters well beyond Flap. One token went the other way: DOGSHIT2.0 (`0x9bfA2074e0c59fFc5fD4F18a70DFd1549cB5eB5C`) sold in v1 and cannot be sold in v2. PotatoSwap's own router cannot sell it either at the v2 block, so this is a real finding (its state changed between the blocks, or v1 missed it).

**Why the balanced/strict numbers moved (scanner).** The static flags now come from scanner v10 (commit 31f5beb) instead of v4 (v1 census) or v5 (the first v2 pass). The 306 static changes are all due to the scanner. 277 tokens lose balanced because v10 flags setters gated by a caller check, inside allowlisted or unknown selectors (`caller-gated-safe` 218, `caller-gated-unknown` 238), plus `env-fingerprint` 11, as dangerous; this spreads over 120 code templates. With the v5 scan on the same Reports, balanced allowed 58% and strict 11.4%; with v10 the figures are 20.5% and 11.6%. Permissive does not read static flags and is unaffected.

**The v1 plain-wallet cross-check had the same flaw.** It also read reserves before the transfer, so its '225 of 230 confirmed' was not independent (example: PUFF `0x4D87750a795b0Ae310A24349fA9108585100A90e`, listed in v1 as cannot sell, sells through PotatoSwap's router). The v2 cross-check calls PotatoSwap's real V2 router for both legs. The v1 headline (31.1% cannot sell) is superseded by this report.

**Where ExitProof and a PotatoSwap wallet still disagree (4 of 49 cannot-sell).** GOUT `0x6992f5D4c23299F1EE588B91cce555294De007a9` and moon `0x13e69129a41f59A17103aA29CE2fBCe72ECD7999` deliver 0 tokens on the router-to-buyer hop (`delivered = 0`): they block transfers that do not come from the pair, so a buyer through ExitProof would receive nothing. SHIT `0x0efc71Dae79DCA1a433f4f14DA094aa21060e57F` loses 20% on that hop and then fails the probe sale. DOG `0x903358FAf7c6304AFbD560e9E29b12Ab1b8fddC5` delivers in full but refuses the probe's `transferFrom` sale by a non-PotatoSwap spender. All four discriminate by path or caller; ExitProof fails closed on them by design. BEPE is counted as 'cannot even buy': the wallet's router buy reverted.

## 20 most notable dangerous tokens

Ranked by severity (cannot sell > tax of 15% or more > active owner with dangerous switches > upgradeable > cannot buy), then by
WOKB liquidity in the pool. Addresses are public chain data. Facts = the 11-bit circuit input without the mode bits.

| # | token | symbol | pair | WOKB liquidity | facts | ExitProof verdict |
|---|---|---|---|---|---|---|
| 1 | `0xFF0c811f0354E6cea151749CEFBe33aFa5E6929b` | XOSK | `0xB5CB97252ADCc487b4AB10F961E11CB79c028d41` | 29.4058 OKB | 0x0ae: CANNOT SELL, sell tax >=50%/unmeasurable, buy tax 5-15%, owner active, danger switches; setters: excludeFromFees; cross-check: EOA buys, cannot sell | cannot sell (all modes) |
| 2 | `0x903358FAf7c6304AFbD560e9E29b12Ab1b8fddC5` | DOG | `0x81E5Ecb20522ffba19680eF4F866121F29C86442` | 21.0633 OKB | 0x0a6: CANNOT SELL, sell tax >=50%/unmeasurable, buy tax <5%, owner active, danger switches; setters: setUniswapV2Pair, includeInFee; cross-check: EOA buys and sells | cannot sell (all modes) |
| 3 | `0x6992f5D4c23299F1EE588B91cce555294De007a9` | GOUT | `0x524E680d10614608FE45FBf67c0F28a9b7a9C689` | 5.0002 OKB | 0x0be: CANNOT SELL, sell tax >=50%/unmeasurable, buy tax >=50%/unmeasurable, owner active, danger switches; setters: setMaxWalletAmount, setMarketingFee, excludeFromFees, setSwapAndLiquifyEnabled; cross-check: EOA buys and sells | cannot sell (all modes) |
| 4 | `0x7d03e6016836424A8c3A58F914c6CEd868A27520` | BabyDogShit | `0xC30b98a832101d1461FA8878394323eE96492FC0` | 1.7653 OKB | 0x0a6: CANNOT SELL, sell tax >=50%/unmeasurable, buy tax <5%, owner active, danger switches; cross-check: EOA buys, cannot sell | cannot sell (all modes) |
| 5 | `0x17ABA978dB7c2dF43384d28Af3d5Dac02dEB257c` | SH | `0x4D72e70707D0fd8cC222adA080F8Bedb99Cf6A80` | 1.1225 OKB | 0x0be: CANNOT SELL, sell tax >=50%/unmeasurable, buy tax >=50%/unmeasurable, owner active, danger switches; cross-check: EOA buys, cannot sell | cannot sell (all modes) |
| 6 | `0xD7B7B426A4d154B2Cd41C29872cEd213C8098e11` | DOGSHIT | `0x9D16713B31386EeC307d9837a8e5C5b8D7f0F902` | 0.9767 OKB | 0x0ae: CANNOT SELL, sell tax >=50%/unmeasurable, buy tax 5-15%, owner active, danger switches; setters: setSwapAndLiquifyEnabled; cross-check: EOA buys, cannot sell | cannot sell (all modes) |
| 7 | `0xf19471Fe0599aB94ee3F71137267a342f22C3C91` | W25 | `0x4A919c19BA4Be5fF1C8D0E486DB342bA49d23736` | 0.6413 OKB | 0x0be: CANNOT SELL, sell tax >=50%/unmeasurable, buy tax >=50%/unmeasurable, owner active, danger switches; setters: setTrading; cross-check: EOA buys, cannot sell | cannot sell (all modes) |
| 8 | `0x8De0f22a2E586EC35dcf9C6D763Bd01aD8E4a4F9` | TESTSH | `0xC2e7bf6c751DDadcAf61053f36A297d9Bec6fb92` | 0.3669 OKB | 0x0be: CANNOT SELL, sell tax >=50%/unmeasurable, buy tax >=50%/unmeasurable, owner active, danger switches; cross-check: EOA buys, cannot sell | cannot sell (all modes) |
| 9 | `0x0efc71Dae79DCA1a433f4f14DA094aa21060e57F` | SHIT | `0xd686BEc4319F1036140e804E875057A5add60561` | 0.2589 OKB | 0x0b6: CANNOT SELL, sell tax >=50%/unmeasurable, buy tax 15-50%, owner active, danger switches; setters: setIsFeeExempt; cross-check: EOA buys and sells | cannot sell (all modes) |
| 10 | `0xF79D3f032a786083B5684699E43c9deC9AC229c5` | l14 | `0x901280c742235C01EbD63B8fE615f50Ade6a485A` | 0.1956 OKB | 0x0be: CANNOT SELL, sell tax >=50%/unmeasurable, buy tax >=50%/unmeasurable, owner active, danger switches; setters: setTrading; cross-check: EOA buys, cannot sell | cannot sell (all modes) |
| 11 | `0xF4B7cCd63Af9f5382541B62AD77C6E8a4bf48901` | l11 | `0x613827b4e6BA5ea3097f0F6d467Cc3FcaCD13bE9` | 0.1619 OKB | 0x0a6: CANNOT SELL, sell tax >=50%/unmeasurable, buy tax <5%, owner active, danger switches; setters: setTrading; cross-check: EOA buys, cannot sell | cannot sell (all modes) |
| 12 | `0xfDd1f2103f566fc4aAb4a8d95b29dEeEc45eD2a5` | OKS | `0xB0f83F2B7b8348F5efFBb06677391F1595Fc8523` | 0.156 OKB | 0x0be: CANNOT SELL, sell tax >=50%/unmeasurable, buy tax >=50%/unmeasurable, owner active, danger switches; cross-check: EOA buys, cannot sell | cannot sell (all modes) |
| 13 | `0xe8119eEbd2B47CfA6EaF266c74eF7857255DD447` | W23 | `0x0774A77462105635Ce02a2C9Df15C2f30f107860` | 0.1338 OKB | 0x0be: CANNOT SELL, sell tax >=50%/unmeasurable, buy tax >=50%/unmeasurable, owner active, danger switches; setters: setTrading; cross-check: EOA buys, cannot sell | cannot sell (all modes) |
| 14 | `0xF6DFFb4C478981bF08E69bee85cAe1365EE64761` | l13 | `0x8E68f0D528A03e3a82820Bb788Fe1830867e955C` | 0.1055 OKB | 0x0be: CANNOT SELL, sell tax >=50%/unmeasurable, buy tax >=50%/unmeasurable, owner active, danger switches; setters: setTrading; cross-check: EOA buys, cannot sell | cannot sell (all modes) |
| 15 | `0x8236D5F99DCD18DC8A4F3AE666f5BE5c2b2B0B18` | TCCC | `0xA51C9c036d4F89B372edD039860425B1E971E4E2` | 0.0999 OKB | 0x0ae: CANNOT SELL, sell tax >=50%/unmeasurable, buy tax 5-15%, owner active, danger switches; cross-check: EOA buys, cannot sell | cannot sell (all modes) |
| 16 | `0xF009de0d367143567c0a8E987C25034040f44f5e` | l07 | `0xD0F4F68AC9A20D04361388Df34ED37b392178820` | 0.0984 OKB | 0x0a6: CANNOT SELL, sell tax >=50%/unmeasurable, buy tax <5%, owner active, danger switches; setters: setTrading; cross-check: EOA buys, cannot sell | cannot sell (all modes) |
| 17 | `0x9239497951EABB0D3Bf33F0C63622AC215ab6083` | BTCV | `0x41382a03Ef2B73cf7A877684545F17295b7Ef099` | 0.0928 OKB | 0x0a6: CANNOT SELL, sell tax >=50%/unmeasurable, buy tax <5%, owner active, danger switches; cross-check: EOA buys, cannot sell | cannot sell (all modes) |
| 18 | `0xf0B9BC1b7C04F6cD9826f305C97BE45547Be7cc0` | O-8 | `0x86Ef97c1211cb6df635C254B65760276B0b4c2D9` | 0.0828 OKB | 0x0be: CANNOT SELL, sell tax >=50%/unmeasurable, buy tax >=50%/unmeasurable, owner active, danger switches; cross-check: EOA buys, cannot sell | cannot sell (all modes) |
| 19 | `0xd7507850d532889dC12257aebA176002bba604cc` | BEPE | `0xc00507c8E6fc35e569F4Ff89f5006EC74297B4B5` | 0.0698 OKB | 0x0fe: CANNOT SELL, sell tax >=50%/unmeasurable, buy tax >=50%/unmeasurable, owner active, upgradeable, danger switches; cross-check: EOA cannot buy | cannot sell (all modes) |
| 20 | `0xF00eE36930Cc0E2771B459Ed198b36D39B81962B` | BIAO | `0x02358f99dAD4DF5b530DE766D05601C8f165E2c5` | 0.0612 OKB | 0x0a6: CANNOT SELL, sell tax >=50%/unmeasurable, buy tax <5%, owner active, danger switches; setters: setSwapAndLiquifyEnabled; cross-check: EOA buys, cannot sell | cannot sell (all modes) |

## Methodology

1. **Snapshot.** A local anvil fork of X Layer mainnet (chain 196) pinned at block 76875879 (2026-11-25T22:15:15.000Z). Mainnet was only read (via a read-only, method-allowlisted proxy); every transaction went to the local fork, signed with anvil's public test key.
2. **Stack.** The repo's own `scripts/tapeout.mjs` and `scripts/deploy-fork.mjs` created the TapeOut processor, taped out the 54-NAND ExitProof policy circuit (verified on all 2048 inputs on the forked processor), and deployed `RiskRegistry` and `ExitProofRouter` on the fork.
3. **Sample.** All 27534 pairs were enumerated from the factory (`allPairs`) and the reserves of all 26996 WOKB pairs were read at the snapshot block. Pairs with less than 0.01 OKB of WOKB reserve were skipped and counted (most launch pairs on PotatoSwap are never funded or end up drained). From the 953 live pools: the 600 most recent plus 200 drawn uniformly from the older ones (mulberry32 partial Fisher-Yates, seed 196).
4. **Dynamic check.** `eth_call` of `ExitProofRouter.inspect(factory, WOKB, amountIn, token, permissive)` with amountIn = min(0.001 OKB, 1% of WOKB reserve). The router buys on the pair, measures what the caller would actually be delivered, moves the whole position to a fresh code-less holder address which approves the router, sells all of it back with `transferFrom` (a spender-initiated sale, like any DEX router; the pair reserves are read after the transfer), measures buy and sell tax into buckets (<5%, 5-15%, 15-50%, >=50%), reads `owner()`, and asks the circuit. It always reverts with `Report(facts, allow, reason, buyOut, sellOut, delivered)`.
5. **Static check.** `scanner/src/scan.mjs` `scan()` on the same fork: dispatcher selectors against the safe allowlist and the dangerous-setter list, caller-vs-storage checks, external calls, proxy slots, `owner()`.
6. **Verdicts.** The facts the router would build once the scanner daemon has attested the token (RiskRegistry is keyed by token address and only counts an attestation made for the token's current codehash; registry flags = scan result: `ownerActive = owner() || privileged`, `upgradeable = scan.upgradeable`, `danger = dangerSetter`, `unscanned = 0`), evaluated for each mode with `circuit/truth.json`, the exhaustive truth table of the taped-out circuit (generated from `circuit/spec.py`). For every token the on-chain circuit answer in the Report was compared with the truth table (0 mismatches).
7. **Plain-wallet cross-check.** Every cannot-sell and cannot-buy token was re-tried without ExitProof on the same fork, serially, inside `evm_snapshot` / `evm_revert`: a fresh impersonated EOA buys the probe amount through the PotatoSwap V2 router (`0x881fB2f98c13d521009464e7D1CBf16E1b394e8E`, `swapExactETHForTokensSupportingFeeOnTransferTokens`), waits one block, approves the router and sells its whole balance with `swapExactTokensForETHSupportingFeeOnTransferTokens` (amountOutMin 0).
8. **Same state.** The stack deployment added 8 fork-only transactions from anvil test account #2 (block 76875879 + 1 to + 8); they touch only the new TapeOut processor, the BEM token allowances of that account and the two new contracts, never a sampled token or pair. Inspect and scan ran at the fork head after them.

**Fork simulation = what ExitProof sees.** At that block, the fork runs the same bytecode with the same state as mainnet, so each Report is exactly what `inspect()` (and the identical check inside `buyETH`) would return for a real user at that block.

## Caveats and limits

- One block. Owner-controlled tokens can change after the snapshot (that is what the time-bomb columns measure: the power to change, not the change).
- A tiny probe (at most 0.001 OKB). Tokens with max-transaction / max-wallet limits or amount-dependent taxes may behave differently at larger sizes; tax buckets on very small amounts can be distorted by rounding on low-decimal tokens.
- The probe sells from a fresh code-less holder in the same transaction. Tokens that only trap EOAs or later blocks (cooldowns, time-based traps) can pass the probe; the static flags exist to cover that class, and they are heuristics with documented false positives (see `scanner/README.md`), mostly on strict mode.
- "Dangerous owner switches" means ExitProof found a listed dangerous setter, live SELFDESTRUCT, an unrecognized dispatcher, an environment fingerprint, or (scanner v9+) a state-changing function gated by a caller check, with an active owner. It is a capability, not proof of intent. The L3 owner-power simulation (`simulate()`) was not run in this census, so `ownerCanTrap` is false everywhere and the danger share is a lower bound in that respect.
- Dust pools (WOKB reserve below the threshold) are excluded from all percentages; many of them are rugged or abandoned launches, so the census describes live pools only.
- The sample is the newest pairs plus a random draw of older ones, not the full set; the recent group dominates and recent launches are riskier, so the totals are not a uniform estimate over all pairs. The per-group table separates them.

## Reproduce

```
N=600 M=200 SEED=196 node scanner/src/census.mjs   # writes docs/census-raw.jsonl (resumable)
RESCAN=1 node scanner/src/census.mjs                 # optional: re-scan rows with the current scanner, re-run the wallet check
node scanner/src/census-report.mjs                    # writes docs/CENSUS.md, docs/census.json, docs/census.svg
git show 41ece32:docs/census-raw.jsonl > v1.jsonl && CENSUS_PREV=v1.jsonl node scanner/src/census-report.mjs   # + v1 comparison
```

Re-running at block 76875879 needs an archive-capable upstream for the fork; a fresh run uses the latest block. Raw per-token rows: `docs/census-raw.jsonl`.
