// Headless-Chrome check of milestone 1 of the theme-support plan: with ?skin=cc.squatch.skin.brush the
// Trail OD is drawn from the vendored Brush skin package, at the layout's millimetre positions, coloured
// from --sq-comp-* after the skin's overrides, with its knobs driven by the contract; and with no
// ?skin the rig renders pixel for pixel as it did before skin packages existed.
//
// It starts its own servers from cold: this tree, and a baseline commit (SKIN_CHECK_BASELINE, default
// the last commit before skin packages) extracted with `git archive`. Every measurement is read from
// what Chrome actually drew (screenshots), not from the renderer's own idea of where things went:
//   1  the page's validateSkin result has no errors           2  8 files verified against "files"
//   3  every drawn art file is the package's file with only var(--sq-*, #hex) replaced, by values
//      this tool resolves itself from the vendored tokens (0 bytes differ)
//   4  each knob's centre and diameter, measured from the drawn cap outline, against the on-disk
//      layout x the face scale (<= 0.5 CSS px), in both modes
//   5  the knobs' ranges and readout come from the contract (Drive 0..1 default 0.5, Level -30..12
//      default -6, "Drive 5.0" at 0.5)
//   6  a real drag takes Level to the middle of its travel: -9 dB within 1 dB, and the pointer drawn
//      at -travel/2 + travel x n within 1 degree (measured from the pixels)
//   7  the footswitch bypasses: lamp drawn in --sq-comp-led-off, nameplate says "bypassed"
//   8  both modes: the faceplate colours differ between them and nothing is left unresolved; face,
//      knob cap and lamp pixels match their tokens
//   9  every other device keeps its brush-ink art; while the skin rig plays for 30 s the canvas keeps
//      the rig's own frame budget (p95 JS <= 1.0 ms, p95 submit <= 1.8 ms) and underruns stay within
//      live-check's allowance
//   10 no ?skin, dark and light: the screenshot equals the baseline's, 0 pixels differ
// The process exits 1 unless every assertion held (tools/check-gate.mjs).
//
// usage: node tools/skin-check.mjs        (PORT base: SKIN_CHECK_PORT, default 7497; CHROME as browser-check)
// Negative controls, each must exit 1:
//   SKIN_CHECK_SABOTAGE=layout   serves skin.json with controls.drive.x moved 1.5 mm (check 4 fails)
//   SKIN_CHECK_SABOTAGE=theme    serves squatch-ink tokens without component.knob.cap (the package is
//                                refused, so checks 1, 3, 4 and 5 fail)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { gate } from './check-gate.mjs';
import { loadPackage, layoutFor, faceGeometry, skinTokens, substitute, pointerDegrees } from '../web/js/ui/skin-package.js';
import { toNormalized } from '../web/vendor/squatch-skin/lib/contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'tests/out/skin');
fs.mkdirSync(out, { recursive: true });
const SABOTAGE = process.env.SKIN_CHECK_SABOTAGE || '';
const BASELINE = process.env.SKIN_CHECK_BASELINE || 'a07aecc'; // the last commit before skin packages
const PORT = +(process.env.SKIN_CHECK_PORT || 7497);
const ID = 'cc.squatch.skin.brush';
const LABEL = 'Trail Drive'; // the demo's first Trail OD
const ZOOM = 2.6;
const DPR = 2;
const PLAY_SECONDS = 30;

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

// ---------------------------------------------------------------- what the package should look like, resolved here
const reader = (dir) => async (rel) => new Uint8Array(fs.readFileSync(path.join(dir, rel)));
const disk = await loadPackage(ID, {
  readVendor: reader(path.join(root, 'web/vendor/squatch-skin')), readPackage: reader(path.join(root, 'design/skins/brush')),
  sha256: async (b) => new Uint8Array(crypto.createHash('sha256').update(b).digest()),
});
if (!disk.ok) throw new Error(`the vendored package is refused on disk: ${disk.errors.join('; ')}`);
const product = disk.products.get('cc.squatch.trail-od');
const LAYOUT = layoutFor(disk.manifest, product);
const ART = { faceplate: disk.manifest.art.faceplate, knob: disk.manifest.art.knob.body, pointer: disk.manifest.art.knob.pointer, footswitch: disk.manifest.art.footswitch, ledOn: disk.manifest.art.led.on, ledOff: disk.manifest.art.led.off };
const TOK = { dark: skinTokens(disk.theme, disk.manifest, 'dark'), light: skinTokens(disk.theme, disk.manifest, 'light') };
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const levelP = product.params.find((p) => p.key === 'level');

