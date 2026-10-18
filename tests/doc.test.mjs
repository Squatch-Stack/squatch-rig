// Pipeline document: validation, canonical form, graph rules, demo shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Store, emptyDoc, validateDoc, canonicalJSON, FORMAT } from '../web/js/graph/doc.js';
import { demoDoc } from '../web/js/graph/demo.js';
import { TYPES, paramsOf } from '../web/js/graph/types.js';

globalThis.CustomEvent ??= class extends Event { constructor(t, o) { super(t); this.detail = o?.detail; } };
const index = JSON.parse(fs.readFileSync(new URL('../web/models/index.json', import.meta.url))).models;

test('demo preset: compressor -> OD -> OD -> NAM head(s) -> env filter -> reverb (the public demo has one head, the dev rig three)', () => {
  const d = validateDoc(demoDoc(index));
  const types = Object.values(d.nodes).map((n) => n.type);
  const richIndex = index.length > 2;
  for (const t of ['compressor', 'envfilter', 'reverb', 'cab', 'gate', 'limiter', ...(richIndex ? ['splitter', 'mixer'] : [])]) assert.ok(types.includes(t), t);
  assert.equal(types.filter((t) => t === 'overdrive').length, 2);
  const heads = Object.values(d.nodes).filter((n) => n.type === 'nam');
  // The public tree's index lists only the two NAM Core examples and gets the one-head public demo; a dev tree with its own
  // captures gets the three-head rig behind a 3-way split.
  assert.equal(heads.length, richIndex ? 3 : 1);
  assert.ok(heads.every((h) => h.model && d.models[h.model]), 'every head references a model by hash');
  assert.equal(new Set(heads.map((h) => d.models[h.model].family)).size, richIndex ? 2 : 1, 'one model family per kind of head');
  // every node reachable from the input and reaching the output
  const s = new Store(d);
  const inId = Object.keys(d.nodes).find((k) => d.nodes[k].type === 'input');
  const outId = Object.keys(d.nodes).find((k) => d.nodes[k].type === 'output');
  for (const id of Object.keys(d.nodes)) {
    assert.ok(id === inId || s.reaches(inId, id), `${d.nodes[id].label} fed from input`);
    assert.ok(id === outId || s.reaches(id, outId), `${d.nodes[id].label} reaches output`);
  }
});

test('document is maps keyed by id (CRDT-friendly), with a meta block for owner/signature', () => {
  const d = demoDoc(index);
  assert.equal(d.format, FORMAT);
  for (const k of ['nodes', 'edges', 'models']) assert.ok(d[k] && !Array.isArray(d[k]) && typeof d[k] === 'object', k);
  assert.deepEqual(Object.keys(d.meta).filter((k) => k !== 'publicDemoLevelVersion').sort(), ['created', 'modified', 'owner', 'parents', 'signature']);
  for (const h of Object.keys(d.models)) assert.match(h, /^sha256:[0-9a-f]{64}$/);
});

test('canonicalJSON is key-order independent and round-trips', () => {
  const a = { b: 1, a: [3, { y: 2, x: 1 }], c: null };
  const b = { c: null, a: [3, { x: 1, y: 2 }], b: 1 };
  assert.equal(canonicalJSON(a), canonicalJSON(b));
  assert.deepEqual(JSON.parse(canonicalJSON(a)), a);
  const d = demoDoc(index);
  assert.equal(canonicalJSON(JSON.parse(JSON.stringify(d))), canonicalJSON(d));
});

test('store: connect refuses cycles and duplicates; remove drops edges; undo restores', () => {
  const s = new Store(emptyDoc());
  const a = s.addNode('overdrive', [0, 0]), b = s.addNode('reverb', [200, 0]);
  assert.ok(s.connect([a, 0], [b, 0]));
  assert.equal(s.connect([a, 0], [b, 0]), null, 'duplicate');
  assert.equal(s.connect([b, 0], [a, 0]), null, 'cycle');
  s.removeNode(b);
  assert.equal(Object.keys(s.doc.edges).length, 0);
  s.undo();
  assert.equal(Object.keys(s.doc.edges).length, 1);
  assert.ok(s.doc.nodes[b]);
});

