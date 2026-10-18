#!/usr/bin/env node
// The README's figures, measured from the effect kernels the AudioWorklets run (web/worklets/dsp/*.js) and drawn as SVG.
//
//   node tools/readme-figures.mjs [OUT_DIR]          write OUT_DIR/fig-<name>-{light,dark}.svg (default docs/readme)
//   node tools/readme-figures.mjs --check [OUT_DIR]  write nothing; exit 1 if a committed file differs from what the
//                                                    kernels draw now
//
// Nothing is typed in by hand: change a kernel and the picture changes. Colours are the squatch-skin "squatch-ink"
// tokens (light and dark). Text uses the system font stack, because an SVG shown through <img> cannot load web fonts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Compressor } from '../web/worklets/dsp/compressor.js';
import { Overdrive } from '../web/worklets/dsp/overdrive.js';
import { EnvelopeFilter } from '../web/worklets/dsp/envfilter.js';
import { Reverb } from '../web/worklets/dsp/reverb.js';
import { SR, sine, run, peak, db } from '../tests/lib/sig.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const THEMES = {
  light: { page: '#FCFBF8', rule: '#D4CBBB', faint: '#E8E0D4', text: '#1C160E', muted: '#6B5B3E', accent: '#9C7208', limit: '#9A2E1B' },
  dark: { page: '#201A12', rule: '#3A3226', faint: '#2C251B', text: '#EDE6D8', muted: '#A89878', accent: '#D4A93F', limit: '#D9553D' },
};
const SANS = "ui-sans-serif,-apple-system,'Segoe UI',Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,'SF Mono',Menlo,Consolas,monospace";
const W = 440, H = 290, L = 52, R = 16, T = 52, B = 44;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const n1 = (v) => (Math.abs(v) >= 1 ? v.toFixed(1).replace(/\.0$/, '') : v.toFixed(2).replace(/0$/, '').replace(/\.0$/, ''));

class Plot {
  constructor(theme, title, subtitle, { x, y, logY = false }) {
    this.c = THEMES[theme]; this.title = title; this.subtitle = subtitle; this.x = x; this.y = y; this.logY = logY; this.parts = [];
  }
  px(v) { return L + ((v - this.x[0]) / (this.x[1] - this.x[0])) * (W - L - R); }
  py(v) {
    const [a, b] = this.y;
    const f = this.logY ? (Math.log10(v) - Math.log10(a)) / (Math.log10(b) - Math.log10(a)) : (v - a) / (b - a);
    return H - B - f * (H - T - B);
  }
  text(x, y, s, { size = 11, fill = this.c.muted, anchor = 'start', family = SANS, weight = 400 } = {}) {
    this.parts.push(`<text x="${n1(x)}" y="${n1(y)}" font-family="${family}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(s)}</text>`);
  }
  grid(xt, yt, xlabel, ylabel, yfmt = (v) => String(v)) {
    const c = this.c;
    for (const v of yt) {
      const y = this.py(v);
      this.parts.push(`<line x1="${L}" y1="${n1(y)}" x2="${W - R}" y2="${n1(y)}" stroke="${c.faint}"/>`);
      this.text(L - 6, y + 4, yfmt(v), { size: 10, anchor: 'end', family: MONO });
    }
    for (const v of xt) {
      const x = this.px(v);
      this.parts.push(`<line x1="${n1(x)}" y1="${T}" x2="${n1(x)}" y2="${H - B}" stroke="${c.faint}"/>`);
      this.text(x, H - B + 15, String(v), { size: 10, anchor: 'middle', family: MONO });
    }
    this.text((L + W - R) / 2, H - 8, xlabel, { anchor: 'middle' });
    this.parts.push(`<text transform="translate(13 ${n1((T + H - B) / 2)}) rotate(-90)" font-family="${SANS}" font-size="11" fill="${c.muted}" text-anchor="middle">${esc(ylabel)}</text>`);
  }
  line(pts, color, { width = 1.8, dash = '' } = {}) {
    const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${n1(this.px(x))} ${n1(this.py(y))}`).join(' ');
    this.parts.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linejoin="round" stroke-linecap="round"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`);
  }
  dots(pts, color) {
    for (const [x, y] of pts) this.parts.push(`<circle cx="${n1(this.px(x))}" cy="${n1(this.py(y))}" r="2.6" fill="${color}"/>`);
  }
  legend(items, x = L + 8, y = T + 14) {
    items.forEach(([label, color, dash], i) => {
      const yy = y + i * 15;
      this.parts.push(`<line x1="${x}" y1="${yy - 3}" x2="${x + 18}" y2="${yy - 3}" stroke="${color}" stroke-width="2"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`);
      this.text(x + 24, yy, label, { size: 10.5, fill: this.c.text });
    });
  }
  render(desc) {
    const c = this.c;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t d"><title id="t">${esc(this.title)}</title><desc id="d">${esc(desc)}</desc>`
      + `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="10" fill="${c.page}" stroke="${c.rule}"/>`
      + `<text x="${L}" y="24" font-family="${SANS}" font-size="14" font-weight="600" fill="${c.text}">${esc(this.title)}</text>`
      + `<text x="${L}" y="40" font-family="${SANS}" font-size="11" fill="${c.muted}">${esc(this.subtitle)}</text>`
      + this.parts.join('') + '</svg>\n';
  }
}

