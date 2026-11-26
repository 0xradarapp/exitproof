#!/usr/bin/env node
// Demo scene 1: send one guarded buy of a known honeypot through the live router, on purpose.
// The router buys, fails to sell everything back, and reverts with Blocked(reason, facts):
// the OKB value comes back, only the gas is spent.
//
//   DEPLOYER_KEY=0x… CONFIRM_MAINNET=yes node scripts/demo-blocked-buy.mjs
//
// The key is read from the environment only. TOKEN and AMOUNT_OKB can be overridden.
import { createPublicClient, createWalletClient, http, parseEther, decodeErrorResult } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';

const dep = JSON.parse(readFileSync(new URL('../deployments/xlayer.json', import.meta.url)));
const TOKEN = process.env.TOKEN ?? '0xfDd1f2103f566fc4aAb4a8d95b29dEeEc45eD2a5'; // OKS, a honeypot
const AMOUNT = parseEther(process.env.AMOUNT_OKB ?? '0.01');
const RPC = process.env.RPC_URL ?? 'https://xlayerrpc.okx.com';
const FACTORY = '0x630DB8E822805c82Ca40a54daE02dd5aC31f7fcF';
const abi = [
  { type: 'function', name: 'buyETH', stateMutability: 'payable', outputs: [{ type: 'uint256' }],
    inputs: [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint8' }, { type: 'address' }, { type: 'uint256' }] },
  { type: 'error', name: 'Blocked', inputs: [{ name: 'reason', type: 'uint8' }, { name: 'facts', type: 'uint16' }] },
];

const chain = { id: 196, name: 'X Layer', nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const key = process.env.DEPLOYER_KEY;
if (!key) throw new Error('DEPLOYER_KEY is required (env only)');
const account = privateKeyToAccount(key);
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ account, chain, transport: http(RPC) });
const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
const args = [FACTORY, TOKEN, 1n, 1, account.address, deadline];

console.log(`router ${dep.router}\ntoken  ${TOKEN}\nbuyer  ${account.address}\nvalue  ${process.env.AMOUNT_OKB ?? '0.01'} OKB (returned on revert)`);
try {
  await pub.simulateContract({ address: dep.router, abi, functionName: 'buyETH', args, value: AMOUNT, account });
  throw new Error('the simulation did NOT revert: this token is not blocked, refusing to send');
} catch (e) {
  const data = e?.cause?.data ?? e?.walk?.((x) => x?.data)?.data;
  if (!(data?.errorName === 'Blocked' || /Blocked/.test(String(e?.message)))) throw e;
  console.log(`simulated: reverts with Blocked(${data?.args?.join(', ') ?? '…'}) as expected`);
}
if (process.env.CONFIRM_MAINNET !== 'yes') { console.log('dry run: set CONFIRM_MAINNET=yes to send'); process.exit(0); }

const hash = await wallet.writeContract({ address: dep.router, abi, functionName: 'buyETH', args, value: AMOUNT, gas: 8_000_000n });
console.log(`sent   ${hash}`);
const r = await pub.waitForTransactionReceipt({ hash });
console.log(`status ${r.status} · block ${r.blockNumber} · gas ${r.gasUsed}`);
console.log(`https://www.oklink.com/xlayer/tx/${hash}`);