// ---------------------------------------------------------------- servers: this tree, and the baseline
const servers = [];
async function serve(dir, port) {
  const p = spawn(process.execPath, [path.join(dir, 'server.mjs')], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' }, stdio: 'ignore' });
  servers.push(p);
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${url}/`)).ok) return url; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server in ${dir} did not start on ${port}`);
}
function extractBaseline(ref) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-baseline-'));
  const tar = execFileSync('git', ['archive', '--format=tar', ref, 'server.mjs', 'web', 'design'], { cwd: root, maxBuffer: 1 << 30 });
  execFileSync('tar', ['-x', '-C', dir], { input: tar });
  // amp models are never in git; the baseline renders the same models from this tree
  for (const f of fs.readdirSync(path.join(root, 'web/models'))) {
    const to = path.join(dir, 'web/models', f);
    if (!fs.existsSync(to)) fs.symlinkSync(path.join(root, 'web/models', f), to);
  }
  return dir;
}

// ---------------------------------------------------------------- page-side helpers (pixels from a screenshot)
function installHelpers() {
  const S = (window.__sk = { shots: {} });
  S.load = async (name, b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = new OffscreenCanvas(img.width, img.height), ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    S.shots[name] = ctx.getImageData(0, 0, img.width, img.height);
    return [img.width, img.height];
  };
  const at = (im, x, y) => { const i = (Math.round(y) * im.width + Math.round(x)) * 4; return [im.data[i], im.data[i + 1], im.data[i + 2]]; };
  S.px = (name, x, y) => { // x, y in device px; a pixel's centre is at +0.5
    x -= 0.5; y -= 0.5;
    const im = S.shots[name], x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const a = at(im, x0, y0), b = at(im, x0 + 1, y0), c = at(im, x0, y0 + 1), d = at(im, x0 + 1, y0 + 1);
    return a.map((_, k) => a[k] * (1 - fx) * (1 - fy) + b[k] * fx * (1 - fy) + c[k] * (1 - fx) * fy + d[k] * fx * fy);
  };
  S.median = (name, x0, y0, x1, y1) => {
    const ch = [[], [], []];
    for (let y = Math.round(y0); y <= y1; y++) for (let x = Math.round(x0); x <= x1; x++) at(S.shots[name], x, y).forEach((v, k) => ch[k].push(v));
    return ch.map((c) => c.sort((p, q) => p - q)[c.length >> 1]);
  };
  // march along a ray (0 deg = up, clockwise) from r0 to r1; the radius where the colour is first half way from `from` to `to`
  S.edge = (name, cx, cy, deg, r0, r1, from, to) => {
    const ux = Math.sin((deg * Math.PI) / 180), uy = -Math.cos((deg * Math.PI) / 180);
    const den = to.reduce((s, v, k) => s + (v - from[k]) ** 2, 0);
    const t = (c) => c.reduce((s, v, k) => s + (v - from[k]) * (to[k] - from[k]), 0) / den;
    let prev = null;
    for (let r = r0; r >= r1; r -= 0.2) {
      const v = t(S.px(name, cx + ux * r, cy + uy * r));
      if (v >= 0.5) {
        const rr = prev == null ? r : r + 0.2 * ((v - 0.5) / (v - prev));
        return { x: cx + ux * rr, y: cy + uy * rr, r: rr };
      }
      prev = v;
    }
    return null;
  };
  S.circle = (p, q, s) => {
    const d = 2 * (p.x * (q.y - s.y) + q.x * (s.y - p.y) + s.x * (p.y - q.y));
    const x = ((p.x ** 2 + p.y ** 2) * (q.y - s.y) + (q.x ** 2 + q.y ** 2) * (s.y - p.y) + (s.x ** 2 + s.y ** 2) * (p.y - q.y)) / d;
    const y = ((p.x ** 2 + p.y ** 2) * (s.x - q.x) + (q.x ** 2 + q.y ** 2) * (p.x - s.x) + (s.x ** 2 + s.y ** 2) * (q.x - p.x)) / d;
    return { x, y, r: Math.hypot(p.x - x, p.y - y) };
  };
  // where a pointer of colour `to` sits on a cap of colour `from`: the weighted circular mean on a ring
  S.angle = (name, cx, cy, r, from, to) => {
    const den = to.reduce((s, v, k) => s + (v - from[k]) ** 2, 0);
    let sx = 0, sy = 0;
    for (let i = 0; i < 1440; i++) {
      const a = (i / 1440) * 2 * Math.PI, c = S.px(name, cx + Math.sin(a) * r, cy - Math.cos(a) * r);
      const w = Math.max(0, Math.min(1, c.reduce((s, v, k) => s + (v - from[k]) * (to[k] - from[k]), 0) / den)) ** 2;
      sx += w * Math.sin(a); sy += w * Math.cos(a);
    }
    return (Math.atan2(sx, sy) * 180) / Math.PI;
  };
  S.diff = (a, b) => {
    const A = S.shots[a], B = S.shots[b];
    if (A.width !== B.width || A.height !== B.height) return { size: [A.width, A.height, B.width, B.height], pixels: -1 };
    let n = 0, x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
    for (let i = 0; i < A.data.length; i += 4) {
      if (A.data[i] !== B.data[i] || A.data[i + 1] !== B.data[i + 1] || A.data[i + 2] !== B.data[i + 2]) {
        n++; const p = i / 4, x = p % A.width, y = (p / A.width) | 0;
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      }
    }
    return { pixels: n, of: A.width * A.height, box: n ? [x0, y0, x1, y1] : null };
  };
  // the device, its view and the world transform, in CSS px
  S.device = (label) => {
    const { canvas, store } = window.rig;
    const [id, n] = Object.entries(store.doc.nodes).find(([, d]) => d.label === label);
    const v = canvas.views.get(id), r = canvas.app.canvas.getBoundingClientRect();
    return { id, pos: n.pos, params: n.params, bypass: n.bypass, size: v.size, left: r.left + canvas.world.x, top: r.top + canvas.world.y, s: canvas.world.scale.x,
      knobs: (v.knobs || []).map((q) => ({ key: q.key, x: q.x, y: q.y, r: q.r, readout: q.readout, spec: q.spec && { min: q.spec.min, max: q.spec.max, def: q.spec.def, contract: !!q.spec.contract } })),
      nameplate: v.nameplate ? { name: v.nameplate.name.text, status: v.nameplate.status.text } : null };
  };
  S.zoom = (label, s) => {
    const { canvas, store } = window.rig;
    const [id, n] = Object.entries(store.doc.nodes).find(([, d]) => d.label === label);
    const v = canvas.views.get(id), W = canvas.app.screen.width, H = canvas.app.screen.height;
    canvas.world.scale.set(s);
    canvas.world.position.set(Math.round(W / 2 - (n.pos[0] + v.size.w / 2) * s), Math.round(H / 2 - (n.pos[1] + v.size.h / 2) * s));
    canvas._viewChanged();
  };
}

