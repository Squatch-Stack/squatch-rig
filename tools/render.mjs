#!/usr/bin/env node
// Offline render: a preset + a DI loop -> WAV, deterministically, in Node with
// the same DSP the browser runs (tools/render/graph.mjs).
//
//   node tools/render.mjs [options]
//     --preset demo | <file.rig.json>   pipeline document (default: the demo rig)
//     --loop <id> | <file.wav>          DI loop id from web/audio/loops/index.json (default: first)
//     --seconds <s>                     length (default: one pass of the loop)
//     --preroll <s>                     render and discard this much first, so the file
//                                       starts warm and loops seamlessly (default: one pass;
//                                       0 to start from silence)
//     --solo <label>                    keep only the NAM head whose label contains <label>
//                                       (the other heads are disconnected; its mixer channel is centred)
//     --dry                             write the DI itself (stereo), for comparison
//     --input-gain <dB>                 transport input gain (default 0)
//     --format pcm16|pcm24|float32      (default pcm24)
//     --out <file.wav>                  (default: stdout summary only)
//     --doc-out <file.json>             also write the exact document rendered
//     --meters <fps> --meters-out <f>   also write per-frame meter snapshots (for the reel)
// Prints a JSON summary: seconds, LUFS, sample peak, true peak, sha256 of the WAV.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { renderDoc } from './render/graph.mjs';
import { integratedLoudness, samplePeakDb, truePeakDb } from './render/loudness.mjs';
import { encodeWav, decodeWav } from '../web/js/audio/wav.js';
import { demoDoc } from '../web/js/graph/demo.js';
import { validateDoc } from '../web/js/graph/doc.js';

// Optional private devices (private/render-devices.mjs registers their node types); absent in the public tree.
try { await import('../private/render-devices.mjs'); } catch (e) { if (!(e.code === 'ERR_MODULE_NOT_FOUND' && String(e.message).includes('render-devices'))) throw e; }

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = (...p) => path.join(root, 'web', ...p);

export function loadLoops() { return JSON.parse(fs.readFileSync(web('audio/loops/index.json'), 'utf8')).loops; }
export function modelIndex() { return JSON.parse(fs.readFileSync(web('models/index.json'), 'utf8')).models; }

export function loadDi(loop) {
  const loops = loadLoops();
  const l = loop ? loops.find((x) => x.id === loop) : loops[0];
  const file = l ? web(l.file) : path.resolve(loop);
  const { sampleRate, channels } = decodeWav(fs.readFileSync(file));
  if (sampleRate !== 48000) throw new Error(`${file}: ${sampleRate} Hz, the rig runs at 48 kHz`);
  const mono = channels.length === 1 ? channels[0] : channels[0].map((v, i) => 0.5 * (v + channels[1][i]));
  return { id: l?.id ?? path.basename(file), data: mono, seconds: mono.length / 48000, meta: l || null };
}

/** Keep only the NAM head whose label contains `label`: disconnect the others' inputs, centre its mixer channel. */
export function soloHead(doc, label) {
  const d = structuredClone(doc);
  const heads = Object.entries(d.nodes).filter(([, n]) => n.type === 'nam');
  const keep = heads.find(([, n]) => n.label.toLowerCase().includes(label.toLowerCase()));
  if (!keep) throw new Error(`no NAM head labelled like "${label}" (have: ${heads.map(([, n]) => n.label).join(', ')})`);
  for (const [id] of heads) if (id !== keep[0]) for (const [eid, e] of Object.entries(d.edges)) if (e.to[0] === id) delete d.edges[eid];
  // follow the kept head downstream to the mixer input it lands on
  let cur = keep[0];
  for (let hops = 0; hops < 8; hops++) {
    const e = Object.values(d.edges).find((x) => x.from[0] === cur);
    if (!e) break;
    const n = d.nodes[e.to[0]];
    if (n.type === 'mixer') { n.params[`pan${e.to[1]}`] = 0; break; }
    cur = e.to[0];
  }
  d.name = `${d.name} (solo: ${keep[1].label})`;
  return d;
}

