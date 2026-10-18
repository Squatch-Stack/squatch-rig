// The public guard knows no private name; it checks generic patterns and the shapes of personal data. Each check has
// a planted failure, and a mutated copy of the guard (a negative control) shows the test notices a broken guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanTree, selfTest, scanBuffer } from '../tools/public-guard.mjs';
import { Shapes } from '../tools/shape-reader.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'public-guard-test-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
const join = (...p) => p.join(''); // the guard scans this file too: plant values from pieces

test('the guard passes its own self-test', () => assert.deepEqual(selfTest(), []));

test('shapes: a telephone number, a street address and a private address are refused in text, with the line and never the value', () => {
  const planted = {
    'a.md': `call ${join('(417) 555-', '0142')} after noon`,
    'b.txt': `ship to ${join('1234 Mapl', 'e Street')}, Springfield`,
    'c.json': `{"host": "${['192', '168', '4', '9'].join('.')}"}`,
  };
  for (const [file, text] of Object.entries(planted)) {
    const f = scanBuffer(file, Buffer.from(text));
    assert.ok(f.length > 0, `not caught: ${file}`);
    assert.ok(!JSON.stringify(f).includes('0142') && !JSON.stringify(f).includes('Maple'), 'the value was printed');
  }
});

test('shapes: a documented exception stays quiet (a vendored bundle), and a plain document passes', () => {
  assert.deepEqual(scanBuffer('vendor/pixi.mjs', Buffer.from('var a=4294967296,b=2147483647;')), []);
  assert.deepEqual(scanBuffer('README.md', Buffer.from('A guitar rig for the browser. 48000 Hz, 128 samples, 2.7 ms.')), []);
});

test('the shapes file carries patterns only: no reasons, sources or self-tests, and no way to name a private thing', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(root, 'tools/register-shapes.json'), 'utf8'));
  for (const e of [...doc.patterns, ...doc.allow]) {
    for (const k of Object.keys(e)) assert.ok(['id', 'kind', 're', 'flags', 'severity', 'scope', 'ids', 'paths', 'text', 'match'].includes(k), `unexpected key ${k} in ${e.id}`);
  }
  assert.ok(doc.patterns.length >= 10);
  assert.ok(!('entries' in doc) && !('refs' in doc));
});

test('it fails closed: an empty or missing shapes file is an error, never a pass', () => {
  assert.throws(() => Shapes.load(path.join(tmp, 'missing.json')), /fail closed/);
  assert.throws(() => new Shapes({ version: 1, patterns: [] }), /fail closed/);
});

test('negative control: a guard copy that skips the shapes lets the planted number through, the real one does not', () => {
  const dir = path.join(tmp, 'mutant');
  fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
  for (const f of ['public-guard.mjs', 'shape-reader.mjs', 'register-shapes.json']) fs.copyFileSync(path.join(root, 'tools', f), path.join(dir, 'tools', f));
  const src = fs.readFileSync(path.join(dir, 'tools/public-guard.mjs'), 'utf8');
  assert.ok(src.includes('loadShapes().scanText(text, file)'));
  fs.writeFileSync(path.join(dir, 'tools/public-guard.mjs'), src.replace('loadShapes().scanText(text, file)', '[]'));
  return import(path.join(dir, 'tools/public-guard.mjs')).then((mutant) => {
    const buf = Buffer.from(`call ${join('(417) 555-', '0142')}`);
    assert.deepEqual(mutant.scanBuffer('a.md', buf), [], 'the mutant should be blind');
    assert.ok(scanBuffer('a.md', buf).length > 0, 'the real guard should see it');
    assert.ok(mutant.selfTest().length > 0, 'the self-test must notice a blind guard');
  });
});

test('negative control: a guard copy with the home-path pattern removed fails its own self-test', () => {
  const dir = path.join(tmp, 'mutant2');
  fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
  for (const f of ['public-guard.mjs', 'shape-reader.mjs', 'register-shapes.json']) fs.copyFileSync(path.join(root, 'tools', f), path.join(dir, 'tools', f));
  const src = fs.readFileSync(path.join(dir, 'tools/public-guard.mjs'), 'utf8');
  const cut = src.replace("['\\\\/Us', 'ers\\\\/[^\\\\s/]'].join('')", "'never-matches-xyzzy'");
  assert.notEqual(cut, src, 'the mutation did not apply');
  fs.writeFileSync(path.join(dir, 'tools/public-guard.mjs'), cut);
  return import(path.join(dir, 'tools/public-guard.mjs') + '?m2').then((mutant) => assert.ok(mutant.selfTest().length > 0));
});

test('a tree is scanned whole: text, a file name is not needed, binaries by their strings', () => {
  const dir = path.join(tmp, 'tree');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'ok.html'), '<p>hello</p>');
  assert.deepEqual(scanTree(dir).findings, []);
  assert.equal(scanTree(dir).files, 1);
});

test('a symbolic link in a tree is a finding: it is never followed and never published', () => {
  const dir = path.join(tmp, 'link');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'ok.txt'), 'hello');
  fs.symlinkSync('/etc/hosts', path.join(dir, 'hosts'));
  const { findings } = scanTree(dir);
  assert.deepEqual(findings.map((f) => [f.file, f.pattern]), [['hosts', 'symlink']]);
  fs.rmSync(path.join(dir, 'hosts'));
  assert.deepEqual(scanTree(dir).findings, []);
});
