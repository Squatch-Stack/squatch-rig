// The standard engine is the default; the experimental build is opt-in and never fetched unless chosen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { engineChoice, engineWasmPath, rememberEngine, ENGINE_KEY } from '../web/js/audio/engine-choice.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const store = (init = {}) => { const m = new Map(Object.entries(init)); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) }; };

test('default is the standard engine, from stock sources', () => {
  assert.equal(engineChoice({ search: '', storage: store() }), 'standard');
  assert.equal(engineChoice(), 'standard');
  assert.equal(engineWasmPath(engineChoice({ search: '?demo&intro=0', storage: store() })), 'wasm/nam.wasm');
});

test('anything but an explicit "experimental" is the standard engine', () => {
  for (const v of ['', 'Experimental ', 'a2', 'true', 'nam-experimental', '1'])
    assert.equal(engineChoice({ search: `?engine=${encodeURIComponent(v)}`, storage: store({ [ENGINE_KEY]: 'experimental' }) }), v === '' ? 'experimental' : 'standard', v);
  assert.equal(engineChoice({ storage: store({ [ENGINE_KEY]: 'garbage' }) }), 'standard');
  assert.equal(engineChoice({ storage: { getItem() { throw new Error('blocked'); } } }), 'standard');
});

test('experimental is selectable by URL or by the remembered setting, and the URL wins', () => {
  assert.equal(engineWasmPath(engineChoice({ search: '?engine=experimental', storage: store() })), 'wasm/nam-experimental.wasm');
  assert.equal(engineChoice({ search: '', storage: store({ [ENGINE_KEY]: 'experimental' }) }), 'experimental');
  assert.equal(engineChoice({ search: '?engine=standard', storage: store({ [ENGINE_KEY]: 'experimental' }) }), 'standard');
  const s = store();
  rememberEngine(s, 'experimental');
  assert.equal(engineChoice({ storage: s }), 'experimental');
  rememberEngine(s, 'standard');
  assert.equal(s.getItem(ENGINE_KEY), null);
});

test('engine.js names no wasm file except through the choice, and the default page never names the experimental one', () => {
  const engine = fs.readFileSync(path.join(root, 'web/js/audio/engine.js'), 'utf8');
  assert.ok(!/nam(-experimental)?\.wasm/.test(engine), 'engine.js hard-codes a wasm path');
  assert.match(engine, /engineWasmPath\(/);
  const html = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8');
  assert.ok(!/nam-experimental/.test(html), 'index.html preloads the experimental build');
  assert.match(html, /<option value="standard">/);
});
