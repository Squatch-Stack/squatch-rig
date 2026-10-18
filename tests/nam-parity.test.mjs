// NAM WASM (the module the browser runs) vs the native `render` tool built from
// the same NAM Core fork, same model, same input. Skips if the native tool is
// not built (see README: build/native).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { instantiateNam } from '../web/worklets/nam-wasm.js';
import { readWav, writeWavFloat } from './lib/wav.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const renderBin = path.join(root, 'build/native/tools/render');
const outDir = path.join(root, 'tests/out');
fs.mkdirSync(outDir, { recursive: true });

// Every model on disk: the public tree has the two NAM Core examples, a dev tree also has its own captures.
const models = fs.readdirSync(path.join(root, 'web/models')).filter((f) => f.endsWith('.nam')).sort();
const SECONDS = 6;

export function renderWasm(wasmFile, modelFile, input, block = 128) {
  const mod = new WebAssembly.Module(fs.readFileSync(path.join(root, wasmFile)));
  const nam = instantiateNam(mod);
  const m = nam.create(fs.readFileSync(path.join(root, 'web/models', modelFile)), 48000, block);
  const out = new Float32Array(input.length);
  const t0 = performance.now();
  for (let i = 0; i < input.length; i += block) {
    const n = Math.min(block, input.length - i);
    m.process(input.subarray(i, i + n), out.subarray(i, i + n), n);
  }
  const ms = performance.now() - t0;
  m.destroy();
  return { out, ms };
}

for (const model of models) {
  test(`NAM wasm matches native render: ${model}`, { skip: !fs.existsSync(renderBin) && 'native render not built' }, () => {
    const di = readWav(path.join(root, 'web/audio/di-loop.wav'));
    const input = di.data.subarray(0, SECONDS * 48000);
    const inPath = path.join(outDir, 'parity-in.wav');
    writeWavFloat(inPath, input, 48000);
    const nativePath = path.join(outDir, `parity-native-${model}.wav`);
    execFileSync(renderBin, [path.join(root, 'web/models', model), inPath, nativePath], { stdio: 'pipe' });
    const native = readWav(nativePath).data;
    const results = {};
    const variants = path.join(root, 'build/wasm-variants');
    const wasms = ['web/wasm/nam.wasm', ...(fs.existsSync(variants) ? fs.readdirSync(variants).filter((f) => f.endsWith('.wasm')).map((f) => `build/wasm-variants/${f}`) : [])];
    for (const wasm of wasms) {
      const { out, ms } = renderWasm(wasm, model, input);
      let maxAbs = 0, peak = 0;
      for (let i = 0; i < out.length; i++) { maxAbs = Math.max(maxAbs, Math.abs(out[i] - native[i])); peak = Math.max(peak, Math.abs(native[i])); }
      results[wasm] = { maxAbsDiff: maxAbs, nativePeak: peak, realtimeFactor: +(SECONDS * 1000 / ms).toFixed(1) };
      assert.ok(maxAbs < 1e-4, `${wasm}: max abs diff ${maxAbs}`);
    }
    console.log(JSON.stringify({ model, ...results }));
    fs.writeFileSync(path.join(outDir, `parity-${model}.json`), JSON.stringify(results, null, 1));
  });
}

test('several models in ONE shared instance give the same output as separate instances', () => {
  // The worklet shares one wasm instance (one heap) between every NAM node.
  const mod = new WebAssembly.Module(fs.readFileSync(path.join(root, 'web/wasm/nam.wasm')));
  const di = readWav(path.join(root, 'web/audio/di-loop.wav')).data.subarray(0, 2 * 48000);
  const files = models.slice(0, 3);
  assert.ok(files.length >= 2, 'at least two models, so one instance really is shared');
  const shared = instantiateNam(mod);
  const ms = files.map((f) => shared.create(fs.readFileSync(path.join(root, 'web/models', f)), 48000, 128));
  const outs = files.map(() => new Float32Array(di.length));
  for (let i = 0; i < di.length; i += 128) ms.forEach((m, k) => m.process(di.subarray(i, i + 128), outs[k].subarray(i, i + 128), 128));
  files.forEach((f, k) => {
    const { out } = renderWasm('web/wasm/nam.wasm', f, di);
    let d = 0; for (let i = 0; i < out.length; i++) d = Math.max(d, Math.abs(out[i] - outs[k][i]));
    assert.equal(d, 0, `${f}: shared vs separate differ by ${d}`);
  });
  ms.forEach((m) => m.destroy());
});
