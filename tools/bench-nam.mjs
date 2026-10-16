// Benchmark NAM wasm builds in Node (V8, same engine as Chrome's worklet).
// usage: node tools/bench-nam.mjs [wasm files...]   -> realtime factor per model
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { instantiateNam } from '../web/worklets/nam-wasm.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wasms = process.argv.slice(2).length ? process.argv.slice(2) : ['web/wasm/nam.wasm', 'web/wasm/nam-scalar.wasm'];
const models = (process.env.MODELS ? process.env.MODELS.split(',') : fs.readdirSync(path.join(root, 'web/models')).filter((f) => f.endsWith('.nam')));
const SR = 48000, BLOCK = 128, WARM = 3, SECS = 2, REPS = +(process.env.REPS || 5);
// Best of REPS: the machine this was written on is shared and heavily loaded,
// so the minimum is the least-contended estimate of the kernel's own cost.
const input = new Float32Array(SR * SECS);
for (let i = 0; i < input.length; i++) input[i] = 0.3 * Math.sin(2 * Math.PI * 110 * i / SR) + 0.05 * (Math.random() - 0.5);
const rows = [];
for (const w of wasms) {
  const mod = new WebAssembly.Module(fs.readFileSync(path.resolve(root, w)));
  for (const model of models) {
    const nam = instantiateNam(mod);
    const m = nam.create(fs.readFileSync(path.join(root, 'web/models', model)), SR, BLOCK);
    const out = new Float32Array(BLOCK);
    const run = (secs) => { for (let i = 0; i < secs * SR; i += BLOCK) m.process(input.subarray(i % input.length, (i % input.length) + BLOCK), out, BLOCK); };
    run(WARM);
    let ms = Infinity;
    for (let r = 0; r < REPS; r++) { const t0 = performance.now(); run(SECS); ms = Math.min(ms, performance.now() - t0); }
    const perQuantumUs = (ms * 1000) / ((SECS * SR) / BLOCK);
    rows.push({ wasm: path.basename(w), model, realtime: +(SECS * 1000 / ms).toFixed(1), usPerQuantum: +perQuantumUs.toFixed(1), budgetPct: +(100 * perQuantumUs / (BLOCK / SR * 1e6)).toFixed(1) });
    m.destroy();
  }
}
console.table(rows);
if (process.env.BENCH_JSON) fs.writeFileSync(process.env.BENCH_JSON, JSON.stringify(rows, null, 1));
