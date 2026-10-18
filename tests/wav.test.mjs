// WAV encoder/decoder (web/js/audio/wav.js): header fields, round trips at
// every format, clamping, and agreement with the independent test reader.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { encodeWav, decodeWav } from '../web/js/audio/wav.js';
import { readWav } from './lib/wav.mjs';

const sine = (n, f, a = 0.5, sr = 48000) => Float32Array.from({ length: n }, (_, i) => a * Math.sin((2 * Math.PI * f * i) / sr));

test('header: RIFF/WAVE, fmt fields and sizes are consistent', () => {
  const L = sine(1001, 440), R = sine(1001, 660);
  for (const [format, tag, bits] of [['pcm16', 1, 16], ['pcm24', 1, 24], ['float32', 3, 32]]) {
    const buf = encodeWav([L, R], 48000, { format });
    const dv = new DataView(buf), s = (o) => String.fromCharCode(...new Uint8Array(buf, o, 4));
    const block = 2 * bits / 8, data = 1001 * block;
    assert.equal(s(0), 'RIFF'); assert.equal(s(8), 'WAVE'); assert.equal(s(12), 'fmt '); assert.equal(s(36), 'data');
    assert.equal(dv.getUint16(20, true), tag);
    assert.equal(dv.getUint16(22, true), 2);
    assert.equal(dv.getUint32(24, true), 48000);
    assert.equal(dv.getUint32(28, true), 48000 * block);
    assert.equal(dv.getUint16(32, true), block);
    assert.equal(dv.getUint16(34, true), bits);
    assert.equal(dv.getUint32(40, true), data);
    assert.equal(dv.getUint32(4, true), 36 + data + (data & 1));
    assert.equal(buf.byteLength, 44 + data + (data & 1), `${format}: odd data sizes are padded to even`);
  }
});

test('round trip: float32 is exact, PCM within half an LSB', () => {
  const L = sine(4800, 997, 0.9), R = sine(4800, 50, -0.3);
  const f = decodeWav(encodeWav([L, R], 44100, { format: 'float32' }));
  assert.equal(f.sampleRate, 44100);
  assert.deepEqual(f.channels[0], L); assert.deepEqual(f.channels[1], R);
  for (const [format, lsb] of [['pcm16', 1 / 32768], ['pcm24', 1 / 8388608]]) {
    const d = decodeWav(encodeWav([L, R], 48000, { format }));
    let err = 0;
    for (let c = 0; c < 2; c++) for (let i = 0; i < L.length; i++) err = Math.max(err, Math.abs(d.channels[c][i] - [L, R][c][i]));
    assert.ok(err <= lsb * 0.5 + 1e-9, `${format}: max error ${err} > half LSB`);
  }
});

test('PCM clamps out-of-range samples to full scale (no wrap-around)', () => {
  const x = Float32Array.from([2, -2, 1, -1, 0]);
  const d16 = decodeWav(encodeWav([x], 48000, { format: 'pcm16' })).channels[0];
  assert.deepEqual(Array.from(d16), [32767 / 32768, -1, 32767 / 32768, -1, 0]);
  const d24 = decodeWav(encodeWav([x], 48000, { format: 'pcm24' })).channels[0];
  assert.deepEqual(Array.from(d24), [8388607 / 8388608, -1, 8388607 / 8388608, -1, 0]);
});

test('files decode identically with the independent test reader', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-wav-'));
  const x = sine(2000, 330, 0.7);
  for (const format of ['pcm16', 'pcm24', 'float32']) {
    const p = path.join(tmp, `${format}.wav`);
    fs.writeFileSync(p, Buffer.from(encodeWav([x], 48000, { format })));
    const a = readWav(p), b = decodeWav(fs.readFileSync(p));
    assert.equal(a.sampleRate, 48000);
    for (let i = 0; i < x.length; i++) assert.ok(Math.abs(a.data[i] - b.channels[0][i]) < 1e-7);
  }
  fs.rmSync(tmp, { recursive: true });
});

test('decodes WAVE_FORMAT_EXTENSIBLE (as some DAWs write)', () => {
  const x = sine(10, 1000, 0.25);
  const std = new Uint8Array(encodeWav([x], 48000, { format: 'float32' }));
  // rebuild with a 40-byte extensible fmt chunk
  const fmt = new Uint8Array(48); const dv = new DataView(fmt.buffer);
  fmt.set([...'fmt '].map((c) => c.charCodeAt(0)), 0); dv.setUint32(4, 40, true);
  dv.setUint16(8, 0xfffe, true); dv.setUint16(10, 1, true); dv.setUint32(12, 48000, true); dv.setUint32(16, 48000 * 4, true);
  dv.setUint16(20, 4, true); dv.setUint16(22, 32, true); dv.setUint16(24, 22, true); dv.setUint16(26, 32, true); dv.setUint32(28, 4, true);
  dv.setUint16(32, 3, true); // SubFormat: IEEE float
  const data = std.subarray(36);
  const out = new Uint8Array(12 + fmt.length + data.length);
  out.set(std.subarray(0, 12)); out.set(fmt, 12); out.set(data, 12 + fmt.length);
  new DataView(out.buffer).setUint32(4, out.length - 8, true);
  assert.deepEqual(decodeWav(out).channels[0], x);
});

test('rejects what it cannot encode', () => {
  assert.throws(() => encodeWav([new Float32Array(3), new Float32Array(4)], 48000), /lengths differ/);
  assert.throws(() => encodeWav([new Float32Array(3)], 48000, { format: 'mp3' }), /unknown WAV format/);
  assert.throws(() => decodeWav(new Uint8Array(12)), /RIFF/);
});
