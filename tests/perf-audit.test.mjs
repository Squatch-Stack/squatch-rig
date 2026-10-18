// Guards for the 2026-10 performance audit: each optimisation keeps its output and its no-allocation property.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, abMakeupDb } from '../web/js/audio/engine.js';
import { runFx } from '../web/worklets/dsp/fxrun.js';

// ---- fxrun: no per-block slices when channel counts match
test('runFx hands the kernel the host arrays themselves when channel counts match', () => {
  const seen = [];
  const k = { process(i, o) { seen.push([i, o]); } };
  const ins = [new Float32Array(128), new Float32Array(128)], out = [new Float32Array(128), new Float32Array(128)];
  runFx('x', k, ins, out, 128);
  assert.equal(seen[0][0], ins); assert.equal(seen[0][1], out);
});
test('runFx still maps channels when counts differ (mono in, stereo out duplicates)', () => {
  const k = { process(i, o, n) { for (let s = 0; s < n; s++) o[0][s] = 2 * i[0][s]; } };
  const ins = [Float32Array.from([1, 2, 3])], out = [new Float32Array(3), new Float32Array(3)];
  runFx('x', k, ins, out, 3);
  assert.deepEqual([...out[0]], [2, 4, 6]); assert.deepEqual([...out[1]], [2, 4, 6]);
  const k2 = { process(i, o) { assert.equal(i.length, 1); assert.equal(o.length, 1); } };
  runFx('x', k2, [new Float32Array(3), new Float32Array(3)], [new Float32Array(3)], 3);
});

// ---- engine.pollLevels: same numbers as the reduce-based original, no per-frame objects
function stubEngine(seed) {
  const e = Object.create(Engine.prototype);
  let t = 0;
  const analyser = (len) => ({ fftSize: len, getFloatTimeDomainData(a) { for (let i = 0; i < a.length; i++) a[i] = Math.sin((i + t++ * 7) * 0.013 * seed) * 0.4; } });
  e.levels = new Map(); e.scratch = new Float32Array(1024); e.replaying = false;
  e.nodes = new Map([['a', { analysers: [analyser(1024), analyser(1024)], meter: null }], ['b', { analysers: [], meter: analyser(1024) }]]);
  e.masterMeter = analyser(2048); e.rigMatchMeter = analyser(8192); e.dryMatchMeter = analyser(8192);
  e.matchRigData = new Float32Array(8192); e.matchDryData = new Float32Array(8192); e.dryMakeupDb = 0;
  return e;
}
test('pollLevels reproduces the reference levels, master and A/B trim', () => {
  const e = stubEngine(1), ref = stubEngine(1);
  e.pollLevels(true);
  // reference: the original implementation, written out with reduce
  const rd = (an, len) => { const b = new Float32Array(len); an.getFloatTimeDomainData(b); return b; };
  const want = new Map();
  for (const [id, n] of ref.nodes) (n.analysers.length ? n.analysers : [n.meter]).forEach((a, p) => {
    const b = rd(a, 1024); let s = 0, pk = 0; for (let i = 0; i < b.length; i++) { s += b[i] * b[i]; pk = Math.max(pk, Math.abs(b[i])); }
    want.set(`${id}:${p}`, { rms: Math.sqrt(s / b.length), peak: pk });
  });
  for (const [k, v] of want) assert.deepEqual(e.levels.get(k), v, k);
  const m = rd(ref.masterMeter, 2048);
  assert.equal(e.master.rms, Math.sqrt(m.reduce((s, v) => s + v * v, 0) / m.length));
  assert.equal(e.master.peak, m.reduce((x, v) => Math.max(x, Math.abs(v)), 0));
  const rig = rd(ref.rigMatchMeter, 8192), dry = rd(ref.dryMatchMeter, 8192);
  const rms = (d) => Math.sqrt(d.reduce((s, v) => s + v * v, 0) / d.length);
  const target = abMakeupDb(rms(rig), rms(dry), dry.reduce((x, v) => Math.max(x, Math.abs(v)), 0));
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  assert.equal(e.dryMakeupDb, clamp((target - 0) * 0.08, -0.25, 0.25));
});
test('pollLevels updates level records and the master buffer in place', () => {
  const e = stubEngine(2);
  e.pollLevels(true);
  const rec = e.levels.get('a:1'), buf = e._masterBuf;
  e.pollLevels(true);
  assert.equal(e.levels.get('a:1'), rec); assert.equal(e._masterBuf, buf);
});

// ---- limiter: O(1) running minimum is bit-identical to the window scan it replaced
import { Limiter } from '../web/worklets/dsp/limiter.js';
import { dbToLin, tauCoef } from '../web/worklets/dsp/util.js';

