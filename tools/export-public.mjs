#!/usr/bin/env node
// Build a static, rights-reviewed demo from an explicit source allowlist.
// The private Spark captures, their index entries and research pages never
// cross into dist/public-demo. This directory can be served from any base path.
//
// Build outputs are never exported (owner, 2026-10-15). nam.wasm is built in the demo repo's CI from the pinned sources in
// wasm-src/ (see wasm/PINS), placed by tools/assemble-site.mjs, scanned by tools/public-guard.mjs, attested and deployed.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanTree } from './public-guard.mjs';
// The private-name gate and the scrub rules exist only in the development repository. The exported copy of this tool
// (it builds the site in the public repository's CI) has neither: its public guard is the whole check there.
const dev = (name) => (fs.existsSync(new URL(`./${name}`, import.meta.url)) ? import(`./${name}`) : null);
const scrub = await dev('export-scrub.mjs');
const privateGuard = await dev('private-guard.mjs');
const scrubbed = scrub ? scrub.scrubbed : (file, bytes) => bytes;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.env.SQUATCH_PUBLIC_OUT || path.join(root, 'dist/public-demo'));
const tracked = execFileSync('git', ['ls-files', '-z', 'web'], { cwd: root }).toString().split('\0').filter(Boolean);
const extra = ['web/js/graph/demo-public.js', 'web/js/graph/quick-sounds.js'];
const allowed = [...new Set([...tracked, ...extra])].filter((file) => {
  if (!fs.existsSync(path.join(root, file))) return false;
  if (['web/listen.html', 'web/js/listen.js', 'web/js/home-link.js', 'web/css/listen.css', 'web/js/graph/demo.js', 'web/wasm/build-info.json', 'web/wasm/nam.wasm', 'web/wasm/nam-experimental.wasm'].includes(file)) return false;
  if (file === 'web/models/index.json') return false;
  if (/(^|\/)VENDOR\.json$/.test(file)) return false; // vendoring bookkeeping: a list of file hashes that secret scanners read as keys, unused at runtime
  if (/^web\/models\/.*\.nam$/i.test(file)) return /^web\/models\/namcore-example-A[12]\.nam$/.test(file);
  return true;
});
const design = [
  'design/skin.brush-ink.json',
  'design/assets/brush/generated/A-stroke-settle.json',
  'design/assets/brush/generated/B-enso-settle.json',
  ...fs.readdirSync(path.join(root, 'design/assets/devices')).filter((name) => name.endsWith('.svg')).map((name) => `design/assets/devices/${name}`),
  // The pedal plates the default skin draws (design/skin.brush-ink.json, "plate"); SOURCE.json stays private.
  ...fs.readdirSync(path.join(root, 'design/assets/plates')).filter((name) => name.endsWith('.svg')).map((name) => `design/assets/plates/${name}`),
];
const screens = ['docs/screens/rig-light.png', 'docs/screens/rig-dark.png', 'docs/screens/rig-phone.png',
  // the README's pictures: screenshots of the page, and figures drawn from the effect kernels (tools/readme-figures.mjs)
  ...fs.readdirSync(path.join(root, 'docs/readme')).filter((name) => /^(rig-.*\.jpg|fig-.*\.svg)$/.test(name)).map((name) => `docs/readme/${name}`)];
for (const file of [...allowed, ...design, ...screens, 'LICENSE']) if (!fs.statSync(path.join(root, file)).isFile()) throw new Error(`missing source file: ${file}`);
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const copy = (src, dest) => {
  const target = path.join(out, dest);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, scrubbed(src, fs.readFileSync(path.join(root, src))), { mode: fs.statSync(path.join(root, src)).mode & 0o777 });
};
for (const file of allowed) copy(file, file.slice('web/'.length));
for (const file of design) copy(file, file);
for (const file of screens) copy(file, file);
copy('LICENSE', 'LICENSE');
// The sources CI builds nam.wasm from, the guard and the assembler it runs, and the workflow itself.
const buildSources = ['wasm/PINS', 'wasm/build.sh', 'wasm/ci-build.sh', 'wasm/nam_wasm.cpp', 'wasm/experimental-fast.patch'];
for (const file of buildSources) copy(file, `wasm-src/${path.basename(file)}`);
for (const tool of ['public-guard.mjs', 'shape-reader.mjs', 'register-shapes.json', 'assemble-site.mjs']) copy(`tools/${tool}`, `tools/${tool}`);
copy('tools/public-demo/pages.yml', '.github/workflows/pages.yml');
copy('tools/public-demo/gitignore', '.gitignore');
// web/wasm/ holds no binary here: CI places the builds at wasm/ and at <assetBase>/wasm/ (nam.wasm, nam-experimental.wasm).
fs.mkdirSync(path.join(out, 'wasm'), { recursive: true });
fs.writeFileSync(path.join(out, 'wasm/.gitkeep'), '');

const write = (file, content) => { fs.mkdirSync(path.dirname(path.join(out, file)), { recursive: true }); fs.writeFileSync(path.join(out, file), content); };
const models = JSON.parse(fs.readFileSync(path.join(root, 'web/models/index.json'), 'utf8')).models
  .filter((entry) => /^namcore-example-A[12]\.nam$/.test(entry.file));
