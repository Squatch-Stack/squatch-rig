// Headless-Chrome checks of the real app (not a mock):
//   1. load the demo, play it live for a few seconds, record per-node worklet
//      CPU, render capacity, latency and levels; screenshot dark + light
//   2. NAM in the browser (AudioWorklet + wasm, OfflineAudioContext) vs the
//      native `render` tool on the same model and DI input
//   3. CPU headroom of the full demo chain: render 20 s offline, time it
//   4. the Node offline renderer (tools/render) against Chrome's OfflineAudioContext
// Each measurement is asserted (results.checks: measured value and limit); a
// stage that throws is recorded as results.error {stage, message}. The process
// exits 1 unless every assertion held.
//
// usage: node tools/browser-check.mjs [baseUrl]   (default http://127.0.0.1:7491)
// CHROME=/path/to/chrome overrides the browser.
// Negative control: BROWSER_CHECK_SABOTAGE=parity scales Chrome's full-chain
// render by 1.001 (+0.009 dB, inaudible) before the Node comparison; the
// -80 dB error-to-signal check must then fail and the run exit 1.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { readWav } from '../tests/lib/wav.mjs';
import { gate, finite } from './check-gate.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'tests/out');
fs.mkdirSync(out, { recursive: true });
const base = process.argv[2] || 'http://127.0.0.1:7491';
const SABOTAGE = process.env.BROWSER_CHECK_SABOTAGE || '';

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const cache = path.join(os.homedir(), '.cache/puppeteer/chrome');
  if (fs.existsSync(cache)) {
    for (const v of fs.readdirSync(cache).sort().reverse()) {
      const p = path.join(cache, v, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
      if (fs.existsSync(p)) return p;
    }
  }
  return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
}

const results = { when: new Date().toISOString(), host: `${os.cpus()[0].model}, load avg ${os.loadavg().map((x) => x.toFixed(1)).join('/')}`, ...(SABOTAGE && { sabotage: SABOTAGE }) };
const g = gate(results);
const logs = [];
let browser, page;

