// v10: SAFE write rule (an allowlisted function may only SSTORE into mapping slots or the totalSupply() slot),
// condition (d) accepts EQ only against calldata / CALLER, burn/burnFrom in SAFE, Ownable2Step plumbing shapes.
// PoCs from /tmp/ep-v9rr (MappingApproveBackdoor, MemKeyOwnerTrap, PermitAdmin) must be dangerSetter; real
// OpenZeppelin 5.5.0 ERC20Burnable / Ownable2Step builds must be clean.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createWalletClient, http, encodeDeployData, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { scan } from '../src/scan.mjs';
import { simulate, mergeSimulation } from '../src/simulate.mjs';
import { selectorOf } from '../src/selectors.mjs';
import { startAnvil, deployInfra, launchAudit, deployToken, deployScannerFixture, SUPPLY } from './helpers.mjs';

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
const AO = selectorOf('acceptOwnership()');

for (const [name, check] of [
  // V9-1: approve writes the scalar fee slot (CALLER only as a mapping key) => SAFE write rule
  ['MappingApproveBackdoor', (s) => s.evidence.callerGatedSafe.includes(selectorOf('approve(address,uint256)'))],
  // V9-2: the owner slot is EQ-compared on the transfer path with a value routed through memory => (d) fails
  ['MemKeyOwnerTrap', (s) => s.evidence.callerGatedUnknown.includes(TO) && !s.evidence.ownershipPlumbing.includes(TO)],
  // V9-3: permit (SAFE) writes the scalar fee slot when the signer is the admin => SAFE write rule
  ['PermitAdmin', (s) => s.evidence.callerGatedSafe.includes(selectorOf('permit(address,address,uint256,uint256,uint8,bytes32,bytes32)'))],
]) {
  test(`v10 ${name} => dangerSetter (strict and balanced block)`, async () => {
    const { token, pair } = await launchAudit(env, infra, name, { pairCreator: other });
    const s = await scan(env.pub, token.address);
    assert.ok(check(s), JSON.stringify({ g: s.evidence.callerGatedUnknown, gs: s.evidence.callerGatedSafe, p: s.evidence.ownershipPlumbing }));
    assert.equal(s.dangerSetter, true);
    assert.equal(s.privileged, true, 'strict blocks too');
    const sim = await simulate(env.rpc, token.address, pair.address, { callers: [other.account.address] });
    assert.ok(balancedBlocks(mergeSimulation(structuredClone(s), sim)));
  });
}

test('v10 real OpenZeppelin 5.5.0: ERC20Burnable, Ownable2Step, Burnable+Permit+Ownable are clean (not dangerSetter)', async () => {
  const oz = JSON.parse(readFileSync(new URL('./fixtures/oz-fixtures.json', import.meta.url), 'utf8'));
  assert.equal(oz._openzeppelin, '5.5.0');
  const deployOz = async (name) => {
    const hash = await env.wallet.sendTransaction({ data: encodeDeployData({ abi: oz[name].abi, bytecode: oz[name].bytecode, args: ['0x00000000000000000000000000000000000000aa', parseEther('1'), parseEther('1')] }) });
    return { address: (await env.pub.waitForTransactionReceipt({ hash })).contractAddress, abi: oz[name].abi };
  };
  const tx = async (t, functionName, args = [], wallet = env.wallet) => {
    await env.pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: t.address, abi: t.abi, functionName, args }) });
  };
  const clean = (s, name) => assert.deepEqual([s.dangerSetter, s.evidence.callerGatedSafe, s.evidence.callerGatedUnknown], [false, [], []], name);

  const b = await deployOz('OzBurnable');
  const sb = await scan(env.pub, b.address);
  clean(sb, 'OzBurnable');
  assert.equal(sb.privileged, false, 'burn / burnFrom are SAFE');
  assert.deepEqual(sb.evidence.unknownSelectors, []);

  const o2 = await deployOz('OzOwnable2Step');
  const s2 = await scan(env.pub, o2.address);
  clean(s2, 'OzOwnable2Step');
  assert.deepEqual(s2.evidence.ownershipPlumbing, [AO, RO, TO].sort());
  // the two-step handover keeps the shape; renounced afterwards it stays clean
  await tx(o2, 'transferOwnership', [other.account.address]);
  await tx(o2, 'acceptOwnership', [], other);
  clean(await scan(env.pub, o2.address), 'OzOwnable2Step after handover');
  await tx(o2, 'renounceOwnership', [], other);
  clean(await scan(env.pub, o2.address), 'OzOwnable2Step renounced');

  const obp = await deployOz('OzOwnedBurnablePermit');
  const s3 = await scan(env.pub, obp.address);
  clean(s3, 'OzOwnedBurnablePermit');
  assert.deepEqual(s3.evidence.ownershipPlumbing, [RO, TO].sort());
});

test('v10 earlier controls stay clean (CleanToken, PermitToken, OzOwnableToken)', async () => {
  for (const s of [
    await scan(env.pub, (await deployToken(env, 'CleanToken')).address),
    await scan(env.pub, (await deployScannerFixture(env, 'PermitToken', [SUPPLY])).address),
    await scan(env.pub, (await launchAudit(env, infra, 'OzOwnableToken', { pairCreator: other })).token.address),
  ]) assert.deepEqual([s.dangerSetter, s.evidence.callerGatedSafe], [false, []]);
});
