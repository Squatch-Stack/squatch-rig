import test from 'node:test';
import assert from 'node:assert/strict';
import { dismissFirstPlay, firstPlayDismissed } from '../web/js/ui/first-play-storage.js';

test('first-play dismissal persists and tolerates blocked localStorage', () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  assert.equal(firstPlayDismissed(storage), false);
  assert.equal(dismissFirstPlay(storage), true);
  assert.equal(firstPlayDismissed(storage), true);
  const blocked = { getItem() { throw new Error('storage denied'); }, setItem() { throw new Error('storage denied'); } };
  assert.equal(firstPlayDismissed(blocked), false);
  assert.equal(dismissFirstPlay(blocked), false);
});
