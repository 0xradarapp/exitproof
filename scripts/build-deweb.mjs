// Builds the DeWEB copy of web/ into dist/deweb/: the files TapeKit serves from our circuit's ERC-6551 container.
//
//   node scripts/build-deweb.mjs                      → dist/deweb/ from deployments/xlayer.json (mainnet)
//   DEPLOYMENT=fork node scripts/build-deweb.mjs      → same, embedding deployments/fork.json (fork rehearsal only)
// Prints every file, its size and sha256, and the total; writes dist/deweb.manifest.json (network, config hash, the
// router/registry/processor/circuitId it embedded, every file's sha256), which publish-deweb.mjs checks against
// deployments/<network>.json before it publishes anything.
//
// What it does to web/:
//   - index.html gets style.css (comments and indentation stripped), verdict.js + app.js (one inline module) and the
//     config inlined, the favicon as a data: URI, and a CSP that allows exactly those inline blocks (sha256 hashes)
//     and only the RPC host(s) of the mainnet config;
//   - vendor/ethers.min.js (byte-identical to the npm tarball, sha384 checked) and the woff2 fonts the CSS uses stay
//     separate files (no base64 inflation), with their licenses next to them;
//   - config: only the "xlayer" network (RPC https://rpc.xlayer.tech), filled from deployments/<DEPLOYMENT>.json when
//     it exists (else the pending state of web/config.json: router/registry null, the page shows "not deployed yet",
//     and publish-deweb.mjs refuses the build).
// Checks (the build fails on any): TapeKit's "100% on-chain" static rule (no off-chain URL in src/href/…, srcset,
// CSS url() or @import, meta refresh), every site-internal reference is relative and resolves to a built file, no
// loopback RPC in the config or CSP, the inline module parses, and no file exceeds the SiteRegistry limit.
// Nothing outside dist/ is written.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');
const OUT = path.join(ROOT, 'dist', 'deweb');
const ETHERS_SHA384 = '6Zl0Pc8zjSz8KvmNeXRvUQgY4ryFb+BwDvKCmLYcBME0joAaru491tQgi9B7zsMM'; // ethers 6.13.4 dist/ethers.umd.min.js
const MAX_FILE = 350 * 24_000; // SiteRegistry CHUNKS_MAX × CHUNK_MAX
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const b64sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('base64');
const read = (p) => fs.readFileSync(path.join(WEB, p), 'utf8');
const fail = (m) => { console.error('BUILD FAILED: ' + m); process.exit(1); };
const replaceOnce = (s, from, to, what) => {
  const n = s.split(from).length - 1;
  if (n !== 1) fail(`expected exactly one ${what} in the source, found ${n}`);
  return s.replace(from, () => to);
};

