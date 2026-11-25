// v9: the caller-gated rule extends to SAFE selectors (CALLER/ORIGIN compared with storage or an address literal
// inside an allowlisted function => caller-gated-safe), renounceOwnership leaves SAFE, and the ownership-plumbing
// exemption requires the exact Ownable shape plus a harmless owner slot on the transfer paths. PoCs from
// /tmp/ep-v8rr (OwnerKeyTrap, PackedFeeOwner, ApproveBackdoor, RenounceBomb) must all be dangerSetter.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { scan } from '../src/scan.mjs';
import { simulate, mergeSimulation } from '../src/simulate.mjs';
import { selectorOf } from '../src/selectors.mjs';
import { startAnvil, deployInfra, launchAudit, deployToken, deployScannerFixture, write, SUPPLY } from './helpers.mjs';

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
const TO = selectorOf('transferOwnership(address)');
const RO = selectorOf('renounceOwnership()');

for (const [name, check] of [
  // V8-1: plain transferOwnership, but the transfer path compares the owner slot with a literal (0x…c0DE)
  ['OwnerKeyTrap', (s) => s.evidence.callerGatedUnknown.includes(TO) && !s.evidence.ownershipPlumbing.includes(TO)],
  // V8-2: one SSTORE into the owner slot that carries a trailing calldata word (fee bits)
  ['PackedFeeOwner', (s) => s.evidence.callerGatedUnknown.includes(TO)],
  // V8-3a: approve() (SAFE) has `msg.sender == _ops` (immutable) => caller-gated-safe
  ['ApproveBackdoor', (s) => s.evidence.callerGatedSafe.includes(selectorOf('approve(address,uint256)'))],
  // V8-3b: renounceOwnership() also writes the fee => not plumbing => caller-gated
  ['RenounceBomb', (s) => s.evidence.callerGatedUnknown.includes(RO)],
]) {
  test(`v9 ${name} => dangerSetter`, async () => {
    const { token, pair } = await launchAudit(env, infra, name, { pairCreator: other });
    const s = await scan(env.pub, token.address);
    assert.ok(check(s), JSON.stringify({ g: s.evidence.callerGatedUnknown, gs: s.evidence.callerGatedSafe, p: s.evidence.ownershipPlumbing }));
    assert.equal(s.dangerSetter, true);
    const sim = await simulate(env.rpc, token.address, pair.address, { callers: [other.account.address] });
    assert.ok(balancedBlocks(mergeSimulation(structuredClone(s), sim)));
  });
}

test('v9 controls stay clean: CleanToken, PermitToken, renounced OZ Ownable (both ownership functions are plumbing)', async () => {
  for (const s of [
    await scan(env.pub, (await deployToken(env, 'CleanToken')).address),
    await scan(env.pub, (await deployScannerFixture(env, 'PermitToken', [SUPPLY])).address),
  ]) {
    assert.deepEqual([s.privileged, s.dangerSetter, s.evidence.callerGatedSafe, s.evidence.callerGatedUnknown], [false, false, [], []]);
  }
  const { token } = await launchAudit(env, infra, 'OzOwnableToken', { pairCreator: other });
  const active = await scan(env.pub, token.address);
  assert.deepEqual(active.evidence.ownershipPlumbing, [RO, TO].sort(), 'owner still active: same shape');
  assert.equal(active.dangerSetter, false);
  await write(env, token, 'renounceOwnership');
  const s = await scan(env.pub, token.address);
  assert.deepEqual([s.dangerSetter, s.evidence.callerGatedSafe, s.evidence.callerGatedUnknown], [false, [], []]);
});

test('v9 real OpenZeppelin 5 bodies stay clean (ERC20, ERC20Permit, ERC20Permit + Ownable active and renounced)', async () => {
  const { readFileSync } = await import('node:fs');
  const { encodeDeployData, parseEther } = await import('viem');
  const oz = JSON.parse(readFileSync(new URL('./fixtures/oz-fixtures.json', import.meta.url), 'utf8'));
  const OWN = selectorOf('transferOwnership(address)');
  for (const name of ['OzPlain', 'OzPermit', 'OzOwnedPermit']) {
    const pairAddr = '0x00000000000000000000000000000000000000aa';
    const hash = await env.wallet.sendTransaction({ data: encodeDeployData({ abi: oz[name].abi, bytecode: oz[name].bytecode, args: [pairAddr, parseEther('1'), parseEther('1')] }) });
    const t = (await env.pub.waitForTransactionReceipt({ hash })).contractAddress;
    const s = await scan(env.pub, t);
    assert.deepEqual([s.dangerSetter, s.evidence.callerGatedSafe, s.evidence.callerGatedUnknown], [false, [], []], name);
    if (name === 'OzOwnedPermit') {
      assert.deepEqual(s.evidence.ownershipPlumbing, [RO, OWN].sort());
      const h2 = await env.wallet.writeContract({ address: t, abi: oz[name].abi, functionName: 'renounceOwnership' });
      await env.pub.waitForTransactionReceipt({ hash: h2 });
      const r = await scan(env.pub, t);
      assert.deepEqual([r.dangerSetter, r.evidence.owner], [false, null]);
    } else {
      assert.equal(s.privileged, false, name);
    }
  }
});
