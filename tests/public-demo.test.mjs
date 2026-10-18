// The public demo is exported without any build output, and nam.wasm is built in CI. These tests cover the guard that
// scans every file (binaries included) and the assembler that places the CI-built wasm, each with a planted failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanTree, selfTest } from '../tools/public-guard.mjs';
import { assemble } from '../tools/assemble-site.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'public-demo-test-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
const word = (...parts) => parts.join(''); // keep banned words out of this file's own text

// A minimal valid wasm header plus padding, optionally with a symbol name in its string data.
const fakeWasm = (symbol = '') => Buffer.concat([Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]), Buffer.alloc(2048, 0), Buffer.from(symbol), Buffer.alloc(16, 0)]);

test('the guard catches every planted failure and passes a clean tree (its own self-test)', () => {
  assert.deepEqual(selfTest(), []);
});

test('the guard finds a home path inside a wasm binary, which a text-only guard would skip', () => {
  const dir = path.join(tmp, 'planted');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'nam.wasm'), fakeWasm(word('/Us', 'ers/someone/build/nam.cpp')));
  const { findings } = scanTree(dir);
  assert.ok(findings.length > 0 && findings.every((f) => f.file === 'nam.wasm' && f.how === 'strings'), JSON.stringify(findings));
});

test('the guard scans image metadata and JS bundles, and leaves ordinary binary data and musical pitches alone', () => {
  const dir = path.join(tmp, 'meta');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'a.png'), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from('tEXtSoftware\0' + word('/ho', 'me/someone/art') + ' render')]));
  fs.writeFileSync(path.join(dir, 'app.min.js'), 'x=1;//' + word('/Us', 'ers/someone/build') + '\n');
  fs.writeFileSync(path.join(dir, 'tune.html'), '<p>call ' + word('(417) 555-', '0142') + '</p>');
  const flagged = new Set(scanTree(dir).findings.map((f) => f.file));
  assert.deepEqual([...flagged].sort(), ['a.png', 'app.min.js', 'tune.html']);
  const quiet = path.join(tmp, 'quiet');
  fs.mkdirSync(quiet);
  fs.writeFileSync(path.join(quiet, 'font.woff2'), Buffer.concat([Buffer.from([0x77, 0x4f, 0x46, 0x32]), Buffer.from('xxA4|Y>\0lkA3lj\0')]));
  fs.writeFileSync(path.join(quiet, 'tune.html'), '<p>Concert A4 is 440 Hz</p>');
  assert.deepEqual(scanTree(quiet).findings, []);
});

test('the export carries no build output, carries the CI recipe, and passes the guard', () => {
  const out = path.join(tmp, 'export');
  execFileSync('node', [path.join(root, 'tools/export-public.mjs')], { cwd: root, env: { ...process.env, SQUATCH_PUBLIC_OUT: out }, stdio: 'pipe' });
  const wasms = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const a = path.join(d, e.name); if (e.isDirectory()) walk(a); else if (/\.wasm$/i.test(e.name)) wasms.push(path.relative(out, a)); } };
  walk(out);
  assert.deepEqual(wasms, [], 'a build output was exported');
  for (const f of ['wasm-src/PINS', 'wasm-src/ci-build.sh', 'wasm-src/experimental-fast.patch', '.github/workflows/pages.yml', 'tools/public-guard.mjs', 'tools/shape-reader.mjs', 'tools/register-shapes.json', 'tools/assemble-site.mjs', '.gitignore']) assert.ok(fs.existsSync(path.join(out, f)), `missing ${f}`);
  assert.deepEqual(scanTree(out).findings, []);
  assert.deepEqual(execFileSync('find', [out, '-name', 'VENDOR.json']).toString().trim(), '', 'vendoring bookkeeping (hash lists) is not exported');
  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
  assert.equal(manifest.wasm.targets.length, 2);
  assert.equal(manifest.wasm.experimentalTargets.length, 2);
  assert.ok([...manifest.wasm.targets, ...manifest.wasm.experimentalTargets].every((t) => !manifest.files.some((f) => f.file === t)), 'the wasm is listed before it is built');
  // The pinned recipe: a full commit, an exact emsdk, and a patch with the renamed experimental path only.
  const pins = fs.readFileSync(path.join(out, 'wasm-src/PINS'), 'utf8');
  assert.match(pins, /^NAM_CORE_COMMIT=[0-9a-f]{40}$/m);
  assert.match(pins, /^EMSDK_COMMIT=[0-9a-f]{40}$/m);
  assert.match(pins, /^EMSDK_VERSION=\d+\.\d+\.\d+$/m);
  // Assemble with a stand-in wasm: placed at both targets and listed with its digest.
  const built = path.join(tmp, 'nam.wasm');
  fs.writeFileSync(built, fakeWasm('create_experimental_fast_config'));
  const site = path.join(tmp, 'site');
  const builtExp = path.join(tmp, 'nam-experimental.wasm');
  fs.writeFileSync(builtExp, fakeWasm('create_experimental_fast_config + experimental'));
  const res = assemble({ wasm: built, experimental: builtExp, src: out, out: site });
  for (const t of [...manifest.wasm.targets, ...manifest.wasm.experimentalTargets]) assert.ok(fs.existsSync(path.join(site, t)), `not placed: ${t}`);
  const placed = JSON.parse(fs.readFileSync(path.join(site, 'manifest.json'), 'utf8')).files.filter((f) => f.sha256 === res.sha256);
  assert.equal(placed.length, 2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(site, 'manifest.json'), 'utf8')).files.filter((f) => f.sha256 === res.expSha256).length, 2);
  assert.notEqual(res.sha256, res.expSha256);
  // Planted failure 0: only one of the two builds is supplied.
  assert.throws(() => assemble({ wasm: built, src: out, out: path.join(tmp, 'site-bad0') }), /both builds/);
  assert.ok(!fs.existsSync(path.join(site, 'tools')) && !fs.existsSync(path.join(site, 'wasm-src')) && !fs.existsSync(path.join(site, '.github')));
  // Planted failure 1: the build carries a home path.
  const bad = path.join(tmp, 'bad.wasm');
  fs.writeFileSync(bad, fakeWasm(word('/Us', 'ers/someone/model.cpp')));
  assert.throws(() => assemble({ wasm: bad, experimental: builtExp, src: out, out: path.join(tmp, 'site-bad') }), /public guard/);
  // Planted failure 2: a built .wasm is committed to the source tree.
  fs.writeFileSync(path.join(out, 'wasm/nam.wasm'), fakeWasm());
  assert.throws(() => assemble({ wasm: built, experimental: builtExp, src: out, out: path.join(tmp, 'site-bad2') }), /committed/);
  // Planted failure 3: not a wasm at all.
  fs.rmSync(path.join(out, 'wasm/nam.wasm'));
  fs.writeFileSync(bad, 'not wasm'.repeat(300));
  assert.throws(() => assemble({ wasm: bad, experimental: builtExp, src: out, out: path.join(tmp, 'site-bad3') }), /not a WebAssembly/);
});

test('the public export never probes for private devices (a 404 is a console error on every load)', () => {
  const stub = fs.readFileSync(path.join(root, 'tools/export-public.mjs'), 'utf8');
  assert.match(stub, /write\('js\/private-devices\.js'/);
  assert.ok(!/import\(/.test(stub.slice(stub.indexOf("write('js/private-devices.js'"), stub.indexOf("write('js/private-devices.js'") + 400)));
});
