import test from 'node:test';
import assert from 'node:assert/strict';
import { Bloom } from '../web/worklets/dsp/bloom.js';
import { validateDoc } from '../web/js/graph/doc.js';
import fs from 'node:fs';

function process(effect, input) {
  const output = new Float32Array(input.length);
  for (let i = 0; i < input.length; i += 128) {
    effect.process([input.subarray(i, i + 128)], [output.subarray(i, i + 128)], Math.min(128, input.length - i));
  }
  return output;
}
function rms(values, from = 0) {
  let sum = 0;
  for (let i = from; i < values.length; i++) sum += values[i] ** 2;
  return Math.sqrt(sum / (values.length - from));
}

test('Bloom produces finite, audible, parameter-sensitive audio at 48 kHz', () => {
  const input = Float32Array.from({ length: 8192 }, (_, i) => 0.16 * Math.sin(2 * Math.PI * 220 * i / 48000));
  const soft = new Bloom(48000); soft.set('bloom', 0.2);
  const driven = new Bloom(48000); driven.set('bloom', 0.9);
  const a = process(soft, input), b = process(driven, input);
  assert.ok(a.every(Number.isFinite) && b.every(Number.isFinite));
  assert.ok(rms(a, 2048) > 0.01 && rms(b, 2048) > 0.01);
  assert.ok(rms(Float32Array.from(a, (v, i) => v - b[i]), 2048) > 0.001);
  assert.ok(Math.max(...b) < 2);
});

test('Bloom keeps channel state separate and the custom preset valid', () => {
  const fx = new Bloom(48000), x = new Float32Array(128), silent = new Float32Array(128);
  x[0] = 0.8;
  const a = new Float32Array(128), b = new Float32Array(128);
  fx.process([x, silent], [a, b], 128);
  assert.ok(b.every((v) => v === 0));
  const doc = validateDoc(JSON.parse(fs.readFileSync(new URL('../presets/bloom.rig.json', import.meta.url))));
  assert.equal(doc.nodes.bloom_custom.type, 'bloom');
  assert.ok(Object.values(doc.edges).some((edge) => edge.from[0] === 'bloom_custom'));
});