// ---- measurements: each returns plain data, drawn once per theme --------------------------------------------------------

function measureCompressor() {
  const thr = -24, levels = [-39, -36, -33, -30, -27, -24, -21, -18, -15, -12, -9, -6, -3];
  return [2, 4, 8].map((ratio) => ({
    ratio,
    points: levels.map((lvl) => {
      const c = new Compressor(SR);
      c.set('threshold', thr); c.set('ratio', ratio); c.set('knee', 0); c.set('makeup', 0); c.set('attack', 1); c.set('release', 300);
      const y = run(c, sine(1000, 10 ** (lvl / 20), SR));
      return [lvl, lvl - db(peak(y, SR - 4800))];
    }),
    theory: levels.map((lvl) => [lvl, Math.max(0, (lvl - thr) * (1 - 1 / ratio))]),
  }));
}

function measureOverdrive() {
  const cycles = 2, f = 220, n = Math.round((SR * cycles) / f), settle = SR / 2;
  return [0.15, 0.5, 1].map((drive) => {
    const od = new Overdrive(SR); od.set('drive', drive); od.set('asym', 0); od.set('tone', 0.5); od.set('level', 0);
    const x = sine(f, 0.5, settle + n);
    const y = run(od, x).subarray(settle);
    const p = peak(y);
    return { drive, peak: p, trace: Array.from(y, (v, i) => [(i / SR) * 1000, v / p]), input: Array.from(x.subarray(settle), (v, i) => [(i / SR) * 1000, v / 0.5]) };
  });
}

function measureReverb() {
  return [1, 2.5, 5].map((decay) => {
    const rv = new Reverb(SR);
    rv.set('decay', decay); rv.set('mix', 1); rv.set('damp', 20000); rv.set('predelay', 0);
    const n = Math.round(SR * decay * 1.5), x = new Float32Array(n); x[0] = 1;
    const [Lc, Rc] = run(rv, x, { outCh: 2 });
    const e = new Float64Array(n); let acc = 0;
    for (let i = n - 1; i >= 0; i--) { const v = 0.5 * (Lc[i] + Rc[i]); acc += v * v; e[i] = acc; }
    const step = Math.round(SR / 50), pts = [];
    for (let i = 0; i < n; i += step) pts.push([i / SR, Math.max(-70, 10 * Math.log10(e[i] / e[0]))]);
    return { decay, pts };
  });
}

function measureEnvFilter() {
  const ef = new EnvelopeFilter(SR);
  ef.set('lo', 300); ef.set('hi', 3000); ef.set('sens', 18); ef.set('attack', 5); ef.set('release', 100);
  const step = SR / 4, block = 32, x = new Float32Array(SR / 2);
  x.set(sine(440, 0.002, step)); x.set(sine(440, 0.5, step), step);
  const pts = [];
  for (let i = 0; i < x.length; i += block) {
    ef.process([x.subarray(i, i + block)], [new Float32Array(block)], block);
    const ms = ((i + block - step) / SR) * 1000;
    if (ms >= -5 && ms <= 30) pts.push([ms, ef.cutoff]);
  }
  return pts;
}

// ---- figures ------------------------------------------------------------------------------------------------------------

