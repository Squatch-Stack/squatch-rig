import test from 'node:test';
import assert from 'node:assert/strict';
import { isBuiltIn, pickInput, effectiveLabel, readChoice, writeChoice } from '../web/js/audio/device-pick.js';

// What Chrome on a MacBook with a UMC204HD plugged in lists, after mic permission (measured 2026-10-09).
const MAC_WITH_UMC = [
  { deviceId: 'default', label: 'Default - MacBook Pro Microphone (Built-in)' },
  { deviceId: 'umc-id', label: 'UMC204HD 192k (1397:0508)' },
  { deviceId: 'mic-id', label: 'MacBook Pro Microphone (Built-in)' },
];

test('built-in microphones are recognised; interfaces are not', () => {
  for (const l of ['MacBook Pro Microphone (Built-in)', 'Default - MacBook Pro Microphone (Built-in)', 'iPhone Microphone',
    'FaceTime HD Camera', 'AirPods Pro']) assert.equal(isBuiltIn(l), true, l);
  for (const l of ['UMC204HD 192k (1397:0508)', 'Scarlett 2i2 USB', 'Babyface Pro', '']) assert.equal(isBuiltIn(l), false, l);
});

test('with no saved choice, a plugged-in interface is picked over the built-in microphone', () => {
  assert.equal(pickInput(MAC_WITH_UMC), 'umc-id');
});

test('a saved choice wins when that device is present, by id or by label', () => {
  assert.equal(pickInput(MAC_WITH_UMC, { id: 'mic-id' }), 'mic-id');
  assert.equal(pickInput(MAC_WITH_UMC, { id: 'stale-id', label: 'UMC204HD 192k (1397:0508)' }), 'umc-id');
});

test('a saved interface that is unplugged falls back to another interface, else the system default', () => {
  const noUmc = MAC_WITH_UMC.filter((d) => d.deviceId !== 'umc-id');
  assert.equal(pickInput(noUmc, { id: 'umc-id', label: 'UMC204HD 192k (1397:0508)' }), '');
});

test('before mic permission (no labels) nothing is picked automatically', () => {
  const unlabeled = MAC_WITH_UMC.map((d) => ({ ...d, label: '' }));
  assert.equal(pickInput(unlabeled), '');
});

test('the effective input of the system default is what Default points at', () => {
  assert.equal(isBuiltIn(effectiveLabel(MAC_WITH_UMC, '')), true);
  assert.equal(effectiveLabel(MAC_WITH_UMC, 'umc-id'), 'UMC204HD 192k (1397:0508)');
});

test('saved choices round-trip, and junk reads as no choice', () => {
  assert.deepEqual(readChoice(writeChoice('umc-id', 'UMC204HD 192k (1397:0508)')), { id: 'umc-id', label: 'UMC204HD 192k (1397:0508)' });
  assert.deepEqual(readChoice(null), {});
  assert.deepEqual(readChoice('just-an-id'), { id: 'just-an-id', label: '' });
});
