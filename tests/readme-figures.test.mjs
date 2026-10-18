// The README figures are drawn from the real kernels: they must be reproducible, committed up to date, and the
// check that says so must be able to fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildFigures } from '../tools/readme-figures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tool = path.join(root, 'tools/readme-figures.mjs');
const check = (dir) => spawnSync(process.execPath, [tool, '--check', dir], { encoding: 'utf8' });

test('readme figures: the committed SVGs are what the kernels draw now', () => {
  const r = check(path.join(root, 'docs/readme'));
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('readme figures: drawing twice gives the same bytes', () => {
  assert.deepEqual(buildFigures(), buildFigures());
});

test('readme figures: the check fails on a changed or a missing file (negative control)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figs-'));
  try {
    for (const [name, svg] of Object.entries(buildFigures())) fs.writeFileSync(path.join(dir, name), svg);
    assert.equal(check(dir).status, 0);
    const victim = path.join(dir, 'fig-compressor-light.svg');
    fs.writeFileSync(victim, fs.readFileSync(victim, 'utf8').replace('ratio 4:1', 'ratio 5:1'));
    assert.equal(check(dir).status, 1, 'a changed figure must fail the check');
    fs.rmSync(victim);
    assert.equal(check(dir).status, 1, 'a missing figure must fail the check');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('readme figures: every figure has a title, a description and both themes', () => {
  const files = buildFigures();
  assert.equal(Object.keys(files).length, 8);
  for (const [name, svg] of Object.entries(files)) {
    assert.match(svg, /<title id="t">[^<]+<\/title><desc id="d">[^<]+<\/desc>/, name);
    assert.ok(svg.length < 60000, `${name} is ${svg.length} bytes`);
  }
});
