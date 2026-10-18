// Signal helpers for DSP tests.
export const SR = 48000;
export function sine(freq, amp, n, sr = SR, phase = 0) {
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin(2 * Math.PI * freq * i / sr + phase);
  return x;
}
/** Run a kernel (process(ins, outs, n)) over mono input in 128-frame blocks. */
export function run(kernel, input, { outCh = 1, block = 128 } = {}) {
  const n = input.length;
  const outs = Array.from({ length: outCh }, () => new Float32Array(n));
  for (let i = 0; i < n; i += block) {
    const m = Math.min(block, n - i);
    kernel.process([input.subarray(i, i + m)], outs.map((o) => o.subarray(i, i + m)), m);
  }
  return outCh === 1 ? outs[0] : outs;
}
export const peak = (x, from = 0, to = x.length) => { let p = 0; for (let i = from; i < to; i++) p = Math.max(p, Math.abs(x[i])); return p; };
export const rms = (x, from = 0, to = x.length) => { let s = 0; for (let i = from; i < to; i++) s += x[i] * x[i]; return Math.sqrt(s / (to - from)); };
export const db = (x) => 20 * Math.log10(Math.max(x, 1e-15));
/** Magnitude of DFT bin k over x[from..from+N) (Goertzel). */
export function bin(x, k, N, from = 0) {
  const w = 2 * Math.PI * k / N, c = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < N; i++) { const s0 = x[from + i] + c * s1 - s2; s2 = s1; s1 = s0; }
  const re = s1 - s2 * Math.cos(w), im = s2 * Math.sin(w);
  return (2 / N) * Math.hypot(re, im);
}
/** Power spectrum (|X|^2 per bin 0..N/2) via radix-2 FFT. N must be a power of two. */
export function powerSpectrum(x, N, from = 0) {
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < N; i++) re[i] = x[from + i];
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; }
  }
  for (let len = 2; len <= N; len <<= 1) {
    const a = -2 * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < N; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const ur = re[i + j], ui = im[i + j];
        const vr = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci;
        const vi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
        re[i + j] = ur + vr; im[i + j] = ui + vi; re[i + j + len / 2] = ur - vr; im[i + j + len / 2] = ui - vi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
  const p = new Float64Array(N / 2 + 1);
  for (let k = 0; k <= N / 2; k++) p[k] = re[k] * re[k] + im[k] * im[k];
  return p;
}
