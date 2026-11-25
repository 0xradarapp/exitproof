// Compiles ScannerFixtures.sol with solc 0.8.24 (foundry svm install), optimizer 200, cancun -> fixtures.json.
// Output is committed so tests need no compiler; re-run after editing the .sol.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const solc = process.env.SOLC ?? path.join(homedir(), '.svm/0.8.24/solc-0.8.24');
// Every contract is built with the repo setting (optimizer on, 200 runs). NOOPT ones are also built with the
// optimizer off, stored as `<Name>_noopt`.
const NOOPT = new Set(['CallerEqBeefToken', 'CallerEqFullToken']);
function compile(optimizer) {
  const input = {
    language: 'Solidity',
    sources: { 'ScannerFixtures.sol': { content: readFileSync(path.join(dir, 'ScannerFixtures.sol'), 'utf8') } },
    settings: {
      optimizer: { enabled: optimizer, runs: 200 },
      evmVersion: 'cancun',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  };
  const out = JSON.parse(execFileSync(solc, ['--standard-json'], { input: JSON.stringify(input) }));
  const errs = (out.errors ?? []).filter((e) => e.severity === 'error');
  if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join('\n'));
  return out.contracts['ScannerFixtures.sol'];
}
const res = {};
for (const [name, c] of Object.entries(compile(true))) {
  if (!c.evm.bytecode.object) continue;
  res[name] = { abi: c.abi, bytecode: `0x${c.evm.bytecode.object}` };
}
for (const [name, c] of Object.entries(compile(false))) {
  if (NOOPT.has(name)) res[`${name}_noopt`] = { abi: c.abi, bytecode: `0x${c.evm.bytecode.object}` };
}
writeFileSync(path.join(dir, 'fixtures.json'), `${JSON.stringify(res, null, 1)}\n`);
console.log(Object.keys(res).join(' '));
