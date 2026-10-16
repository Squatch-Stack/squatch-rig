// Milestone 1 of the theme-support plan, the Node half: the vendored Brush skin package is accepted
// by squatch-skin's own validator, the layout the canvas draws the Trail OD from is the layout the
// skin ships and the contract agrees with, and a tampered package is refused.
// The browser half is tools/skin-check.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadPackage, layoutFor, faceGeometry, skinTokens, substitute, tokensIn, REFUSED } from '../web/js/ui/skin-package.js';
import { flatten, resolve, applyOverrides } from '../web/vendor/squatch-skin/lib/tokens.mjs';
import { productFromContract } from '../web/vendor/squatch-skin/lib/contract.mjs';
import { TYPES, faceOf } from '../web/js/graph/types.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = path.join(root, 'web/vendor/squatch-skin');
const PKG = path.join(root, 'design/skins/brush');
const ID = 'cc.squatch.skin.brush';
const sha256 = async (b) => new Uint8Array(crypto.createHash('sha256').update(b).digest());
const reader = (dir) => async (rel) => {
  const p = path.resolve(dir, rel);
  if (!p.startsWith(dir + path.sep)) throw new Error('outside the package');
  return new Uint8Array(fs.readFileSync(p));
};
const load = (dir = PKG, id = ID) => loadPackage(id, { readVendor: reader(VENDOR), readPackage: reader(dir), sha256 });
const EIGHT = ['art/face.svg', 'art/footswitch.svg', 'art/knob.svg', 'art/led-off.svg', 'art/led-on.svg', 'art/pointer.svg', 'fonts/OFL.txt', 'fonts/lora-latin-italic-var.woff2'];
// The device box the canvas gives an overdrive: design/skin.brush-ink.json scales the 150 x 250 art by 0.8.
const BOX = { w: 120, h: 200 };

// VENDOR.json (the hash list tools/vendor-skin.mjs writes against the skin repository) and that tool are not in the public tree.
const vendorJson = path.join(VENDOR, 'VENDOR.json');
const haveVendorJson = fs.existsSync(vendorJson) && fs.existsSync(path.join(root, 'tools/vendor-skin.mjs'));
test('every vendored squatch-skin file matches VENDOR.json byte for byte', { skip: !haveVendorJson && 'VENDOR.json and tools/vendor-skin.mjs are not in the public tree' }, async () => {
  const { FILES } = await import('../tools/vendor-skin.mjs');
  const m = JSON.parse(fs.readFileSync(path.join(VENDOR, 'VENDOR.json'), 'utf8'));
  assert.equal(Object.keys(m.files).length, FILES.length);
  for (const [, dest] of FILES) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root, dest))).digest('hex'), m.files[dest], dest);
});

test('the vendored Brush package is accepted, lays out only the Trail OD, and all 8 files hash-match', async () => {
  const r = await load();
  assert.equal(r.ok, true, r.errors.join('\n'));
  assert.equal(r.label, 'Brush skin');
  assert.deepEqual(r.report.products, ['cc.squatch.trail-od']);
  assert.deepEqual(r.report.files.map((f) => f.path).sort(), [...EIGHT].sort());
  for (const rel of EIGHT) {
    const got = `sha256-${crypto.createHash('sha256').update(fs.readFileSync(path.join(PKG, rel))).digest('base64')}`;
    assert.equal(r.manifest.files[rel], got, rel);
  }
});

test('the layout the canvas draws is the one the skin ships: 66 x 122 mm 125B, knobs >= 10 mm, 2 mm apart, on the face', async () => {
  const { manifest, products } = await load();
  const product = products.get(TYPES.overdrive.contract);
  const L = layoutFor(manifest, product);
  assert.equal(L, manifest.layouts['cc.squatch.trail-od'], 'product id wins over form:3-knob');
  assert.deepEqual(L.face, { width: 66, height: 122, unit: 'mm', enclosure: '125B' });
  assert.ok(L.footswitch && L.led);
  const circles = [...['drive', 'tone', 'level'].map((k) => ({ k, ...L.controls[k] })), { k: 'footswitch', ...L.footswitch }, { k: 'led', ...L.led }];
  for (const c of circles.slice(0, 3)) assert.ok(c.d >= 10, `${c.k} ${c.d} mm`);
  for (const c of circles) assert.ok(c.x - c.d / 2 >= 0 && c.y - c.d / 2 >= 0 && c.x + c.d / 2 <= 66 && c.y + c.d / 2 <= 122, `${c.k} inside the face`);
  for (let i = 0; i < circles.length; i++) for (let j = i + 1; j < circles.length; j++) {
    const [a, b] = [circles[i], circles[j]];
    assert.ok(Math.hypot(a.x - b.x, a.y - b.y) - a.d / 2 - b.d / 2 >= 2, `${a.k}/${b.k} clearance`);
  }
  // and the canvas geometry: the face fits the overdrive's box, centred, and every part is the layout x one scale
  const G = faceGeometry(L, product, BOX);
  assert.equal(G.mm, Math.min(BOX.w / 66, BOX.h / 122));
  assert.ok(G.face.x >= 0 && G.face.y >= 0 && G.face.x + G.face.w <= BOX.w + 1e-9 && G.face.y + G.face.h <= BOX.h + 1e-9);
  assert.ok(Math.abs(G.face.x - (BOX.w - G.face.w) / 2) < 1e-9);
  for (const q of G.knobs) {
    const s = L.controls[q.key];
    assert.ok(Math.abs(q.x - (G.face.x + s.x * G.mm)) < 1e-9 && Math.abs(q.y - (G.face.y + s.y * G.mm)) < 1e-9 && Math.abs(q.r - (s.d / 2) * G.mm) < 1e-9, q.key);
  }
  assert.deepEqual([G.footswitch.x, G.footswitch.y, G.led.x, G.led.y].map((v) => +v.toFixed(6)),
    [G.face.x + 33 * G.mm, G.face.y + 104 * G.mm, G.face.x + 33 * G.mm, G.face.y + 90 * G.mm].map((v) => +v.toFixed(6)));
});

