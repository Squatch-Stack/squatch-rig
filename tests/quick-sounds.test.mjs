import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { QUICK_SOUNDS, quickSoundDoc } from '../web/js/graph/quick-sounds.js';
import { validateDoc } from '../web/js/graph/doc.js';
import { render } from '../tools/render.mjs';
import { upgradePublicDemo } from '../web/js/graph/demo-public.js';

const models = JSON.parse(fs.readFileSync(new URL('../web/models/index.json', import.meta.url), 'utf8')).models;

test('quick sounds are complete wired, valid rigs with the selected pedal in the signal path', () => {
  assert.equal(new Set(QUICK_SOUNDS.map((sound) => sound.id)).size, QUICK_SOUNDS.length);
  for (const sound of QUICK_SOUNDS) {
    const doc = validateDoc(quickSoundDoc(models, sound.id));
    assert.ok(doc.name.includes(sound.label));
    const nodes = Object.entries(doc.nodes);
    const input = nodes.find(([, n]) => n.type === 'input')?.[0];
    const output = nodes.find(([, n]) => n.type === 'output')?.[0];
    assert.ok(input && output);
    const seen = new Set([input]), pending = [input];
    while (pending.length) {
      const id = pending.pop();
      for (const edge of Object.values(doc.edges)) {
        if (edge.from[0] === id && !seen.has(edge.to[0])) {
          seen.add(edge.to[0]); pending.push(edge.to[0]);
        }
      }
    }
    assert.ok(seen.has(output), `${sound.id}: output is reachable`);
    if (sound.id === 'bloom') assert.ok(nodes.some(([id, n]) => n.type === 'bloom' && !n.bypass && seen.has(id)));
    if (sound.id === 'trail') assert.ok(nodes.some(([id, n]) => n.type === 'overdrive' && n.label === 'Trail Drive' && !n.bypass && seen.has(id)));
  }
  assert.throws(() => quickSoundDoc(models, 'unknown'), /unknown quick sound/);
});

test('quick sounds produce distinct audible renders from the same DI', () => {
  const outputs = QUICK_SOUNDS.map((sound) => {
    const result = render({ doc: quickSoundDoc(models, sound.id), loop: 'clean-chords', seconds: 0.4, preroll: 0 });
    const pcm = result.channels[0];
    const rms = Math.sqrt(pcm.reduce((sum, sample) => sum + sample * sample, 0) / pcm.length);
    assert.ok(rms > 0.0001 && Number.isFinite(rms), `${sound.id}: audible finite render`);
    return pcm;
  });
  for (let i = 1; i < outputs.length; i++) {
    let maxDifference = 0;
    for (let j = 0; j < outputs[i].length; j++) maxDifference = Math.max(maxDifference, Math.abs(outputs[i][j] - outputs[0][j]));
    assert.ok(maxDifference > 0.01, `${QUICK_SOUNDS[i].id}: meaningfully differs from stack`);
  }
});

test('public-only models make playable single-head sounds without private captures', () => {
  const publicModels = models.filter((entry) => entry.file.startsWith('namcore-example-'));
  for (const sound of QUICK_SOUNDS) {
    const doc = validateDoc(quickSoundDoc(publicModels, sound.id));
    assert.equal(Object.values(doc.nodes).filter((node) => node.type === 'nam').length, 1);
    assert.ok(Object.values(doc.nodes).every((node) => !node.model || publicModels.some((entry) => entry.hash === node.model)));
    assert.ok(Object.values(doc.nodes).some((node) => node.type === 'cab'));
    const result = render({ doc, loop: 'clean-chords', seconds: 0.25, preroll: 0 });
    const pcm = result.channels[0];
    const rms = Math.sqrt(pcm.reduce((sum, sample) => sum + sample * sample, 0) / pcm.length);
    assert.ok(rms > 0.0001 && Number.isFinite(rms), `${sound.id}: public render is audible`);
  }
});

test('older first-release autosaves get the calibrated NAM input and bass trim while keeping edits', () => {
  const publicModels = models.filter((entry) => entry.file.startsWith('namcore-example-'));
  const doc = quickSoundDoc(publicModels, 'stack');
  delete doc.meta.publicDemoLevelVersion;
  const head = Object.values(doc.nodes).find((node) => node.label === 'NAM Core head');
  const limiter = Object.values(doc.nodes).find((node) => node.label === 'Limiter');
  head.params.input = -4; head.params.normalize = 1; limiter.params.gain = 6;
  const gate = Object.values(doc.nodes).find((node) => node.label === 'Gate');
  const hall = Object.values(doc.nodes).find((node) => node.label === 'Hall');
  Object.assign(gate.params, { threshold: -46, hold: 40, release: 90, range: -70 });
  Object.assign(hall.params, { decay: 2.6, mix: 0.22 });
  const pedal = Object.values(doc.nodes).find((node) => node.label === 'Trail Drive');
  pedal.params.tone = 0.72;
  const outputId = Object.keys(doc.nodes).find((id) => doc.nodes[id].type === 'output');
  delete doc.nodes[outputId];
  for (const [id, edge] of Object.entries(doc.edges)) if (edge.to[0] === outputId) delete doc.edges[id];
  upgradePublicDemo(doc);
  assert.equal(head.params.input, -16);
  assert.equal(head.params.bass, -9);
  assert.equal(head.params.normalize, 0);
  assert.equal(limiter.params.gain, 0);
  assert.equal(gate.params.threshold, -36);
  assert.equal(hall.params.mix, 0.08);
  assert.equal(pedal.params.tone, 0.72);
  assert.ok(!Object.values(doc.nodes).some((node) => node.type === 'output'));
  upgradePublicDemo(doc);
  assert.equal(head.params.input, -16, 'migration is idempotent');
});