// ---- config: mainnet only
const webCfg = JSON.parse(read('config.json'));
const xl = { ...webCfg.networks.xlayer };
const NETWORK = process.env.DEPLOYMENT || 'xlayer';
if (!['xlayer', 'fork'].includes(NETWORK)) fail('DEPLOYMENT must be xlayer or fork');
const depFile = path.join(ROOT, 'deployments', NETWORK + '.json');
let source = 'web/config.json (pending: no deployments/' + NETWORK + '.json)';
if (fs.existsSync(depFile)) {
  const d = JSON.parse(fs.readFileSync(depFile, 'utf8'));
  for (const k of ['router', 'registry', 'processor', 'circuitId']) if (d[k] !== undefined && d[k] !== null) xl[k] = String(d[k]);
  if (d.feeBps !== undefined) xl.feeBps = d.feeBps;
  source = 'deployments/' + NETWORK + '.json';
}
if (!/^https:\/\//.test(xl.rpc)) fail('networks.xlayer.rpc must be an https URL, got ' + xl.rpc);
const config = { defaultNetwork: 'xlayer', networks: { xlayer: xl } };
const rpcOrigin = new URL(xl.rpc).origin;

// ---- CSS: comments out, indentation and blank lines out (no string in style.css contains "/*")
let css = read('style.css');
const fontRefs = [...css.matchAll(/url\(([^)]+)\)/g)].map((m) => m[1].replace(/^['"]|['"]$/g, ''));
css = css.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.trim()).filter(Boolean).join('\n');

// ---- JS: verdict.js + app.js as one module (no bundler needed: app.js imports only verdict.js)
const verdict = read('verdict.js').replace(/^export (?=(?:async )?(?:function|const|let|class) )/gm, '');
if (/^\s*export\b/m.test(verdict)) fail('verdict.js has an export form this build does not inline');
let app = read('app.js');
app = replaceOnce(app, (app.match(/^import \{[^}]+\} from '\.\/verdict\.js';\n/m) || ['<missing verdict.js import>'])[0], '', 'verdict.js import');
if (/^\s*import\b/m.test(app) || /\bimport\(/.test(app)) fail('app.js has an import this build does not inline');
app = replaceOnce(app, "await (await fetch('./config.json', { cache: 'no-store' })).json()",
  JSON.stringify(config), 'config.json fetch');
const js = `${verdict}\n${app}`;
if (/<\/script/i.test(js) || /<!--/.test(js)) fail('inline JS contains </script or <!--');
const tmp = path.join(fs.mkdtempSync(path.join((process.env.TMPDIR || '/tmp'), 'deweb-')), 'module.mjs');
fs.writeFileSync(tmp, js);
try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); } catch (e) { fail('inline module does not parse: ' + e.stderr); }
fs.rmSync(path.dirname(tmp), { recursive: true });

// ---- HTML
const favicon = 'data:image/svg+xml;base64,' + Buffer.from(read('favicon.svg')).toString('base64');
const csp = [
  "default-src 'none'",
  `script-src 'self' 'sha256-${b64sha256(js)}'`,
  `style-src 'sha256-${b64sha256(css)}'`,
  "font-src 'self'",
  "img-src 'self' data:",
  `connect-src ${rpcOrigin}`,
  "base-uri 'none'",
  "form-action 'none'"
].join('; ');
let html = read('index.html').replace(/<!--[\s\S]*?-->\n?/g, '');
html = html.replace(/<meta http-equiv="Content-Security-Policy" content="[^"]*">/, () => `<meta http-equiv="Content-Security-Policy" content="${csp}">`);
if (!html.includes(csp)) fail('CSP meta tag not found in web/index.html');
html = replaceOnce(html, '<link rel="icon" href="favicon.svg" type="image/svg+xml">', `<link rel="icon" href="${favicon}" type="image/svg+xml">`, 'favicon link');
html = replaceOnce(html, '<link rel="stylesheet" href="style.css">', `<style>${css}</style>`, 'stylesheet link');
html = replaceOnce(html, '<script type="module" src="app.js"></script>', `<script type="module">${js}</script>`, 'app.js script tag');

// ---- files
const files = new Map(); // site path -> Buffer
files.set('index.html', Buffer.from(html, 'utf8'));
const ethers = fs.readFileSync(path.join(WEB, 'vendor/ethers.min.js'));
if (crypto.createHash('sha384').update(ethers).digest('base64') !== ETHERS_SHA384) fail('web/vendor/ethers.min.js is not the pinned ethers 6.13.4 build');
files.set('vendor/ethers.min.js', ethers);
files.set('vendor/ethers.LICENSE.md', fs.readFileSync(path.join(WEB, 'vendor/ethers.LICENSE.md')));
for (const f of fontRefs) files.set(f, fs.readFileSync(path.join(WEB, f)));
files.set('fonts/OFL.txt', fs.readFileSync(path.join(WEB, 'fonts/OFL.txt')));

