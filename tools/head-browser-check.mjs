#!/usr/bin/env node
// Record the shipped Chord Stabs loop through just NAM Core (optionally cab)
// in a real AudioWorklet graph. This catches a gain failure that DSP unit
// tests and full-rig limiter checks can hide.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { webkit } from 'playwright';

const args = process.argv.slice(2);
const browserName = args.find((arg) => arg.startsWith('--browser='))?.split('=')[1] || 'chromium';
const base = (args.find((arg) => !arg.startsWith('--')) || 'http://127.0.0.1:7492/public-demo/').replace(/\/?$/, '/');
const cache = path.join(os.homedir(), '.cache/puppeteer/chrome');
const versions = fs.existsSync(cache) ? fs.readdirSync(cache).sort().reverse() : [];
const chrome = process.env.CHROME || versions.map((v) => path.join(cache, v, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')).find(fs.existsSync);
if (!chrome) throw new Error('Chrome for Testing is missing');
let browser, page;
if (browserName === 'webkit') {
  browser = await webkit.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  page = await context.newPage();
  const nativeWait = page.waitForFunction.bind(page);
  page.waitForFunction = (fn, optionsOrArg, ...rest) => {
    const isOptions = optionsOrArg && typeof optionsOrArg === 'object' && ('timeout' in optionsOrArg || 'polling' in optionsOrArg);
    const values = isOptions ? rest : [optionsOrArg];
    return nativeWait(({ source, args }) => (0, eval)(`(${source})`)(...args), { source: fn.toString(), args: values.filter((v) => v !== undefined) }, isOptions ? optionsOrArg : {});
  };
} else if (browserName === 'chromium') {
  browser = await puppeteer.launch({ executablePath: chrome, headless: true,
    args: ['--disable-audio-output', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
  page = await browser.newPage();
} else throw new Error(`Unsupported browser: ${browserName}`);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
try {
  await page.goto(`${base}?demo&intro=0`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('body[data-ready="1"]', { timeout: 30000 });
  const audioRate = await page.evaluate(() => window.rig.engine.ctx.sampleRate);
  if (audioRate !== 48000) throw new Error(`NAM AudioContext must run at the model's 48000 Hz rate, got ${audioRate}`);
  await page.click('.tp-play');
  await page.waitForFunction(() => window.rig.engine.ctx.state === 'running' && window.rig.engine.nodes.size > 0);
  const original = await page.evaluate(() => structuredClone(window.rig.store.doc));
  const result = [];
  for (const withCab of [false, true]) for (const withLimiter of [false, true]) {
    const r = await page.evaluate(async ({ cab, limiter, originalDoc }) => {
      const { store, engine } = window.rig;
      const doc = structuredClone(originalDoc);
      for (const [id, node] of Object.entries(doc.nodes)) {
        if (!['input', 'nam', 'output', ...(cab ? ['cab'] : []), 'limiter'].includes(node.type)) delete doc.nodes[id];
      }
      const limiterNode = Object.values(doc.nodes).find((node) => node.type === 'limiter');
      limiterNode.bypass = !limiter;
      const ids = Object.entries(doc.nodes);
      doc.edges = {};
      for (let i = 1; i < ids.length; i++) doc.edges[`e${i}`] = { from: [ids[i - 1][0], 0], to: [ids[i][0], 0] };
      store.load(doc);
      await engine.whenModelsLoaded();
      await engine.suspend();
      await engine.setLoop('chord-stabs');
      engine.startRecording();
      await engine.resume();
      await new Promise((resolve) => setTimeout(resolve, 2400));
      const blob = await engine.stopRecording();
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const sr = engine.ctx.sampleRate, channels = 2, start = 44;
      const frames = Math.floor((bytes.length - start) / (3 * channels));
      let peak = 0, quiet = Infinity, quietAt = -1;
      const windowFrames = Math.round(sr * 0.05);
      // Stabs repeat with variable spacing, so find the quietest 50 ms window
      // across the full take instead of sampling an arbitrary time range.
      for (let at = 0; at + windowFrames < frames; at += windowFrames) {
        let power = 0;
        for (let i = at; i < at + windowFrames; i++) {
          const p = start + i * 6;
          let v = bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16);
          if (v & 0x800000) v -= 0x1000000;
          const x = v / 8388608;
          power += x * x;
        }
        const rms = Math.sqrt(power / windowFrames);
        if (rms < quiet) { quiet = rms; quietAt = at / sr; }
      }
      for (let i = 0; i < frames; i++) {
        const p = start + i * 6;
        let v = bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16);
        if (v & 0x800000) v -= 0x1000000;
        peak = Math.max(peak, Math.abs(v / 8388608));
      }
      return { withCab: cab, withLimiter: limiter, frames, peakDb: 20 * Math.log10(peak), quietDb: 20 * Math.log10(quiet), quietAt, modelReady: [...engine.nodes.values()].some((n) => n.type === 'nam' && n.status === 'ready') };
    }, { cab: withCab, limiter: withLimiter, originalDoc: original });
    if (!r.modelReady || r.frames < 2.2 * 48000 || r.peakDb > -0.2 || r.quietDb > -50) throw new Error(`isolated head audio failed: ${JSON.stringify(r)}`);
    result.push(r);
  }
  if (errors.length) throw new Error(errors.join('; '));
  console.log(JSON.stringify({ ok: true, base, browser: browserName, sampleRate: audioRate, result, errors }));
} finally {
  // Browser shutdown closes the page/context as well; a separate page close
  // can hang after an AudioWorklet recording on some Chromium builds.
  await browser.close().catch(() => {});
}
