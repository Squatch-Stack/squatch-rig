// Pedal plates (web/js/ui/plates.js): the owner-approved plates ship byte for byte, every plated device in the
// default skin points at one, the composed device puts its anchor slots on the rings the plate draws, and the
// plate's own markup reaches the canvas unchanged apart from its colour classes. Negative controls: a changed
// byte in a plate, and a slot moved off its ring, are both caught.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { FACE, knobXs, composePlate, inlineClasses, plateColours, pedalArtOn, mix } from '../web/js/ui/plates.js';
import { TYPES } from '../web/js/graph/types.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLATES = path.join(root, 'design/assets/plates');
// SOURCE.json (where the approved files came from, with their hashes) stays in the private tree; the public export has
// the plates only, so the two byte tests below skip there and say why.
const SOURCE = path.join(PLATES, 'SOURCE.json');
const source = fs.existsSync(SOURCE) ? JSON.parse(fs.readFileSync(SOURCE, 'utf8')) : null;
const NO_SOURCE = source ? false : 'SOURCE.json is not in the public tree';
const skin = JSON.parse(fs.readFileSync(path.join(root, 'design/skin.brush-ink.json'), 'utf8'));
const hash = (b) => crypto.createHash('sha256').update(b).digest('hex');
const CSS = { ink: '#1C160E', accent: '#9C7208' };

/** The anchor slots of a composed device, as { slot: [{cx, cy, r} | {x, y, w, h}] }. */
function slotsOf(svg) {
  const out = {};
  for (const m of svg.matchAll(/<(circle|rect) data-slot="([^"]+)"([^>]*)\/>/g)) {
    const a = Object.fromEntries([...m[3].matchAll(/([a-z]+)="([^"]+)"/g)].map(([, k, v]) => [k, Number(v)]));
    (out[m[2]] ??= []).push(a);
  }
  return out;
}

test('every plate is the approved file, byte for byte (SOURCE.json)', { skip: NO_SOURCE }, () => {
  const files = fs.readdirSync(PLATES).filter((f) => f.endsWith('.svg')).sort();
  assert.deepEqual(files, Object.keys(source.files).sort());
  for (const f of files) assert.equal(hash(fs.readFileSync(path.join(PLATES, f))), source.files[f], f);
  assert.match(source.approved_source.commit, /^[0-9a-f]{7,40}$/);
});

test('negative control: one changed byte in a plate is caught', { skip: NO_SOURCE }, () => {
  const b = Buffer.from(fs.readFileSync(path.join(PLATES, 'gate.svg')));
  b[b.length - 10] ^= 1;
  assert.notEqual(hash(b), source.files['gate.svg']);
});

test('the default skin plates every device that has a plate, and only known node types', () => {
  const plated = Object.entries(skin.devices).filter(([, d]) => d.plate);
  assert.ok(plated.length >= 9, `only ${plated.length} plated devices`);
  for (const [type, d] of plated) {
    assert.ok(TYPES[type], `${type} is not a node type`);
    assert.ok(fs.existsSync(path.join(root, 'design', d.plate)), d.plate);
    assert.ok(d.svg, `${type} keeps its line art for ?pedalart=0`);
  }
});

test('a composed device puts its slots on the rings and window the plate draws', () => {
  const plate = fs.readFileSync(path.join(PLATES, 'comp.svg'), 'utf8');
  const svg = composePlate(plate, { colours: plateColours('comp', 'light', CSS), knobs: 3, ins: 1, outs: 1 });
  const s = slotsOf(svg);
  // the plate's own fixtures: lamp ring (33, 90) and footswitch ring (33, 104); the window rect
  assert.ok(plate.includes('cx="33" cy="90"') && plate.includes('cx="33" cy="104"'), 'the plate draws its rings where FACE says');
  assert.deepEqual([s.led[0].cx, s.led[0].cy], [33, 90]);
  assert.deepEqual([s.footswitch[0].cx, s.footswitch[0].cy], [33, 104]);
  assert.deepEqual([s.glyph[0].x, s.glyph[0].y], [FACE.window.x, FACE.window.y]);
  assert.deepEqual(s.knob.map((q) => q.cx), knobXs(3));
  assert.equal(s['jack-in'][0].cx, 0);
  assert.equal(s['jack-out'][0].cx, FACE.w);
});

test('negative control: a slot moved off its ring is caught by the same check', () => {
  const plate = fs.readFileSync(path.join(PLATES, 'comp.svg'), 'utf8');
  const moved = composePlate(plate, { colours: plateColours('comp', 'light', CSS), knobs: 1 }).replace('data-slot="led" cx="33" cy="90"', 'data-slot="led" cx="33" cy="88"');
  assert.notDeepEqual([slotsOf(moved).led[0].cx, slotsOf(moved).led[0].cy], [33, 90]);
});

test('the plate reaches the device unchanged except for its colour classes', () => {
  for (const f of fs.readdirSync(PLATES).filter((name) => name.endsWith('.svg'))) {
    const plate = fs.readFileSync(path.join(PLATES, f), 'utf8');
    const colours = plateColours('gate', 'dark', CSS);
    const svg = composePlate(plate, { colours, knobs: 2 });
    const stripClasses = (t) => t.replace(/\s(class|fill|stroke|stop-color)="[^"]*"/g, '');
    const body = plate.slice(plate.indexOf('>', plate.indexOf('<svg')) + 1, plate.lastIndexOf('</svg>'));
    assert.ok(stripClasses(svg).includes(stripClasses(body)), `${f}: plate markup changed`);
    assert.ok(!/class="[^"]*\b(f|s|stop)-(paper|ink|lacquer|lacquer2|sun)\b/.test(svg), `${f}: a colour class was left for a stylesheet the image does not have`);
  }
});

test('colour classes become attributes; other classes stay', () => {
  const c = { paper: '#111111', ink: '#222222', lacquer: '#333333', lacquer2: '#444444', sun: '#555555' };
  assert.equal(inlineClasses('<rect class="f-paper s-ink"/>', c), '<rect fill="#111111" stroke="#222222"/>');
  assert.equal(inlineClasses('<stop class="stop-sun"/>', c), '<stop stop-color="#555555"/>');
  assert.equal(inlineClasses('<g class="founder f-lacquer2"/>', c), '<g class="founder" fill="#444444"/>');
});

test('the face is the lacquer at 13% over the pedal face, as Rig Live mixes it', () => {
  assert.equal(mix('#53749D', 0.13, '#F7F5F0'), '#E2E4E5');
  assert.equal(plateColours('gate', 'light', CSS).face, '#E2E4E5');
  assert.equal(plateColours(undefined, 'light', CSS).face, '#F7F5F0'); // no lacquer: the plain face
});

test('?pedalart=0 turns the plates off and remembers it; ?pedalart=1 turns them back on', () => {
  const store = new Map(), storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  assert.equal(pedalArtOn(new URLSearchParams(''), storage), true);
  assert.equal(pedalArtOn(new URLSearchParams('pedalart=0'), storage), false);
  assert.equal(pedalArtOn(new URLSearchParams(''), storage), false);
  assert.equal(pedalArtOn(new URLSearchParams('pedalart=1'), storage), true);
  assert.equal(pedalArtOn(new URLSearchParams(''), storage), true);
});
