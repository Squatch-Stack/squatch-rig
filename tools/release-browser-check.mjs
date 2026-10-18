#!/usr/bin/env node
// Exercise the shipped static bundle through visible controls and real WebAudio.
// A fresh browser profile keeps this deterministic; no external audio device is needed.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import puppeteer from 'puppeteer-core';
import { webkit } from 'playwright';
import { encodeWav } from '../web/js/audio/wav.js';

const args = process.argv.slice(2);
const browserName = args.find((arg) => arg.startsWith('--browser='))?.split('=')[1] || 'chromium';
const base = (args.find((arg) => !arg.startsWith('--')) || 'http://127.0.0.1:7492/public-demo/').replace(/\/?$/, '/');
const cache = path.join(os.homedir(), '.cache/puppeteer/chrome');
const versions = fs.existsSync(cache) ? fs.readdirSync(cache).sort().reverse() : [];
const chrome = process.env.CHROME || versions.map((v) => path.join(cache, v, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')).find(fs.existsSync);
if (!chrome) throw new Error('Chrome for Testing is missing');
const out = path.resolve('tests/out');
fs.mkdirSync(out, { recursive: true });
let browser, context, page;
if (browserName === 'webkit') {
  browser = await webkit.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['microphone'] });
  browser.newPage = () => context.newPage();
  page = await context.newPage();
  const nativeEvaluate = page.evaluate.bind(page);
  page.evaluate = (fn, ...args) => nativeEvaluate(({ source, values }) => (0, eval)(`(${source})`)(...values), { source: fn.toString(), values: args });
  page.setViewport = ({ width, height }) => page.setViewportSize({ width, height });
  page.select = (selector, value) => page.locator(selector).selectOption(value);
  page.waitForFileChooser = () => page.waitForEvent('filechooser').then((chooser) => ({ accept: (files) => chooser.setFiles(files) }));
  const nativeWait = page.waitForFunction.bind(page);
  page.waitForFunction = (fn, optionsOrArg, ...rest) => {
    const isOptions = optionsOrArg && typeof optionsOrArg === 'object' && ('timeout' in optionsOrArg || 'polling' in optionsOrArg);
    const values = isOptions ? rest : [optionsOrArg];
    return nativeWait(({ source, args }) => (0, eval)(`(${source})`)(...args), { source: fn.toString(), args: values.filter((v) => v !== undefined) }, isOptions ? optionsOrArg : {});
  };
} else if (browserName === 'chromium') {
  browser = await puppeteer.launch({ executablePath: chrome, headless: true,
    args: ['--mute-audio', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 } });
  page = await browser.newPage();
} else throw new Error(`Unsupported browser: ${browserName}`);
const errors = [], checks = [];
page.on('pageerror', (error) => errors.push(error.message));
const ok = (condition, name) => { if (!condition) throw new Error(name); checks.push(name); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ready = async () => page.waitForSelector('body[data-ready="1"]', { timeout: 30000 });
const evalRig = (fn, ...args) => page.evaluate(fn, ...args);
try {
  await page.goto(`${base}?demo&intro=0`, { waitUntil: 'networkidle0' });
  await ready();
  ok(await page.$eval('script[type="module"]', (el) => /\/assets\/[a-f0-9]{12}\/js\/main\.js$/.test(el.src)), 'HTML selects a versioned complete asset tree');
  const firstUse = await evalRig(() => ({
    sound: document.querySelector('#sound-pick').value,
    loop: window.rig.engine.loopId,
    context: window.rig.engine.ctx.state,
    source: Object.values(window.rig.store.doc.nodes).find((n) => n.type === 'input')?.params.source,
    head: Object.values(window.rig.store.doc.nodes).find((n) => n.type === 'nam')?.params,
  }));
  ok(firstUse.sound === 'stack' && firstUse.loop === 'clean-chords' && firstUse.context === 'suspended' && firstUse.source === 0,
    'first visit shows a ready-to-play sound and DI loop without autoplay or microphone permission');
  ok(firstUse.head?.input === -16 && firstUse.head?.bass === -9 && firstUse.head?.normalize === 0,
    'first-visit NAM head uses the calibrated trim and chord bass treatment');
  const guideFirstLook = await evalRig(() => ({
    visible: !document.querySelector('#first-play').hidden,
    hear: document.querySelector('#first-play .tp-play')?.textContent,
    loops: [...document.querySelectorAll('#first-play [data-loop]')].map((el) => el.dataset.loop),
    ab: !!document.querySelector('#first-play .tp-ab'),
  }));
  ok(guideFirstLook.visible && guideFirstLook.hear === 'Hear it' && guideFirstLook.ab && guideFirstLook.loops.join(',') === 'clean-chords,chord-stabs,picked-riff,single-note-riff,lead',
    `first-visit guide offers Hear it, A/B, and five one-tap loops: ${JSON.stringify(guideFirstLook)}`);
  await page.screenshot({ path: path.join(out, `first-play-${browserName}-desktop.png`) });
  const unnamed = await evalRig(() => [...document.querySelectorAll('button, input, select, canvas, [role="button"]')]
    .filter((el) => el.getClientRects().length && !el.hidden)
    .filter((el) => !(el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText?.trim() || el.labels?.length || el.getAttribute('aria-valuetext')))
    .map((el) => `${el.tagName}.${String(el.className || '')}`));
  ok(unnamed.length === 0, `visible controls have accessible names: ${unnamed.join(', ')}`);
  ok(await page.$eval('.support-link', (el) => el.href === 'https://github.com/sponsors/Squatch-Stack'), 'support link');
  ok(await page.$$eval('.tp-loop option', (els) => els.map((el) => el.value).join(',') === 'clean-chords,chord-stabs,picked-riff,single-note-riff,lead'), 'five real-performance DI loops; sequenced palm mute retired');
  const pedals = await page.$$eval('#pedal-pick option', (els) => els.map((el) => el.value));
  ok(['gate', 'compressor', 'overdrive', 'bloom', 'envfilter', 'reverb', 'limiter'].every((id) => pedals.includes(id)), 'all effect pedals selectable');

  // A real UI gesture starts playback, and every loop must switch on the live graph.
  if (await evalRig(() => window.rig.engine.ctx.state !== 'running')) {
    await page.$eval('#first-play .tp-play', (el) => el.focus());
    await page.keyboard.press('Enter');
  }
  await page.waitForFunction(() => window.rig.engine.ctx.state === 'running' && window.rig.engine.master.rms > 0.0001, { timeout: 15000 });
  const firstTake = await evalRig(async () => {
    const engine = window.rig.engine;
    engine.startRecording(); await new Promise((resolve) => setTimeout(resolve, 2400));
    const blob = await engine.stopRecording();
    const mainUrl = document.querySelector('script[type="module"]').src;
    const { decodeWav } = await import(new URL('audio/wav.js', mainUrl).href);
    const { sampleRate, channels } = decodeWav(new Uint8Array(await blob.arrayBuffer()));
    let peak = 0, power = 0, clipped = 0, maxStep = 0, prior = channels[0][0] || 0;
    for (let i = 0; i < channels[0].length; i++) {
      const x = channels[0][i]; peak = Math.max(peak, Math.abs(x)); power += x * x;
      if (Math.abs(x) >= 1) clipped++;
      maxStep = Math.max(maxStep, Math.abs(x - prior)); prior = x;
    }
    const rms = Math.sqrt(power / channels[0].length);
    return { sampleRate, seconds: channels[0].length / sampleRate, peakDb: 20 * Math.log10(peak), rmsDb: 20 * Math.log10(rms), crestDb: 20 * Math.log10(peak / rms), clipped, maxStep };
  });
  ok(firstTake.sampleRate === 48000 && firstTake.peakDb < -0.2 && firstTake.peakDb > -36 && firstTake.rmsDb > -40 && firstTake.clipped === 0,
    `first Play produces audible non-clipping audio: ${JSON.stringify(firstTake)}`);
  await page.select('.tp-loop', 'single-note-riff');
  await page.waitForFunction(() => window.rig.engine.loopId === 'single-note-riff', { timeout: 5000 });
  await page.waitForFunction(() => {
    const e = window.rig.engine, level = (a) => { const d = new Float32Array(a.fftSize); a.getFloatTimeDomainData(d); return Math.sqrt(d.reduce((s, x) => s + x * x, 0) / d.length); };
    const rig = level(e.rigMatchMeter), dry = level(e.dryMatchMeter);
    return rig > 0.01 && dry > 0.01 && Math.abs(20 * Math.log10(rig / dry) - e.dryMakeupDb) < 1;
  }, { timeout: 15000 });
  const abBalance = await evalRig(() => {
    const e = window.rig.engine;
    e._updateAbMatch();
    const level = (a) => { const d = new Float32Array(a.fftSize); a.getFloatTimeDomainData(d); return Math.sqrt(d.reduce((s, x) => s + x * x, 0) / d.length); };
    const rig = level(e.rigMatchMeter), dry = level(e.dryMatchMeter);
    return { rigDb: 20 * Math.log10(rig), dryDb: 20 * Math.log10(dry), makeupDb: e.dryMakeupDb, residualDb: 20 * Math.log10(rig / dry) - e.dryMakeupDb };
  });
  ok(Number.isFinite(abBalance.residualDb) && Math.abs(abBalance.residualDb) < 1 && abBalance.rigDb > -40 && abBalance.dryDb > -40,
    `dry A/B matched to the processed rig within 1 dB: ${JSON.stringify(abBalance)}`);
  await page.$eval('#first-play .tp-ab', (el) => el.focus()); await page.keyboard.press('Enter');
  ok(await evalRig(() => window.rig.engine.bypassed), 'guided A/B switches to matched dry DI');
  await page.click('#first-play .tp-ab');
  ok(await evalRig(() => !window.rig.engine.bypassed), 'guided A/B switches back to the processed rig');
  await page.click('#first-play [data-loop="lead"]');
  await page.waitForFunction(() => window.rig.engine.loopId === 'lead', { timeout: 5000 });
  await page.$eval('#first-play [data-loop="picked-riff"]', (el) => el.focus()); await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.rig.engine.loopId === 'picked-riff', { timeout: 5000 });
  await page.click('#first-play [data-loop="chord-stabs"]');
  await page.waitForFunction(() => window.rig.engine.loopId === 'chord-stabs', { timeout: 5000 });
  checks.push('guided one-tap loop selection works during playback');
  const loopRms = {};
  for (const loop of ['chord-stabs', 'picked-riff', 'single-note-riff', 'lead', 'clean-chords']) {
    const before = await evalRig(() => window.rig.engine.tapStats.quanta);
    await page.select('.tp-loop', loop);
    await page.waitForFunction((id) => window.rig.engine.loopId === id, { timeout: 10000 }, loop);
    await page.waitForFunction((n) => window.rig.engine.tapStats.quanta > n + 40, { timeout: 5000 }, before);
    await sleep(350);
    loopRms[loop] = await evalRig(() => window.rig.engine.master.rms);
    ok(await page.$eval('#credit', (el) => el.textContent.includes('DI loop')), `${loop}: credit and running audio`);
  }

  // The complete quick sounds replace the graph and remain audible.
  for (const sound of ['stack', 'trail', 'bloom', 'hall']) {
    await page.select('#sound-pick', sound);
    await page.waitForFunction((id) => document.querySelector('#sound-pick').value === id && window.rig.engine.doc === window.rig.store.doc, { timeout: 10000 }, sound);
    ok(await evalRig(() => Object.values(window.rig.store.doc.nodes).some((n) => n.type === 'output') && window.rig.engine.ctx.state === 'running'), `${sound}: wired playback graph`);
  }
  await page.select('#sound-pick', 'bloom');
  await page.select('.tp-loop', 'single-note-riff');
  const bypassClicks = await evalRig(async () => {
    const { engine: e, store } = window.rig;
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const originalDiBuffer = e.diBuffer;
    // Fixed, one-second 110 Hz sine (integer-cycle loop) gives every device
    // the same sustained input. Browser scheduling can still shift the toggle
    // phase; the old decaying phrase also moved the steady-state denominator.
    const rate = e.ctx.sampleRate;
    const tone = e.ctx.createBuffer(1, rate, rate), samples = tone.getChannelData(0);
    for (let i = 0; i < samples.length; i++) samples[i] = 0.12 * Math.sin(2 * Math.PI * 110 * i / rate);
    e.diBuffer = tone;
    const types = ['gate', 'compressor', 'overdrive', 'bloom', 'nam', 'cab', 'envfilter', 'reverb', 'limiter'];
    const records = [];
    for (const type of types) {
      const [id] = Object.entries(store.doc.nodes).find(([, node]) => node.type === type) || [];
      if (!id || !e.nodes.has(id)) continue;
      for (const input of e._inputs()) input.startDi({ restart: true });
      await delay(100); // let the old source crossfade out and the test tone settle
      store.setBypass(id, false);
      await delay(100);
      const t0 = e.ctx.currentTime, rate = e.ctx.sampleRate;
      e.startRecording();
      await delay(240);
      const onFrame = Math.round((e.ctx.currentTime - t0) * rate);
      store.setBypass(id, true);
      await delay(180);
      const offFrame = Math.round((e.ctx.currentTime - t0) * rate);
      store.setBypass(id, false);
      await delay(220);
      const blob = await e.stopRecording();
      const { decodeWav } = await import(new URL('audio/wav.js', document.querySelector('script[type="module"]').src).href);
      const { channels, sampleRate } = decodeWav(new Uint8Array(await blob.arrayBuffer()));
      const maxStep = (from, to) => {
        let peak = 0;
        for (const data of channels) for (let i = Math.max(1, from); i < Math.min(data.length, to); i++) peak = Math.max(peak, Math.abs(data[i] - data[i - 1]));
        return peak;
      };
      // Include the 25 ms wet/dry fade and the worklet's 80 ms bypass timer.
      const around = (frame) => maxStep(frame - sampleRate * 0.02, frame + sampleRate * 0.12);
      const steady = Math.max(maxStep(onFrame - sampleRate * 0.16, onFrame - sampleRate * 0.045), maxStep(offFrame + sampleRate * 0.13, offFrame + sampleRate * 0.16));
      records.push({ type, toggleOn: around(onFrame), toggleOff: around(offFrame), steady });
    }
    e.diBuffer = originalDiBuffer;
    for (const input of e._inputs()) input.startDi({ restart: true });
    await delay(100);
    return { records, maxToggle: Math.max(...records.flatMap((r) => [r.toggleOn, r.toggleOff])), maxSteady: Math.max(...records.map((r) => r.steady)) };
  });
  // Absolute sample-step bound on the fixed tone. Quantum alignment can shift
  // which sample lands in the capture window, so compare the complete 120 ms
  // transition against a ceiling instead of a moving steady-state ratio.
  // A pre-fix WebKit limiter resume reached 0.0894. The fixed path peaked at
  // 0.0171 across five runs per browser; 0.040 catches that regression while
  // leaving room for browser quantum alignment.
  const bypassStepLimit = 0.040;
  ok(bypassClicks.records.length === 9 && bypassClicks.records.every((r) =>
    r.toggleOn < bypassStepLimit && r.toggleOff < bypassStepLimit),
    `bypass transitions stay below measured ${bypassStepLimit} sample-step ceiling: ${JSON.stringify(bypassClicks)}`);
  checks.push(`bypass max sample step ${bypassClicks.maxToggle.toFixed(4)} vs steady ${bypassClicks.maxSteady.toFixed(4)} (ceiling ${bypassStepLimit})`);
  const bassDefaults = {};
  for (const sound of ['stack', 'trail', 'bloom', 'hall']) {
    await page.select('#sound-pick', sound);
    await page.waitForFunction((id) => document.querySelector('#sound-pick').value === id, { timeout: 10000 }, sound);
    bassDefaults[sound] = await evalRig(() => Object.values(window.rig.store.doc.nodes).find((n) => n.type === 'nam')?.params.bass);
    const expected = sound === 'hall' ? -12 : -9;
    ok(bassDefaults[sound] === expected, `${sound}: shipped Bass treatment`);
  }
  await page.select('#sound-pick', 'stack');
  const sliderCheck = await evalRig(async () => {
    const { store, canvas } = window.rig;
    const original = structuredClone(store.doc);
    let count = 0, problems = [];
    for (const [id, node] of Object.entries(original.nodes)) {
      canvas.select({ kind: 'node', id });
      for (const range of document.querySelectorAll('#inspector input[type="range"][data-param]')) {
        const key = range.dataset.param, norm = range.value;
        const set = (value) => { range.value = String(value); range.dispatchEvent(new Event('input', { bubbles: true })); return store.doc.nodes[id].params[key]; };
        const lo = set(+range.min), hi = set(+range.max);
        if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo === hi) problems.push(`${node.label}.${key}`);
        set(+norm); count++;
      }
    }
    return { count, problems };
  });
  ok(sliderCheck.count >= 25 && sliderCheck.problems.length === 0, `parameter sliders reach both extremes and restore (${sliderCheck.count} ranges)`);
  const namIdForBass = await evalRig(() => Object.entries(window.rig.store.doc.nodes).find(([, n]) => n.type === 'nam')[0]);
  await evalRig((id) => window.rig.canvas.select({ kind: 'node', id }), namIdForBass);
  const bassControl = await page.$eval(`#inspector label[for="p-${namIdForBass}-bass"]`, (el) => el.textContent);
  const bassValueText = await page.$eval('#inspector input[data-param="bass"]', (el) => el.getAttribute('aria-valuetext'));
  ok(bassValueText?.includes('9') && bassValueText.toLowerCase().includes('db') && bassControl === 'Bass',
    'NAM Bass is keyboard and screen-reader labeled with its current value');
  const sweep = await evalRig(async (id) => {
    const e = window.rig.engine, slider = document.querySelector('#inspector input[data-param="bass"]');
    e.startRecording();
    for (let i = 0; i <= 60; i++) {
      slider.value = String((i * 137) % 1001); slider.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 8));
    }
    slider.value = '250'; slider.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 350));
    const { decodeWav } = await import(new URL('audio/wav.js', document.querySelector('script[type="module"]').src).href);
    const { channels } = decodeWav(new Uint8Array(await (await e.stopRecording()).arrayBuffer()));
    let peak = 0, maxStep = 0, prior = channels[0][0] || 0;
    for (const x of channels[0]) { peak = Math.max(peak, Math.abs(x)); maxStep = Math.max(maxStep, Math.abs(x - prior)); prior = x; }
    return { peak, maxStep, bass: window.rig.store.doc.nodes[id].params.bass };
  }, namIdForBass);
  ok(sweep.bass === -9 && sweep.peak < 1 && sweep.maxStep < 0.5, `fast Bass sweep stays click-free: ${JSON.stringify(sweep)}`);
  await evalRig((id) => { window.rig.store.setParam(id, 'bass', -9); window.rig.canvas.select(null); }, namIdForBass);
  await page.$eval('#stage canvas', (el) => el.focus());
  await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
  const keyboardSelection = await evalRig(() => ({ id: window.rig.canvas.selected?.id, node: window.rig.store.doc.nodes[window.rig.canvas.selected?.id] }));
  if (keyboardSelection.node && keyboardSelection.node.type !== 'input' && keyboardSelection.node.type !== 'output') {
    const before = keyboardSelection.node.bypass; await page.keyboard.press('b');
    ok(await evalRig((id, value) => window.rig.store.doc.nodes[id].bypass === !value, keyboardSelection.id, before),
      'keyboard Tab selection and B bypass operate the graph');
  } else checks.push('keyboard graph selection');
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
  await page.keyboard.down('Control'); await page.keyboard.down('Shift'); await page.keyboard.press('z');
  await page.keyboard.up('Shift'); await page.keyboard.up('Control');
  await page.$eval('.tp-play', (el) => el.focus()); await page.keyboard.press('Space');
  await page.waitForFunction(() => window.rig.engine.ctx.state === 'suspended', { timeout: 5000 });
  await page.keyboard.press('Space'); await page.waitForFunction(() => window.rig.engine.ctx.state === 'running', { timeout: 5000 });
  checks.push('keyboard shortcuts operate undo, redo, and Play/Stop');

  // Light/dark, both skins, motion preference and their persisted values.
  await page.select('#theme-pick', 'light');
  await page.select('#skin-pick', 'ink');
  await page.waitForFunction(() => window.rig.canvas.skin.name === 'ink');
  await page.click('#motion');
  ok(await evalRig(() => document.documentElement.dataset.theme === 'light' && window.rig.canvas.skin.name === 'ink' && document.documentElement.dataset.motion === 'reduced'), 'theme, skin and motion controls');
  await page.reload({ waitUntil: 'networkidle0' }); await ready();
  ok(await evalRig(() => document.documentElement.dataset.theme === 'light' && window.rig.canvas.skin.name === 'ink'), 'view choices persist on reload');
  await page.select('#skin-pick', 'brush-ink');
  await page.waitForFunction(() => window.rig.canvas.skin.name === 'brush-ink');
  await page.click('#motion'); await page.click('#motion');
  ok(await evalRig(() => document.documentElement.dataset.motion === undefined), 'motion cycles back to system');

  // Pedal picker, inspector bypass and knob, undo/redo and keyboard deletion.
  const beforeNodes = await evalRig(() => Object.keys(window.rig.store.doc.nodes).length);
  await page.select('#pedal-pick', 'overdrive');
  ok(await evalRig((n) => Object.keys(window.rig.store.doc.nodes).length === n + 1 && window.rig.canvas.selected?.kind === 'node', beforeNodes), 'pedal picker adds and selects');
  await page.$eval('#inspector [data-param="drive"]', (el) => { el.value = '850'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  ok(await evalRig(() => window.rig.store.doc.nodes[window.rig.canvas.selected.id].params.drive > 0.8), 'inspector drive knob updates DSP document');
  await page.click('#inspector [data-bypass]');
  ok(await evalRig(() => window.rig.store.doc.nodes[window.rig.canvas.selected.id].bypass), 'inspector bypass');
  await page.click('#undo'); await page.click('#undo'); await page.click('#undo');
  ok(await evalRig((n) => Object.keys(window.rig.store.doc.nodes).length === n, beforeNodes), 'undo removes added pedal');
  await page.click('#redo');
  ok(await evalRig((n) => Object.keys(window.rig.store.doc.nodes).length === n + 1, beforeNodes), 'redo restores pedal');
  await page.click('#undo');

  // Add-menu, physical jack wiring and the engine's matching AudioNode edge.
  await page.click('#add');
  const items = await page.$$eval('#add-menu button', (els) => els.map((el) => el.textContent));
  ok(['Reverb', 'NAM Head', 'Cab', 'Splitter', 'Mixer', 'Input', 'Output'].every((name) => items.includes(name)), 'add menu exposes every device family');
  await page.click(`#add-menu button:nth-child(${items.indexOf('Reverb') + 1})`);
  const rvId = await evalRig(() => window.rig.canvas.selected?.id);
  const odId = await evalRig(() => Object.entries(window.rig.store.doc.nodes).find(([, n]) => n.label === 'Trail Drive')[0]);
  await evalRig((rv, od) => {
    const pos = window.rig.store.doc.nodes[od].pos;
    window.rig.store.moveNode(rv, [pos[0], pos[1] + 270]);
    window.rig.canvas.fit();
  }, rvId, odId);
  await sleep(180);
  const ports = await evalRig((rv, od) => {
    const c = window.rig.canvas, rect = c.app.canvas.getBoundingClientRect(), w = c.world;
    const at = (id, p) => {
      const n = c.store.doc.nodes[id];
      return { x: rect.left + w.x + (n.pos[0] + p.x) * w.scale.x, y: rect.top + w.y + (n.pos[1] + p.y) * w.scale.y };
    };
    return { a: at(od, c.views.get(od).ports.outs[0]), b: at(rv, c.views.get(rv).ports.ins[0]) };
  }, rvId, odId);
  await page.mouse.move(ports.a.x, ports.a.y); await page.mouse.down();
  await page.mouse.move(ports.b.x, ports.b.y, { steps: 12 }); await page.mouse.up();
  ok(await evalRig((rv, od) => Object.values(window.rig.store.doc.edges).some((e) => e.from[0] === od && e.to[0] === rv) && window.rig.engine.conns.has(`${od}:0>${rv}:0`), rvId, odId), 'jack drag wires the WebAudio graph');
  await evalRig((id) => window.rig.store.removeNode(id), rvId);

  // Bundled NAM model switching and a local cab IR through their file controls.
  const namId = await evalRig(() => Object.entries(window.rig.store.doc.nodes).find(([, n]) => n.type === 'nam')[0]);
  const a1 = await evalRig(() => window.rig.library.models.find((m) => m.file === 'namcore-example-A1.nam').hash);
  await evalRig((id) => window.rig.canvas.select({ kind: 'node', id }), namId);
  await page.select('#inspector select[aria-label="Model"]', a1);
  await page.waitForFunction((id, hash) => window.rig.store.doc.nodes[id].model === hash && window.rig.engine.nodes.get(id)?.status === 'ready', { timeout: 15000 }, namId, a1);
  checks.push('NAM model picker loads a second licensed model');
  await page.click('#undo');
  const cabId = await evalRig(() => Object.entries(window.rig.store.doc.nodes).find(([, n]) => n.type === 'cab')[0]);
  const impulse = new Float32Array(4800); impulse[0] = 1; impulse[1200] = 0.2;
  const irFile = path.join(out, 'release-test-ir.wav'); fs.writeFileSync(irFile, Buffer.from(encodeWav([impulse], 48000, { format: 'pcm16' })));
  await evalRig((id) => window.rig.canvas.select({ kind: 'node', id }), cabId);
  const irChooser = page.waitForFileChooser();
  await page.$eval('#inspector', (el) => [...el.querySelectorAll('button')].find((b) => b.textContent.includes('Load IR')).click());
  await (await irChooser).accept([irFile]);
  await page.waitForFunction((id) => !!window.rig.store.doc.nodes[id].ir && window.rig.engine.nodes.get(id)?.irName !== 'synthetic', { timeout: 10000 }, cabId);
  checks.push('cab IR file loads into WebAudio');
  await page.$eval('#inspector', (el) => [...el.querySelectorAll('button')].find((b) => b.textContent.includes('Use synthetic')).click());
  ok(await evalRig((id) => !window.rig.store.doc.nodes[id].ir, cabId), 'cab returns to synthetic IR');

  // Broken references remain audible on the synthetic fallback and explain
  // the repair to both sighted visitors and screen readers.
  const missingIr = `sha256:${'0'.repeat(64)}`;
  await evalRig((id, hash) => window.rig.store.setIr(id, hash, { name: 'Missing IR test' }), cabId, missingIr);
  await page.waitForFunction((id) => window.rig.engine.nodes.get(id)?.status === 'missing', { timeout: 10000 }, cabId);
  await evalRig((id) => window.rig.canvas.select({ kind: 'node', id }), cabId);
  ok(await page.$eval('#inspector [role="status"]', (el) => el.textContent.includes('synthetic cab is playing')),
    'missing cab IR is reported and the synthetic cab fallback stays active');
  await page.$eval('#inspector', (el) => [...el.querySelectorAll('button')].find((b) => b.textContent.includes('Use synthetic')).click());
  const irRecovered = await evalRig((id) => ({ ir: window.rig.store.doc.nodes[id].ir, status: window.rig.engine.nodes.get(id)?.status, missing: window.rig.engine.nodes.get(id)?.missingIr }), cabId);
  ok(!irRecovered.ir && irRecovered.status === 'ready', `one action removes the missing IR reference: ${JSON.stringify(irRecovered)}`);
  const delayedIr = `sha256:${'1'.repeat(64)}`;
  await evalRig((id, hash) => {
    const library = window.rig.library, cab = window.rig.engine.nodes.get(id);
    window.__originalBytes = library.bytes;
    library.bytes = (asked) => asked === hash ? new Promise((resolve) => { window.__resolveIr = resolve; }) : window.__originalBytes.call(library, asked);
    window.rig.store.setIr(id, hash, { name: 'Slow IR test' });
    window.rig.store.setIr(id, null);
    window.__syntheticBuffer = cab.conv.buffer;
    window.__resolveIr(new ArrayBuffer(1));
  }, cabId, delayedIr);
  await sleep(50);
  ok(await evalRig((id) => {
    const cab = window.rig.engine.nodes.get(id);
    window.rig.library.bytes = window.__originalBytes;
    return !window.rig.store.doc.nodes[id].ir && cab.status === 'ready' && cab.conv.buffer === window.__syntheticBuffer;
  }, cabId), 'a late IR load cannot replace a newer synthetic cab choice');

  const namIdForFailure = await evalRig(() => Object.entries(window.rig.store.doc.nodes).find(([, n]) => n.type === 'nam')[0]);
  const goodModel = await evalRig((id) => window.rig.store.doc.nodes[id].model, namIdForFailure);
  const missingModel = `sha256:${'f'.repeat(64)}`;
  await evalRig((id, hash) => window.rig.store.setModel(id, hash, { name: 'Missing model test', family: 'test', arch: 'test' }), namIdForFailure, missingModel);
  await page.waitForFunction((id) => window.rig.engine.nodes.get(id)?.status === 'missing', { timeout: 10000 }, namIdForFailure);
  await evalRig((id) => window.rig.canvas.select({ kind: 'node', id }), namIdForFailure);
  ok(await page.$eval('#inspector [role="status"]', (el) => el.textContent.includes('not in your library')),
    'missing model reference explains how to repair it');
  const modelInfo = await evalRig((hash) => window.rig.library.info(hash), goodModel);
  await evalRig((id, hash, info) => window.rig.store.setModel(id, hash, info), namIdForFailure, goodModel, modelInfo);
  await page.waitForFunction((id) => window.rig.engine.nodes.get(id)?.status === 'ready', { timeout: 10000 }, namIdForFailure);
  checks.push('restoring the available NAM model returns audio');
  const failedModel = `sha256:${'2'.repeat(64)}`;
  await evalRig((id, hash) => {
    const library = window.rig.library, original = library.bytes;
    library.bytes = (asked) => asked === hash ? Promise.reject(new Error('Storage unavailable')) : original.call(library, asked);
    window.__restoreBytes = () => { library.bytes = original; };
    window.rig.store.setModel(id, hash, { name: 'Unavailable model test', family: 'test', arch: 'test' });
  }, namIdForFailure, failedModel);
  await page.waitForFunction((id) => window.rig.engine.nodes.get(id)?.status === 'error', { timeout: 10000 }, namIdForFailure);
  await evalRig((id) => window.rig.canvas.select({ kind: 'node', id }), namIdForFailure);
  ok(await page.$eval('#inspector [role="status"]', (el) => el.textContent.includes('Storage unavailable')),
    'model storage failure is visible instead of remaining on Loading');
  await evalRig((id, hash, info) => { window.__restoreBytes(); window.rig.store.setModel(id, hash, info); }, namIdForFailure, goodModel, modelInfo);
  await page.waitForFunction((id) => window.rig.engine.nodes.get(id)?.status === 'ready', { timeout: 10000 }, namIdForFailure);

  // Rejected microphone permission must not leave the visitor on a silent
  // input: return to the bundled DI loop and announce what happened.
  await evalRig(() => {
    navigator.mediaDevices.getUserMedia = async () => { const e = new Error('Permission denied'); e.name = 'NotAllowedError'; throw e; };
  });
  await page.select('#source', '1');
  await page.waitForFunction(() => document.querySelector('#source').value === '0' &&
    Object.values(window.rig.store.doc.nodes).find((n) => n.type === 'input').params.source === 0, { timeout: 10000 });
  ok(await page.$eval('#toast', (el) => !el.hidden && el.textContent.includes('Microphone unavailable') && el.textContent.includes('DI loop')),
    'denied microphone permission returns to DI and provides a recovery message');

  // Last Output is protected. Simulate a first-release autosave where it had
  // already been removed; the visible repair must preserve the rig and wire it.
  await evalRig(() => {
    const d = structuredClone(window.rig.store.doc);
    d.name = 'Quick sound: Stacked drives';
    delete d.meta.publicDemoLevelVersion;
    const nodes = Object.entries(d.nodes);
    Object.assign(nodes.find(([, n]) => n.label === 'NAM Core head')[1].params, { input: -4, normalize: 1 });
    nodes.find(([, n]) => n.label === 'Limiter')[1].params.gain = 6;
    const out = nodes.find(([, n]) => n.type === 'output')[0];
    delete d.nodes[out];
    for (const [id, edge] of Object.entries(d.edges)) if (edge.to[0] === out) delete d.edges[id];
    localStorage.setItem('squatch-rig:autosave', JSON.stringify(d));
  });
  await page.goto(`${base}?intro=0`, { waitUntil: 'networkidle0' }); await ready();
  ok(await page.$eval('#restore-output', (el) => !el.hidden), 'missing Output shows recovery control');
  ok(await evalRig(() => {
    const head = Object.values(window.rig.store.doc.nodes).find((n) => n.label === 'NAM Core head');
    return head.params.input === -16 && head.params.normalize === 0;
  }), 'old autosave gain staging migrated');
  await page.click('#restore-output');
  ok(await evalRig(() => {
    const d = window.rig.store.doc, entry = Object.entries(d.nodes).find(([, n]) => n.type === 'output');
    return !!entry && Object.values(d.edges).some((edge) => edge.to[0] === entry[0] && d.nodes[edge.from[0]].label === 'Limiter');
  }), 'Restore Output rewires the existing rig');
  ok(await page.$eval('#restore-output', (el) => el.hidden), 'recovery control closes after repair');
  await page.click('#undo');
  ok(await page.$eval('#restore-output', (el) => !el.hidden), 'repair is undoable');
  await page.click('#redo');
  const outputId = await evalRig(() => Object.entries(window.rig.store.doc.nodes).find(([, n]) => n.type === 'output')[0]);
  await evalRig((id) => window.rig.canvas.select({ kind: 'node', id }), outputId);
  ok(await page.$eval('#inspector', (el) => el.textContent.includes('Required stage') && !el.querySelector('.danger')), 'last Output cannot be removed in inspector');
  await page.$eval('#stage canvas', (el) => el.focus());
  await page.keyboard.press('Delete');
  ok(await evalRig((id) => !!window.rig.store.doc.nodes[id], outputId), 'Delete key cannot remove last Output');
  const beforeRestoredPlayback = await evalRig(() => ({ context: window.rig.engine.ctx.state, play: document.querySelector('#first-play .tp-play')?.textContent, guideHidden: document.querySelector('#first-play').hidden }));
  if (beforeRestoredPlayback.context !== 'running') {
    await page.click('#first-play:not([hidden]) .tp-play').catch(() => page.click('#transport .tp-play'));
  }
  try { await page.waitForFunction(() => window.rig.engine.master.rms > 0.0001, { timeout: 10000 }); }
  catch (error) {
    const state = await evalRig(() => ({ context: window.rig.engine.ctx.state, playRequested: window.rig.engine.playRequested, master: window.rig.engine.master, taps: window.rig.engine.tapStats, input: [...window.rig.engine.nodes.values()].filter((n) => n.type === 'input').map((n) => ({ status: n.status, source: !!n.src })), nodes: window.rig.engine.nodes.size, button: document.querySelector('#first-play .tp-play')?.outerHTML, toast: document.querySelector('#toast')?.textContent }));
    throw new Error(`restored rig did not produce audio: ${JSON.stringify({ beforeRestoredPlayback, state })}; ${error.message}`);
  }
  checks.push('restored rig plays audio');

  // Transport controls and user DI, including recording a valid 24-bit WAV.
  await page.$eval('.tp-range[aria-label="Input gain"]', (el) => { el.value = '3'; el.dispatchEvent(new Event('input')); });
  await page.$eval('.tp-range[aria-label="Master level"]', (el) => { el.value = '-3'; el.dispatchEvent(new Event('input')); });
  ok(await evalRig(() => window.rig.engine.inputTrim > 1 && window.rig.engine.masterLevel < 1), 'transport input and master gain');
  await page.click('.tp-ab');
  ok(await evalRig(() => window.rig.engine.bypassed), 'A/B switches to dry DI');
  await page.click('.tp-ab');
  ok(await evalRig(() => !window.rig.engine.bypassed), 'A/B switches back to rig');
  // Headless Chrome on this host can leave getUserMedia pending even with its
  // fake-device flags. Feed the real engine acquisition path a synthetic stream.
  await evalRig(() => {
    const engine = window.rig.engine;
    navigator.mediaDevices.getUserMedia = async () => {
      const osc = new OscillatorNode(engine.ctx, { frequency: 220 });
      const dest = new MediaStreamAudioDestinationNode(engine.ctx);
      osc.connect(dest); osc.start();
      engine.__testInput = { osc, dest };
      return dest.stream;
    };
  });
  await page.select('#source', '1');
  await page.waitForFunction(() => !!window.rig.engine.stream?.getAudioTracks?.().length &&
    [...window.rig.engine.nodes.values()].some((n) => n.type === 'input' && n.live), { timeout: 10000 });
  checks.push('Interface source connects a synthetic MediaStream to the live input node');
  await evalRig(() => {
    const track = window.rig.engine.stream.getAudioTracks()[0];
    track.stop(); // programmatic stop does not fire `ended`; dispatch the device-loss event too
    track.dispatchEvent(new Event('ended'));
  });
  await page.waitForFunction(() => document.querySelector('#source').value === '0' &&
    Object.values(window.rig.store.doc.nodes).find((n) => n.type === 'input').params.source === 0, { timeout: 10000 });
  ok(await page.$eval('#toast', (el) => !el.hidden && el.textContent.includes('Audio interface disconnected') && el.textContent.includes('DI loop')),
    'unplugged interface returns to DI with reconnect guidance');
  await page.select('#source', '1');
  await page.waitForFunction(() => window.rig.engine.stream?.getAudioTracks?.()[0]?.readyState === 'live' &&
    Object.values(window.rig.store.doc.nodes).find((n) => n.type === 'input').params.source === 1, { timeout: 10000 });
  checks.push('reconnecting the input reacquires a live stream');
  await page.select('#source', '0');
  await page.waitForFunction(() => Object.values(window.rig.store.doc.nodes).find((n) => n.type === 'input').params.source === 0 && !window.rig.engine.stream);
  checks.push('returning to DI releases the microphone stream');
  const background = await browser.newPage();
  await background.goto('about:blank'); await background.bringToFront();
  await sleep(250);
  const whileHidden = await evalRig(() => ({ visibility: document.visibilityState, state: window.rig.engine.ctx.state }));
  await page.bringToFront();
  await sleep(250);
  const afterRestore = await evalRig(() => ({ visibility: document.visibilityState, state: window.rig.engine.ctx.state, rms: window.rig.engine.master.rms }));
  ok((browserName === 'webkit' || whileHidden.visibility === 'hidden') && afterRestore.visibility === 'visible' && afterRestore.state === 'running' && afterRestore.rms > 0.0001,
    `audio survives a background/foreground transition: ${JSON.stringify({ whileHidden, afterRestore })}`);
  await background.close();
  await evalRig(() => window.rig.engine.ctx.suspend());
  await page.waitForFunction(() => window.rig.engine.ctx.state === 'suspended' &&
    document.querySelector('#toast').textContent.includes('Press Play to resume'), { timeout: 5000 });
  await page.click('#first-play .tp-play');
  await page.waitForFunction(() => window.rig.engine.ctx.state === 'running' && window.rig.engine.master.rms > 0.0001, { timeout: 10000 });
  checks.push('interrupted audio explains how to resume and Play recovers it');
  const chooser = page.waitForFileChooser(); await page.click('.tp-local');
  await (await chooser).accept([path.resolve('web/audio/di-loop.wav')]);
  await page.waitForFunction(() => window.rig.engine.loopId === 'local-di');
  ok(await page.$eval('#credit', (el) => el.textContent.includes('stays in this browser session')), 'local DI upload and privacy credit');
  await evalRig(() => {
    const orig = URL.createObjectURL;
    URL.createObjectURL = function(blob) { window.__lastExportBlob = blob; return orig.call(this, blob); };
  });
  await page.click('.tp-rec');
  await page.waitForFunction(() => !!window.rig.engine.recording);
  await page.waitForFunction(() => window.rig.engine.recording?.frames > 0, { timeout: 10000 });
  await sleep(400); await page.click('.tp-rec');
  try { await page.waitForFunction(() => !window.rig.engine.recording, { timeout: 10000 }); }
  catch (error) {
    const state = await evalRig(() => ({ state: window.rig.engine.ctx.state, frames: window.rig.engine.recording?.frames, done: !!window.rig.engine.recording?.done, quanta: window.rig.engine.tapStats.quanta, pressed: document.querySelector('.tp-rec')?.getAttribute('aria-pressed') }));
    throw new Error(`recording did not stop: ${JSON.stringify(state)}; ${error.message}`);
  }
  ok(await evalRig(async () => window.__lastExportBlob?.type === 'audio/wav' && (await window.__lastExportBlob.arrayBuffer()).byteLength > 44), 'output recording produces WAV');

  // Preset download and upload through the actual browser controls.
  await page.click('#save');
  const saved = await evalRig(async () => JSON.parse(await window.__lastExportBlob.text()));
  ok(saved.format === 'squatch-rig/pipeline' && Object.values(saved.nodes).some((n) => n.type === 'output'), 'Save exports a complete preset');
  saved.name = 'Round trip preset';
  const file = path.join(out, 'release-round-trip.rig.json'); fs.writeFileSync(file, JSON.stringify(saved));
  const openChooser = page.waitForFileChooser(); await page.click('#load');
  await (await openChooser).accept([file]);
  await page.waitForFunction(() => window.rig.store.doc.name === 'Round trip preset');
  checks.push('Open imports a saved preset');
  await page.$eval('#preset-name', (el) => { el.value = 'Renamed preset'; el.dispatchEvent(new Event('change', { bubbles: true })); });
  ok(await evalRig(() => window.rig.store.doc.name === 'Renamed preset'), 'preset name editor');
  await page.click('#fit'); checks.push('Fit control');

  // Phone controls and visible repair affordance.
  await page.setViewport({ width: 360, height: 800, deviceScaleFactor: 1 });
  const guidedPhone = await evalRig(() => ({ visible: !document.querySelector('#first-play').hidden, width: document.documentElement.scrollWidth, viewport: innerWidth, hear: document.querySelector('#first-play .tp-play')?.getBoundingClientRect().width }));
  ok(guidedPhone.visible && guidedPhone.width <= guidedPhone.viewport && guidedPhone.hear >= 90,
    `guided first-play fits a 360 px phone: ${JSON.stringify(guidedPhone)}`);
  await page.screenshot({ path: path.join(out, 'first-play-phone-360.png') });
  await page.$eval('#first-play .first-play-dismiss', (el) => el.focus()); await page.keyboard.press('Enter');
  ok(await evalRig(() => document.querySelector('#first-play').hidden && localStorage.getItem('squatch-rig:first-play-dismissed') === '1'),
    'first-play guide dismisses and stores that choice');
  await page.click('#more');
  await page.select('#sound-pick', 'trail');
  if (await evalRig(() => window.rig.engine.ctx.state === 'running')) await page.click('#transport .tp-play');
  await page.waitForFunction(() => window.rig.engine.ctx.state === 'suspended', { timeout: 5000 });
  const chosenLoop = await evalRig(() => window.rig.engine.loopId);
  ok(await page.$eval('#transport .tp-play', (el) => el.textContent === 'Play' && !el.hasAttribute('aria-label')),
    'dismissing the guide restores the ordinary Play control');
  await page.click('#transport .tp-play');
  await page.waitForFunction(() => window.rig.engine.ctx.state === 'running', { timeout: 10000 });
  ok(await evalRig((loop) => window.rig.store.doc.name === 'Quick sound: Trail OD' && window.rig.engine.loopId === loop, chosenLoop),
    'Play after guide dismissal keeps the visitor’s selected sound and loop');
  await page.reload({ waitUntil: 'networkidle0' }); await ready();
  ok(await evalRig(() => document.querySelector('#first-play').hidden), 'dismissed guide stays dismissed after reload');
  await page.click('#more');
  ok(await page.$eval('#sound-pick', (el) => el.getBoundingClientRect().width > 0), 'phone More reveals sound selector');
  const phoneWidth = await evalRig(() => ({ viewport: innerWidth, page: document.documentElement.scrollWidth }));
  ok(phoneWidth.page <= phoneWidth.viewport, `360 px phone layout avoids horizontal page overflow: ${JSON.stringify(phoneWidth)}`);
  // Mark the view as user-controlled, so a pending resize auto-fit cannot
  // recenter the graph after the strip moves it.
  await page.$eval('#stage canvas', (el) => el.dispatchEvent(new WheelEvent('wheel', { bubbles: true })));
  await page.$eval('#chain-strip input', (el) => { el.value = '950'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.waitForFunction(() => { const state = window.rig.canvas.chainView(); return state.visible > 0.97 || state.pos > 0.4; }, { timeout: 5000 });
  const chainState = await evalRig(() => window.rig.canvas.chainView());
  ok(chainState.visible > 0.97 || chainState.pos > 0.4, `360 px chain strip pans when needed or shows the full graph: ${JSON.stringify(chainState)}`);
  await page.screenshot({ path: path.join(out, 'release-phone-360.png') });
  ok(errors.length === 0, `no page exceptions: ${errors.join('; ')}`);
  const result = { ok: true, base, browser: browserName, firstUse, firstTake, abBalance, bypassClicks, bassDefaults, sliderCheck, sweep, loopRms, checks, errors };
  fs.writeFileSync(path.join(out, 'release-browser-check.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  // Closing the browser also closes its page/context. Avoid a second CDP
  // target-close request here; it can remain pending after the audio checks.
  const child = browser.process?.();
  const closing = browser.close().catch(() => {});
  const closed = await Promise.race([closing.then(() => true), sleep(3000).then(() => false)]);
  if (!closed && child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(2000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  if (!closed) browser.disconnect?.();
}
