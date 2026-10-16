// Offline renderer (tools/render): determinism, the WebAudio emulation's
// spec behaviour, and the loudness meter against ffmpeg's ebur128.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { render, measure, modelIndex, soloHead } from '../tools/render.mjs';
import { Gain, StereoPanner, Biquad, Convolver, BufferSource, LiteGraph, QUANTUM } from '../tools/render/webaudio-lite.mjs';
import { integratedLoudness, truePeakDb } from '../tools/render/loudness.mjs';
import { encodeWav } from '../web/js/audio/wav.js';
import { demoDoc } from '../web/js/graph/demo.js';
import { validateDoc } from '../web/js/graph/doc.js';

const sha = (channels) => crypto.createHash('sha256').update(Buffer.from(encodeWav(channels, 48000, { format: 'float32' }))).digest('hex');
const doc = validateDoc(demoDoc(modelIndex()));

test('offline render of the full demo rig is bit-identical run to run', () => {
  const a = render({ doc, loop: 'chord-stabs', seconds: 1.5, preroll: 0.5, meterFps: 30 });
  const b = render({ doc: structuredClone(doc), loop: 'chord-stabs', seconds: 1.5, preroll: 0.5, meterFps: 30 });
  assert.equal(a.channels[0].length, 72000);
  assert.equal(sha(a.channels), sha(b.channels));
  assert.deepEqual(a.frames, b.frames, 'meter frames are deterministic too');
  assert.equal(a.frames.length, 45);
  // it is not trivially silent, and it respects the limiter ceiling
  const m = measure(a.channels);
  assert.ok(m.lufs > -30, `loudness ${m.lufs}`);
  assert.ok(m.samplePeakDb <= -0.99, `peak ${m.samplePeakDb}`);
  // and the input actually matters: another loop renders differently
  const c = render({ doc, loop: 'lead', seconds: 1.5, preroll: 0.5 });
  assert.notEqual(sha(c.channels), sha(a.channels));
});

test('solo keeps exactly one head and centres it', () => {
  const labels = Object.values(doc.nodes).filter((n) => n.type === 'nam').map((n) => n.label);
  const label = labels.find((l) => l.startsWith('Head B')) ?? labels[0]; // the dev rig has Head A, B and C; the public demo has one head
  const s = soloHead(doc, label.startsWith('Head B') ? 'Head B' : label);
  const heads = Object.entries(s.nodes).filter(([, n]) => n.type === 'nam');
  const fed = heads.filter(([id]) => Object.values(s.edges).some((e) => e.to[0] === id));
  assert.deepEqual(fed.map(([, n]) => n.label), [label]);
  const r = render({ doc: s, loop: 'picked-riff', seconds: 0.5, preroll: 0.25 });
  let d = 0; for (let i = 0; i < r.channels[0].length; i++) d = Math.max(d, Math.abs(r.channels[0][i] - r.channels[1][i]));
  // centred head, but the reverb is stereo: channels differ, yet not wildly
  assert.ok(d > 0 && d < 0.5);
});

test('webaudio-lite: equal-power StereoPanner and speaker up/down-mix', () => {
  const g = new LiteGraph(48000);
  const src = new BufferSource(g, { buffer: new Float32Array(QUANTUM).fill(1) }); src.start();
  const pan = new StereoPanner(g, { pan: 0 }); src.connect(pan);
  const [[L, R]] = pan.pull(0);
  assert.ok(Math.abs(L[5] - Math.SQRT1_2) < 1e-6 && Math.abs(R[5] - Math.SQRT1_2) < 1e-6, 'mono at centre: -3 dB each side');
  const mono = new Gain(g, { channelCount: 1, channelCountMode: 'explicit' }); pan.connect(mono);
  assert.ok(Math.abs(mono.pull(0)[0][0][5] - Math.SQRT1_2) < 1e-6, 'stereo -> mono averages');
});

test('webaudio-lite: setTargetAtTime follows v(t) = V1 + (V0 - V1) e^(-t/tau)', () => {
  const g = new LiteGraph(48000);
  const gain = new Gain(g, { gain: 1 });
  gain.gain.setTargetAtTime(0.5, 0, 0.012);
  const v = gain.gain.fill(0);
  for (const i of [0, 1, 64, 127]) assert.ok(Math.abs(v[i] - (0.5 + 0.5 * Math.exp(-i / (0.012 * 48000)))) < 1e-7);
});

test('webaudio-lite: biquad lowpass has unity DC gain; convolver equals direct convolution', () => {
  const g = new LiteGraph(48000);
  const src = new BufferSource(g, { buffer: new Float32Array(48000).fill(0.25) }); src.start();
  const lp = new Biquad(g, { type: 'lowpass', frequency: 1000, Q: 0.7 }); src.connect(lp);
  let y; for (let q = 0; q < 100; q++) y = lp.pull(q)[0][0];
  assert.ok(Math.abs(y[127] - 0.25) < 1e-6);

  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32) - 0.5;
  const ir = Float32Array.from({ length: 700 }, rnd), x = Float32Array.from({ length: QUANTUM * 12 }, rnd);
  const g2 = new LiteGraph(48000);
  const s2 = new BufferSource(g2, { buffer: x, loop: false }); s2.start();
  const conv = new Convolver(g2); conv.buffer = ir; s2.connect(conv);
  const out = new Float32Array(x.length);
  for (let q = 0; q < 12; q++) out.set(conv.pull(q)[0][0], q * QUANTUM);
  let err = 0;
  for (let n = 0; n < x.length; n++) { let acc = 0; for (let k = 0; k < ir.length && k <= n; k++) acc += ir[k] * x[n - k]; err = Math.max(err, Math.abs(acc - out[n])); }
  assert.ok(err < 1e-5, `max error ${err}`);
});

const ffmpeg = ['/opt/homebrew/bin/ffmpeg', 'ffmpeg'].find((p) => { try { execFileSync(p, ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } });
test('loudness meter agrees with ffmpeg ebur128 (BS.1770-4) within 0.1 LU', { skip: !ffmpeg && 'ffmpeg not found' }, () => {
  const r = render({ doc, loop: 'picked-riff', seconds: 4, preroll: 1 });
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rig-lufs-')), 'x.wav');
  fs.writeFileSync(tmp, Buffer.from(encodeWav(r.channels, 48000, { format: 'float32' })));
  const text = spawnSync(ffmpeg, ['-hide_banner', '-nostats', '-i', tmp, '-af', 'ebur128', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  const I = +/Summary:[\s\S]*?I:\s+(-?[\d.]+) LUFS/.exec(text)[1];
  const mine = integratedLoudness(r.channels);
  assert.ok(Math.abs(mine - I) <= 0.1, `mine ${mine.toFixed(2)} vs ffmpeg ${I}`);
  fs.rmSync(path.dirname(tmp), { recursive: true });
});

test('true peak finds inter-sample overs a sample-peak meter misses', () => {
  // fs/4 sine at 45 degrees: samples sit at +-0.707 of a 1.0 peak
  const x = Float32Array.from({ length: 4800 }, (_, i) => Math.sin(Math.PI / 2 * i + Math.PI / 4));
  const tp = truePeakDb([x]);
  assert.ok(tp > -0.3 && tp < 0.3, `true peak ${tp} dB`);
});
