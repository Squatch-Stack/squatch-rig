// Bloom's envelope-driven motion: the worklet meter, the motion feed's pick and
// sustain, the sheaf geometry, and the glow's reduced-motion and bypass rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Bloom } from '../web/worklets/dsp/bloom.js';
import { fxMeter } from '../web/worklets/dsp/fxrun.js';
import { bloomGeom, bloomFibre, bloomGlow, brushesFor, drawGlyph } from '../web/js/ui/glyphs.js';

// motion.js asks the page for the motion preference; give it a minimal one
let reducedPref = 'full';
globalThis.document = { documentElement: { dataset: { get motion() { return reducedPref; } } } };
globalThis.matchMedia = () => ({ matches: false });
const { MotionFeed } = await import('../web/js/ui/motion.js');

function gfx() {
  const calls = [];
  const g = {
    calls,
    poly(p) { calls.push(['poly', p.length]); return g; }, fill(o) { calls.push(['fill', o]); return g; },
    moveTo() { return g; }, lineTo() { return g; }, stroke(o) { calls.push(['stroke', o]); return g; },
    circle(x, y, r) { calls.push(['circle', r]); return g; },
  };
  return g;
}

test('the Bloom meter reports a pick at the onset and the drive share in the sustain, and resets on read', () => {
  const fx = new Bloom(48000);
  fx.set('bloom', 0.7); fx.set('touch', 0.8);
  let ph = 0; // one continuous 220 Hz tone, so the only onset is the real one
  const block = (amp) => { const x = Float32Array.from({ length: 128 }, () => amp * Math.sin((ph += 2 * Math.PI * 220 / 48000))); fx.process([x], [new Float32Array(128)], 128); };
  block(0);
  fxMeter('bloom', fx);
  block(0.5); // a pick after silence
  const onset = fxMeter('bloom', fx);
  assert.ok(onset.pick > 0.3, `pick at the onset: ${onset.pick}`);
  assert.ok(onset.bloom < 0.7, 'the guard holds the drive back during the pick');
  for (let i = 0; i < 400; i++) block(0.5); // ~1 s of steady note
  fxMeter('bloom', fx);
  block(0.5);
  const sus = fxMeter('bloom', fx);
  // the 3 ms detector rides the waveform, so a held note keeps a small guard (~0.25): the
  // feed treats guard below 0.3 as no pick. What matters is onset versus sustain.
  assert.ok(sus.pick < onset.pick - 0.1 && sus.pick < 0.3 && sus.bloom > onset.bloom, JSON.stringify({ onset, sus }));
  assert.deepEqual([fx.mixN, fx.pickPeak], [0, 0]);
});

function feedFor(levels) {
  const doc = { nodes: { b: { type: 'bloom', params: { bloom: 0.7, touch: 0.8 }, bypass: false } }, edges: { e: { from: ['in', 0], to: ['b', 0] } } };
  doc.nodes.in = { type: 'input', params: {}, bypass: false };
  let level = 0;
  const engine = { level: (id) => (id === 'in' ? { rms: level * 0.7, peak: level } : { rms: level * 0.5, peak: level * 0.7 }) };
  const feed = new MotionFeed(engine, { doc });
  return { feed, set: (v) => { level = v; }, levels };
}

test('the feed opens the sheaf as a note sustains and closes it exactly when the note dies', () => {
  reducedPref = 'full';
  const { feed, set } = feedFor();
  set(0.5);
  feed.update(1 / 60, true);
  feed.update(1 / 60, true);
  const early = { ...feed.node('b') };
  for (let i = 0; i < 60; i++) feed.update(1 / 60, true);
  const held = { ...feed.node('b') };
  assert.ok(early.pick > held.pick, `pick flashes first (${early.pick} then ${held.pick})`);
  assert.ok(held.sus > early.sus && held.sus > 0.3, `sus grows (${early.sus} -> ${held.sus})`);
  set(0);
  for (let i = 0; i < 600; i++) feed.update(1 / 60, true);
  assert.equal(feed.node('b').sus, 0);
  assert.equal(feed.node('b').pick, 0);
  assert.equal(feed.update(1 / 60, true), false, 'an idle Bloom stops the frame loop');
});

test('reduced motion quantises the bloom quantities', () => {
  reducedPref = 'reduced';
  const { feed, set } = feedFor();
  set(0.5);
  for (let i = 0; i < 40; i++) feed.update(1 / 60, true);
  const s = feed.node('b');
  assert.equal(Math.round(s.sus * 12), s.sus * 12);
  reducedPref = 'full';
});

test('the sheaf fans open with sus, from one fixed origin (the lamp)', () => {
  const G = bloomGeom({ x: 19, y: 77, w: 83, h: 67 }, { bloom: 0.7 });
  const spread = (open) => { const ys = [0, 6].map((i) => bloomFibre(G, i, open).at(-1)[1]); return Math.abs(ys[0] - ys[1]); };
  assert.ok(spread(1) > spread(0) * 1.5, `${spread(0)} -> ${spread(1)}`);
  for (let i = -1; i < 7; i++) assert.deepEqual(bloomFibre(G, i, 0.4)[0], [G.ox, G.oy]);
});

test('the Bloom glyph draws with the face theme and the glow obeys bypass and reduced motion', () => {
  const T = { ink: 1, inkDim: 2, paper: 3, seal: 4, bloomLeaf: 5, bloomLed: 6 };
  const box = { x: 19, y: 77, w: 83, h: 67, k: 0.8 };
  const m = { env: 0.6, vis: 0.5, sus: 0.8, pick: 0.5 };
  const g = gfx();
  drawGlyph(g, { type: 'bloom', params: { bloom: 0.7 } }, box, m, { theme: T, reach: 1 }, brushesFor('bloom'));
  assert.ok(g.calls.some(([k, o]) => k === 'fill' && o.color === 1), 'the sheaf is drawn in the face ink');
  const led = { x: 24, y: 137, r: 2.6 };
  const on = gfx(); bloomGlow(on, box, led, m, true, false, T);
  assert.equal(on.calls.filter(([k]) => k === 'circle').length, 4);
  for (const [live, reduced] of [[false, false], [true, true]]) {
    const off = gfx(); bloomGlow(off, box, led, m, live, reduced, T);
    assert.equal(off.calls.length, 0);
  }
});
