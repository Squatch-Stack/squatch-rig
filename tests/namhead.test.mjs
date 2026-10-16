import test from 'node:test';
import assert from 'node:assert/strict';
import { NamHead } from '../web/worklets/dsp/namhead.js';

function passThroughHead(bass = 0) {
  const head = new NamHead(48000, { input: 0, output: 0, bass, normalize: 0, dcblock: 0 });
  head.setModel({ loudness: null, process(input, output, n) { output.set(input.subarray(0, n)); } });
  return head;
}

function toneRmsAfter(head, frequency, startSeconds = 0.3) {
  const sr = 48000, seconds = 0.6, input = new Float32Array(sr * seconds), output = new Float32Array(128);
  let power = 0, count = 0;
  for (let at = 0; at < input.length; at += 128) {
    const n = Math.min(128, input.length - at);
    for (let i = 0; i < n; i++) input[at + i] = 0.2 * Math.sin(2 * Math.PI * frequency * (at + i) / sr);
    head.process(input.subarray(at, at + n), output, n);
    if (at / sr >= startSeconds) for (let i = 0; i < n; i++) { power += output[i] ** 2; count++; }
  }
  return Math.sqrt(power / count);
}

test('NAM head Bass shelf reduces 110 Hz while leaving upper guitar harmonics nearly intact', () => {
  const flat110 = toneRmsAfter(passThroughHead(0), 110);
  const cut110 = toneRmsAfter(passThroughHead(-9), 110);
  const flat660 = toneRmsAfter(passThroughHead(0), 660);
  const cut660 = toneRmsAfter(passThroughHead(-9), 660);
  assert.ok(20 * Math.log10(cut110 / flat110) < -4, '110 Hz should be reduced by at least 4 dB');
  assert.ok(Math.abs(20 * Math.log10(cut660 / flat660)) < 0.5, '660 Hz should remain effectively unchanged');
});

test('changing NAM head Bass ramps without a discontinuity or non-finite samples', () => {
  const sr = 48000, head = passThroughHead(-12), input = new Float32Array(8192), output = new Float32Array(128), rendered = [];
  for (let at = 0; at < input.length; at += 128) {
    const n = Math.min(128, input.length - at);
    for (let i = 0; i < n; i++) input[at + i] = 0.25 * Math.sin(2 * Math.PI * 110 * (at + i) / sr);
    if (at === 4096) head.set('bass', 0);
    head.process(input.subarray(at, at + n), output, n);
    rendered.push(...output.subarray(0, n));
  }
  assert.ok(rendered.every(Number.isFinite));
  let largestStep = 0;
  for (let i = 1; i < rendered.length; i++) largestStep = Math.max(largestStep, Math.abs(rendered[i] - rendered[i - 1]));
  assert.ok(largestStep < 0.02, `Bass adjustment step was ${largestStep}`);
});

test('rapid NAM Bass changes resume the current ramp instead of restarting with a step', () => {
  const sr = 48000, head = passThroughHead(-12), input = new Float32Array(128), output = new Float32Array(128);
  let previous = 0, largestStep = 0;
  for (let block = 0; block < 80; block++) {
    head.set('bass', block % 2 ? -12 : 0);
    const offset = block * input.length;
    for (let i = 0; i < input.length; i++) input[i] = 0.4 * Math.sin(2 * Math.PI * 110 * (offset + i) / sr);
    head.process(input, output, input.length);
    for (const sample of output) { largestStep = Math.max(largestStep, Math.abs(sample - previous)); previous = sample; }
  }
  assert.ok(largestStep < 0.02, `rapid Bass adjustment step was ${largestStep}`);
});
