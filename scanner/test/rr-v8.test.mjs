// v8 structural rule: an unknown selector (not SAFE, not on the dangerous list) whose reachable code reads CALLER or
// ORIGIN => dangerSetter (reason caller-gated-unknown), whatever the sweep finds and whatever owner() says. The v7
// re-review variants (/tmp/ep-v7rr: RenouncedSharedSlot, ObfuscatedAdmin, DecoyMagic) and the earlier ones must all
// be dangerSetter; CleanToken, the OZ-shaped permit token and a renounced plain OZ Ownable token must not.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createWalletClient, http, keccak256, toHex, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { scan } from '../src/scan.mjs';
import { simulate, mergeSimulation, packedAddresses } from '../src/simulate.mjs';
import { selectorOf } from '../src/selectors.mjs';
import {
  startAnvil, deployInfra, launchAudit, deployToken, deployScannerFixture, write, SUPPLY,
} from './helpers.mjs';

const KEY3 = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6'; // anvil dev #3 (public test key)
let env;
let infra;
let other;
before(async () => {
  env = await startAnvil();
  infra = await deployInfra(env);
  other = createWalletClient({ chain: foundry, transport: http(env.rpc), account: privateKeyToAccount(KEY3) });
});
after(async () => { await env.stop(); });
const balancedBlocks = (m) => (m.privileged && (m.dangerSetter || m.ownerCanTrap)) || m.upgradeable;

for (const [name, sig] of [
  ['RenouncedSharedSlot', 'setLaunchParam(uint256)'],
  ['ObfuscatedAdmin', 'setLaunchParam(uint256)'],
  ['DecoyMagic', 'setLaunchParam(uint256,uint256)'],
  ['RenouncedPackedAdmin', 'setLaunchParam(uint256)'],
  ['MagicSecondSilent', 'setLaunchParam(uint256,uint256)'],
  ['HiddenAdminBomb', 'setLaunchParam(uint256)'],
  ['RenamedSetterBomb', 'setSellFeeBps(uint256)'],
]) {
  test(`v8 ${name}: caller-gated unknown selector => dangerSetter statically, balanced blocks`, async () => {
    const { token, pair } = await launchAudit(env, infra, name, { pairCreator: other });
    const s = await scan(env.pub, token.address);
    assert.ok(s.evidence.callerGatedUnknown.includes(selectorOf(sig)), JSON.stringify(s.evidence.callerGatedUnknown));
    assert.ok(s.evidence.reasons.includes('caller-gated-unknown'));
    assert.equal(s.dangerSetter, true);
    const sim = await simulate(env.rpc, token.address, pair.address, { callers: [other.account.address] });
    assert.ok(balancedBlocks(mergeSimulation(structuredClone(s), sim)));
  });
}

test('v8 ObfuscatedAdmin: the SLOAD taint survives XOR, so the masked admin compare is a caller-vs-storage check', async () => {
  const { token } = await launchAudit(env, infra, 'ObfuscatedAdmin', { pairCreator: other });
  const s = await scan(env.pub, token.address);
  assert.ok(s.evidence.reasons.includes('caller-vs-storage'));
});

test('v8 RenouncedSharedSlot: packed admin at byte offset 3 is discovered (every offset 0..12)', async () => {
  const { token, pair } = await launchAudit(env, infra, 'RenouncedSharedSlot', { pairCreator: other });
  const sim = await simulate(env.rpc, token.address, pair.address, { callers: [other.account.address] });
  const hidden = getAddress(`0x${keccak256(toHex('hidden-admin')).slice(-40)}`);
  assert.ok(sim.evidence.storageCallers.includes(hidden));
  assert.ok(packedAddresses((BigInt(hidden) << 24n) | 7n).includes(hidden));
});

test('v8 controls: CleanToken, PermitToken and a renounced plain OZ Ownable token are not dangerSetter', async () => {
  const clean = await scan(env.pub, (await deployToken(env, 'CleanToken')).address);
  assert.deepEqual([clean.privileged, clean.dangerSetter, clean.evidence.callerGatedUnknown], [false, false, []]);
  const permit = await scan(env.pub, (await deployScannerFixture(env, 'PermitToken', [SUPPLY])).address);
  assert.deepEqual([permit.privileged, permit.dangerSetter, permit.evidence.callerGatedUnknown], [false, false, []]);

  const { token, pair } = await launchAudit(env, infra, 'OzOwnableToken', { pairCreator: other });
  await write(env, token, 'renounceOwnership');
  const s = await scan(env.pub, token.address);
  assert.equal(s.evidence.owner, null, 'renounced');
  assert.deepEqual(s.evidence.callerGatedUnknown, []);
  assert.deepEqual(s.evidence.ownershipPlumbing, [selectorOf('transferOwnership(address)')]);
  assert.equal(s.dangerSetter, false);
  assert.equal(s.privileged, true, 'caller-vs-storage (strict fence, unchanged since v3)');
  const sim = await simulate(env.rpc, token.address, pair.address, { callers: [other.account.address] });
  assert.deepEqual(sim.evidence.unknownSweep.plumbingUnexercised, [selectorOf('transferOwnership(address)')]);
  assert.equal(sim.evidence.unknownSweep.complete, true);
  assert.deepEqual(sim.signals, []);
  const m = mergeSimulation(structuredClone(s), sim);
  assert.equal(balancedBlocks(m), false, 'balanced passes the renounced plain OZ token');
});

test('v8 transferOwnership(address) is plumbing only in the Ownable shape (one SSTORE to the compared slot)', async () => {
  const { analyzeCode } = await import('../src/scan.mjs');
  const CORE = ['a9059cbb', '23b872dd', '095ea7b3', '70a08231'];
  const build = (extraStores) => {
    const pro = '5f3560e01c';
    const head = (x, y) => pro + CORE.reduce((acc, sel) => acc + `8063${sel}1461${x}57`, '') + `8063f2fde38b1461${y}57` + '5f5ffd';
    const h0 = head('0000', '0000');
    const X = h0.length / 2; // JUMPDEST STOP
    const Y = X + 2;
    // body: CALLER PUSH0 SLOAD EQ ISZERO PUSH2 R JUMPI; SSTORE(slot 0, calldata[4]) [; SSTORE(slot 1, 1)]; STOP
    const pre = '5b335f541415';
    const rest = `6004355f55${extraStores ? '6001600155' : ''}00`;
    const R = Y + (pre.length + 6 + 2 + rest.length) / 2;
    const hex = (n) => n.toString(16).padStart(4, '0');
    return `0x${head(hex(X), hex(Y))}5b00${pre}61${hex(R)}57${rest}5b5f5ffd`;
  };
  const ok = analyzeCode(build(false));
  assert.equal(ok.dispatcher.ok, true);
  assert.deepEqual([ok.ownershipPlumbing, ok.callerGatedUnknown, ok.dangerSetter], [['0xf2fde38b'], [], false]);
  const bad = analyzeCode(build(true));
  assert.deepEqual([bad.ownershipPlumbing, bad.callerGatedUnknown, bad.dangerSetter], [[], ['0xf2fde38b'], true]);
});
