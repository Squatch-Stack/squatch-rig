// The README diagrams say what the code does: tools/check-readme-diagrams.mjs passes on the real tree and fails on each
// planted lie (negative controls), for the public README and the demo README.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from '../tools/check-readme-diagrams.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// In the dev tree the public README and workflows live in tools/public-source/; in the public tree they are the real ones.
const DEV = fs.existsSync(path.join(root, 'tools/public-source/README.md'));
const SOURCE = DEV ? { readme: 'tools/public-source/README.md', workflows: ['tools/public-source/ci.yml', 'tools/public-source/pages.yml'] }
  : { readme: 'README.md', workflows: ['.github/workflows/ci.yml', '.github/workflows/pages.yml'] };
const DEMO = { readme: 'tools/public-demo/README.md', workflows: ['tools/public-demo/pages.yml'] };

/** A scratch copy of just the files the checker reads, so a test can break one. */
function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-'));
  const copy = (rel) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.cpSync(path.join(root, rel), path.join(dir, rel), { recursive: true }); };
  for (const rel of ['tools/public-source', 'tools/public-demo', 'web/js', 'web/worklets', 'docs/readme', 'design/assets/plates', 'tools/render.mjs', 'README.md', '.github/workflows']) if (fs.existsSync(path.join(root, rel))) copy(rel);
  return dir;
}
const run = (dir, which = SOURCE) => check(path.join(dir, which.readme), dir, which.workflows.map((w) => path.join(dir, w)));
const edit = (file, from, to) => { const t = fs.readFileSync(file, 'utf8'); assert.ok(t.includes(from), `planted edit not found: ${from}`); fs.writeFileSync(file, t.replace(from, to)); };

test('the real READMEs pass', () => {
  assert.deepEqual(check(path.join(root, SOURCE.readme), root, SOURCE.workflows.map((w) => path.join(root, w))), []);
  assert.deepEqual(check(path.join(root, DEMO.readme), root, DEMO.workflows.map((w) => path.join(root, w))), []);
});

const LIES = [
  ['a device moved in the demo chain', (d) => edit(path.join(d, 'web/js/graph/demo-public.js'), "add('gate'", "add('compressor'")],
  ['a kernel file removed', (d) => fs.rmSync(path.join(d, 'web/worklets/dsp/reverb.js'))],
  ['a file the diagram names is gone', (d) => fs.rmSync(path.join(d, 'web/js/audio/engine.js'))],
  ['a workflow job renamed', (d) => edit(path.join(d, SOURCE.workflows[1]), '\n  deploy:\n', '\n  publish:\n')],
  ['an image the README embeds is missing', (d) => fs.rmSync(path.join(d, 'docs/readme/rig-row1-light.jpg'))],
];
for (const [name, plant] of LIES) {
  test(`negative control: ${name}`, () => {
    const dir = scratch();
    try {
      assert.deepEqual(run(dir), [], 'the scratch copy starts clean');
      plant(dir);
      assert.ok(run(dir).length > 0, 'the checker must report it');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

test('negative control: a demo job renamed', () => {
  const dir = scratch();
  try {
    edit(path.join(dir, 'tools/public-demo/pages.yml'), '\n  build:\n', '\n  assemble:\n');
    assert.ok(run(dir, DEMO).length > 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
