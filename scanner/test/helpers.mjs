// Test helpers: spawn a throwaway anvil, deploy compiled fixtures from ../../out, build V2 pools.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import net from 'node:net';
import {
  createPublicClient, createWalletClient, http, encodeDeployData, parseEther,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// anvil's well-known dev key #0 (public test key, never used on a real chain)
export const DEV_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
// anvil dev key #1, used as the registry attester in tests
export const ATTESTER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

export const SUPPLY = 1_000_000n * 10n ** 18n;

export function artifact(file, name) {
  const j = JSON.parse(readFileSync(path.join(ROOT, 'out', file, `${name}.json`), 'utf8'));
  return { abi: j.abi, bytecode: j.bytecode.object };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

export async function startAnvil(extraArgs = []) {
  const port = await freePort();
  const proc = spawn('anvil', ['--port', String(port), '--silent', '--hardfork', 'cancun', ...extraArgs], {
    stdio: 'ignore',
  });
  const rpc = `http://127.0.0.1:${port}`;
  const pub = createPublicClient({ chain: foundry, transport: http(rpc) });
  for (let i = 0; i < 100; i++) {
    try {
      await pub.getChainId();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const account = privateKeyToAccount(DEV_KEY);
  const wallet = createWalletClient({ chain: foundry, transport: http(rpc), account });
  const stop = () => new Promise((r) => {
    proc.once('exit', r);
    proc.kill('SIGKILL');
  });
  return { rpc, pub, wallet, account, stop };
}

export async function deploy(env, file, name, args = [], value = 0n) {
  const a = artifact(file, name);
  const hash = await env.wallet.sendTransaction({
    data: encodeDeployData({ abi: a.abi, bytecode: a.bytecode, args }),
    value,
  });
  const r = await env.pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`deploy ${name} failed`);
  return { address: r.contractAddress, abi: a.abi };
}

export async function write(env, c, functionName, args = [], value = 0n) {
  const hash = await env.wallet.writeContract({ address: c.address, abi: c.abi, functionName, args, value });
  const r = await env.pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`${functionName} failed`);
  return r;
}

export function read(env, c, functionName, args = []) {
  return env.pub.readContract({ address: c.address, abi: c.abi, functionName, args });
}

/** Deploys WOKB + factory once per anvil. */
export async function deployInfra(env) {
  const wokb = await deploy(env, 'V2.sol', 'MockWOKB');
  const factory = await deploy(env, 'V2.sol', 'MockV2Factory', [25]);
  return { wokb, factory };
}

/**
 * Lists `token` against WOKB: creates pair, initPair (if pair-aware), seeds liquidity.
 * Returns pair contract handle.
 */
export async function listToken(env, infra, token, tokenAmount = SUPPLY / 2n, okb = parseEther('10')) {
  await write(env, infra.factory, 'createPair', [token.address, infra.wokb.address]);
  const pairAddr = await read(env, infra.factory, 'getPair', [token.address, infra.wokb.address]);
  const pair = { address: pairAddr, abi: artifact('V2.sol', 'MockV2Pair').abi };
  if (token.abi.some((x) => x.name === 'initPair')) await write(env, token, 'initPair', [pairAddr]);
  await write(env, token, 'transfer', [pairAddr, tokenAmount]);
  await write(env, infra.wokb, 'deposit', [], okb);
  await write(env, infra.wokb, 'transfer', [pairAddr, okb]);
  await write(env, pair, 'mint', [env.account.address]);
  return pair;
}

export async function deployToken(env, name, args = [SUPPLY]) {
  if (name === 'ProxyToken') {
    const impl = await deploy(env, 'Tokens.sol', 'ProxyImpl');
    const { encodeFunctionData } = await import('viem');
    const init = encodeFunctionData({
      abi: impl.abi, functionName: 'initialize', args: [SUPPLY, env.account.address],
    });
    const p = await deploy(env, 'Tokens.sol', 'ProxyToken', [impl.address, init]);
    // talk to the proxy with the implementation ABI plus upgradeTo
    return { address: p.address, abi: [...impl.abi, ...p.abi.filter((x) => x.type === 'function')], impl };
  }
  return deploy(env, 'Tokens.sol', name, args);
}

const SCANNER_FIXTURES = JSON.parse(readFileSync(path.join(ROOT, 'scanner/test/fixtures/fixtures.json'), 'utf8'));

/** Deploys a contract from scanner/test/fixtures/ScannerFixtures.sol (prebuilt fixtures.json). */
export async function deployScannerFixture(env, name, args = []) {
  const a = SCANNER_FIXTURES[name];
  const hash = await env.wallet.sendTransaction({ data: encodeDeployData({ abi: a.abi, bytecode: a.bytecode, args }) });
  const r = await env.pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`deploy ${name} failed`);
  return { address: r.contractAddress, abi: a.abi };
}


/**
 * Audit-style launch (fable-security-audit Appendix B): create the pair for the predicted token address first,
 * then (now or later via `finish()`) deploy the ScannerFixtures token that mints its liquidity straight to the pair,
 * then add WOKB and sync. Returns { predicted, pair, finish, token }.
 */
export async function launchAudit(env, infra, name, {
  deployNow = true, liq = 100_000n * 10n ** 18n, rest = 900_000n * 10n ** 18n, okb = parseEther('10'), pairCreator = null,
} = {}) {
  const { getContractAddress } = await import('viem');
  const nonce = await env.pub.getTransactionCount({ address: env.account.address });
  // pairCreator (another wallet) creates the pair, so the PairCreated sender is not the token's admin
  const predicted = getContractAddress({ from: env.account.address, nonce: BigInt(pairCreator ? nonce : nonce + 1) });
  if (pairCreator) {
    const h = await pairCreator.writeContract({ address: infra.factory.address, abi: infra.factory.abi, functionName: 'createPair', args: [predicted, infra.wokb.address] });
    await env.pub.waitForTransactionReceipt({ hash: h });
  } else {
    await write(env, infra.factory, 'createPair', [predicted, infra.wokb.address]);
  }
  const pairAddr = await read(env, infra.factory, 'getPair', [predicted, infra.wokb.address]);
  const pair = { address: pairAddr, abi: artifact('V2.sol', 'MockV2Pair').abi };
  const finish = async () => {
    const t = await deployScannerFixture(env, name, [pairAddr, liq, rest]);
    if (t.address.toLowerCase() !== predicted.toLowerCase()) throw new Error('launchAudit: address prediction failed');
    await write(env, infra.wokb, 'deposit', [], okb);
    await write(env, infra.wokb, 'transfer', [pairAddr, okb]);
    await write(env, pair, 'mint', [env.account.address]);
    return t;
  };
  return { predicted, pair, finish, token: deployNow ? await finish() : null };
}
