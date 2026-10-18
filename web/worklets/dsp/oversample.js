// Polyphase 4x oversampler: linear-phase Kaiser FIR used for both the
// interpolator and the decimator. 129 taps at the 4x rate (group delay exactly
// 64 samples at 4x = 16 at 1x per filter, 32 samples round trip). Kaiser beta
// 8.6 gives ~86 dB stopband; the transition runs ~17-25 kHz at a 48 kHz base
// rate, so anything folding back lands above ~23 kHz.
import { kaiserLowpass } from './util.js';

export class Oversampler4x {
  constructor(taps = 129) {
    const L = 4;
    this.L = L;
    const h = kaiserLowpass(taps, 21000 / 192000, 8.6);
    const per = Math.ceil(taps / L);
    this.per = per;
    // phases[k][j] = L*h[j*L + k]  (interpolator gain L restores the level)
    this.phases = [];
    for (let k = 0; k < L; k++) {
      const p = new Float64Array(per);
      for (let j = 0; j < per; j++) { const t = j * L + k; p[j] = t < taps ? L * h[t] : 0; }
      this.phases.push(p);
    }
    this.h = Float64Array.from(h);
    this.taps = taps;
    // Doubled circular history so the interpolator's convolution reads one contiguous run.
    this.xh = new Float64Array(2 * per); this.xi = 0;
    this.dw = null; // linear decimator history + current block, grown on first use (see downBlock)
    this.latency = (taps - 1) / L; // at the base rate, round trip
  }
  /** Push one base-rate sample, write L oversampled samples into out4. */
  up(x, out4) {
    const per = this.per, xh = this.xh, phases = this.phases;
    const xi = this.xi + 1 === per ? 0 : this.xi + 1;
    this.xi = xi;
    xh[xi] = x; xh[xi + per] = x;
    const base = xi + per; // newest sample, walking backwards
    // The four phases are independent dot products over the same history. Running them in one pass keeps each
    // accumulation in its original order (bit-identical) while the four dependency chains overlap in the CPU:
    // a single running sum is limited by floating-point add latency, not by multiplies.
    const p0 = phases[0], p1 = phases[1], p2 = phases[2], p3 = phases[3];
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
    for (let j = 0; j < per; j++) {
      const v = xh[base - j];
      s0 += p0[j] * v; s1 += p1[j] * v; s2 += p2[j] * v; s3 += p3[j] * v;
    }
    out4[0] = s0; out4[1] = s1; out4[2] = s2; out4[3] = s3;
  }
  /**
   * Decimate a block: `y` holds 4n oversampled samples (in order), `out[i]` receives the base-rate sample after
   * each group of four. Same arithmetic, in the same order, as pushing the samples one at a time through a
   * circular history; but here the history is linear, so four outputs (four independent dot products) are
   * computed in one pass and their add chains overlap in the CPU. Bit-identical to the per-sample form.
   */
  downBlock(y, n, out) {
    const taps = this.taps, h = this.h, hl = taps - 1, m = 4 * n;
    let w = this.dw;
    if (!w || w.length < hl + m) { const nw = new Float64Array(hl + m); if (w) nw.set(w.subarray(0, hl)); w = this.dw = nw; }
    w.set(y.length === m ? y : y.subarray(0, m), hl);
    let i = 0;
    for (; i + 4 <= n; i += 4) {
      const e = hl + 4 * i + 3;
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
      for (let t = 0; t < taps; t++) {
        const ht = h[t], b = e - t;
        s0 += ht * w[b]; s1 += ht * w[b + 4]; s2 += ht * w[b + 8]; s3 += ht * w[b + 12];
      }
      out[i] = s0; out[i + 1] = s1; out[i + 2] = s2; out[i + 3] = s3;
    }
    for (; i < n; i++) {
      const e = hl + 4 * i + 3;
      let s = 0;
      for (let t = 0; t < taps; t++) s += h[t] * w[e - t];
      out[i] = s;
    }
    w.copyWithin(0, m, m + hl); // keep the newest taps-1 samples for the next block
  }
}