test('the last Input and Output cannot be deleted; an older rig without Output can be repaired and undone', () => {
  const s = new Store(demoDoc(index));
  const input = Object.keys(s.doc.nodes).find((id) => s.doc.nodes[id].type === 'input');
  const output = Object.keys(s.doc.nodes).find((id) => s.doc.nodes[id].type === 'output');
  assert.equal(s.removeNode(input), false);
  assert.equal(s.removeNode(output), false);
  assert.ok(s.doc.nodes[input] && s.doc.nodes[output]);
  assert.equal(s.undoStack.length, 0, 'blocked removal must not create undo history');

  const old = structuredClone(s.doc);
  delete old.nodes[output];
  for (const [id, edge] of Object.entries(old.edges)) if (edge.to[0] === output) delete old.edges[id];
  s.load(old);
  const restored = s.restoreOutput();
  assert.equal(s.doc.nodes[restored].type, 'output');
  const incoming = Object.values(s.doc.edges).filter((edge) => edge.to[0] === restored);
  assert.equal(incoming.length, 1);
  assert.equal(s.doc.nodes[incoming[0].from[0]].label, 'Limiter');
  s.undo();
  assert.ok(!Object.values(s.doc.nodes).some((node) => node.type === 'output'));
  s.redo();
  assert.ok(s.doc.nodes[restored]);
});

test('validateDoc fills defaults, drops dangling edges, rejects unknown types', () => {
  const d = emptyDoc();
  d.nodes.x = { type: 'overdrive' };
  d.edges.e = { from: ['x', 0], to: ['nope', 0] };
  const v = validateDoc(d);
  assert.equal(v.nodes.x.params.drive, TYPES.overdrive.params.drive.def);
  assert.equal(Object.keys(v.edges).length, 0);
  d.nodes.y = { type: 'flanger' };
  assert.throws(() => validateDoc(d), /unknown type/);
});

test('every parameter spec is well-formed', () => {
  for (const [t, def] of Object.entries(TYPES)) {
    const node = { type: t, config: { ways: 3 } };
    for (const [k, p] of Object.entries(paramsOf(node))) {
      assert.ok(p.min < p.max && p.def >= p.min && p.def <= p.max, `${t}.${k}`);
      if (p.curve === 'log') assert.ok(p.min > 0, `${t}.${k} log needs min > 0`);
    }
    assert.ok(def.label && def.form, t);
  }
});

// Display-name migration (2026-10-16): the demo's first overdrive was renamed; old saves and links must still load.
const oldName = ['TS', ' Drive'].join('');
test('a pipeline saved with the old overdrive label loads under the new label, nothing else changes', () => {
  const d = demoDoc(index);
  const [odId, od] = Object.entries(d.nodes).find(([, n]) => n.type === 'overdrive');
  const saved = structuredClone(d);
  saved.nodes[odId].label = oldName;
  const loaded = validateDoc(saved);
  assert.equal(loaded.nodes[odId].label, 'Trail Drive');
  assert.deepEqual(loaded.nodes[odId].params, validateDoc(d).nodes[odId].params);
  assert.equal(loaded.nodes[odId].type, 'overdrive');
  assert.deepEqual(Object.keys(loaded.nodes), Object.keys(d.nodes), 'node ids unchanged');
  // a label the owner typed is never touched, and the old name on another type is left alone
  saved.nodes[odId].label = 'My fuzz';
  assert.equal(validateDoc(saved).nodes[odId].label, 'My fuzz');
  const other = Object.entries(saved.nodes).find(([, n]) => n.type === 'reverb');
  saved.nodes[other[0]].label = oldName;
  assert.equal(validateDoc(saved).nodes[other[0]].label, oldName);
  assert.ok(od);
});
