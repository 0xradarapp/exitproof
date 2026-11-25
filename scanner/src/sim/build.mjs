// Compiles SimRouter.sol with solc 0.8.24 (foundry svm install), optimizer 200 + viaIR, cancun -> sim-router.json
// (runtime bytecode + keccak of the source). The output is committed so the scanner needs no compiler; the test
// suite re-compiles and compares when solc is available. Re-run after editing the .sol:
//   node scanner/src/sim/build.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak256, toHex } from 'viem';

const dir = path.dirname(fileURLToPath(import.meta.url));
export const SOLC = process.env.SOLC ?? path.join(homedir(), '.svm/0.8.24/solc-0.8.24');

export function compileSimRouter(solc = SOLC) {
  const source = readFileSync(path.join(dir, 'SimRouter.sol'), 'utf8');
  const input = {
    language: 'Solidity',
    sources: { 'SimRouter.sol': { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      evmVersion: 'cancun',
      metadata: { bytecodeHash: 'none', appendCBOR: false },
      outputSelection: { '*': { SimRouter: ['abi', 'evm.deployedBytecode.object'] } },
    },
  };
  const out = JSON.parse(execFileSync(solc, ['--standard-json'], { input: JSON.stringify(input) }));
  const errs = (out.errors ?? []).filter((e) => e.severity === 'error');
  if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join('\n'));
  const c = out.contracts['SimRouter.sol'].SimRouter;
  return { solc: '0.8.24', sourceHash: keccak256(toHex(source)), runtime: `0x${c.evm.deployedBytecode.object}` };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = compileSimRouter();
  writeFileSync(path.join(dir, 'sim-router.json'), `${JSON.stringify(r, null, 1)}\n`);
  console.log(`SimRouter runtime ${(r.runtime.length - 2) / 2} bytes, source ${r.sourceHash}`);
}
