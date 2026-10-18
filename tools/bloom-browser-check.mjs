// End-to-end Bloom check: real browser canvas + AudioWorklet vs the offline
// Node renderer on one identical pipeline and DI loop.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { render } from './render.mjs';
import { validateDoc } from '../web/js/graph/doc.js';

const base = process.argv[2] || 'http://127.0.0.1:7491';
const doc = validateDoc(JSON.parse(fs.readFileSync(new URL('../presets/bloom.rig.json', import.meta.url))));
const cache = path.join(os.homedir(), '.cache/puppeteer/chrome');
const versions = fs.existsSync(cache) ? fs.readdirSync(cache).sort().reverse() : [];
const chrome = process.env.CHROME || versions.map(v => path.join(cache, v, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')).find(fs.existsSync) || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await puppeteer.launch({ executablePath: chrome, headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
  defaultViewport: { width: 1680, height: 940, deviceScaleFactor: 1 } });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${base}/?demo&intro=0`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('body[data-ready="1"]', { timeout: 30000 });
  const result = await page.evaluate(async doc => {
    window.rig.store.load(doc);
    window.rig.canvas.fit();
    await window.rig.engine.whenModelsLoaded();
    const bloom = window.rig.engine.nodes.get('bloom_custom');
    const visible = window.rig.canvas.views.has('bloom_custom');
    const art = Boolean(window.rig.canvas.skin.art?.bloom);
    const controls = window.rig.canvas.views.get('bloom_custom')?.knobs.map(q => q.key) || [];
    const { Engine } = await import('/js/audio/engine.js');
    const context = new OfflineAudioContext(2, 48000, 48000);
    const engine = await new Engine(window.rig.library).init({ context, loop: 'picked-riff' });
    engine.sync(doc);
    await engine.whenModelsLoaded();
    const audio = await context.startRendering();
    return { visible, art, controls, worklet: Boolean(bloom?.proc),
      channels: [Array.from(audio.getChannelData(0)), Array.from(audio.getChannelData(1))] };
  }, doc);
  await page.screenshot({ path: new URL('../docs/screens/bloom-ui.png', import.meta.url).pathname, fullPage: true });
  const native = render({ doc, loop: 'picked-riff', seconds: 1, preroll: 0 }).channels;
  let maxAbs = 0, error = 0, signal = 0;
  for (let c = 0; c < 2; c++) for (let i = 0; i < 48000; i++) {
    const d = result.channels[c][i] - native[c][i];
    maxAbs = Math.max(maxAbs, Math.abs(d)); error += d * d; signal += native[c][i] ** 2;
  }
  const report = { visible: result.visible, art: result.art, controls: result.controls, worklet: result.worklet,
    maxAbsDiff: maxAbs, errorToSignalDb: 10 * Math.log10(error / signal), pageErrors: errors };
  console.log(JSON.stringify(report));
  if (!report.visible || !report.art || !report.worklet ||
      ['warmth', 'bloom', 'touch', 'level'].some(k => !report.controls.includes(k)) ||
      errors.length || maxAbs > 0.002) process.exitCode = 1;
} finally { await browser.close(); }
