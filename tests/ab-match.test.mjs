import test from 'node:test';
import assert from 'node:assert/strict';
import { abMakeupDb, Engine } from '../web/js/audio/engine.js';

test('dry A/B makeup follows simultaneous rig-to-DI loudness and stays bounded', () => {
  assert.ok(Math.abs(abMakeupDb(0.5, 0.25) - 6.0206) < 0.001);
  assert.ok(Math.abs(abMakeupDb(0.25, 0.5) + 6.0206) < 0.001);
  assert.equal(abMakeupDb(0, 0.5), null);
  assert.equal(abMakeupDb(0.5, 0), null);
  assert.equal(abMakeupDb(1e-4, 1), null);
  assert.equal(abMakeupDb(1, 0.002), 24);
  assert.equal(abMakeupDb(0.002, 1), -24);
  assert.ok(Math.abs(abMakeupDb(0.8, 0.3, 0.95) - 0.2707) < 0.01, 'makeup cannot boost the dry peak above -0.18 dBFS');
});

test('a browser that ignores the 48 kHz request gets a clear audio error', () => {
  const original = globalThis.AudioContext;
  let closed = false;
  globalThis.AudioContext = class {
    constructor() { this.sampleRate = 44100; }
    close() { closed = true; return Promise.resolve(); }
  };
  try {
    const engine = new Engine(null);
    assert.throws(() => engine.ensureContext({ sampleRate: 48000 }), /needs a 48 kHz audio session/);
    assert.equal(engine.ctx, null);
    assert.equal(closed, true);
  } finally {
    globalThis.AudioContext = original;
  }
});
