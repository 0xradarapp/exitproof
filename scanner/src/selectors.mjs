// Dangerous owner-setter signatures. Selectors are computed with keccak (viem toFunctionSelector), never
// hand-typed, so the table is auditable: every entry is `selector -> canonical signature`.
//
// Scope: functions that let a privileged account change whether / how much a holder can sell after the
// buy (fees, blacklists, limits, pausing, trading switches, pair/router swaps, fee exemptions, mint,
// cooldowns, swap switches) and code-replacement hooks (upgrade/implementation setters).
// setTaxRates(uint16,uint16) / setPool(address,bool) / setAuthorizedBuyer(address) were added after the first
// mainnet sample (2026-11-25): a PotatoSwap launch template ("FUT") exposes exactly these.
//
// Deliberately NOT listed (documented): one-shot `initPair(address)` (fixture helper; lock-on-first-call),
// `setTarget(address,address)` (fixture helper), `renounceOwnership()` / `transferOwnership(address)`
// (ownership plumbing, not a trap by itself). Unknown `set*` functions are not counted (determinism: no 4byte
// lookups at scan time).
import { toFunctionSelector } from 'viem';

export const selectorOf = (sig) => toFunctionSelector(sig);

const U = 'uint256';
const SIGNATURES = [
  // fees / taxes
  `setFee(${U})`, `setFee(${U},${U})`, `setFees(${U})`, `setFees(${U},${U})`, `setFees(${U},${U},${U})`,
  `setFees(${U},${U},${U},${U})`, `setTax(${U})`, `setTax(${U},${U})`, `setTaxes(${U},${U})`,
  `setTaxes(${U},${U},${U})`, `setTaxes(${U},${U},${U},${U})`, `setBuyFee(${U})`, `setSellFee(${U})`,
  `setBuyFee(${U},${U})`, `setSellFee(${U},${U})`, `setBuyFees(${U},${U})`, `setSellFees(${U},${U})`,
  `setBuyFees(${U},${U},${U})`, `setSellFees(${U},${U},${U})`, `setBuyTax(${U})`, `setSellTax(${U})`,
  `setBuyTaxes(${U},${U})`, `setSellTaxes(${U},${U})`, `updateFees(${U},${U})`, `updateFees(${U},${U},${U})`,
  `updateFees(${U},${U},${U},${U})`, `updateBuyFees(${U},${U},${U})`, `updateSellFees(${U},${U},${U})`,
  `setTaxFeePercent(${U})`, `setTaxFee(${U})`, `setFeePercent(${U})`, `setMarketingFee(${U})`,
  `setLiquidityFee(${U})`, `setLiquidityFeePercent(${U})`, `setSwapFee(${U})`, 'setTaxRates(uint16,uint16)',
  `setTaxRates(${U},${U})`,
  // blacklist / bots
  'blacklist(address)', 'blacklist(address,bool)', 'blacklist(address[],bool)', 'addBot(address)',
  'addBots(address[])', 'setBots(address[])', 'setBots(address[],bool)', 'setBot(address,bool)',
  'blacklistAddress(address)', 'blacklistAddress(address,bool)', 'setBlacklist(address,bool)',
  'setBlacklist(address[],bool)', 'addToBlacklist(address)', 'addToBlackList(address)', 'setBlacklisted(address,bool)',
  'setIsBlacklisted(address,bool)', 'blockBots(address[])', 'manageBlacklist(address[],bool)',
  // limits
  `setMaxTxAmount(${U})`, `setMaxTx(${U})`, `setMaxTxPercent(${U})`, `setMaxTxnAmount(${U})`,
  `updateMaxTxnAmount(${U})`, `setMaxWallet(${U})`, `setMaxWalletSize(${U})`, `setMaxWalletAmount(${U})`,
  `setMaxWalletPercent(${U})`, `updateMaxWalletAmount(${U})`, `setMaxSellAmount(${U})`, `setLimits(${U},${U})`,
  // pause / trading switches
  'pause()', 'unpause()', 'setPaused(bool)', 'enableTrading()', 'enableTrading(bool)', 'openTrading()',
  'startTrading()', 'closeTrading()', 'disableTrading()', 'setTradingEnabled(bool)', 'setTrading(bool)',
  'setTradingOpen(bool)', 'tradingStatus(bool)',
  // pair / router / exemptions
  'setAuthorizedBuyer(address)', 'setPool(address,bool)', 'setRouter(address)', 'setRouterAddress(address)', 'setPair(address)', 'setPairAddress(address)',
  'setUniswapPair(address)', 'setUniswapV2Pair(address)', 'excludeFromFee(address)', 'excludeFromFees(address,bool)',
  'includeInFee(address)', 'setFeeExempt(address,bool)', 'setIsFeeExempt(address,bool)',
  'setExcludedFromFee(address,bool)', 'excludeFromMaxTransaction(address,bool)',
  // supply
  `mint(address,${U})`, `mint(${U})`,
  // cooldown / swap
  `setCooldown(${U})`, `setCooldownTime(${U})`, 'setCooldownEnabled(bool)', 'setSwapEnabled(bool)',
  'setSwapAndLiquifyEnabled(bool)',
  // code replacement
  'upgradeTo(address)', 'upgradeToAndCall(address,bytes)', 'setImplementation(address)',
];

/** selector -> signature, sorted by selector for deterministic iteration. */
export const DANGEROUS = Object.freeze(Object.fromEntries(
  SIGNATURES.map((s) => [selectorOf(s), s]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
));

if (Object.keys(DANGEROUS).length !== SIGNATURES.length) throw new Error('duplicate dangerous signature');

/** Selectors that replace code: imply `upgradeable` (and are also dangerous setters). */
export const UPGRADE_SELECTORS = Object.freeze(
  ['upgradeTo(address)', 'upgradeToAndCall(address,bytes)', 'setImplementation(address)'].map(selectorOf),
);

/** AccessControl hasRole(bytes32,address): role-based admin present. */
export const HAS_ROLE = selectorOf('hasRole(bytes32,address)'); // 0x91d14854

export const OWNER_GETTERS = Object.freeze(['owner()', 'getOwner()'].map(selectorOf));

/** A readable ERC-20 dispatcher must expose all four in EQ form, else it is treated as unrecognized. */
export const CORE_ERC20 = Object.freeze([
  'transfer(address,uint256)', 'transferFrom(address,address,uint256)', 'approve(address,uint256)', 'balanceOf(address)',
].map(selectorOf));