if (models.length !== 2) throw new Error('expected exactly two NAM Core example models');
for (const model of models) {
  const bytes = fs.readFileSync(path.join(out, 'models', model.file));
  const hash = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
  if (hash !== model.hash) throw new Error(`model hash mismatch: ${model.file}`);
}
write('models/index.json', JSON.stringify({ models }, null, 2) + '\n');

// Keep the public bundle independent of the private multi-head demo and local
// hub URL. Relative imports keep GitHub Pages project paths working.
const main = fs.readFileSync(path.join(out, 'js/main.js'), 'utf8').replace("from './graph/demo.js'", "from './graph/demo-public.js'");
const sounds = fs.readFileSync(path.join(out, 'js/graph/quick-sounds.js'), 'utf8').replace("from './demo.js'", "from './demo-public.js'");
if (main.includes("from './graph/demo.js'") || sounds.includes("from './demo.js'")) throw new Error('private demo import survived');
write('js/main.js', main);
write('js/graph/quick-sounds.js', sounds);
// The public site mounts no private devices, so it must not probe for them (a 404 is a console error on every load).
write('js/private-devices.js', "// The public site has no private devices.\nexport const privateDevices = { workletUrls: [], addable: [] };\nexport async function loadPrivateDevices() { return privateDevices; }\n");
// Pages serves files with a ten-minute browser cache. Keep the stable paths
// for tabs already running an older build, but point each new HTML document at
// a content-addressed asset tree. Every relative ES import, worklet, model,
// loop, font and design URL then belongs to the same release.
const assetDirs = ['audio', 'css', 'design', 'fonts', 'img', 'js', 'models', 'vendor', 'wasm', 'worklets'];
const assetFiles = [];
const collect = (dir) => {
  for (const item of fs.readdirSync(path.join(out, dir), { withFileTypes: true })) {
    const rel = `${dir}/${item.name}`;
    if (item.isDirectory()) collect(rel);
    else assetFiles.push(rel);
  }
};
for (const dir of assetDirs) collect(dir);
const assetHash = crypto.createHash('sha256');
for (const file of assetFiles.sort()) assetHash.update(file + '\0').update(fs.readFileSync(path.join(out, file)));
// nam.wasm is built later, so its content address is its recipe: every pinned input and build script.
for (const file of buildSources) assetHash.update(`wasm-src/${path.basename(file)}\0`).update(fs.readFileSync(path.join(root, file)));
const assetBase = `assets/${assetHash.digest('hex').slice(0, 12)}`;
for (const dir of assetDirs) fs.cpSync(path.join(out, dir), path.join(out, assetBase, dir), { recursive: true });
const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8')
  .replace(/<script type="module" src="js\/home-link\.js"><\/script>\n/, '')
  .replace(/<a class="home-link"[^>]*>.*?<\/a>/, '<a class="home-link" href="https://squatch.cc/" aria-label="Squatch Stack"><span aria-hidden="true">←</span><span class="home-label"> Squatch Stack</span></a>')
  .replace('href="css/app.css"', `href="${assetBase}/css/app.css"`)
  .replace('href="css/transport.css"', `href="${assetBase}/css/transport.css"`)
  .replace('"./vendor/pixi.mjs"', `"./${assetBase}/vendor/pixi.mjs"`)
  .replace('src="js/main.js"', `src="${assetBase}/js/main.js"`);
if (html.includes('data-squatch-home') || html.includes('home-link.js')) throw new Error('private hub link survived');
write('index.html', html);
write('.nojekyll', '');
write('README.md', fs.readFileSync(path.join(root, 'tools/public-demo/README.md'), 'utf8').replaceAll('{{ASSET_BASE}}', assetBase));

const files = [];
const walk = (dir) => {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, item.name);
    if (item.isDirectory()) walk(absolute);
    else files.push(path.relative(out, absolute));
  }
};
walk(out);
// Every exported file, binaries included, is scanned by tools/public-guard.mjs (home paths, the secrets folder, personal-data shapes).
// The same guard runs again in CI on the finished site, with nam.wasm in it.
{
  const { findings } = scanTree(out);
  if (findings.length) throw new Error(`public guard: ${findings.map((f) => `${f.file}: ${f.pattern}`).join('; ')}`);
}
// The private register's names and the owner's personal terms are checked only here, in the development repository
// (tools/private-guard.mjs); the public guard above carries no names by design. The register is outside every repo.
if (privateGuard) await privateGuard.assertNoPrivate(out);
const manifest = files.sort().map((file) => {
  const bytes = fs.readFileSync(path.join(out, file));
  return { file, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
});
write('manifest.json', JSON.stringify({ format: 'squatch-rig/public-demo', wasm: { targets: ['wasm/nam.wasm', `${assetBase}/wasm/nam.wasm`], experimentalTargets: ['wasm/nam-experimental.wasm', `${assetBase}/wasm/nam-experimental.wasm`], recipe: 'wasm-src/PINS' }, files: manifest }, null, 2) + '\n');
console.log(JSON.stringify({ output: out, files: manifest.length + 1, bytes: manifest.reduce((sum, item) => sum + item.bytes, 0), models: models.map((model) => model.file) }));