test('second-release autosave migrates only the shipped NAM gain and bass settings', () => {
  const publicModels = models.filter((entry) => entry.file.startsWith('namcore-example-'));
  const doc = quickSoundDoc(publicModels, 'stack');
  delete doc.meta.publicDemoLevelVersion;
  doc.name = 'My edited rig';
  const head = Object.values(doc.nodes).find((node) => node.label === 'NAM Core head');
  const output = Object.values(doc.nodes).find((node) => node.type === 'output');
  const drive = Object.values(doc.nodes).find((node) => node.label === 'Trail Drive');
  head.params.input = -16;
  head.params.bass = 0;
  head.params.normalize = 1;
  output.params.volume = 0;
  drive.params.tone = 0.77;
  upgradePublicDemo(doc);
  assert.equal(head.params.normalize, 0);
  assert.equal(head.params.input, -16);
  assert.equal(head.params.bass, -9);
  assert.equal(output.params.volume, 3);
  assert.equal(drive.params.tone, 0.77);
  assert.equal(doc.meta.publicDemoLevelVersion, 3);
});

test('a visitor’s Bass change in the current public demo survives autosave migration', () => {
  const publicModels = models.filter((entry) => entry.file.startsWith('namcore-example-'));
  const doc = quickSoundDoc(publicModels, 'stack');
  const head = Object.values(doc.nodes).find((node) => node.label === 'NAM Core head');
  head.params.bass = 0;
  head.params.normalize = 1;
  upgradePublicDemo(doc);
  assert.equal(head.params.bass, 0);
  assert.equal(head.params.normalize, 1);
  assert.equal(doc.meta.publicDemoLevelVersion, 3);
});

test('a second-release autosave without the new Bass field is normalized before migration', () => {
  const publicModels = models.filter((entry) => entry.file.startsWith('namcore-example-'));
  const old = quickSoundDoc(publicModels, 'stack');
  delete old.meta.publicDemoLevelVersion;
  const head = Object.values(old.nodes).find((node) => node.label === 'NAM Core head');
  const output = Object.values(old.nodes).find((node) => node.type === 'output');
  delete head.params.bass;
  head.params.normalize = 1;
  output.params.volume = 0;
  const doc = validateDoc(old);
  upgradePublicDemo(doc);
  assert.equal(Object.values(doc.nodes).find((node) => node.label === 'NAM Core head').params.bass, -9);
  assert.equal(doc.meta.publicDemoLevelVersion, 3);
});

test('public NAM Core default trims the chord difference tone with its post-head bass shelf', () => {
  const publicModels = models.filter((entry) => entry.file.startsWith('namcore-example-'));
  const doc = quickSoundDoc(publicModels, 'stack');
  const head = Object.values(doc.nodes).find((node) => node.label === 'NAM Core head');
  assert.equal(head.params.input, -16, 'retain the tuned input trim because loop normalization loses source calibration');
  assert.equal(head.params.bass, -9, 'reduce the high-gain model’s low-frequency intermod products');
});

test('the darker Hall quick sound uses the stronger available Bass cut', () => {
  const publicModels = models.filter((entry) => entry.file.startsWith('namcore-example-'));
  const values = ['stack', 'trail', 'bloom'].map((sound) => {
    const doc = quickSoundDoc(publicModels, sound);
    return Object.values(doc.nodes).find((node) => node.label === 'NAM Core head').params.bass;
  });
  const hall = quickSoundDoc(publicModels, 'hall');
  const hallBass = Object.values(hall.nodes).find((node) => node.label === 'NAM Core head').params.bass;
  assert.deepEqual(values, [-9, -9, -9]);
  assert.equal(hallBass, -12);
});