test('the contract and the layout agree in both directions, and the rig face is the contract\'s knobs', async () => {
  const { manifest } = await load();
  const product = productFromContract(JSON.parse(fs.readFileSync(path.join(VENDOR, 'contracts/trail-od.oscquery.json'), 'utf8')));
  assert.equal(TYPES.overdrive.contract, product.id);
  const knobs = product.params.filter((p) => p.kind === 'knob').map((p) => p.key);
  assert.deepEqual(knobs, ['drive', 'tone', 'level']);
  assert.deepEqual(Object.keys(manifest.layouts[product.id].controls).sort(), [...knobs].sort());
  assert.deepEqual(faceOf({ type: 'overdrive', params: {} }), knobs);
  // the ranges the canvas will drive the knobs with
  const by = Object.fromEntries(product.params.map((p) => [p.key, p]));
  assert.deepEqual([by.drive.min, by.drive.max, by.drive.default, by.level.min, by.level.max, by.level.default], [0, 1, 0.5, -30, 12, -6]);
});

test('every token the art binds exists in light and dark; the drawn art keeps no var() and changes nothing else', async () => {
  const { manifest, texts, theme } = await load();
  const names = new Set(Object.values(texts).flatMap(tokensIn));
  assert.ok(names.size >= 8, [...names].join(' '));
  const drawn = {};
  for (const mode of ['light', 'dark']) {
    const V = skinTokens(theme, manifest, mode);
    for (const n of names) assert.ok(V.has(n), `${n} in ${mode}`);
    const s = substitute(texts['art/face.svg'], V);
    assert.deepEqual(s.unresolved, []);
    assert.ok(!s.text.includes('var('));
    // outside the substituted colours the faceplate is byte-identical to the package's file
    const strip = (t) => t.replace(/var\(\s*--sq-[a-z0-9-]+\s*,\s*#[0-9A-Fa-f]{3,8}\s*\)|#[0-9A-Fa-f]{6}/g, '#');
    assert.equal(strip(s.text), strip(texts['art/face.svg']));
    drawn[mode] = s.text;
  }
  assert.notEqual(drawn.light, drawn.dark, 'one file, two looks');
});

test('the skin\'s overrides are exactly component.legend.type and component.knob.ring-width (4.5px)', async () => {
  const { manifest, theme } = await load();
  const base = resolve(theme.tokens, 'light');
  const skinned = resolve(applyOverrides(theme.tokens, manifest.tokens).tokens, 'light');
  const changed = [...base.keys()].filter((k) => JSON.stringify(base.get(k)) !== JSON.stringify(skinned.get(k))).sort();
  assert.deepEqual(changed, ['component.knob.ring-width', 'component.legend.type']);
  assert.equal(skinTokens(theme, manifest, 'light').get('--sq-comp-knob-ring-width'), '4.5px');
  assert.equal(skinTokens(theme, null, 'light').get('--sq-comp-knob-ring-width'), '3px');
  assert.equal(skinTokens(theme, manifest, 'dark').get('--sq-comp-legend-type-font-style'), 'italic');
});

test('negative control: a tampered vendored file is refused, and the rig calls it "a refused skin"', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-skin-'));
  try {
    fs.cpSync(PKG, tmp, { recursive: true });
    const face = path.join(tmp, 'art/face.svg');
    fs.writeFileSync(face, fs.readFileSync(face, 'utf8').replace('#F7F5F0', '#F7F5F1')); // one fallback digit
    const r = await load(fs.realpathSync(tmp));
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.startsWith('files: "art/face.svg" hash mismatch')), r.errors.join('\n'));
    assert.equal(r.label, REFUSED);
    assert.deepEqual(r.texts, {}, 'a refused package hands the canvas no art');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  // asked for one id, served another package: refused too
  const other = await load(PKG, 'cc.squatch.skin.machined');
  assert.equal(other.ok, false);
  assert.equal(other.label, REFUSED);
  // and nothing outside cc.squatch.skin.* is a package at all
  assert.equal((await load(PKG, 'com.example.skin.brush')).ok, false);
});
