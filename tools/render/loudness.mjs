// ITU-R BS.1770-4 / EBU R128 measurements for the renders: integrated
// loudness (LUFS, K-weighted, gated), sample peak and true peak (4x
// oversampled). 48 kHz only (the rig's rate); checked against ffmpeg's
// ebur128 filter in tests/render.test.mjs.
import { kaiserLowpass } from '../../web/worklets/dsp/util.js';

// BS.1770 K-weighting at 48 kHz: pre-filter (high shelf) then RLB high-pass.
const K1 = { b: [1.53512485958697, -2.69169618940638, 1.19839281085285], a: [-1.69065929318241, 0.73248077421585] };
const K2 = { b: [1.0, -2.0, 1.0], a: [-1.99004745483398, 0.99007225036621] };

function biquad(x, { b, a }) {
  const y = new Float64Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b[0] * x[i] + b[1] * x1 + b[2] * x2 - a[0] * y1 - a[1] * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

/** Integrated loudness in LUFS of channels (array of Float32Array) at 48 kHz. */
export function integratedLoudness(channels, sampleRate = 48000) {
  if (sampleRate !== 48000) throw new Error('loudness: 48 kHz only');
  const z = channels.map((c) => biquad(biquad(c, K1), K2));
  const block = Math.round(0.4 * sampleRate), hop = Math.round(0.1 * sampleRate);
  const powers = [];
  for (let s = 0; s + block <= z[0].length; s += hop) {
    let p = 0;
    for (const ch of z) { let e = 0; for (let i = s; i < s + block; i++) e += ch[i] * ch[i]; p += e / block; }
    powers.push(p);
  }
  const lk = (p) => -0.691 + 10 * Math.log10(p);
  const abs = powers.filter((p) => lk(p) > -70);
  if (!abs.length) return -Infinity;
  const rel = lk(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const gated = abs.filter((p) => lk(p) > rel);
  return lk(gated.reduce((a, b) => a + b, 0) / gated.length);
}

export function samplePeakDb(channels) {
  let p = 0;
  for (const c of channels) for (const v of c) { const a = Math.abs(v); if (a > p) p = a; }
  return 20 * Math.log10(Math.max(p, 1e-12));
}

/** True peak (dBTP) by 4x polyphase interpolation, 48 taps per phase. */
export function truePeakDb(channels) {
  const R = 4, taps = 48 * R + 1, h = kaiserLowpass(taps, 0.5 / R * 0.95, 9);
  const m = (taps - 1) / 2;
  let p = 0;
  for (const x of channels) {
    for (let n = 0; n < x.length; n++) {
      for (let ph = 0; ph < R; ph++) {
        // y[n*R + ph] = R * sum_k h[k] * up[n*R + ph - k + m], up nonzero every R
        let acc = 0;
        for (let k = (ph + m) % R; k < taps; k += R) {
          const idx = (n * R + ph - k + m) / R;
          if (idx >= 0 && idx < x.length) acc += h[k] * x[idx];
        }
        const a = Math.abs(acc * R);
        if (a > p) p = a;
      }
    }
  }
  return 20 * Math.log10(Math.max(p, 1e-12));
}
