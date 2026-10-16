#!/usr/bin/env node
// Prove a rebuilt nam.wasm behaves like the one it replaces: render every model in web/models with both modules on the
// same inputs and compare sample by sample.
//
//   node tools/compare-wasm.mjs OLD.wasm NEW.wasm [--seconds N] [--tol RELATIVE]
//
// Exit 0 only if every render is bit-identical, or (with --tol) every max abs difference is within RELATIVE x the render's peak. Prints the max absolute difference per model, block size and input.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { instantiateNam } from '../web/worklets/nam-wasm.js';
import { readWav } from '../tests/lib/wav.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const si = args.indexOf('--seconds');
const seconds = si >= 0 ? Number(args.splice(si, 2)[1]) : 6;
const ti = args.indexOf('--tol');
const tol = ti >= 0 ? Number(args.splice(ti, 2)[1]) : 0;
const [oldFile, newFile] = args;
if (!oldFile || !newFile) { console.error('usage: compare-wasm.mjs OLD.wasm NEW.wasm [--seconds N]'); process.exit(2); }

const modOld = new WebAssembly.Module(fs.readFileSync(oldFile));
const modNew = new WebAssembly.Module(fs.readFileSync(newFile));
const modelDir = path.join(root, 'web/models');
const models = fs.readdirSync(modelDir).filter((f) => f.endsWith('.nam')).sort();
const inputs = ['di-loop.wav', ...fs.readdirSync(path.join(root, 'web/audio/loops')).filter((f) => f.endsWith('.wav')).map((f) => `loops/${f}`)];

function render(mod, model, input, block) {
  const nam = instantiateNam(mod);
  const m = nam.create(fs.readFileSync(path.join(modelDir, model)), 48000, block);
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i += block) {
    const n = Math.min(block, input.length - i);
    m.process(input.subarray(i, i + n), out.subarray(i, i + n), n);
  }
  m.destroy();
  return out;
}

let bad = 0, runs = 0;
for (const inName of inputs) {
  const wav = readWav(path.join(root, 'web/audio', inName));
  const input = wav.data.subarray(0, Math.min(wav.data.length, seconds * 48000));
  for (const model of models) for (const block of [32, 128, 480]) {
    const a = render(modOld, model, input, block), b = render(modNew, model, input, block);
    let maxAbs = 0, peak = 0, nan = 0;
    for (let i = 0; i < a.length; i++) {
      if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) nan++;
      maxAbs = Math.max(maxAbs, Math.abs(a[i] - b[i])); peak = Math.max(peak, Math.abs(a[i]));
    }
    const bitIdentical = Buffer.compare(Buffer.from(a.buffer), Buffer.from(b.buffer)) === 0 && nan === 0;
    const identical = bitIdentical || (tol > 0 && nan === 0 && maxAbs <= tol * peak);
    runs++; if (!identical) bad++;
    console.log(`${bitIdentical ? 'IDENTICAL' : identical ? 'WITHIN-TOL' : 'DIFFERS  '} ${model} ${inName} block=${block} peak=${peak.toFixed(3)} maxAbsDiff=${maxAbs} rel=${(maxAbs / (peak || 1)).toExponential(2)}`);
  }
}
console.log(`${runs - bad}/${runs} renders ${tol > 0 ? 'within tolerance' : 'bit-identical'}`);
process.exit(bad ? 1 : 0);
