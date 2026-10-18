// Look-ahead peak limiter that cannot overshoot its ceiling.
//
// Per sample: required gain r = min(1, ceiling/|x|). A running minimum of r
// over the look-ahead window L, then a release-only smoother (instant down,
// exponential up), then a length-L moving average. Every gain applied to a
// peak is an average of values each <= that peak's required gain, and the
// audio is delayed by L-1 samples so the average has fully arrived: output
// peak <= ceiling, exactly, with a click-free ramp into the reduction.
import { dbToLin, tauCoef } from './util.js';

export class Limiter {
  static params = {
    gain: { min: 0, max: 18, def: 0, unit: 'dB', label: 'Drive' },
    ceiling: { min: -12, max: 0, def: -1, unit: 'dB', label: 'Ceiling' },
    release: { min: 10, max: 1000, def: 120, unit: 'ms', label: 'Release', curve: 'log' },
  };
  constructor(sampleRate, lookaheadMs = 2) {
    this.sr = sampleRate;
    this.p = {};
    for (const [k, v] of Object.entries(Limiter.params)) this.p[k] = v.def;
    this.L = Math.max(1, Math.round((lookaheadMs * sampleRate) / 1000));
    // Running minimum of the required gain over the last L samples: a monotonic deque of ring positions
    // (values strictly increasing front to back), O(1) per sample where a scan of the window cost O(L).
    // The ring starts as L ones, which the deque represents as its newest slot alone (ties pop older entries).
    this.dqPos = new Int32Array(this.L + 1); this.dqVal = new Float64Array(this.L + 1);
    this.dqHead = 0; this.dqLen = 1; this.dqPos[0] = this.L - 1; this.dqVal[0] = 1;
    this.sm = new Float64Array(this.L).fill(1); // ring of smoothed gains (for the average)
    this.sum = this.L; this.idx = 0; this.r = 1;
    this.delay = [];
    this.grDb = 0;
    this.latency = this.L - 1;
    this._update();
  }
  set(name, value) { this.p[name] = value; this._update(); }
  _update() {
    this.inGain = dbToLin(this.p.gain);
    this.ceil = dbToLin(this.p.ceiling);
    this.aR = tauCoef(this.p.release, this.sr);
  }
  process(ins, outs, n) {
    const L = this.L, chans = ins.length;
    while (this.delay.length < chans) this.delay.push(new Float32Array(L));
    let minGain = 1;
    for (let i = 0; i < n; i++) {
      let a = 0;
      for (let c = 0; c < chans; c++) { const v = Math.abs(ins[c][i] * this.inGain); if (v > a) a = v; }
      const idx = this.idx;
      const need = a > this.ceil ? this.ceil / a : 1;
      // slot idx is about to be overwritten: drop it from the window, then keep the deque monotonic
      const cap = L + 1, dqPos = this.dqPos, dqVal = this.dqVal;
      let head = this.dqHead, len = this.dqLen;
      if (dqPos[head] === idx) { head = head + 1 === cap ? 0 : head + 1; len--; }
      while (len > 0) { const back = head + len - 1; if (dqVal[back >= cap ? back - cap : back] >= need) len--; else break; }
      const tail = head + len;
      const at = tail >= cap ? tail - cap : tail;
      dqPos[at] = idx; dqVal[at] = need; len++;
      this.dqHead = head; this.dqLen = len;
      const h = dqVal[head];
      this.r = h < this.r ? h : this.aR * this.r + (1 - this.aR) * h;
      if (this.r > h) this.r = h;
      this.sum += this.r - this.sm[idx];
      this.sm[idx] = this.r;
      if ((i & 63) === 0) { let s = 0; for (let k = 0; k < L; k++) s += this.sm[k]; this.sum = s; }
      const g = Math.min(1, this.sum / L);
      if (g < minGain) minGain = g;
      // ring index idx currently holds the sample written L steps ago -> delay L-1 after write/read order
      const readIdx = idx + 1 === L ? 0 : idx + 1;
      for (let c = 0; c < chans; c++) {
        const d = this.delay[c];
        d[idx] = ins[c][i] * this.inGain;
        outs[c][i] = d[readIdx] * g;
      }
      this.idx = readIdx;
    }
    this.grDb = -20 * Math.log10(minGain);
  }
}
