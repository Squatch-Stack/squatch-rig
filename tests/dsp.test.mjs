// Unit tests for the effect kernels (the exact code the AudioWorklets run).
import { test, after } from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { Compressor, gainComputer } from '../web/worklets/dsp/compressor.js';
import { Overdrive } from '../web/worklets/dsp/overdrive.js';
import { EnvelopeFilter } from '../web/worklets/dsp/envfilter.js';
import { Reverb } from '../web/worklets/dsp/reverb.js';
import { NoiseGate } from '../web/worklets/dsp/gate.js';
import { Limiter } from '../web/worklets/dsp/limiter.js';
import { tanhFast } from '../web/worklets/dsp/util.js';
import { SR, sine, run, peak, rms, db, bin, powerSpectrum } from './lib/sig.mjs';

const report = {};
export { report };
after(() => { fs.mkdirSync(new URL('./out/', import.meta.url), { recursive: true }); fs.writeFileSync(new URL('./out/dsp-report.json', import.meta.url), JSON.stringify(report, null, 1)); });

test('tanhFast tracks Math.tanh', () => {
  let e = 0;
  for (let x = -8; x <= 8; x += 0.001) e = Math.max(e, Math.abs(tanhFast(x) - Math.tanh(x)));
  assert.ok(e < 5e-4, `max err ${e}`);
});

test('compressor: static curve matches Giannoulis et al. (hard and soft knee)', () => {
  assert.equal(gainComputer(-30, -24, 4, 0), -30);
  assert.equal(gainComputer(-8, -24, 4, 0), -24 + 16 / 4);
  // soft knee: continuous at both knee edges, and at the threshold halfway between
  const T = -20, R = 4, W = 10;
  assert.ok(Math.abs(gainComputer(T - W / 2, T, R, W) - (T - W / 2)) < 1e-12);
  assert.ok(Math.abs(gainComputer(T + W / 2, T, R, W) - (T + W / 2 / R)) < 1e-12);
  assert.ok(Math.abs(gainComputer(T, T, R, W) - (T + (1 / R - 1) * (W / 2) ** 2 / (2 * W))) < 1e-12);
});

test('compressor: steady-state gain reduction vs theory across ratios and levels', () => {
  const rows = [];
  for (const ratio of [2, 4, 8]) {
    for (const levelDb of [-18, -12, -6]) {
      const c = new Compressor(SR);
      c.set('threshold', -24); c.set('ratio', ratio); c.set('knee', 0); c.set('makeup', 0);
      c.set('attack', 1); c.set('release', 300);
      const f = 1000, n = SR;
      const amp = 10 ** (levelDb / 20);
      const y = run(c, sine(f, amp, n));
      const measured = levelDb - db(peak(y, n - 4800));
      const theory = (levelDb + 24) * (1 - 1 / ratio);
      rows.push({ ratio, levelDb, theory: +theory.toFixed(2), measured: +measured.toFixed(2) });
      assert.ok(Math.abs(measured - theory) < 0.75, `ratio ${ratio} level ${levelDb}: GR ${measured} vs ${theory}`);
    }
  }
  report.compressor = rows;
  console.log('compressor GR', JSON.stringify(rows));
});

test('compressor: attack time constant', () => {
  const c = new Compressor(SR);
  c.set('threshold', -40); c.set('ratio', 20); c.set('knee', 0); c.set('makeup', 0); c.set('attack', 10); c.set('release', 500);
  // DC step (constant level), so the detector sees a clean step: GR target = (0+40)*(1-1/20) = 38 dB
  const x = new Float32Array(SR / 2).fill(1);
  const y = run(c, x);
  const grAt = (ms) => -db(y[Math.round(ms * SR / 1000)]);
  const target = 38;
  // one-pole: after tau, 63.2% of target
  assert.ok(Math.abs(grAt(10) / target - 0.632) < 0.03, `GR at tau ${grAt(10)}`);
});

function harmonics(od, f0bin, N, amp) {
  const f0 = f0bin * SR / N;
  const y = run(od, sine(f0, amp, N * 3));
  const from = N * 2;
  const h = [1, 2, 3, 4, 5].map((k) => bin(y, f0bin * k, N, from));
  return h.map((v) => db(v / h[0]));
}

