// Offline renderer for a pipeline document, in Node, with the SAME DSP the
// browser runs: the effect kernels (web/worklets/dsp/*.js via fxrun.js), the
// NAM wasm and its NamHead wrapper (dsp/namhead.js), and the synthetic cab IR
// (web/js/audio/ir.js). The native WebAudio nodes around them are emulated by
// webaudio-lite.mjs, wired exactly as web/js/audio/nodes.js wires them.
//
// Deterministic by construction: no clocks, no threads, no randomness, and
// every model is loaded before the first sample.
import { Gain, StereoPanner, Biquad, Convolver, BufferSource, WorkletHost, LiteGraph, QUANTUM } from './webaudio-lite.mjs';
import { instantiateNam } from '../../web/worklets/nam-wasm.js';
import { NamHead } from '../../web/worklets/dsp/namhead.js';
import { runFx, fxMeter } from '../../web/worklets/dsp/fxrun.js';
import { Compressor } from '../../web/worklets/dsp/compressor.js';
import { Overdrive } from '../../web/worklets/dsp/overdrive.js';
import { Bloom } from '../../web/worklets/dsp/bloom.js';
import { EnvelopeFilter } from '../../web/worklets/dsp/envfilter.js';
import { Reverb } from '../../web/worklets/dsp/reverb.js';
import { NoiseGate } from '../../web/worklets/dsp/gate.js';
import { Limiter } from '../../web/worklets/dsp/limiter.js';
import { dbToLin } from '../../web/worklets/dsp/util.js';
import { synthCabIR } from '../../web/js/audio/ir.js';
import { insOf, outsOf } from '../../web/js/graph/types.js';
import { fillInputs } from '../../web/js/audio/meters.js';

const KINDS = { compressor: Compressor, overdrive: Overdrive, bloom: Bloom, envfilter: EnvelopeFilter, reverb: Reverb, gate: NoiseGate, limiter: Limiter };
const RAMP = 0.012;
const smooth = (param, v) => param.setTargetAtTime(v, 0, RAMP); // every param is applied at t = 0

/** Private devices register a builder here (see private/render-devices.mjs); empty in the public tree. */
const BUILDERS = new Map();
export function registerRenderBuilder(type, build) { BUILDERS.set(type, build); }

export function insert(g) {
  const inp = new Gain(g), out = new Gain(g), wet = new Gain(g, { gain: 1 }), dry = new Gain(g, { gain: 0 });
  inp.connect(dry).connect(out); wet.connect(out);
  return { inp, out, wet, dry };
}