class ScanLimiter { // the pre-audit implementation, kept as the reference
  constructor(sr, ms = 2) {
    this.sr = sr; this.p = { gain: 0, ceiling: -1, release: 120 };
    this.L = Math.max(1, Math.round((ms * sr) / 1000));
    this.req = new Float64Array(this.L).fill(1); this.sm = new Float64Array(this.L).fill(1);
    this.sum = this.L; this.idx = 0; this.r = 1; this.delay = []; this.grDb = 0; this._update();
  }
  set(n, v) { this.p[n] = v; this._update(); }
  _update() { this.inGain = dbToLin(this.p.gain); this.ceil = dbToLin(this.p.ceiling); this.aR = tauCoef(this.p.release, this.sr); }
  process(ins, outs, n) {
    const L = this.L, chans = ins.length;
    while (this.delay.length < chans) this.delay.push(new Float32Array(L));
    let minGain = 1;
    for (let i = 0; i < n; i++) {
      let a = 0;
      for (let c = 0; c < chans; c++) { const v = Math.abs(ins[c][i] * this.inGain); if (v > a) a = v; }
      const idx = this.idx;
      this.req[idx] = a > this.ceil ? this.ceil / a : 1;
      let h = 1;
      for (let k = 0; k < L; k++) if (this.req[k] < h) h = this.req[k];
      this.r = h < this.r ? h : this.aR * this.r + (1 - this.aR) * h;
      if (this.r > h) this.r = h;
      this.sum += this.r - this.sm[idx]; this.sm[idx] = this.r;
      if ((i & 63) === 0) { let s = 0; for (let k = 0; k < L; k++) s += this.sm[k]; this.sum = s; }
      const g = Math.min(1, this.sum / L);
      if (g < minGain) minGain = g;
      const readIdx = (idx + 1) % L;
      for (let c = 0; c < chans; c++) { const d = this.delay[c]; d[idx] = ins[c][i] * this.inGain; outs[c][i] = d[readIdx] * g; }
      this.idx = readIdx;
    }
    this.grDb = -20 * Math.log10(minGain);
  }
}
test('limiter output and gain reduction are bit-identical to the scan version', () => {
  let seed = 12345; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (const sr of [48000, 44100, 8000, 1000]) { // 1 kHz gives L = 2; 
    for (const gain of [0, 12, 18]) {
      const a = new Limiter(sr), b = new ScanLimiter(sr);
      a.set('gain', gain); b.set('gain', gain);
      const oa = [new Float32Array(128), new Float32Array(128)], ob = [new Float32Array(128), new Float32Array(128)];
      for (let blk = 0; blk < 400; blk++) {
        const burst = blk % 7 === 0 ? 1.6 : blk % 5 === 0 ? 0.002 : 0.4; // loud bursts, near-silence, normal
        const ins = [new Float32Array(128), new Float32Array(128)];
        for (let i = 0; i < 128; i++) { ins[0][i] = (rnd() * 2 - 1) * burst; ins[1][i] = (rnd() * 2 - 1) * burst * 0.7; }
        a.process(ins, oa, 128); b.process(ins, ob, 128);
        assert.deepEqual(oa[0], ob[0], `sr ${sr} gain ${gain} block ${blk} L`); assert.deepEqual(oa[1], ob[1]);
        assert.equal(a.grDb, b.grDb);
      }
    }
  }
});
test('limiter still cannot overshoot its ceiling', () => {
  const l = new Limiter(48000), ceil = dbToLin(-1);
  l.set('gain', 18);
  const out = [new Float32Array(128)]; let pk = 0;
  for (let blk = 0; blk < 300; blk++) { const x = new Float32Array(128); for (let i = 0; i < 128; i++) x[i] = Math.sin((blk * 128 + i) * 0.05) * (blk % 11 ? 0.9 : 2); l.process([x], out, 128); for (const v of out[0]) pk = Math.max(pk, Math.abs(v)); }
  assert.ok(pk <= ceil + 1e-6, `peak ${pk} > ${ceil}`);
});

// ---- overdrive / oversampler: block decimation and 4-way interpolation are bit-identical to the per-sample code
import { Overdrive } from '../web/worklets/dsp/overdrive.js';
import { Bloom } from '../web/worklets/dsp/bloom.js';
import { Oversampler4x } from '../web/worklets/dsp/oversample.js';
import { Oversampler4x as RefOs } from './lib/oversample-ref.mjs';
import { OnePole, DcBlock } from '../web/worklets/dsp/util.js';