test('overdrive: symmetric clip gives odd harmonics only; asymmetry adds even ones', () => {
  const N = 16384, k = 75; // ~220 Hz, coherent
  const sym = new Overdrive(SR); sym.set('drive', 0.8); sym.set('asym', 0);
  const asy = new Overdrive(SR); asy.set('drive', 0.8); asy.set('asym', 0.5);
  const hs = harmonics(sym, k, N, 0.3), ha = harmonics(asy, k, N, 0.3);
  report.overdrive_harmonics_dB = { symmetric: hs.map((v) => +v.toFixed(1)), asymmetric: ha.map((v) => +v.toFixed(1)) };
  console.log('OD harmonics (dB re H1, H1..H5)', JSON.stringify(report.overdrive_harmonics_dB));
  assert.ok(hs[2] > -30, `H3 sym ${hs[2]}`);
  assert.ok(hs[1] < -90, `H2 sym ${hs[1]}`);
  assert.ok(ha[1] > -35, `H2 asym ${ha[1]}`);
});

test('overdrive: mid hump (TS voicing) at small signal', () => {
  const od = new Overdrive(SR); od.set('drive', 0.5); od.set('tone', 0.5); od.set('level', 0);
  const gainAt = (f) => { const N = 9600; const y = run(od, sine(f, 0.001, N * 2)); return db(rms(y, N) / (0.001 / Math.SQRT2)); };
  const g100 = gainAt(100), g1k = gainAt(1000), g8k = gainAt(8000);
  report.overdrive_small_signal_dB = { '100Hz': +g100.toFixed(1), '1kHz': +g1k.toFixed(1), '8kHz': +g8k.toFixed(1) };
  console.log('OD small-signal gain', JSON.stringify(report.overdrive_small_signal_dB));
  assert.ok(g1k - g100 > 10, 'mids above bass');
  assert.ok(g1k - g8k > 3, 'mids above treble');
});

test('overdrive: 4x oversampling cuts aliasing', () => {
  const N = 16384, k = 1021; // ~2991 Hz: harmonics above 24 kHz fold onto non-harmonic bins
  const inharmonic = (os, drive) => {
    const od = new Overdrive(SR, { oversample: os }); od.set('drive', drive); od.set('asym', 0.3); od.set('tone', 1); od.set('level', 0);
    const y = run(od, sine(k * SR / N, 0.5, N * 3));
    const win = new Float32Array(N);
    // 4-term Blackman-Harris (-92 dB sidelobes) so leakage does not mask aliases
    for (let i = 0; i < N; i++) { const t = 2 * Math.PI * i / N; win[i] = y[2 * N + i] * (0.35875 - 0.48829 * Math.cos(t) + 0.14128 * Math.cos(2 * t) - 0.01168 * Math.cos(3 * t)); }
    const p = powerSpectrum(win, N);
    let harm = 0, alias = 0;
    for (let b = 3; b <= N / 2; b++) {
      const f = b * SR / N;
      if (f > 20000) continue; // audible band only
      const r = b % k; const near = r <= 4 || k - r <= 4;
      if (near) harm += p[b]; else alias += p[b];
    }
    return 10 * Math.log10(alias / harm);
  };
  report.overdrive_alias_dB = {};
  for (const drive of [0.5, 1]) {
    const a1 = inharmonic(1, drive), a4 = inharmonic(4, drive);
    report.overdrive_alias_dB[`drive${drive}`] = { os1x: +a1.toFixed(1), os4x: +a4.toFixed(1) };
    // At full drive the clipper is nearly hard, so harmonics fall off ~1/n and
    // some fold even at 4x; the improvement is still well over 12 dB.
    assert.ok(a4 < a1 - 12, `drive ${drive}: 4x ${a4} vs 1x ${a1}`);
  }
  console.log('OD aliasing (inharmonic/harmonic power, <20 kHz, 3 kHz sine at -6 dBFS)', JSON.stringify(report.overdrive_alias_dB));
});

test('envelope filter: cutoff tracks input level between lo and hi', () => {
  const ef = new EnvelopeFilter(SR);
  ef.set('lo', 300); ef.set('hi', 3000); ef.set('sens', 18); ef.set('attack', 5); ef.set('release', 100);
  const half = SR / 2;
  const x = new Float32Array(SR);
  x.set(sine(440, 0.002, half));
  x.set(sine(440, 0.5, half), half);
  const trace = [];
  for (let i = 0; i < SR; i += 128) {
    ef.process([x.subarray(i, i + 128)], [new Float32Array(128)], 128);
    trace.push(ef.cutoff);
  }
  const quiet = trace[Math.floor(half / 128) - 1], loud = trace[trace.length - 1];
  // time to reach 90% of the log span after the step
  const span = Math.log2(3000 / 300);
  const idx = trace.findIndex((c, j) => j * 128 >= half && Math.log2(c / 300) >= 0.9 * span);
  const riseMs = ((idx * 128 - half) / SR) * 1000;
  report.envfilter = { quietHz: Math.round(quiet), loudHz: Math.round(loud), rise90ms: +riseMs.toFixed(1) };
  console.log('envelope filter', JSON.stringify(report.envfilter));
  assert.ok(quiet < 330, `quiet cutoff ${quiet}`);
  assert.ok(loud > 2900, `loud cutoff ${loud}`);
  assert.ok(riseMs > 0 && riseMs < 40, `rise ${riseMs} ms`);
});