/** Build one pipeline node. Returns { inputs[], outputs[], meter() }. */
function build(g, id, node, ctx) {
  const P = node.params;
  if (BUILDERS.has(node.type)) return BUILDERS.get(node.type)({ g, id, node, ctx, insert });
  switch (node.type) {
    case 'input': {
      const out = new Gain(g), diGain = new Gain(g), liveGain = new Gain(g, { gain: 0 }), trim = new Gain(g, { gain: ctx.inputTrim });
      diGain.connect(out); liveGain.connect(out); out.connect(trim);
      const srcGain = new Gain(g, { gain: 1 });
      srcGain.connect(diGain);
      const src = new BufferSource(g, { buffer: ctx.di, loop: true });
      src.connect(srcGain); src.start();
      smooth(out.gain, dbToLin(P.gain));
      return { inputs: [], outputs: [trim] };
    }
    case 'output': {
      const inp = new Gain(g, { channelCount: 2, channelCountMode: 'explicit' });
      smooth(inp.gain, dbToLin(P.volume));
      ctx.outputs.push(inp);
      return { inputs: [inp], outputs: [], meterNode: inp };
    }
    case 'splitter': {
      const inp = new Gain(g), pans = [];
      for (let i = 0; i < outsOf(node); i++) {
        const gn = new Gain(g), p = new StereoPanner(g);
        inp.connect(gn).connect(p);
        smooth(gn.gain, dbToLin(P[`level${i}`])); smooth(p.pan, P[`pan${i}`]);
        pans.push(p);
      }
      return { inputs: [inp], outputs: pans };
    }
    case 'mixer': {
      const master = new Gain(g, { channelCount: 2, channelCountMode: 'explicit' }), gains = [];
      for (let i = 0; i < insOf(node); i++) {
        const gn = new Gain(g), p = new StereoPanner(g);
        gn.connect(p).connect(master);
        smooth(gn.gain, dbToLin(P[`level${i}`])); smooth(p.pan, P[`pan${i}`]);
        gains.push(gn);
      }
      smooth(master.gain, dbToLin(P.master));
      return { inputs: gains, outputs: [master] };
    }
    case 'nam': {
      const io = insert(g);
      const head = new NamHead(g.sampleRate, { ...P });
      const bytes = ctx.models[node.model];
      if (!bytes) throw new Error(`node ${node.label || id}: model ${node.model} not available`);
      head.setModel(ctx.nam.create(new Uint8Array(bytes), g.sampleRate, QUANTUM));
      const proc = new WorkletHost(g, { channelCount: 1, channelCountMode: 'explicit', outputChannels: 1, fn: (ins, out) => head.process(ins[0] || null, out[0], QUANTUM) });
      io.inp.connect(proc).connect(io.wet);
      if (node.bypass) { smooth(io.wet.gain, 0); smooth(io.dry.gain, 1); }
      ctx.dispose.push(() => head.setModel(null)?.destroy());
      return { inputs: [io.inp], outputs: [io.out] };
    }
    case 'cab': {
      const io = insert(g);
      const conv = new Convolver(g), hp = new Biquad(g, { type: 'highpass', Q: 0.7 }), lp = new Biquad(g, { type: 'lowpass', Q: 0.7 }), level = new Gain(g);
      io.inp.connect(conv).connect(hp).connect(lp).connect(level).connect(io.wet);
      if (node.ir) throw new Error(`node ${node.label || id}: custom IRs are not supported offline yet`);
      conv.buffer = synthCabIR(g.sampleRate, P.voice, P.mic);
      smooth(hp.frequency, P.lowcut); smooth(lp.frequency, P.highcut); smooth(level.gain, dbToLin(P.level));
      if (node.bypass) { smooth(io.wet.gain, 0); smooth(io.dry.gain, 1); }
      return { inputs: [io.inp], outputs: [io.out] };
    }
    default: {
      const K = KINDS[node.type];
      if (!K) throw new Error(`node ${id}: unknown type ${node.type}`);
      const io = insert(g);
      const kernel = new K(g.sampleRate);
      for (const [k, v] of Object.entries(P)) kernel.set(k, v);
      const silent = [new Float32Array(QUANTUM)];
      const proc = new WorkletHost(g, { outputChannels: node.type === 'reverb' ? 2 : null, fn: (ins, out) => runFx(node.type, kernel, ins.length ? ins : silent, out, QUANTUM) });
      io.inp.connect(proc).connect(io.wet);
      if (node.bypass) { smooth(io.wet.gain, 0); smooth(io.dry.gain, 1); }
      return { inputs: [io.inp], outputs: [io.out], fx: () => fxMeter(node.type, kernel), bypass: node.bypass };
    }
  }
}

/**
 * Render `doc` with `di` (mono Float32Array, looped) as the DI source.
 *   models: { "sha256:…": ArrayBuffer|Uint8Array }  wasmBytes: the nam.wasm bytes
 *   meterFps: if set, also returns one metering frame per video frame (the
 *             shape web/js/audio/meters.js applyFrame() takes), computed the way
 *             the browser's analysers see the signal (1024-sample windows).
 * Returns { sampleRate, channels: [L, R], frames }.
 */