// ---------------------------------------------------------------- run
const results = { when: new Date().toISOString(), host: `${os.cpus()[0].model}, load avg ${os.loadavg().map((x) => x.toFixed(1)).join('/')}`, baseline: BASELINE, ...(SABOTAGE && { sabotage: SABOTAGE }) };
const g = gate(results);
const logs = [];
let browser, baseDir;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (page, name) => {
  const b64 = await page.screenshot({ encoding: 'base64' });
  fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(b64, 'base64'));
  return b64;
};
async function open(page, url) {
  await page.goto(url, { waitUntil: 'networkidle0' });
  await page.waitForSelector('body[data-ready="1"]', { timeout: 30000 });
  await wait(2500); // every glyph settles (820 ms, staggered along the chain)
  await page.evaluate(installHelpers);
}
async function sabotage(page) {
  if (!SABOTAGE) return;
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = new URL(req.url());
    if (SABOTAGE === 'layout' && u.pathname === '/design/skins/brush/skin.json') {
      const m = JSON.parse(fs.readFileSync(path.join(root, 'design/skins/brush/skin.json'), 'utf8'));
      m.layouts['cc.squatch.trail-od'].controls.drive.x += 1.5;
      return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(m, null, 2) });
    }
    if (SABOTAGE === 'theme' && u.pathname === '/vendor/squatch-skin/tokens/squatch-ink.tokens.json') {
      const t = JSON.parse(fs.readFileSync(path.join(root, 'web/vendor/squatch-skin/tokens/squatch-ink.tokens.json'), 'utf8'));
      delete t.component.knob.cap;
      return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(t) });
    }
    return req.continue();
  });
}