test('envelope filter: band-pass peaks at the cutoff with unity gain', () => {
  const ef = new EnvelopeFilter(SR);
  ef.set('lo', 1000); ef.set('hi', 1000.001); ef.set('mode', 1); ef.set('q', 6);
  const g = (f) => { const y = run(ef, sine(f, 0.1, SR / 2)); return db(rms(y, SR / 4) / (0.1 / Math.SQRT2)); };
  const at = g(1000), off = g(4000);
  assert.ok(Math.abs(at) < 0.3, `gain at fc ${at}`);
  assert.ok(off < -12, `gain 2 oct up ${off}`);
});

function rt60(ir) {
  // Schroeder backward integration, T30 fit (-5..-35 dB) extrapolated to 60 dB
  const e = new Float64Array(ir.length);
  let acc = 0;
  for (let i = ir.length - 1; i >= 0; i--) { acc += ir[i] * ir[i]; e[i] = acc; }
  const e0 = e[0];
  const edc = (i) => 10 * Math.log10(e[i] / e0);
  let i5 = 0; while (edc(i5) > -5) i5++;
  let i35 = i5; while (i35 < ir.length - 1 && edc(i35) > -35) i35++;
  // least squares slope between i5..i35
  let sx = 0, sy = 0, sxx = 0, sxy = 0, n = 0;
  for (let i = i5; i <= i35; i += 16) { const t = i / SR, y = edc(i); sx += t; sy += y; sxx += t * t; sxy += t * y; n++; }
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  return -60 / slope;
}

test('reverb: measured RT60 matches the decay setting', () => {
  const rows = [];
  for (const decay of [1, 2.5, 5]) {
    const rv = new Reverb(SR);
    rv.set('decay', decay); rv.set('mix', 1); rv.set('damp', 20000); rv.set('predelay', 0);
    const n = Math.round(SR * decay * 1.6);
    const x = new Float32Array(n); x[0] = 1;
    const [L, R] = run(rv, x, { outCh: 2 });
    const mono = L.map((v, i) => 0.5 * (v + R[i]));
    const t = rt60(mono);
    rows.push({ set: decay, measured: +t.toFixed(2) });
    assert.ok(Math.abs(t / decay - 1) < 0.15, `decay ${decay}: RT60 ${t}`);
  }
  report.reverb_rt60 = rows;
  console.log('reverb RT60', JSON.stringify(rows));
});

test('noise gate: closes on hiss, passes signal', () => {
  const g = new NoiseGate(SR);
  const noise = new Float32Array(SR); for (let i = 0; i < SR; i++) noise[i] = (Math.random() * 2 - 1) * 10 ** (-70 / 20);
  const yN = run(g, noise);
  const att = db(rms(yN, SR / 2)) - db(rms(noise, SR / 2));
  const g2 = new NoiseGate(SR);
  const s = sine(440, 0.1, SR);
  const yS = run(g2, s);
  const pass = db(rms(yS, SR / 2)) - db(rms(s, SR / 2));
  report.gate = { hissAttenuation_dB: +att.toFixed(1), signalLoss_dB: +pass.toFixed(2) };
  console.log('gate', JSON.stringify(report.gate));
  assert.ok(att < -60, `hiss attenuation ${att}`);
  assert.ok(Math.abs(pass) < 0.1, `signal change ${pass}`);
});

test('limiter: never exceeds the ceiling; quiet material passes untouched', () => {
  const lim = new Limiter(SR);
  lim.set('gain', 12); lim.set('ceiling', -1);
  const n = SR;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = 0.5 * Math.sin(2 * Math.PI * 97 * i / SR) + 0.4 * (Math.random() * 2 - 1) * (i % 9600 < 200 ? 2 : 0.3);
  const y = run(lim, x);
  const pk = db(peak(y));
  const quiet = new Limiter(SR);
  const q = sine(1000, 0.1, 4800);
  const yq = run(quiet, q);
  let err = 0; for (let i = quiet.latency; i < 4800; i++) err = Math.max(err, Math.abs(yq[i] - q[i - quiet.latency]));
  report.limiter = { peak_dBFS: +pk.toFixed(3), ceiling: -1, latencySamples: quiet.latency };
  console.log('limiter', JSON.stringify(report.limiter));
  assert.ok(pk <= -1 + 1e-4, `peak ${pk}`);
  assert.ok(err < 1e-6, `quiet passthrough err ${err}`);
});
