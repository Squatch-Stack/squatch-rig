#!/usr/bin/env node
// End-to-end check of the visible sound, view and pedal controls in Chromium.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import puppeteer from 'puppeteer-core';

const base = process.argv[2] || 'http://127.0.0.1:7491';
const cache = path.join(os.homedir(), '.cache/puppeteer/chrome');
const builds = fs.existsSync(cache) ? fs.readdirSync(cache).sort().reverse() : [];
const chrome = process.env.CHROME || builds.map((version) => path.join(cache, version, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'))
  .find((candidate) => fs.existsSync(candidate)) || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const output = path.resolve('tests/out');
fs.mkdirSync(output, { recursive: true });
const browser = await puppeteer.launch({ executablePath: chrome, headless: true,
  args: ['--mute-audio', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
  defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 } });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

const check = (condition, message) => { if (!condition) throw new Error(message); };
try {
  await page.goto(`${base}/?demo&intro=0`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('body[data-ready="1"]', { timeout: 30000 });
  check(await page.$eval('.support-link', (link) => link.href === 'https://github.com/sponsors/Squatch-Stack'), 'support link is wrong');
  const options = await page.$$eval('#pedal-pick option', (items) => items.map((item) => item.value));
  check(['gate', 'compressor', 'overdrive', 'bloom', 'envfilter', 'reverb', 'limiter'].every((value) => options.includes(value)), 'pedal selector is incomplete');

  await page.select('#theme-pick', 'light');
  check(await page.evaluate(() => document.documentElement.dataset.theme === 'light'), 'light theme did not apply');
  await page.select('#skin-pick', 'ink');
  await page.waitForFunction(() => window.rig.canvas.skin.name === 'ink');
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector('body[data-ready="1"]');
  check(await page.evaluate(() => document.documentElement.dataset.theme === 'light' && window.rig.canvas.skin.name === 'ink'), 'view choices did not persist');
  await page.select('#skin-pick', 'brush-ink');
  await page.waitForFunction(() => window.rig.canvas.skin.name === 'brush-ink');

  await page.select('#sound-pick', 'bloom');
  check(await page.evaluate(() => window.rig.store.doc.name.includes('Bloom') && Object.values(window.rig.store.doc.nodes).some((node) => node.type === 'bloom' && !node.bypass)), 'Bloom quick sound did not load');
  const alreadyRunning = await page.evaluate(() => window.rig.engine.ctx?.state === 'running');
  if (!alreadyRunning) await page.click('.tp-play');
  try {
    await page.waitForFunction(() => window.rig.engine.ctx?.state === 'running', { timeout: 8000 });
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({ state: window.rig.engine.ctx?.state, ready: window.rig.engine.ready, button: document.querySelector('.tp-play')?.textContent, toast: document.querySelector('#toast')?.textContent }));
    throw new Error(`Play did not start: ${JSON.stringify(diagnostic)}; page errors: ${errors.join('; ')}`, { cause: error });
  }
  await page.waitForFunction(() => window.rig.engine.master?.rms > 0.0001, { timeout: 20000 });
  const bloomRms = await page.evaluate(() => window.rig.engine.master.rms);
  await page.screenshot({ path: path.join(output, 'picker-desktop.png') });
  await page.select('#theme-pick', 'dark');
  check(await page.evaluate(() => document.documentElement.dataset.theme === 'dark'), 'dark theme did not apply');
  await page.screenshot({ path: path.join(output, 'picker-desktop-dark.png') });
  await page.select('#theme-pick', 'light');

  const before = await page.evaluate(() => Object.keys(window.rig.store.doc.nodes).length);
  await page.select('#pedal-pick', 'reverb');
  const added = await page.evaluate(() => ({ count: Object.keys(window.rig.store.doc.nodes).length, selected: window.rig.canvas.selected?.id, value: document.querySelector('#pedal-pick').value }));
  check(added.count === before + 1 && added.selected && added.value === '', 'pedal picker did not add and select a device');
  await page.click('#undo');
  check(await page.evaluate((n) => Object.keys(window.rig.store.doc.nodes).length === n, before), 'undo did not remove the pedal');

  await page.select('#sound-pick', 'hall');
  check(await page.evaluate(() => window.rig.store.doc.name.includes('Hall')), 'Hall quick sound did not load');
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  await page.click('#more');
  check(await page.$eval('.support-link', (link) => link.getBoundingClientRect().width > 0), 'support link is hidden on phone');
  check(await page.$eval('#sound-pick', (el) => el.getBoundingClientRect().width > 0), 'sound picker is hidden on phone with More open');
  check(await page.$eval('#theme-pick', (el) => el.getBoundingClientRect().width > 0), 'theme picker is hidden on phone with More open');
  await page.screenshot({ path: path.join(output, 'picker-phone.png') });
  check(errors.length === 0, `page errors: ${errors.join('; ')}`);
  console.log(JSON.stringify({ ok: true, pedalOptions: options, bloomRms, screenshots: ['picker-desktop.png', 'picker-desktop-dark.png', 'picker-phone.png'] }));
} finally {
  await browser.close();
}