/** Measure one knob from the pixels: three edge points of its cap outline, below it, where no ring or tick is. */
async function measureKnob(page, name, cx, cy, D, mode) {
  return page.evaluate((name, cx, cy, D, face, ink) => {
    const S = window.__sk;
    const pts = [150, 180, 210].map((a) => S.edge(name, cx, cy, a, 0.45 * D, 0.28 * D, face, ink));
    if (pts.some((p) => !p)) return null;
    const c = S.circle(...pts);
    return { x: c.x, y: c.y, d: c.r / 0.363 }; // the outline's outer edge is at 36.3 of the knob art's 100
  }, name, cx, cy, D, rgb(TOK[mode].get('--sq-comp-pedal-face')), rgb(TOK[mode].get('--sq-comp-knob-outline')));
}

/** Where the on-disk layout puts the device's parts on screen (CSS px). */
function expected(dev) {
  const G = faceGeometry(LAYOUT, product, dev.size);
  const X = (lx) => dev.left + (dev.pos[0] + lx) * dev.s, Y = (ly) => dev.top + (dev.pos[1] + ly) * dev.s;
  const pt = (c) => ({ x: X(c.x), y: Y(c.y), d: 2 * c.r * dev.s });
  return { G, X, Y, knobs: Object.fromEntries(G.knobs.map((q) => [q.key, pt(q)])), led: pt(G.led), footswitch: pt(G.footswitch) };
}
const near = (a, b, tol) => a && b && a.every((v, k) => Math.abs(v - b[k]) <= tol);

