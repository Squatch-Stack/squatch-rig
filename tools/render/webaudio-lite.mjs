// A small, deterministic re-implementation of the WebAudio pieces the rig uses,
// for rendering in Node without a browser: GainNode, StereoPannerNode,
// BiquadFilterNode (lowpass/highpass), ConvolverNode, AudioBufferSourceNode and
// AudioWorklet-style hosts. It follows the spec where it matters for level:
// 128-frame render quanta, pull-order processing of a DAG, the channel
// count/mode up- and down-mix rules ("speakers": mono->stereo copies,
// stereo->mono averages), a-rate AudioParam automation with setTargetAtTime,
// the equal-power StereoPanner law, and the spec's biquad formulas (Q in dB for
// lowpass/highpass). It is not a general WebAudio: only what nodes.js builds.
export const QUANTUM = 128;

export class Param {
  constructor(g, value) { this.g = g; this.v0 = value; this.target = value; this.start = 0; this.tau = 0; this.buf = new Float32Array(QUANTUM); this.constant = true; }
  get value() { return this.target; }
  set value(v) { this.v0 = v; this.target = v; this.tau = 0; }
  /** setTargetAtTime(target, time, timeConstant) — the only automation nodes.js uses. */
  setTargetAtTime(target, time, tau) {
    const f = Math.round(time * this.g.sampleRate);
    this.v0 = this._at(f); this.start = f; this.target = target; this.tau = tau * this.g.sampleRate;
  }
  _at(f) { return this.tau > 0 && f >= this.start ? this.target + (this.v0 - this.target) * Math.exp(-(f - this.start) / this.tau) : (f < this.start ? this.v0 : this.target); }
  /** Per-sample values for the quantum starting at frame f0. */
  fill(f0) {
    const b = this.buf;
    if (this.tau > 0) {
      const d0 = this.v0 - this.target;
      // settled: treat as constant once within 1e-7 (relative) of the target
      if (Math.abs(d0 * Math.exp(-(f0 - this.start) / this.tau)) <= 1e-7 * Math.max(1e-3, Math.abs(this.target))) { this.v0 = this.target; this.tau = 0; }
      else { for (let i = 0; i < QUANTUM; i++) b[i] = this._at(f0 + i); this.constant = false; return b; }
    }
    this.constant = true; b.fill(this.target);
    return b;
  }
}

const zeros = new Float32Array(QUANTUM);

/** Up/down-mix `chs` (array of Float32Array) to n channels, speakers rules for 1<->2. */
function mixTo(chs, n) {
  if (chs.length === n) return chs;
  if (chs.length === 1 && n === 2) return [chs[0], chs[0]];
  if (chs.length === 2 && n === 1) { const m = new Float32Array(QUANTUM); for (let i = 0; i < QUANTUM; i++) m[i] = 0.5 * (chs[0][i] + chs[1][i]); return [m]; }
  if (chs.length > n) return chs.slice(0, n); // discrete (not used by the rig)
  return [...chs, ...Array.from({ length: n - chs.length }, () => zeros)];
}

export class LiteNode {
  constructor(g, { inputs = 1, outputs = 1, channelCount = 2, channelCountMode = 'max' } = {}) {
    this.g = g; this.ins = Array.from({ length: inputs }, () => []); this.nOut = outputs;
    this.channelCount = channelCount; this.channelCountMode = channelCountMode;
    this.q = -1; this.out = null;
  }
  connect(dst, output = 0, input = 0) { dst.ins[input].push({ node: this, port: output }); return dst; }
  disconnect() { /* graphs are built once per render */ }
  /** Summed, channel-mixed input for port i. */
  _input(i, q) {
    const srcs = this.ins[i].map((c) => c.node.pull(q)[c.port]);
    let n;
    const maxCh = srcs.reduce((m, s) => Math.max(m, s.length), 1);
    if (this.channelCountMode === 'explicit') n = this.channelCount;
    else if (this.channelCountMode === 'clamped-max') n = Math.min(maxCh, this.channelCount);
    else n = maxCh;
    if (!srcs.length) return { chans: Array.from({ length: n }, () => zeros), connected: false };
    const out = Array.from({ length: n }, () => new Float32Array(QUANTUM));
    for (const s of srcs) {
      const m = mixTo(s, n);
      for (let c = 0; c < n; c++) { const o = out[c], x = m[c]; for (let k = 0; k < QUANTUM; k++) o[k] += x[k]; }
    }
    return { chans: out, connected: true };
  }
  pull(q) {
    if (this.q !== q) { this.q = q; this.out = this.process(this.ins.map((_, i) => this._input(i, q)), q * QUANTUM); }
    return this.out;
  }
}