// ---- checks
const ATTR = /\b(?:src|href|action|poster|data|formaction|background)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
const SRCSET = /\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi;
const CSS_IMPORT = /@import\s+(?:"([^"]*)"|'([^']*)')/gi;
const META_REFRESH = /<meta[^>]+http-equiv\s*=\s*["']?refresh[^>]*content\s*=\s*["'][^"']*url=([^"'>\s]+)/gi;
const external = (u) => /^(?:https?|wss?|ftp):/i.test(u.trim()) || u.trim().startsWith('//');
const grab = (re, text) => {
  const out = []; re.lastIndex = 0; let m;
  while ((m = re.exec(text))) {
    const v = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (v) out.push(...(re === SRCSET ? v.split(',').map((s) => s.trim().split(/\s+/)[0]) : [v]));
  }
  return out;
};
const refs = [ATTR, SRCSET, CSS_URL, CSS_IMPORT, META_REFRESH].flatMap((re) => grab(re, html));
const off = refs.filter(external);
if (off.length) fail('off-chain reference(s) in index.html (TapeKit static rule): ' + off.join(', '));
// Internal references: the markup (inline script bodies left out: TapeKit's attribute regex also matches JS such
// as \`data = …\`) plus the CSS url()s.
const markup = html.replace(/(<script\b[^>]*>)[\s\S]*?(<\/script>)/gi, '$1$2');
const siteRefs = [ATTR, SRCSET, CSS_URL, CSS_IMPORT, META_REFRESH].flatMap((re) => grab(re, markup));
const internal = [];
for (const r of siteRefs) {
  if (/^(data:|blob:|#|mailto:|tel:|javascript:|about:)/i.test(r)) continue;
  if (r.startsWith('/')) fail('absolute path reference: ' + r + ' (must be relative)');
  const p = decodeURIComponent(new URL(r, 'https://site.invalid/').pathname).replace(/^\/+/, '') || 'index.html';
  const target = p.endsWith('/') ? p + 'index.html' : p;
  if (!files.has(target)) fail(`reference "${r}" does not resolve to a built file (${target})`);
  internal.push(r + ' → ' + target);
}
const loop = /127\.0\.0\.1|localhost|\[::1\]/;
if (loop.test(JSON.stringify(config)) || loop.test(csp)) fail('loopback address in the DeWEB config or CSP');
for (const [p, b] of files) if (b.length > MAX_FILE) fail(`${p} is ${b.length} bytes, over the ${MAX_FILE}-byte SiteRegistry limit`);

// ---- write
fs.rmSync(OUT, { recursive: true, force: true });
for (const [p, b] of files) { fs.mkdirSync(path.dirname(path.join(OUT, p)), { recursive: true }); fs.writeFileSync(path.join(OUT, p), b); }
const embedded = Object.fromEntries(['router', 'registry', 'processor', 'circuitId'].map((k) => [k, xl[k] ?? null]));
const manifest = {
  network: NETWORK, source, configSha256: sha256(JSON.stringify(config)), embedded,
  files: Object.fromEntries([...files].sort((a, b) => a[0].localeCompare(b[0])).map(([p, b]) => [p, sha256(b)]))
};
fs.writeFileSync(path.join(ROOT, 'dist', 'deweb.manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
const pending = Object.entries(embedded).filter(([, v]) => v === null || v === undefined).map(([k]) => k);

let total = 0;
console.log('dist/deweb/  (config: ' + source + '; RPC ' + rpcOrigin + '; router ' + xl.router + ')\n');
for (const [p, b] of [...files].sort((a, b) => a[0].localeCompare(b[0]))) {
  total += b.length;
  console.log(`  ${p.padEnd(42)} ${String(b.length).padStart(8)}  ${sha256(b)}`);
}
console.log(`  ${'TOTAL (' + files.size + ' files)'.padEnd(42)} ${String(total).padStart(8)}`);
console.log('\nreferences   ' + internal.length + ' relative, all resolve: ' + [...new Set(internal)].join(', '));
console.log('static rule  on-chain pure (no off-chain src/href/srcset/url()/@import/meta refresh)');
console.log('CSP          ' + csp.replace(/'sha256-[^']+'/g, "'sha256-…'"));
console.log('manifest     dist/deweb.manifest.json · ' + NETWORK + ' · config sha256 ' + manifest.configSha256.slice(0, 16) + '… · ' +
  (pending.length ? 'PENDING (' + pending.join(', ') + ' empty): publish-deweb.mjs will refuse this build' : 'router ' + embedded.router + ', registry ' + embedded.registry + ', processor ' + embedded.processor + ' #' + embedded.circuitId));