test('NAM Core head and Chord Stabs alone retain headroom and a low noise gap', () => {
  const publicModels = models.filter((entry) => entry.file.startsWith('namcore-example-'));
  for (const withCab of [false, true]) {
    const doc = quickSoundDoc(publicModels, 'stack');
    for (const [id, node] of Object.entries(doc.nodes)) {
      if (!['input', 'nam', 'output', ...(withCab ? ['cab'] : [])].includes(node.type)) delete doc.nodes[id];
    }
    const ids = Object.entries(doc.nodes);
    doc.edges = {};
    for (let i = 1; i < ids.length; i++) doc.edges[`e${i}`] = { from: [ids[i - 1][0], 0], to: [ids[i][0], 0] };
    const pcm = render({ doc, loop: 'chord-stabs', seconds: 2.1, preroll: 0 }).channels[0];
    const rms = (a, b) => {
      const section = pcm.subarray(Math.round(a * 48000), Math.round(b * 48000));
      return 20 * Math.log10(Math.sqrt(section.reduce((s, v) => s + v * v, 0) / section.length) + 1e-12);
    };
    const peak = pcm.reduce((p, v) => Math.max(p, Math.abs(v)), 0);
    assert.ok(rms(1.8, 2.0) < -53, `${withCab ? 'cab' : 'head'} quiet gap should be below -53 dBFS`);
    assert.ok(peak < 0.95, `${withCab ? 'cab' : 'head'} should not clip without the limiter`);
  }
});

test('public stacked sound closes the Chord Stabs noise gap without muting the chord', () => {
  const publicModels = models.filter((entry) => entry.file.startsWith('namcore-example-'));
  const doc = quickSoundDoc(publicModels, 'stack');
  const pcm = render({ doc, loop: 'chord-stabs', seconds: 2.1, preroll: 0 }).channels[0];
  const rmsDb = (start, end) => {
    const a = Math.round(start * 48000), b = Math.round(end * 48000);
    let power = 0;
    for (let i = a; i < b; i++) power += pcm[i] ** 2;
    return 20 * Math.log10(Math.sqrt(power / (b - a)) + 1e-12);
  };
  assert.ok(rmsDb(1.8, 2.0) < -38, 'the quiet gap should not carry a loud hiss tail');
  assert.ok(rmsDb(1.0, 1.2) > -35, 'the played chord remains audible');
});

test('the two public drives change the complete amp harmonic response', () => {
  const publicModels = models.filter((entry) => entry.file.startsWith('namcore-example-'));
  const sr = 48000, tone = new Float32Array(sr);
  for (let i = 0; i < sr; i++) tone[i] = 0.08 * Math.sin(2 * Math.PI * 220 * i / sr);
  const thdDb = (off) => {
    const doc = quickSoundDoc(publicModels, 'stack');
    for (const node of Object.values(doc.nodes)) {
      if (['Env Filter', 'Hall', 'Limiter', ...off].includes(node.label)) node.bypass = true;
    }
    const pcm = render({ doc, diData: tone, seconds: 1, preroll: 0 }).channels[0];
    const start = sr * 0.4, len = sr * 0.5, harmonics = [];
    for (let h = 1; h <= 8; h++) {
      let re = 0, im = 0;
      for (let j = 0; j < len; j++) {
        const phase = 2 * Math.PI * 220 * h * j / sr;
        re += pcm[start + j] * Math.cos(phase);
        im += pcm[start + j] * Math.sin(phase);
      }
      harmonics.push(Math.hypot(re, im));
    }
    return 20 * Math.log10(Math.hypot(...harmonics.slice(1)) / harmonics[0]);
  };
  const on = thdDb([]), noTs = thdDb(['Trail Drive']), noStack = thdDb(['Stack Drive']), dry = thdDb(['Trail Drive', 'Stack Drive']);
  assert.ok(on - dry > 12, `drives should add clear harmonic content: ${on} vs ${dry} dB`);
  assert.ok(on - noTs > 2 && on - noStack > 2, `each drive should contribute: ${on}, ${noTs}, ${noStack} dB`);
});

test('NAM Core and Cab 4x12 have a clear minimum horizontal gap in shipped layouts', async () => {
  const { demoDoc: publicDemo } = await import('../web/js/graph/demo-public.js');
  const { demoDoc: privateDemo } = await import('../web/js/graph/demo.js');
  for (const [name, doc] of [['public', publicDemo(models)], ['private', privateDemo(models)]]) {
    const head = Object.values(doc.nodes).find((node) => node.label === 'NAM Core head' || node.label === 'Head C · NAM Core');
    const cab = Object.values(doc.nodes).find((node) => node.label === 'Cab 4x12');
    assert.ok(head && cab, `${name}: NAM Core and cab nodes exist`);
  // The default brush-ink amp-head art is 520 px at 0.5 scale (260 px wide).
    assert.ok(cab.pos[0] - (head.pos[0] + 260) >= 30,
      `${name}: default head/cab gap should be at least 30 px; got ${cab.pos[0] - (head.pos[0] + 260)} px`);
  }
});
