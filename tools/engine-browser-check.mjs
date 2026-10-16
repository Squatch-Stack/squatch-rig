#!/usr/bin/env node
// Real-browser proof that the experimental engine is opt-in: a default page load never requests nam-experimental.wasm,
// selecting Experimental (URL or picker) loads it and not the standard one, and the choice is remembered.
//
//   node tools/engine-browser-check.mjs [BASE_URL]     (a server on BASE_URL; default http://127.0.0.1:7561)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import puppeteer from 'puppeteer-core';

const base = process.argv[2] || 'http://127.0.0.1:7561';
const cache = path.join(os.homedir(), '.cache/puppeteer/chrome');
const builds = fs.existsSync(cache) ? fs.readdirSync(cache).sort().reverse() : [];
const chrome = process.env.CHROME || builds.map((v) => path.join(cache, v, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')).find((c) => fs.existsSync(c)) || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--mute-audio'], defaultViewport: { width: 1440, height: 900 } });
const check = (c, m) => { if (!c) throw new Error(m); };
async function load(url, { fresh = true, act } = {}) {
  const ctx = fresh ? await browser.createBrowserContext() : browser.defaultBrowserContext();
  const page = await ctx.newPage();
  const wasm = [];
  page.on('request', (r) => { if (/\.wasm(\?|$)/.test(r.url())) wasm.push(path.basename(new URL(r.url()).pathname)); });
  await page.goto(url, { waitUntil: 'networkidle0' });
  await page.waitForSelector('body[data-ready="1"]', { timeout: 30000 });
  if (act) await act(page, wasm);
  const out = { wasm: [...wasm], picker: await page.$eval('#engine-pick', (s) => s.value) };
  await page.close(); if (fresh) await ctx.close();
  return out;
}
try {
  const a = await load(`${base}/?demo&intro=0`);
  console.log('default load  ', JSON.stringify(a));
  check(a.wasm.length >= 1 && a.wasm.every((n) => n === 'nam.wasm'), `default load fetched ${a.wasm}`);
  check(a.picker === 'standard', 'picker is not on Standard by default');
  const b = await load(`${base}/?demo&intro=0&engine=experimental`);
  console.log('?engine=exp   ', JSON.stringify(b));
  check(b.wasm.length >= 1 && b.wasm.every((n) => n === 'nam-experimental.wasm'), `experimental load fetched ${b.wasm}`);
  check(b.picker === 'experimental', 'picker is not on Experimental');
  // The picker: choose Experimental, the page reloads on that engine, and it is remembered on the next visit.
  const c = await load(`${base}/?demo&intro=0`, { act: async (page, wasm) => {
    await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.select('#engine-pick', 'experimental')]);
    await page.waitForSelector('body[data-ready="1"]', { timeout: 30000 });
    wasm.length = 0;
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForSelector('body[data-ready="1"]', { timeout: 30000 });
  } });
  console.log('picker, reload', JSON.stringify(c));
  check(c.wasm.length >= 1 && c.wasm.every((n) => n === 'nam-experimental.wasm') && c.picker === 'experimental', 'picker choice did not stick');
  console.log('engine-browser-check ok');
} finally { await browser.close(); }
