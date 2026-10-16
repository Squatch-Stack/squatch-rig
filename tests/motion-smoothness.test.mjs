import test from 'node:test';
import assert from 'node:assert/strict';
import { Brush } from '../web/js/ui/brush.js';
import { Settle } from '../web/js/ui/settle.js';

function graphics() {
  return {
    polygons: [],
    poly(points) { this.polygons.push(points); return this; },
    fill() { return this; },
    moveTo() { return this; },
    lineTo() { return this; },
    stroke() { return this; },
  };
}

function tip(reach) {
  const g = graphics();
  new Brush(1, { streaks: 0, jitter: 0 }).draw(g, [[0, 0], [100, 0]], 8, { n: 8, reach, dry: 0 });
  const vertices = g.polygons[0];
  const count = (vertices.length - 10) / 4;
  return vertices[2 * (count - 1)];
}

test('brush draw-on follows continuous reach, including sample boundaries', () => {
  assert.equal(tip(0.5), 50);
  assert.ok(Math.abs(tip(3 / 7 - 0.0001) - tip(3 / 7 + 0.0001)) < 0.03);
  assert.ok(tip(0.75) > tip(0.5));
  assert.ok(tip(0.75) < tip(1));
  assert.equal(graphics().polygons.length, 0);
});

test('settle interpolates width and opacity between optimizer keyframes', () => {
  const set = new Settle(new URL('../design/', import.meta.url));
  const path = [0, 0, 5, 0, 5, 5, 10, 5];
  set.sets.A = { vb: [0, 0, 10, 10], paths: [{ keys: [[path], [path]], w: [2, 10], o: [0.2, 1] }] };
  const calls = [];
  const brush = { draw(_g, _pts, w, opts) { calls.push({ w, alpha: opts.alpha }); } };
  const box = { x: 0, y: 0, w: 10, h: 10 };
  set.draw(graphics(), box, 0.2, 'A', 0, [brush]);
  set.draw(graphics(), box, 0.20001, 'A', 0, [brush]);
  assert.ok(calls[0].w > 2 * 1.15 * 0.9);
  assert.ok(calls[0].w < 10 * 1.15 * 0.9);
  assert.ok(Math.abs(calls[0].w - calls[1].w) < 0.001);
  assert.ok(Math.abs(calls[0].alpha - calls[1].alpha) < 0.001);
});
