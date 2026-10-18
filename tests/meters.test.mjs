// The metering contract (web/js/audio/meters.js) and the bundled DI loops.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMeters, applyFrame, decayMeters, fillInputs, motionOf, levelNorm } from '../web/js/audio/meters.js';
import { decodeWav } from '../web/js/audio/wav.js';
import { integratedLoudness } from '../tools/render/loudness.mjs';

const web = (p) => path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', p);
const frame = (rms, peak = rms, extra = {}) => ({ time: 0, master: { rms, peak, clips: 0 }, nodes: { a: { type: 'input', ports: [{ rms, peak }] }, b: { type: 'compressor', ports: [{ rms: rms / 2, peak }], gr: 6, ...extra } } });

test('meters: one stable object, env attacks fast and releases slowly', () => {
  const m = createMeters(), ref = m;
  applyFrame(m, frame(1), 1 / 60);
  assert.equal(m, ref); assert.equal(m.seq, 1);
  const up = m.nodes.a.env;
  assert.ok(up > 0.6, `15 ms attack reaches most of the way in one 16.7 ms frame (${up})`);
  applyFrame(m, frame(0), 1 / 60);
  assert.ok(m.nodes.a.env > 0.9 * up, 'release is slow (250 ms)');
  for (let i = 0; i < 120; i++) applyFrame(m, frame(0), 1 / 60);
  assert.ok(m.nodes.a.env < 0.01);
  assert.equal(levelNorm(1), 1); assert.equal(levelNorm(0.001), 0);
});

test('meters: clip latches for one second; gr and motion view', () => {
  const m = createMeters();
  applyFrame(m, frame(0.5, 1.0), 1 / 60);
  assert.equal(m.nodes.a.clip, true); assert.equal(m.nodes.a.clipHold, true);
  for (let i = 0; i < 50; i++) applyFrame(m, frame(0.1, 0.2), 1 / 60);
  assert.equal(m.nodes.a.clip, false); assert.equal(m.nodes.a.clipHold, true, 'still held at 0.83 s');
  for (let i = 0; i < 12; i++) applyFrame(m, frame(0.1, 0.2), 1 / 60);
  assert.equal(m.nodes.a.clipHold, false, 'released after 1 s');
  assert.equal(m.nodes.b.gr, 6);
  const v = motionOf(m, 'b');
  assert.deepEqual(Object.keys(v).sort(), ['bloom', 'clip', 'cutoff', 'env', 'grDb', 'inPeak', 'inRms', 'peak', 'pick', 'rms']);
  assert.equal(v.grDb, 6);
  assert.equal(motionOf(m, 'nope'), null);
  decayMeters(m, 1);
  assert.equal(m.nodes.b.gr, 0);
});

test('meters: input levels come from the wires feeding a node', () => {
  const f = fillInputs(frame(0.4), { edges: { e: { from: ['a', 0], to: ['b', 0] } } });
  assert.equal(f.nodes.b.inRms, 0.4); assert.equal(f.nodes.a.inRms, 0.4);
});

test('DI loops: permissive licence, credited, 10-30 s, 48 kHz, loudness-matched, hashes match', () => {
  const idx = JSON.parse(fs.readFileSync(web('audio/loops/index.json'), 'utf8'));
  assert.ok(idx.loops.length >= 4 && idx.loops.length <= 6);
  for (const l of idx.loops) {
    assert.ok(['CC BY 4.0', 'CC0 1.0'].includes(l.licence), `${l.id}: licence ${l.licence}`);
    assert.ok(l.credit && l.url && l.licenceUrl && l.source, `${l.id}: attribution fields`);
    assert.doesNotMatch(JSON.stringify(l), new RegExp(['to', 'ne ?30', '00'].join(''), 'i'), 'no audio from a licence-restricted catalogue'); // fragments: the public guard bans the name
    const bytes = fs.readFileSync(web(l.file));
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), l.sha256, `${l.id}: sha256`);
    const { sampleRate, channels } = decodeWav(bytes);
    assert.equal(sampleRate, 48000); assert.equal(channels.length, 1);
    const s = channels[0].length / 48000;
    assert.ok(s >= 10 && s <= 30, `${l.id}: ${s} s`);
    const lufs = integratedLoudness([channels[0], channels[0]]) - 3.01; // mono measured as one channel
    assert.ok(Math.abs(lufs - idx.targetLufs) < 0.5, `${l.id}: ${lufs.toFixed(2)} LUFS`);
  }
});