export function loadModels(doc) {
  const idx = modelIndex(), out = {};
  for (const h of Object.keys(doc.models)) {
    const m = idx.find((x) => x.hash === h);
    if (!m) throw new Error(`model ${h} (${doc.models[h].name}) is not in web/models/index.json`);
    out[h] = fs.readFileSync(web('models', m.file));
  }
  return out;
}

/** `diData` (mono Float32Array at 48 kHz) overrides `loop`, e.g. for a sequence of loops. */
export function render({ doc, loop = null, diData = null, seconds = null, preroll = null, inputGainDb = 0, meterFps = 0 }) {
  const di = diData ? { id: 'custom', data: diData, seconds: diData.length / 48000, meta: null } : loadDi(loop);
  const len = seconds ?? di.seconds;
  const pre = preroll ?? di.seconds;
  const r = renderDoc({ doc, di: di.data, models: loadModels(doc), wasmBytes: fs.readFileSync(web('wasm/nam.wasm')), seconds: pre + len, inputGainDb, meterFps });
  const skip = Math.round(pre * r.sampleRate), n = Math.round(len * r.sampleRate);
  return {
    di, sampleRate: r.sampleRate,
    channels: r.channels.map((c) => c.slice(skip, skip + n)),
    frames: r.frames.filter((f) => f.time >= pre - 1e-9).map((f) => ({ ...f, time: f.time - pre })),
  };
}

export function measure(channels, sampleRate = 48000) {
  return { lufs: +integratedLoudness(channels, sampleRate).toFixed(2), samplePeakDb: +samplePeakDb(channels).toFixed(2), truePeakDb: +truePeakDb(channels).toFixed(2) };
}

function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2), v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    o[k] = v;
  }
  return o;
}

async function main() {
  const a = args(process.argv.slice(2));
  let doc;
  if (!a.preset || a.preset === 'demo') doc = validateDoc(demoDoc(modelIndex()));
  else doc = validateDoc(JSON.parse(fs.readFileSync(a.preset, 'utf8')));
  if (a.solo) doc = soloHead(doc, a.solo);
  const t0 = performance.now();
  let channels, di, frames = [];
  if (a.dry) {
    di = loadDi(a.loop || null);
    const n = Math.round((a.seconds ? +a.seconds : di.seconds) * 48000);
    const g = 10 ** ((+(a['input-gain'] || 0)) / 20);
    const m = new Float32Array(n);
    for (let i = 0; i < n; i++) m[i] = di.data[i % di.data.length] * g;
    channels = [m, m];
  } else {
    const r = render({ doc, loop: a.loop || null, seconds: a.seconds ? +a.seconds : null, preroll: a.preroll != null ? +a.preroll : null, inputGainDb: +(a['input-gain'] || 0), meterFps: a.meters ? +a.meters : 0 });
    ({ channels, di, frames } = r);
  }
  const ms = performance.now() - t0;
  const wav = Buffer.from(encodeWav(channels, 48000, { format: a.format || 'pcm24' }));
  if (a.out) { fs.mkdirSync(path.dirname(path.resolve(a.out)), { recursive: true }); fs.writeFileSync(a.out, wav); }
  if (a['doc-out']) fs.writeFileSync(a['doc-out'], JSON.stringify(doc, null, 1));
  if (a['meters-out']) fs.writeFileSync(a['meters-out'], JSON.stringify({ fps: +a.meters, frames }));
  const summary = {
    out: a.out || null, preset: doc.name, loop: di.id, dry: !!a.dry, solo: a.solo || null,
    seconds: +(channels[0].length / 48000).toFixed(3), renderMs: Math.round(ms),
    ...measure(channels), sha256: crypto.createHash('sha256').update(wav).digest('hex'),
  };
  console.log(JSON.stringify(summary));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e.stack || e); process.exit(1); });