export class Gain extends LiteNode {
  constructor(g, { gain = 1, channelCount = 2, channelCountMode = 'max' } = {}) { super(g, { channelCount, channelCountMode }); this.gain = new Param(g, gain); }
  process([inp], f0) {
    const gv = this.gain.fill(f0);
    return [inp.chans.map((x) => { const y = new Float32Array(QUANTUM); for (let i = 0; i < QUANTUM; i++) y[i] = x[i] * gv[i]; return y; })];
  }
}

export class StereoPanner extends LiteNode {
  constructor(g, { pan = 0 } = {}) { super(g, { channelCount: 2, channelCountMode: 'clamped-max' }); this.pan = new Param(g, pan); }
  process([inp], f0) {
    const pv = this.pan.fill(f0), L = new Float32Array(QUANTUM), R = new Float32Array(QUANTUM);
    const h = Math.PI / 2;
    if (inp.chans.length === 1) {
      const x = inp.chans[0];
      for (let i = 0; i < QUANTUM; i++) { const p = Math.max(-1, Math.min(1, pv[i])), t = (p + 1) / 2; L[i] = x[i] * Math.cos(t * h); R[i] = x[i] * Math.sin(t * h); }
    } else {
      const [xl, xr] = inp.chans;
      for (let i = 0; i < QUANTUM; i++) {
        const p = Math.max(-1, Math.min(1, pv[i]));
        if (p <= 0) { const t = p + 1; L[i] = xl[i] + xr[i] * Math.cos(t * h); R[i] = xr[i] * Math.sin(t * h); }
        else { const t = p; L[i] = xl[i] * Math.cos(t * h); R[i] = xr[i] + xl[i] * Math.sin(t * h); }
      }
    }
    return [[L, R]];
  }
}

export class Biquad extends LiteNode {
  constructor(g, { type = 'lowpass', frequency = 350, Q = 1 } = {}) {
    super(g); this.type = type; this.frequency = new Param(g, frequency); this.Q = Q; this.state = [];
  }
  _coef(f) {
    const sr = this.g.sampleRate, nyq = sr / 2, fn = Math.max(0, Math.min(f, nyq)) / sr;
    const w0 = 2 * Math.PI * fn, cw = Math.cos(w0), al = Math.sin(w0) / (2 * Math.pow(10, this.Q / 20));
    let b0, b1, b2; const a0 = 1 + al, a1 = -2 * cw, a2 = 1 - al;
    if (this.type === 'lowpass') { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; } else { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; }
    return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
  }
  process([inp], f0) {
    const fv = this.frequency.fill(f0), constant = this.frequency.constant;
    let k = constant ? this._coef(fv[0]) : null;
    return [inp.chans.map((x, c) => {
      const s = this.state[c] || (this.state[c] = [0, 0, 0, 0]);
      let [x1, x2, y1, y2] = s;
      const y = new Float32Array(QUANTUM);
      for (let i = 0; i < QUANTUM; i++) {
        const kk = constant ? k : this._coef(fv[i]);
        const v = kk[0] * x[i] + kk[1] * x1 + kk[2] * x2 - kk[3] * y1 - kk[4] * y2;
        x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
      }
      s[0] = x1; s[1] = x2; s[2] = y1; s[3] = y2;
      return y;
    })];
  }
}