try {
  g.stage('launch');
  browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: true,
    args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
    defaultViewport: { width: 1680, height: 940, deviceScaleFactor: 2 },
  });
  results.chrome = await browser.version();
  page = await browser.newPage();
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

  // ---------------------------------------------------------------- 1. live demo
  g.stage('live');
  await page.goto(`${base}/?demo&theme=dark`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('body[data-ready="1"]', { timeout: 30000 });
  results.renderer = await page.evaluate(() => window.rig.canvas.rendererName);
  await page.evaluate(() => window.rig.engine.resume());
  await page.evaluate(() => window.rig.engine.whenModelsLoaded());
  const clock = () => page.evaluate(() => ({ t: window.rig.engine.ctx.currentTime, quanta: window.rig.engine.tapStats.quanta }));
  const c0 = await clock();
  await new Promise((r) => setTimeout(r, 6000));
  const c1 = await clock();
  results.liveQuanta = { quanta: c1.quanta - c0.quanta, expected: Math.round(((c1.t - c0.t) * 48000) / 128), seconds: +(c1.t - c0.t).toFixed(2) };
  results.live = await page.evaluate(() => {
    const { engine, store } = window.rig;
    const nodes = {};
    for (const [id, n] of engine.nodes) {
      const d = store.doc.nodes[id];
      nodes[d.label] = { type: d.type, status: n.status, cpuUs: n.stats ? +n.stats.cpuUs.toFixed(1) : null, cpuMaxUs: n.stats?.cpuMaxUs != null ? +n.stats.cpuMaxUs.toFixed(1) : null, precise: n.stats?.precise ?? null, rmsDb: +(20 * Math.log10(Math.max(1e-9, engine.level(id).rms))).toFixed(1) };
    }
    const cpu = engine.cpu(), lat = engine.latency();
    return { state: engine.ctx.state, sampleRate: engine.ctx.sampleRate, nodes, cpuTotalUs: +cpu.us.toFixed(1), budgetUs: +cpu.budget.toFixed(1), dspPct: +(cpu.fraction * 100).toFixed(2), renderCapacity: cpu.capacity, workletClockPrecise: cpu.precise, latency: lat, masterPeakDb: +(20 * Math.log10(Math.max(1e-9, engine.master.peak))).toFixed(1) };
  });
  await page.screenshot({ path: path.join(out, 'demo-dark.png') });
  await page.evaluate(() => document.querySelector('#theme').click());
  await new Promise((r) => setTimeout(r, 800));
  await page.screenshot({ path: path.join(out, 'demo-light.png') });
  // select a head so the inspector shows up in a third shot
  await page.evaluate(() => { const [id] = Object.entries(window.rig.store.doc.nodes).find(([, n]) => n.type === 'nam'); window.rig.canvas.select({ kind: 'node', id }); document.querySelector('#theme').click(); });
  await new Promise((r) => setTimeout(r, 800));
  await page.screenshot({ path: path.join(out, 'demo-inspector.png') });
  await page.evaluate(() => window.rig.engine.suspend());

  // ---------------------------------------------------------------- 1b. pointer interaction smoke test
  g.stage('interaction');
  results.interaction = await (async () => {
    const screenOf = (id, lx, ly) => page.evaluate((id, lx, ly) => {
      const { canvas, store } = window.rig; const n = store.doc.nodes[id]; const w = canvas.world; const r = canvas.app.canvas.getBoundingClientRect();
      return { x: r.left + w.x + (n.pos[0] + lx) * w.scale.x, y: r.top + w.y + (n.pos[1] + ly) * w.scale.y };
    }, id, lx, ly);
    const info = await page.evaluate(() => {
      const { store, canvas } = window.rig;
      const [odId] = Object.entries(store.doc.nodes).find(([, n]) => n.label === 'Trail Drive');
      const v = canvas.views.get(odId); const k = v.knobs.find((q) => q.key === 'drive');
      return { odId, kx: k.x, ky: k.y, before: store.doc.nodes[odId].params.drive, outPort: v.ports.outs[0] };
    });
    // knob: drag up
    const p0 = await screenOf(info.odId, info.kx, info.ky);
    await page.mouse.move(p0.x, p0.y); await page.mouse.down(); await page.mouse.move(p0.x, p0.y - 40, { steps: 8 }); await page.mouse.up();
    const after = await page.evaluate((id) => window.rig.store.doc.nodes[id].params.drive, info.odId);
    // wire: add a reverb below, drag from Trail Drive's output to its input
    const rvId = await page.evaluate((odId) => { const n = window.rig.store.doc.nodes[odId]; return window.rig.store.addNode('reverb', [n.pos[0], n.pos[1] + 330]); }, info.odId);
    await new Promise((r) => setTimeout(r, 200));
    const inPort = await page.evaluate((id) => window.rig.canvas.views.get(id).ports.ins[0], rvId);
    const a = await screenOf(info.odId, info.outPort.x, info.outPort.y), b = await screenOf(rvId, inPort.x, inPort.y);
    await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 12 }); await page.mouse.up();
    const wired = await page.evaluate((od, rv) => Object.values(window.rig.store.doc.edges).some((e) => e.from[0] === od && e.to[0] === rv), info.odId, rvId);
    const graphOk = await page.evaluate((od, rv) => window.rig.engine.conns.has(`${od}:0>${rv}:0`), info.odId, rvId);
    await page.evaluate(() => { window.rig.store.undo(); window.rig.store.undo(); window.rig.store.undo(); });
    return { knobBefore: info.before, knobAfter: after, knobMoved: after > info.before, wireCreated: wired, audioConnected: graphOk };
  })();

  // ---------------------------------------------------------------- 1c. design skin (opt-in) renders
  if (fs.existsSync(path.join(root, 'design/skin.brush-ink.json'))) {
    g.stage('skin');
    await page.goto(`${base}/?demo&theme=light&skin=brush-ink`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('body[data-ready="1"]', { timeout: 30000 });
    results.skin = await page.evaluate(() => ({ name: window.rig.canvas.skin.name, devicesWithArt: Object.keys(window.rig.canvas.skin.art || {}) }));
    await page.screenshot({ path: path.join(out, 'demo-skin-brush-ink.png') });
  }

  // ---------------------------------------------------------------- 2. NAM parity in the browser
  g.stage('parity');
  const SECONDS = 6;
  const parity = {};
  for (const file of fs.readdirSync(path.join(root, 'web/models')).filter((f) => f.endsWith('.nam')).sort().slice(0, 2)) { // whatever models are on disk
    const rendered = await page.evaluate(async (file, SECONDS) => {
      const { Engine } = await import('/js/audio/engine.js');
      const { emptyDoc } = await import('/js/graph/doc.js');
      const lib = window.rig.library;
      const m = lib.models.find((x) => x.file === file);
      const d = emptyDoc('parity');
      d.nodes.i = { type: 'input', label: 'in', pos: [0, 0], bypass: false, params: { source: 0, channel: 0, gain: 0 } };
      d.nodes.n = { type: 'nam', label: 'nam', pos: [0, 0], bypass: false, params: { input: 0, output: 0, normalize: 0, dcblock: 0 }, model: m.hash };
      d.nodes.o = { type: 'output', label: 'out', pos: [0, 0], bypass: false, params: { volume: 0 } };
      d.edges.a = { from: ['i', 0], to: ['n', 0] }; d.edges.b = { from: ['n', 0], to: ['o', 0] };
      const ctx = new OfflineAudioContext(1, 48000 * SECONDS, 48000);
      const e = await new Engine(lib).init({ context: ctx, diUrl: '/audio/di-loop.wav' }); // the same input the native render gets
      e.sync(d);
      await e.whenModelsLoaded();
      const buf = await ctx.startRendering();
      return Array.from(buf.getChannelData(0));
    }, file, SECONDS);
    const di = readWav(path.join(root, 'web/audio/di-loop.wav')).data.subarray(0, SECONDS * 48000);
    const nativeOut = path.join(out, `browser-parity-native-${file}.wav`);
    const inPath = path.join(out, 'browser-parity-in.wav');
    const { writeWavFloat } = await import('../tests/lib/wav.mjs');
    writeWavFloat(inPath, di, 48000);
    execFileSync(path.join(root, 'build/native/tools/render'), [path.join(root, 'web/models', file), inPath, nativeOut], { stdio: 'pipe' });
    const native = readWav(nativeOut).data;
    let maxAbs = 0, peak = 0, renderedPeak = 0, nonFinite = 0;
    for (const v of rendered) { if (!Number.isFinite(v)) nonFinite++; else renderedPeak = Math.max(renderedPeak, Math.abs(v)); }
    for (let i = 0; i < native.length; i++) { maxAbs = Math.max(maxAbs, Math.abs(rendered[i] - native[i])); peak = Math.max(peak, Math.abs(native[i])); }
    parity[file] = { maxAbsDiff: maxAbs, nativePeak: peak, renderedPeak, renderedLength: rendered.length, nativeLength: native.length, nonFinite };
  }
  results.browserParity = parity;

  // ---------------------------------------------------------------- 3. CPU headroom, full demo offline
  g.stage('headroom');
  results.offlineDemo = await page.evaluate(async () => {
    const { Engine } = await import('/js/audio/engine.js');
    const { demoDoc } = await import('/js/graph/demo.js');
    const SECS = 20;
    const runs = [];
    for (let r = 0; r < 3; r++) {
      const ctx = new OfflineAudioContext(2, 48000 * SECS, 48000);
      const e = await new Engine(window.rig.library).init({ context: ctx });
      e.sync(demoDoc(window.rig.library.models));
      await e.whenModelsLoaded();
      const t0 = performance.now();
      const buf = await ctx.startRendering();
      const ms = performance.now() - t0;
      let peak = 0; for (const v of buf.getChannelData(0)) peak = Math.max(peak, Math.abs(v));
      const per = {};
      for (const [id, n] of e.nodes) if (n.stats) per[e.doc.nodes[id].label] = +n.stats.cpuUs.toFixed(1);
      runs.push({ ms: +ms.toFixed(0), realtimeX: +((SECS * 1000) / ms).toFixed(2), outPeakDb: +(20 * Math.log10(peak)).toFixed(1), perNodeUs: per });
    }
    const best = runs.reduce((a, b) => (a.realtimeX > b.realtimeX ? a : b));
    return { seconds: SECS, runs: runs.map(({ perNodeUs, ...r }) => r), best: { ...best, cpuOfOneCorePct: +(100 / best.realtimeX).toFixed(1) } };
  });

  // ---------------------------------------------------------------- 4. offline renderer (Node) vs Chrome, same document
  g.stage('node-vs-chrome');
  {
    const { render } = await import('./render.mjs');
    const { validateDoc } = await import('../web/js/graph/doc.js');
    const { demoDoc } = await import('../web/js/graph/demo.js');
    const doc = validateDoc(demoDoc(JSON.parse(fs.readFileSync(path.join(root, 'web/models/index.json'), 'utf8')).models));
    const SECS = 6;
    const chrome = await page.evaluate(async (doc, SECS) => {
      const { Engine } = await import('/js/audio/engine.js');
      const ctx = new OfflineAudioContext(2, 48000 * SECS, 48000);
      const e = await new Engine(window.rig.library).init({ context: ctx, loop: 'chord-stabs' });
      e.sync(doc); await e.whenModelsLoaded();
      const buf = await ctx.startRendering();
      return [Array.from(buf.getChannelData(0)), Array.from(buf.getChannelData(1))];
    }, doc, SECS);
    const node = render({ doc, loop: 'chord-stabs', seconds: SECS, preroll: 0 }).channels;
    if (SABOTAGE === 'parity') for (const ch of chrome) for (let i = 0; i < ch.length; i++) ch[i] *= 1.001;
    let maxAbs = 0, peak = 0, err = 0, sig = 0;
    for (let c = 0; c < 2; c++) for (let i = 0; i < node[c].length; i++) {
      const d = chrome[c][i] - node[c][i];
      maxAbs = Math.max(maxAbs, Math.abs(d)); peak = Math.max(peak, Math.abs(node[c][i])); err += d * d; sig += node[c][i] ** 2;
    }
    results.nodeRenderVsChrome = { seconds: SECS, loop: 'chord-stabs', samples: [chrome[0].length, chrome[1].length, node[0].length, node[1].length], maxAbsDiff: maxAbs, peak, errorToSignalDb: +(10 * Math.log10(err / sig)).toFixed(1) };
  }

  // ---------------------------------------------------------------- assertions
  g.stage('assert');
  const L = results.live;
  const heads = Object.entries(L.nodes).filter(([, n]) => n.type === 'nam');
  g.check('live context running at 48 kHz', L.state === 'running' && L.sampleRate === 48000, { state: L.state, sampleRate: L.sampleRate }, "state 'running', 48000 Hz");
  g.check('NAM models loaded', heads.length >= 1 && heads.every(([, n]) => n.status === 'ready'), Object.fromEntries(heads.map(([k, n]) => [k, n.status])), "at least one NAM head, every head status 'ready'");
  const notReady = Object.entries(L.nodes).filter(([, n]) => n.status !== 'ready').map(([k, n]) => `${k}: ${n.status}`);
  g.check('every node ready', notReady.length === 0, notReady, "every node status 'ready'");
  const badMeters = Object.entries(L.nodes).filter(([, n]) => !finite(n.rmsDb) || (n.cpuUs != null && !finite(n.cpuUs))).map(([k]) => k);
  g.check('meters and per-node CPU finite', badMeters.length === 0 && finite(L.cpuTotalUs, L.dspPct, L.masterPeakDb), { badMeters, cpuTotalUs: L.cpuTotalUs, dspPct: L.dspPct }, 'finite numbers for every node');
  g.check('live output is real audio', L.masterPeakDb > -60 && L.masterPeakDb <= 0, L.masterPeakDb, '-60 < master peak dBFS <= 0');
  const Q = results.liveQuanta, qErr = Math.abs(Q.quanta - Q.expected) / Q.expected;
  g.check('live render quanta counted', Q.quanta > 0 && Q.expected > 0 && qErr <= 0.05, { ...Q, relErr: +qErr.toFixed(4) }, 'quanta > 0 and within 5% of the audio clock');
  const I = results.interaction;
  g.check('knob drag, wire and audio connection', I.knobMoved && I.wireCreated && I.audioConnected, I, 'knob moved, wire created, audio connected');
  for (const [file, p] of Object.entries(results.browserParity)) {
    g.check(`browser render non-empty: ${file}`, p.renderedLength === SECONDS * 48000 && p.nonFinite === 0 && p.renderedPeak > 1e-3 && p.nativeLength >= p.renderedLength, { renderedLength: p.renderedLength, nativeLength: p.nativeLength, nonFinite: p.nonFinite, renderedPeak: p.renderedPeak }, `${SECONDS * 48000} finite samples, peak > 1e-3 (-60 dBFS), native at least as long`);
    g.check(`browser NAM matches native: ${file}`, p.maxAbsDiff < 1e-4, p.maxAbsDiff, 'max abs diff < 1e-4 (the threshold of tests/nam-parity.test.mjs)');
  }
  const O = results.offlineDemo;
  g.check('offline demo renders audio', O.runs.length === 3 && O.runs.every((r) => finite(r.outPeakDb) && r.outPeakDb > -60 && r.outPeakDb <= 0), O.runs.map((r) => r.outPeakDb), 'every run peak between -60 and 0 dBFS');
  g.check('CPU headroom of the full demo chain', O.best.realtimeX >= 2, O.best.realtimeX, '>= 2x real time offline (best of 3)');
  const N = results.nodeRenderVsChrome;
  g.check('Node render vs Chrome non-empty', N.samples.every((n) => n === N.seconds * 48000) && N.peak > 1e-3, { samples: N.samples, peak: N.peak }, `${N.seconds * 48000} samples per channel, peak > 1e-3`);
  g.check('Node render vs Chrome error-to-signal', finite(N.errorToSignalDb) && N.errorToSignalDb <= -80, N.errorToSignalDb, '<= -80 dB');
  const errors = logs.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]'));
  g.check('no console errors', errors.length === 0, errors.slice(0, 5), 'no [error] or [pageerror] entries');
} catch (e) {
  g.fail(e);
} finally {
  results.console = logs.filter((l) => !l.includes('[nam]')).slice(0, 40);
  const code = g.finish();
  fs.writeFileSync(path.join(out, 'browser-check.json'), JSON.stringify(results, null, 1));
  console.log(JSON.stringify(results, null, 1));
  await browser?.close().catch(() => {});
  process.exitCode = code;
}