function compressorFigure(theme, data) {
  const p = new Plot(theme, 'Compressor', 'gain reduction at threshold -24 dB: measured (dots) and theory (lines)', { x: [-40, 0], y: [-1, 22] });
  p.grid([-40, -30, -20, -10, 0], [0, 5, 10, 15, 20], 'input level (dBFS, steady 1 kHz tone)', 'gain reduction (dB)');
  const shades = [p.c.muted, p.c.accent, p.c.limit];
  data.forEach((d, i) => { p.line(d.theory, shades[i], { width: 1.4 }); p.dots(d.points, shades[i]); });
  p.legend(data.map((d, i) => [`ratio ${d.ratio}:1`, shades[i], '']), L + 8, T + 14);
  return p.render('The compressor kernel measured with steady tones: gain reduction against input level for ratios 2, 4 and 8, on top of the textbook curves.');
}

function overdriveFigure(theme, data) {
  const p = new Plot(theme, 'Overdrive', 'a 220 Hz sine at three drive settings, each scaled to its peak', { x: [0, 1000 * 2 / 220], y: [-1.15, 1.15] });
  p.grid([0, 3, 6, 9], [-1, -0.5, 0, 0.5, 1], 'time (ms)', 'output / peak');
  p.line(data[0].input, p.c.rule, { width: 1.2, dash: '4 3' });
  const shades = [p.c.muted, p.c.accent, p.c.limit];
  data.forEach((d, i) => p.line(d.trace, shades[i], { width: 1.8 }));
  p.legend([['input', p.c.rule, '4 3'], ...data.map((d, i) => [`drive ${d.drive}`, shades[i], ''])], W - R - 90, T + 14);
  return p.render('The overdrive kernel\'s output waveform for a sine at three drive settings: more drive squares the wave off.');
}

function reverbFigure(theme, data) {
  const p = new Plot(theme, 'Reverb decay', 'energy left after an impulse, for decay settings of 1, 2.5 and 5 s', { x: [0, 7.5], y: [-70, 0] });
  p.grid([0, 2, 4, 6], [0, -20, -40, -60], 'time (s)', 'energy (dB)');
  p.line([[0, -60], [7.5, -60]], p.c.limit, { width: 1.2, dash: '4 3' });
  const shades = [p.c.muted, p.c.accent, p.c.text];
  data.forEach((d, i) => p.line(d.pts, shades[i], { width: 1.8 }));
  p.legend([...data.map((d, i) => [`decay ${d.decay} s`, shades[i], '']), ['-60 dB', p.c.limit, '4 3']], W - R - 100, T + 14);
  return p.render('The reverb kernel\'s measured energy decay curves for three decay settings; each reaches -60 dB near its setting.');
}

function envFilterFigure(theme, pts) {
  const p = new Plot(theme, 'Envelope filter', 'cutoff after a quiet-to-loud step at 0 ms (lo 300 Hz, hi 3 kHz, attack 5 ms)', { x: [-5, 30], y: [200, 4000], logY: true });
  p.grid([0, 10, 20, 30], [300, 1000, 3000], 'time since the step (ms)', 'cutoff (Hz)');
  p.line(pts, p.c.accent, { width: 2.2 });
  return p.render('The envelope filter\'s cutoff against time: it sits at 300 Hz for a quiet input and rises towards 3 kHz within tens of milliseconds of a loud one.');
}

export function buildFigures() {
  const data = { compressor: measureCompressor(), overdrive: measureOverdrive(), reverb: measureReverb(), envfilter: measureEnvFilter() };
  const fns = { compressor: compressorFigure, overdrive: overdriveFigure, reverb: reverbFigure, envfilter: envFilterFigure };
  const out = {};
  for (const [name, fn] of Object.entries(fns)) for (const theme of Object.keys(THEMES)) out[`fig-${name}-${theme}.svg`] = fn(theme, data[name]);
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), check = args.includes('--check');
  const outDir = path.resolve(args.find((a) => !a.startsWith('--')) || path.join(root, 'docs/readme'));
  const files = buildFigures();
  if (check) {
    const stale = Object.entries(files).filter(([n, s]) => !fs.existsSync(path.join(outDir, n)) || fs.readFileSync(path.join(outDir, n), 'utf8') !== s).map(([n]) => n);
    console.log(stale.length ? `figures: FAIL, stale: ${stale.join(', ')}` : 'figures: the committed figures match the kernels');
    process.exit(stale.length ? 1 : 0);
  }
  fs.mkdirSync(outDir, { recursive: true });
  for (const [n, s] of Object.entries(files)) { fs.writeFileSync(path.join(outDir, n), s); console.log('wrote', path.join(outDir, n)); }
}
