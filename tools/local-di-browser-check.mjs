// E2E: load a real user-selected DI WAV through the transport and play the rig.
// Usage: node tools/local-di-browser-check.mjs path/to/take.wav [base URL]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import puppeteer from 'puppeteer-core';

const wav = path.resolve(process.argv[2] || '');
if (!fs.existsSync(wav)) throw new Error('pass an existing DI WAV');
const base = process.argv[3] || 'http://127.0.0.1:7491';
const cache = path.join(os.homedir(), '.cache/puppeteer/chrome');
const builds = fs.existsSync(cache) ? fs.readdirSync(cache).sort().reverse() : [];
const chrome = builds.map((v) => path.join(cache, v, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'))
  .find((p) => fs.existsSync(p)) || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await puppeteer.launch({ executablePath: chrome, headless: true,
  args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
  defaultViewport: { width: 1500, height: 900 } });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/?demo&theme=dark&intro=0`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('body[data-ready="1"]', { timeout: 30000 });
  const chooser = page.waitForFileChooser();
  await page.click('.tp-local');
  await (await chooser).accept([wav]);
  try {
    await page.waitForFunction(() => window.rig.engine.loopId === 'local-di', { timeout: 15000 });
  } catch (error) {
    const debug = await page.evaluate(() => ({ toast: document.querySelector('#toast')?.textContent,
      fileCount: document.querySelector('input[aria-label="Choose a local DI WAV"]')?.files?.length,
      loop: window.rig.engine.loopId }));
    throw new Error(`DI import failed: ${JSON.stringify({ debug, errors, error: error.message })}`);
  }
  const before = await page.evaluate(() => window.rig.engine.ctx.state);
  if (before !== 'running') await page.click('.tp-play');
  try {
    await page.waitForFunction(() => window.rig.engine.ctx.state === 'running', { timeout: 5000 });
  } catch (error) {
    const debug = await page.evaluate(() => ({ state: window.rig.engine.ctx.state,
      play: document.querySelector('.tp-play')?.textContent,
      playRequested: window.rig.engine.playRequested,
      ready: window.rig.engine.ready,
      toast: document.querySelector('#toast')?.textContent }));
    throw new Error(`DI playback failed: ${JSON.stringify({ before, debug, errors, error: error.message })}`);
  }
  await new Promise((r) => setTimeout(r, 1200));
  const state = await page.evaluate(() => ({
    loop: window.rig.engine.loopId,
    option: document.querySelector('.tp-loop').value,
    duration: window.rig.engine.diBuffer.duration,
    rate: window.rig.engine.diBuffer.sampleRate,
    credit: document.querySelector('#credit').textContent,
    running: window.rig.engine.ctx.state === 'running',
  }));
  await page.screenshot({ path: path.join(path.dirname(wav), 'local-di-rig.png') });
  if (errors.length || state.loop !== 'local-di' || state.option !== 'local-di' ||
      !state.credit.includes('stays in this browser session') || !state.running || state.duration < 1) {
    throw new Error(JSON.stringify({ state, errors }));
  }
  console.log(JSON.stringify({ state, errors }));
} finally {
  await browser.close();
}