class RefOverdrive extends Overdrive { // the original per-sample process(), on the original oversampler
  _chan(c) {
    while (this.ch.length <= c) { this.ch.push({ os: new RefOs(), hp: new OnePole(), lp: new OnePole(), tone: new OnePole(), dc: new DcBlock(this.sr, 8) }); this._update(); }
    return this.ch[c];
  }
  process(ins, outs, n) {
    const u4 = new Float64Array(4), y4 = new Float64Array(4);
    for (let c = 0; c < ins.length; c++) {
      const st = this._chan(c), x = ins[c], y = outs[c];
      for (let i = 0; i < n; i++) {
        let s;
        if (this.os === 4) { st.os.up(x[i], u4); for (let k = 0; k < 4; k++) y4[k] = this._nl(st, u4[k]); s = st.os.down(y4); } else s = this._nl(st, x[i]);
        y[i] = st.tone.lp(st.dc.process(s)) * this.out;
      }
    }
  }
}
function drive(mk, blocks, sizes) {
  let seed = 99; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const a = mk(0), b = mk(1);
  for (let blk = 0; blk < blocks; blk++) {
    const n = sizes[blk % sizes.length];
    const ins = [new Float32Array(n), new Float32Array(n)];
    for (let i = 0; i < n; i++) { ins[0][i] = Math.sin((blk * 128 + i) * 0.07) * 0.5 * (blk % 9 ? 1 : 3) + (rnd() - 0.5) * 0.05; ins[1][i] = ins[0][i] * 0.8; }
    const oa = [new Float32Array(n), new Float32Array(n)], ob = [new Float32Array(n), new Float32Array(n)];
    a.process(ins, oa, n); b.process(ins, ob, n);
    assert.deepEqual(oa[0], ob[0], `block ${blk} n ${n} L`); assert.deepEqual(oa[1], ob[1], `block ${blk} R`);
  }
}
test('overdrive (4x) is bit-identical to the per-sample reference, mono, stereo, odd block sizes', () => {
  drive((ref) => { const o = ref ? new RefOverdrive(48000) : new Overdrive(48000); o.set('drive', 0.7); return o; }, 300, [128]);
  drive((ref) => ref ? new RefOverdrive(44100) : new Overdrive(44100), 120, [128, 64, 127, 5, 1, 130, 200]); // sizes that are not multiples of 4, growing after the first call
});
test('overdrive 1x path is unchanged', () => {
  drive((ref) => ref ? new RefOverdrive(48000, { oversample: 1 }) : new Overdrive(48000, { oversample: 1 }), 50, [128, 33]);
});
test('bloom (drives the shared overdrive) renders the same samples as before', () => {
  drive((ref) => { const b = new Bloom(48000); if (ref) b.drive = new RefOverdrive(48000); b._update(); return b; }, 200, [128]);
});
test('Oversampler4x.up matches the reference sample for sample', () => {
  const a = new Oversampler4x(), b = new RefOs(), o1 = new Float64Array(4), o2 = new Float64Array(4);
  for (let i = 0; i < 2000; i++) { const x = Math.sin(i * 0.3) * (i % 50 ? 0.5 : 2); a.up(x, o1); b.up(x, o2); assert.deepEqual(o1, o2, `i ${i}`); }
});

// ---- denormal guards: same float32 output, and the decaying states reach exact zero
import { Compressor } from '../web/worklets/dsp/compressor.js';
import { EnvelopeFilter } from '../web/worklets/dsp/envfilter.js';
import { NoiseGate } from '../web/worklets/dsp/gate.js';
function tail(K, seconds, again = true) { // loud noise, quiet sine (small gain reduction), silence, loud noise again
  const k = new K(48000), outs = [], o = [new Float32Array(128)];
  let seed = 5; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const total = (seconds * 48000) / 128;
  for (let b = 0; b < total; b++) {
    const x = new Float32Array(128);
    if (b < 300 || (again && b >= total - 300)) for (let i = 0; i < 128; i++) x[i] = (rnd() - 0.5) * 1.6;
    else if (b < 700) for (let i = 0; i < 128; i++) x[i] = 0.035 * Math.sin((b * 128 + i) * 0.04);
    else if (b < 900) for (let i = 0; i < 128; i++) x[i] = 0.002 * Math.sin((b * 128 + i) * 0.04); // -54 dBFS: near the gate's thresholds
    k.process([x], o, 128); outs.push(Float32Array.from(o[0]));
  }
  return { k, outs };
}
test('compressor yL, envfilter env and gate env flush to exactly 0 in silence (no subnormal state)', () => {
  assert.equal(tail(Compressor, 60, false).k.yL, 0);
  assert.equal(tail(EnvelopeFilter, 60, false).k.env, 0);
  assert.equal(tail(NoiseGate, 60, false).k.env, 0);
});
import { createHash } from 'node:crypto';
const GOLDEN = {
  compressor: 'f0de88d48f5bb59d6b560267e3180004ccd216af61df23769c020ae9918076e3',
  envfilter: 'a1c5b964f811917566b5afbd8ac2170c9716160b98d1ba750bff2ff36ec6e06b',
  bloom: 'cec458842ba4b09eaeeec2501700653201173332233576243896ebec56a09c5d',
  gate: 'af2a97667f128595d898ee4454ac73e3d56d39c794532821b8335b2be5ddf95f',
}; // sha256 of 20 s (loud burst, silence, burst) rendered by the kernels BEFORE the flush was added
test('the flush does not change the float32 output of a decaying tail (golden hashes from the unflushed code)', () => {
  for (const [K, name] of [[Compressor, 'compressor'], [EnvelopeFilter, 'envfilter'], [NoiseGate, 'gate'], [Bloom, 'bloom']]) {
    const h = createHash('sha256');
    for (const b of tail(K, 20).outs) h.update(Buffer.from(b.buffer));
    if (process.env.PRINT_GOLDEN) console.log('GOLDEN', name, h.digest('hex')); else assert.equal(h.digest('hex'), GOLDEN[name], name);
  }
});