export function renderDoc({ doc, di, models, wasmBytes, seconds, sampleRate = 48000, inputGainDb = 0, meterFps = 0, onProgress = null }) {
  const g = new LiteGraph(sampleRate);
  const nam = instantiateNam(new WebAssembly.Module(wasmBytes));
  const ctx = { di, models, nam, outputs: [], dispose: [], inputTrim: dbToLin(inputGainDb) };
  const built = new Map();
  for (const [id, n] of Object.entries(doc.nodes)) built.set(id, build(g, id, n, ctx));
  for (const e of Object.values(doc.edges)) {
    const a = built.get(e.from[0]), b = built.get(e.to[0]);
    if (a?.outputs[e.from[1]] && b?.inputs[e.to[1]]) a.outputs[e.from[1]].connect(b.inputs[e.to[1]]);
  }
  // master: output nodes -> rigBus -> masterBus (0 dB) -> destination (2 ch explicit)
  const dest = new Gain(g, { channelCount: 2, channelCountMode: 'explicit' });
  for (const o of ctx.outputs) o.connect(dest);

  const total = Math.ceil((seconds * sampleRate) / QUANTUM);
  const frames = Math.round(seconds * sampleRate);
  const L = new Float32Array(total * QUANTUM), R = new Float32Array(total * QUANTUM);

  // metering taps: a 1024-sample ring per output port (analyser = mono down-mix)
  const W = 1024, taps = [];
  if (meterFps) for (const [id, b] of built) {
    const ports = b.meterNode ? [b.meterNode] : b.outputs;
    taps.push({ id, type: doc.nodes[id].type, b, rings: ports.map((node) => ({ node, ring: new Float32Array(W), w: 0 })) });
  }
  const meterFrames = [];
  let nextFrame = 0, mPeak = 0, mSS = 0, mN = 0, mClips = 0;
  const snap = (t) => {
    const nodes = {};
    for (const tp of taps) {
      const ports = tp.rings.map(({ ring }) => { let s = 0, p = 0; for (let i = 0; i < W; i++) { const v = ring[i]; s += v * v; const a = v < 0 ? -v : v; if (a > p) p = a; } return { rms: Math.sqrt(s / W), peak: p }; });
      const fm = tp.b.fx && !tp.b.bypass ? tp.b.fx() : null;
      nodes[tp.id] = { type: tp.type, ports, gr: fm?.gr || 0, cutoff: fm?.cutoff ?? null, open: fm?.open ?? null };
    }
    const f = { time: t, master: { rms: mN ? Math.sqrt(mSS / mN) : 0, peak: mPeak, clips: mClips }, nodes };
    mPeak = 0; mSS = 0; mN = 0; mClips = 0;
    return fillInputs(f, doc);
  };

  for (let q = 0; q < total; q++) {
    const [out] = dest.pull(q);
    L.set(out[0], q * QUANTUM); R.set(out[1], q * QUANTUM);
    if (meterFps) {
      for (const tp of taps) for (const r of tp.rings) {
        const src = r.node.pull(q)[0];
        for (let i = 0; i < QUANTUM; i++) { r.ring[r.w] = src.length === 1 ? src[0][i] : 0.5 * (src[0][i] + src[1][i]); r.w = (r.w + 1) % W; }
      }
      for (let i = 0; i < QUANTUM; i++) {
        const a = Math.abs(out[0][i]), b = Math.abs(out[1][i]);
        mPeak = Math.max(mPeak, a, b); mSS += (out[0][i] ** 2 + out[1][i] ** 2) / 2; mN++;
        if (a >= 0.999) mClips++; if (b >= 0.999) mClips++;
      }
      const tEnd = ((q + 1) * QUANTUM) / sampleRate;
      while (nextFrame / meterFps <= tEnd && meterFrames.length < Math.ceil(seconds * meterFps)) { meterFrames.push(snap(nextFrame / meterFps)); nextFrame++; }
    }
    if (onProgress && q % 1875 === 0) onProgress(q / total);
  }
  for (const d of ctx.dispose) d();
  return { sampleRate, channels: [L.subarray(0, frames), R.subarray(0, frames)], frames: meterFrames };
}