try {
  g.stage('servers');
  const cur = await serve(root, PORT);
  baseDir = extractBaseline(BASELINE);
  const base = await serve(baseDir, PORT + 1);

  g.stage('launch');
  browser = await puppeteer.launch({
    executablePath: findChrome(), headless: true,
    args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
    defaultViewport: { width: 1680, height: 940, deviceScaleFactor: DPR },
  });
  results.chrome = await browser.version();
  const page = await browser.newPage();
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  await sabotage(page);

  // ---------------------------------------------------------------- the package skin, both modes
  results.modes = {};
  const drawn = {};
  for (const mode of ['dark', 'light']) {
    g.stage(`skin-${mode}`);
    await open(page, `${cur}/?demo&theme=${mode}&skin=${ID}`);
    await shot(page, `skin-${mode}`);
    const R = (results.modes[mode] = {});
    R.page = await page.evaluate(() => {
      const s = window.rig.canvas.skin, p = s.package;
      return { name: s.name, label: s.label, title: document.title, status: document.querySelector('#renderer').textContent, ok: p?.ok ?? null, errors: p?.errors ?? null,
        files: (p?.report?.files ?? []).map((f) => f.path), devices: p?.devices ?? [], unresolved: p?.unresolved ?? null };
    });
    drawn[mode] = await page.evaluate((mode) => window.rig.canvas.skin.package?.drawn?.[mode] ?? {}, mode);
    // 3: every drawn art file is the package file with only the token colours substituted
    R.artDiff = {};
    for (const [part, rel] of Object.entries(ART)) {
      const want = substitute(disk.texts[rel], TOK[mode]).text, got = drawn[mode]?.[part];
      let n = got == null ? want.length : Math.abs(want.length - got.length);
      if (got != null) for (let i = 0; i < Math.min(want.length, got.length); i++) if (want[i] !== got[i]) n++;
      R.artDiff[part] = n;
    }
    // 9: every other device keeps its brush-ink art
    R.otherDevices = await page.evaluate((mode) => {
      const { canvas, store } = window.rig, s = canvas.skin, bad = [];
      for (const n of Object.values(store.doc.nodes)) {
        const own = s.artOf(n)?.textures?.[mode] ?? null, tex = s.textureFor(n, mode);
        if (n.type === 'overdrive' ? tex === own : tex !== own) bad.push(`${n.label} (${n.type})`);
      }
      return { nodes: Object.keys(store.doc.nodes).length, bad };
    }, mode);

    // zoom on the device and read the pixels
    await page.evaluate((l, s) => window.__sk.zoom(l, s), LABEL, ZOOM);
    await wait(500);
    let b64 = await shot(page, `skin-${mode}-zoom`);
    await page.evaluate((b) => window.__sk.load('z', b), b64);
    let dev = await page.evaluate((l) => window.__sk.device(l), LABEL);
    let E = expected(dev);
    // 4: knob geometry
    R.knobs = {};
    for (const [key, k] of Object.entries(E.knobs)) {
      const m = await measureKnob(page, 'z', k.x * DPR, k.y * DPR, k.d * DPR, mode);
      R.knobs[key] = m ? { expected: [k.x, k.y, k.d].map((v) => +v.toFixed(2)), measured: [m.x / DPR, m.y / DPR, m.d / DPR].map((v) => +v.toFixed(2)), err: +Math.max(Math.abs(m.x / DPR - k.x), Math.abs(m.y / DPR - k.y), Math.abs(m.d / DPR - k.d)).toFixed(3) } : { expected: [k.x, k.y, k.d], measured: null, err: Infinity };
    }
    // 8: token colours as drawn: a patch of open face, the drive knob's cap, the lamp
    const mm = E.G.mm * dev.s * DPR, fx = (x) => E.X(E.G.face.x + x * E.G.mm) * DPR, fy = (y) => E.Y(E.G.face.y + y * E.G.mm) * DPR;
    const dk = E.knobs.drive, ld = E.led;
    R.colours = await page.evaluate((a, b, c) => ({ face: window.__sk.median('z', ...a), cap: window.__sk.median('z', ...b), led: window.__sk.median('z', ...c) }),
      [fx(31), fy(14), fx(35), fy(20)], [dk.x * DPR - 0.04 * dk.d * DPR, dk.y * DPR - 0.04 * dk.d * DPR, dk.x * DPR + 0.04 * dk.d * DPR, dk.y * DPR + 0.04 * dk.d * DPR],
      [ld.x * DPR - 0.15 * ld.d * DPR, ld.y * DPR - 0.15 * ld.d * DPR, ld.x * DPR + 0.15 * ld.d * DPR, ld.y * DPR + 0.15 * ld.d * DPR]);
    R.tokens = { face: TOK[mode].get('--sq-comp-pedal-face'), cap: TOK[mode].get('--sq-comp-knob-cap'), ledOn: TOK[mode].get('--sq-comp-led-on'), ledOff: TOK[mode].get('--sq-comp-led-off') };
    R.mmPx = +(mm / DPR).toFixed(3);
    // 5: contract fidelity
    R.contract = { specs: Object.fromEntries(dev.knobs.map((q) => [q.key, q.spec])) };
    R.contract.readouts = await page.evaluate((id) => {
      const { store, canvas } = window.rig, n = store.doc.nodes[id], keep = { ...n.params };
      store.setParam(id, 'drive', 0.5); store.setParam(id, 'level', -6); canvas.rebuild(true);
      const k = Object.fromEntries(canvas.views.get(id).knobs.map((q) => [q.key, q.readout]));
      store.setParam(id, 'drive', keep.drive); store.setParam(id, 'level', keep.level); canvas.rebuild(true);
      return k;
    }, dev.id);

    if (mode === 'light') {
      // 6: drag Level to the middle of its travel, with the mouse
      g.stage('interaction');
      // select the device first: the first selection collapses the page above the canvas, which
      // would move the knob out from under a drag that started before it
      await page.evaluate((id) => window.rig.canvas.select({ kind: 'node', id }), dev.id);
      await wait(400);
      await page.evaluate((l, s) => window.__sk.zoom(l, s), LABEL, ZOOM);
      await wait(400);
      dev = await page.evaluate((l) => window.__sk.device(l), LABEL);
      E = expected(dev);
      const t0 = toNormalized(levelP, dev.params.level), lk = E.knobs.level;
      await page.mouse.move(lk.x, lk.y);
      await page.mouse.down();
      await page.mouse.move(lk.x, lk.y + (t0 - 0.5) * 160, { steps: 10 });
      await page.mouse.up();
      await page.mouse.move(5, 5);
      await wait(500);
      b64 = await shot(page, 'skin-light-zoom-level-mid');
      await page.evaluate((b) => window.__sk.load('m', b), b64);
      dev = await page.evaluate((l) => window.__sk.device(l), LABEL);
      E = expected(dev);
      const k2 = E.knobs.level, travel = Number(TOK.light.get('--sq-comp-knob-travel'));
      const angle = await page.evaluate((x, y, r, from, to) => window.__sk.angle('m', x, y, r, from, to), k2.x * DPR, k2.y * DPR, 0.17 * k2.d * DPR,
        rgb(TOK.light.get('--sq-comp-knob-cap')), rgb(TOK.light.get('--sq-comp-knob-pointer')));
      R.drag = { startNorm: +t0.toFixed(4), value: dev.params.level, expectedDeg: +pointerDegrees(travel, toNormalized(levelP, dev.params.level)).toFixed(2), measuredDeg: +angle.toFixed(2) };
      // 7: bypass with the footswitch
      g.stage('bypass');
      const fs0 = E.footswitch;
      await page.mouse.click(fs0.x, fs0.y);
      await page.mouse.move(5, 5);
      await wait(500);
      b64 = await shot(page, 'skin-light-zoom-bypassed');
      await page.evaluate((b) => window.__sk.load('b', b), b64);
      dev = await page.evaluate((l) => window.__sk.device(l), LABEL);
      E = expected(dev);
      const l2 = E.led;
      R.bypass = { bypass: dev.bypass, nameplate: dev.nameplate,
        led: await page.evaluate((a) => window.__sk.median('b', ...a), [l2.x * DPR - 0.15 * l2.d * DPR, l2.y * DPR - 0.15 * l2.d * DPR, l2.x * DPR + 0.15 * l2.d * DPR, l2.y * DPR + 0.15 * l2.d * DPR]) };
      await page.mouse.click(fs0.x, fs0.y);
    }
  }

  // ---------------------------------------------------------------- a phone-width look (for a person, not asserted)
  g.stage('phone');
  {
    const p2 = await browser.newPage();
    await p2.setViewport({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    await sabotage(p2);
    await open(p2, `${cur}/?demo&theme=light&skin=${ID}`);
    await p2.evaluate((l) => window.__sk.zoom(l, 1.2), LABEL);
    await wait(500);
    await p2.screenshot({ path: path.join(out, 'skin-light-phone.png') });
    await p2.close();
  }

  // ---------------------------------------------------------------- 10: no ?skin renders as the baseline did
  g.stage('no-skin');
  results.noSkin = {};
  for (const mode of ['dark', 'light']) {
    await open(page, `${base}/?demo&theme=${mode}`);
    const a = await shot(page, `noskin-${mode}-baseline`);
    await open(page, `${cur}/?demo&theme=${mode}`);
    const b = await shot(page, `noskin-${mode}`);
    results.noSkin[mode] = await page.evaluate(async (a, b) => { await window.__sk.load('a', a); await window.__sk.load('b', b); return window.__sk.diff('a', 'b'); }, a, b);
    results.noSkin[mode].skin = await page.evaluate(() => window.rig.canvas.skin.name);
  }

  // ---------------------------------------------------------------- 9: frame cost while the rig plays, skin and no skin
  g.stage('play');
  const play = async (url) => {
    await open(page, url);
    await page.click('.tp-play');
    await page.waitForFunction(() => window.rig.engine.ctx.state === 'running', { timeout: 30000 });
    await page.evaluate(() => window.rig.engine.whenModelsLoaded());
    await wait(1500);
    const warm = await page.evaluate(() => { window.rig.canvas.resetPerf(); return window.rig.engine.playbackStats(); });
    await wait(PLAY_SECONDS * 1000);
    return page.evaluate((warm) => {
      const ps = window.rig.engine.playbackStats(), perf = window.rig.canvas.perf();
      window.rig.engine.suspend();
      return { perf, underruns: ps && warm ? { events: ps.underrunEvents - warm.underrunEvents, seconds: +(ps.underrunDuration - warm.underrunDuration).toFixed(4) } : null };
    }, warm);
  };
  results.play = { seconds: PLAY_SECONDS, skin: await play(`${cur}/?demo&theme=light&skin=${ID}`), noSkin: await play(`${cur}/?demo&theme=light`) };

  // ---------------------------------------------------------------- assertions
  g.stage('assert');
  for (const mode of ['dark', 'light']) {
    const R = results.modes[mode];
    g.check(`${mode}: 1 the page's validateSkin accepted the package`, R.page.ok === true && R.page.errors?.length === 0 && R.page.label === 'Brush skin', { ok: R.page.ok, errors: R.page.errors?.slice(0, 3), label: R.page.label }, 'ok, 0 errors, labelled "Brush skin"');
    g.check(`${mode}: 2 files verified against "files"`, R.page.files.length === 8, R.page.files.length, '8');
    const diffs = Object.values(R.artDiff);
    g.check(`${mode}: 3 drawn art is the package's, only token colours substituted`, diffs.every((n) => n === 0), R.artDiff, '0 bytes differ in each of the 6 files');
    const errs = Object.values(R.knobs).map((k) => k.err);
    g.check(`${mode}: 4 knob centres and diameters as drawn vs layout x face scale`, errs.length === 3 && errs.every((e) => e <= 0.5), R.knobs, '<= 0.5 CSS px for drive, tone and level');
    const S = R.contract.specs;
    g.check(`${mode}: 5 knobs driven by the contract`, S.drive?.contract && S.drive.min === 0 && S.drive.max === 1 && S.drive.def === 0.5 && S.tone?.contract && S.tone.min === 0 && S.tone.max === 1 && S.tone.def === 0.5 && S.level?.contract && S.level.min === -30 && S.level.max === 12 && S.level.def === -6 && R.contract.readouts.drive === 'Drive 5.0' && R.contract.readouts.level === 'Level −6.0 dB',
      R.contract, 'Drive/Tone 0..1 default 0.5, Level -30..12 default -6, readouts "Drive 5.0" and "Level −6.0 dB"');
    g.check(`${mode}: 8 nothing left unresolved`, R.page.unresolved && R.page.unresolved.dark?.length === 0 && R.page.unresolved.light?.length === 0, R.page.unresolved, '0 token names left');
    g.check(`${mode}: 8 face, knob cap and lamp pixels are their tokens`, near(R.colours.face, rgb(R.tokens.face), 12) && near(R.colours.cap, rgb(R.tokens.cap), 6) && near(R.colours.led, rgb(R.tokens.ledOn), 8),
      { measured: R.colours, tokens: { face: R.tokens.face, cap: R.tokens.cap, led: R.tokens.ledOn } }, 'face within 12 per channel (grain), cap within 6, lamp within 8');
    g.check(`${mode}: 9 every other device keeps its brush-ink art`, R.page.devices.join() === 'overdrive' && R.otherDevices.bad.length === 0, { packageDevices: R.page.devices, ...R.otherDevices }, 'only overdrive from the package');
  }
  const changed = Object.keys(ART).filter((p) => drawn.dark?.[p] && drawn.dark[p] !== drawn.light?.[p]);
  g.check('8 one file, two looks: dark and light faceplates differ', changed.includes('faceplate'), changed, 'faceplate (and more) differ between modes');
  const D = results.modes.light.drag;
  g.check('6 dragging Level to mid-travel gives -9 dB', D && Math.abs(D.value - -9) <= 1, D?.value, 'within 1 dB of -9');
  g.check('6 the pointer is drawn at -travel/2 + travel x n', D && Math.abs(D.measuredDeg - D.expectedDeg) <= 1, D && { expected: D.expectedDeg, measured: D.measuredDeg }, 'within 1 degree');
  const B = results.modes.light.bypass;
  g.check('7 footswitch bypasses: lamp off, nameplate "bypassed"', B?.bypass === true && near(B.led, rgb(results.modes.light.tokens.ledOff), 8) && B.nameplate?.status === 'bypassed', B, 'bypass true, lamp pixels --sq-comp-led-off within 8, status "bypassed"');
  // The rig's own budget (README: p95 1.0 ms JS, 1.8 ms submit on an M1 Max), or, on a busier machine,
  // no worse than the same rig without the skin measured back to back (10% + 0.1 ms of slack).
  const P = results.play.skin.perf, Q = results.play.noSkin.perf;
  const within = (k, limit) => P?.[k]?.p95 <= limit || (Q?.[k]?.p95 != null && P?.[k]?.p95 <= Q[k].p95 * 1.1 + 0.1);
  g.check('9 frame cost while playing with the skin', within('updateMs', 1.0) && within('renderSubmitMs', 1.8),
    { skin: { updateP95: P?.updateMs?.p95, renderP95: P?.renderSubmitMs?.p95, rendered: P?.rendered }, noSkin: { updateP95: Q?.updateMs?.p95, renderP95: Q?.renderSubmitMs?.p95, rendered: Q?.rendered } },
    'p95 JS <= 1.0 ms and p95 submit <= 1.8 ms, or each within 10% + 0.1 ms of the no-skin rig');
  const allowed = Math.ceil(PLAY_SECONDS / 30), U = results.play.skin.underruns;
  g.check('9 underruns while playing with the skin', U != null && U.events <= allowed && U.seconds <= 0.010 * allowed, U, `events <= ${allowed}, seconds <= ${0.01 * allowed} (live-check's allowance)`);
  for (const mode of ['dark', 'light']) {
    const N = results.noSkin[mode];
    g.check(`10 no ?skin, ${mode}: identical to ${BASELINE}`, N.pixels === 0 && N.skin === 'brush-ink', N, '0 pixels differ, skin brush-ink');
  }
  const errors = logs.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]'));
  g.check('no console errors', errors.length === 0, errors.slice(0, 5), 'no [error] or [pageerror] entries');
} catch (e) {
  g.fail(e);
} finally {
  results.console = logs.filter((l) => !l.includes('[nam]')).slice(0, 40);
  const code = g.finish();
  fs.writeFileSync(path.join(out, 'skin-check.json'), JSON.stringify(results, null, 1));
  console.log(JSON.stringify({ pass: results.pass, failed: results.failed, error: results.error, checks: results.checks?.map((c) => `${c.pass ? 'ok  ' : 'FAIL'} ${c.name}`) }, null, 1));
  await browser?.close().catch(() => {});
  for (const s of servers) s.kill();
  if (baseDir) fs.rmSync(baseDir, { recursive: true, force: true });
  process.exitCode = code;
}