// ---- uniformly partitioned FFT convolution (partition = one quantum), exact up to float rounding
function fft(re, im, inv) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (2 * Math.PI) / len * (inv ? 1 : -1), wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const ar = re[i + j], ai = im[i + j], br = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci, bi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
        re[i + j] = ar + br; im[i + j] = ai + bi; re[i + j + len / 2] = ar - br; im[i + j + len / 2] = ai - bi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
  if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

class PartConv {
  constructor(ir) {
    const B = QUANTUM, N = 2 * B;
    this.P = Math.ceil(ir.length / B);
    this.H = [];
    for (let p = 0; p < this.P; p++) {
      const re = new Float64Array(N), im = new Float64Array(N);
      for (let i = 0; i < B && p * B + i < ir.length; i++) re[i] = ir[p * B + i];
      fft(re, im, false); this.H.push([re, im]);
    }
    this.X = Array.from({ length: this.P }, () => [new Float64Array(N), new Float64Array(N)]);
    this.head = 0; this.prev = new Float64Array(B);
  }
  process(x) {
    const B = QUANTUM, N = 2 * B;
    this.head = (this.head + this.P - 1) % this.P;
    const [xr, xi] = this.X[this.head];
    for (let i = 0; i < B; i++) { xr[i] = this.prev[i]; xr[B + i] = x[i]; xi[i] = 0; xi[B + i] = 0; this.prev[i] = x[i]; }
    fft(xr, xi, false);
    const ar = new Float64Array(N), ai = new Float64Array(N);
    for (let p = 0; p < this.P; p++) {
      const [sr, si] = this.X[(this.head + p) % this.P], [hr, hi] = this.H[p];
      for (let k = 0; k < N; k++) { ar[k] += sr[k] * hr[k] - si[k] * hi[k]; ai[k] += sr[k] * hi[k] + si[k] * hr[k]; }
    }
    fft(ar, ai, true);
    const y = new Float32Array(B);
    for (let i = 0; i < B; i++) y[i] = ar[B + i]; // overlap-save: keep the last B
    return y;
  }
}

export class Convolver extends LiteNode {
  constructor(g) { super(g, { channelCount: 2, channelCountMode: 'clamped-max' }); this.ir = null; this.conv = []; }
  set buffer(ir) { this.ir = ir; this.conv = []; }
  process([inp]) {
    if (!this.ir) return [inp.chans.map(() => new Float32Array(QUANTUM))];
    const n = inp.chans.length === 1 ? 1 : 2;
    const chans = mixTo(inp.chans, n);
    return [chans.map((x, c) => (this.conv[c] || (this.conv[c] = new PartConv(this.ir))).process(x))];
  }
}

export class BufferSource extends LiteNode {
  constructor(g, { buffer, loop = true }) { super(g, { inputs: 0 }); this.data = buffer; this.loop = loop; this.pos = 0; this.started = false; }
  start() { this.started = true; }
  process() {
    const y = new Float32Array(QUANTUM), d = this.data;
    if (!this.started) return [[y]];
    for (let i = 0; i < QUANTUM; i++) {
      if (this.pos >= d.length) { if (!this.loop) break; this.pos = 0; }
      y[i] = d[this.pos++];
    }
    return [[y]];
  }
}

/** An AudioWorkletNode stand-in: `fn(inChans, outChans, connected)` fills the output channels. */
export class WorkletHost extends LiteNode {
  constructor(g, { channelCount = 2, channelCountMode = 'max', outputChannels = null, fn }) {
    super(g, { channelCount, channelCountMode }); this.outputChannels = outputChannels; this.fn = fn;
  }
  process([inp]) {
    const n = this.outputChannels ?? inp.chans.length;
    const out = Array.from({ length: n }, () => new Float32Array(QUANTUM));
    this.fn(inp.connected ? inp.chans : [], out);
    return [out];
  }
}

export class LiteGraph {
  constructor(sampleRate = 48000) { this.sampleRate = sampleRate; this.currentTime = 0; }
}
