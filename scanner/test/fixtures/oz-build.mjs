// Builds real OpenZeppelin Contracts v5 tokens (ERC20 + ERC20Permit + Ownable) for the v9 "standard OZ bodies stay
// clean" tests -> oz-fixtures.json (committed; tests need no compiler). OZ is MIT; point OZ_DIR at a checkout:
//   OZ_DIR=/path/to/openzeppelin-contracts node scanner/test/fixtures/oz-build.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const OZ = process.env.OZ_DIR;
if (!OZ || !existsSync(path.join(OZ, 'contracts'))) throw new Error('set OZ_DIR to an openzeppelin-contracts checkout');
const solc = process.env.SOLC ?? path.join(homedir(), '.svm/0.8.24/solc-0.8.24');
const version = JSON.parse(readFileSync(path.join(OZ, 'package.json'), 'utf8')).version;
const src = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
contract OzPlain is ERC20 { constructor(address pair, uint256 liq, uint256 rest) ERC20("OzPlain", "OZP") { _mint(pair, liq); _mint(msg.sender, rest); } }
contract OzPermit is ERC20Permit { constructor(address pair, uint256 liq, uint256 rest) ERC20("OzPermit", "OZPM") ERC20Permit("OzPermit") { _mint(pair, liq); _mint(msg.sender, rest); } }
contract OzOwnedPermit is ERC20Permit, Ownable { constructor(address pair, uint256 liq, uint256 rest) ERC20("OzOwned", "OZO") ERC20Permit("OzOwned") Ownable(msg.sender) { _mint(pair, liq); _mint(msg.sender, rest); } }
`;
const input = {
  language: 'Solidity',
  sources: { 'OzFixtures.sol': { content: src } },
  settings: {
    optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', remappings: ['@openzeppelin/contracts/=contracts/'],
    outputSelection: { 'OzFixtures.sol': { '*': ['abi', 'evm.bytecode.object'] } },
  },
};
const out = JSON.parse(execFileSync(solc, ['--standard-json', '--base-path', OZ, '--allow-paths', OZ], { input: JSON.stringify(input), cwd: OZ }));
const errs = (out.errors ?? []).filter((e) => e.severity === 'error');
if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join('\n'));
const res = { _openzeppelin: version };
for (const [name, c] of Object.entries(out.contracts['OzFixtures.sol'])) res[name] = { abi: c.abi, bytecode: `0x${c.evm.bytecode.object}` };
writeFileSync(path.join(dir, 'oz-fixtures.json'), `${JSON.stringify(res)}\n`);
console.log(`OpenZeppelin ${version}:`, Object.keys(res).filter((k) => k[0] !== '_').join(' '));
