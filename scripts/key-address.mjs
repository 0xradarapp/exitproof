// Print the address of the private key stored in a file, without the key ever appearing in argv or output.
//   node scripts/key-address.mjs <key file>
// The file must hold one 32-byte hex key (0x optional) and must not be readable by group or others (chmod 600).
import fs from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';

const file = process.argv[2];
if (!file) { console.error('usage: node scripts/key-address.mjs <key file>'); process.exit(2); }
try {
  if ((fs.statSync(file).mode & 0o077) !== 0) throw new Error(file + ' is readable by group/others: chmod 600 it');
  let k = fs.readFileSync(file, 'utf8').trim();
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(k)) throw new Error(file + ' does not hold a 32-byte hex key');
  if (!k.startsWith('0x')) k = '0x' + k;
  console.log(privateKeyToAccount(k).address);
} catch (e) {
  console.error('key-address: ' + e.message);
  process.exit(1);
}
