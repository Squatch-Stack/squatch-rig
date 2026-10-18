// Bloom: a pick-sensitive drive. A short attack detector holds the clean,
// delay-aligned pick in front; as it decays, an oversampled overdrive blooms
// into the sustain. This is a DSP pedal, not a trained NAM capture.
import { Overdrive } from './overdrive.js';
import { dbToLin } from './util.js';
import { BLOOM_PARAMS } from '../../js/graph/bloom-contract.js';

const LATENCY = 32; // Oversampler4x's measured algorithmic delay in this rig.

export class Bloom {
  static params = BLOOM_PARAMS;

  constructor(sampleRate) {
    this.sr = sampleRate;
    this.drive = new Overdrive(sampleRate);
    this.p = Object.fromEntries(Object.entries(Bloom.params).map(([k, v]) => [k, v.def]));
    this.ch = [];
    this.wetInputs = [];
    // What the UI's bloom motion reads (fxMeter, ~60 Hz): the drive share of the
    // output averaged since the last read, and the strongest pick guard.
    this.mixSum = 0; this.mixN = 0; this.pickPeak = 0;
    this._update();
  }
  _update() {
    this.drive.set('drive', 0.18 + 0.64 * this.p.bloom);
    this.drive.set('tone', 0.74 - 0.48 * this.p.warmth);
    this.drive.set('voice', 760 - 460 * this.p.warmth);
    this.drive.set('asym', 0.3);
    this.drive.set('level', 0);
    this.out = dbToLin(this.p.level);
    this.fastA = 1 - Math.exp(-1 / (0.003 * this.sr));
    this.fastR = 1 - Math.exp(-1 / (0.045 * this.sr));
    this.slowA = 1 - Math.exp(-1 / (0.085 * this.sr));
    this.slowR = 1 - Math.exp(-1 / (0.19 * this.sr));
  }
  set(name, value) {
    if (!Object.hasOwn(Bloom.params, name) || !Number.isFinite(value)) return;
    const spec = Bloom.params[name];
    this.p[name] = Math.max(spec.min, Math.min(spec.max, value));
    this._update();
  }
  _chan(index, n) {
    while (this.ch.length <= index) this.ch.push({ fast: 0, slow: 0, ring: new Float32Array(LATENCY), at: 0, wet: new Float32Array(n) });
    const ch = this.ch[index];
    if (ch.wet.length < n) ch.wet = new Float32Array(n);
    return ch;
  }
  process(ins, outs, n) {
    this.wetInputs.length = ins.length;
    for (let c = 0; c < ins.length; c++) this.wetInputs[c] = this._chan(c, n).wet;
    this.drive.process(ins, this.wetInputs, n);
    const fastA = this.fastA, fastR = this.fastR, slowA = this.slowA, slowR = this.slowR;
    const touch = this.p.touch, bloom = this.p.bloom, outGain = this.out;
    let mixSum = this.mixSum, pickPeak = this.pickPeak;
    for (let c = 0; c < ins.length; c++) {
      const st = this._chan(c, n), input = ins[c], output = outs[c], ring = st.ring, wet = st.wet, rl = ring.length;
      // State and constants in locals for the block: same arithmetic in the same order, without a property
      // load or a boxed-double store per sample.
      let fast = st.fast, slow = st.slow, at = st.at;
      for (let i = 0; i < n; i++) {
        const x = input[i], abs = Math.abs(x);
        fast += (abs > fast ? fastA : fastR) * (abs - fast);
        slow += (abs > slow ? slowA : slowR) * (abs - slow);
        if (fast < 1e-30) fast = 0; // subnormal guard (slow on x86); onset divides by max(fast, 0.015)
        if (slow < 1e-30) slow = 0;
        const onset = Math.max(0, fast - slow) / Math.max(fast, 0.015);
        const guard = Math.min(1, onset * touch * 1.65);
        const clean = ring[at];
        ring[at] = x;
        at = at + 1 === rl ? 0 : at + 1;
        const mix = Math.max(0.05, Math.min(1, bloom * (1 - 0.85 * guard)));
        output[i] = (clean * (1 - mix) + wet[i] * mix) * outGain;
        if (c === 0) { mixSum += mix; if (guard > pickPeak) pickPeak = guard; }
      }
      st.fast = fast; st.slow = slow; st.at = at;
      if (c === 0) this.mixN += n;
    }
    this.mixSum = mixSum; this.pickPeak = pickPeak;
  }
}
