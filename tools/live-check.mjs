#!/usr/bin/env node
// Live playback check in headless Chrome, with the real audio output disabled
// (--disable-audio-output: Chrome renders into a fake output stream on a real-
// time clock) but the whole graph running. Presses Play with a real click (no
// autoplay flag), plays for SECONDS, and reports:
//   - underruns: Chrome's AudioContext.playbackStats (underrunEvents/Duration),
//     total and after warm-up (models are parsed on the audio thread at load)
//   - process() calls: render quanta counted by the tap worklet vs the clock
//   - CPU per 128-frame block: summed worklet time and per node
//   - meters: update rate and whether levels actually move
//   - Record (WAV decodes, right length), A/B and loop switching
// Any stage that throws is recorded as R.error {stage, message}; the report
// sets R.pass and the process exits 1 unless every assertion held (R.checks
// lists each with what it measured and its limit).
// usage: node tools/live-check.mjs [baseUrl] [seconds]   -> tests/out/live-check.json
// Negative control: LIVE_CHECK_SABOTAGE=ab makes the A/B button flip its flag
// and label without changing the audio; the 'A/B changes the sound' check
// must then fail (and the run exit 1) while everything else still passes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { decodeWav } from '../web/js/audio/wav.js';
import { gate } from './check-gate.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = process.argv[2] || 'http://127.0.0.1:7491';
const SECONDS = +(process.argv[3] || 60);
const SABOTAGE = process.env.LIVE_CHECK_SABOTAGE || '';
const out = path.join(root, 'tests/out'); fs.mkdirSync(out, { recursive: true });

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const cache = path.join(os.homedir(), '.cache/puppeteer/chrome');
  if (fs.existsSync(cache)) for (const v of fs.readdirSync(cache).sort().reverse()) {
    const p = path.join(cache, v, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
    if (fs.existsSync(p)) return p;
  }
  return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
}

const R = { when: new Date().toISOString(), host: `${os.cpus()[0].model} x${os.cpus().length}`, seconds: SECONDS, ...(SABOTAGE && { sabotage: SABOTAGE }) };
const g = gate(R);
const logs = [];
let browser, page;
const sample = () => page.evaluate(() => {
  const e = window.rig.engine, cpu = e.cpu();
  return { t: e.ctx.currentTime, wall: performance.now() / 1000, state: e.ctx.state, ps: e.playbackStats(), quanta: e.tapStats.quanta, seq: e.meters.seq, master: { rms: e.meters.master.rms, peak: e.meters.master.peak, env: e.meters.master.env, clips: e.meters.master.clips }, cpuUs: cpu.us, budgetUs: cpu.budget, per: Object.fromEntries(Object.entries(cpu.per).map(([id, us]) => [e.doc.nodes[id].label, us])), env: Object.fromEntries(Object.entries(e.meters.nodes).map(([id, n]) => [e.doc.nodes[id].label, +n.env.toFixed(4)])) };
});
try {
  g.stage('launch');
  browser = await puppeteer.launch({ executablePath: findChrome(), headless: true, args: ['--disable-audio-output', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'], defaultViewport: { width: 1680, height: 940 } });
  R.chrome = await browser.version();
  page = await browser.newPage();
  page.on('console', (m) => { if (!m.text().startsWith('[nam]')) logs.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  g.stage('load');
  await page.goto(`${base}/?demo&intro=0`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('body[data-ready="1"]', { timeout: 30000 });
  // A fresh profile has not dismissed the first-play guide, so the one Play
  // button ("Hear it") lives in #first-play, not #transport (ef2f574). Click it
  // where a first-time visitor finds it.
  R.before = await page.evaluate(() => { const b = document.querySelectorAll('.tp-play'); return { state: window.rig.engine.ctx.state, button: b[0]?.textContent, buttons: b.length, in: b[0]?.closest('#first-play') ? 'first-play' : b[0]?.closest('#transport') ? 'transport' : null }; });
  g.stage('play');
  await page.click('.tp-play'); // a real, trusted mouse click: the autoplay policy applies
  await page.waitForFunction(() => window.rig.engine.ctx.state === 'running' && document.querySelector('.tp-play').textContent === 'Stop', { timeout: 30000 });
  R.afterClick = await page.evaluate(() => ({ state: window.rig.engine.ctx.state, button: document.querySelector('.tp-play').textContent }));
  g.check('one Play button on the page', R.before.buttons === 1, R.before.buttons, '=== 1');
  g.check('real click starts the context', R.afterClick.state === 'running' && R.afterClick.button === 'Stop', R.afterClick, "state running, button 'Stop'");
  g.stage('models');
  await page.evaluate(() => window.rig.engine.whenModelsLoaded());
  await new Promise((r) => setTimeout(r, 1000));
  g.stage('playback');
  // Every meter event during playback: how far each node's RMS actually moves
  // (dB). A 2 s window was too short: on a sustained chord a saturated head
  // moved 2.6 dB; across the whole run (most of a ~15 s loop or more) a working
  // meter moves tens of dB and a frozen one does not move at all.
  await page.evaluate(() => {
    const e = window.rig.engine, m = (window.__meterMotion = { events: 0, lo: {}, hi: {} });
    m.on = () => { m.events++; for (const [id, r] of Object.entries(e.meters.nodes)) { const k = e.doc.nodes[id].label, v = Math.max(-90, r.rmsDb); m.lo[k] = Math.min(m.lo[k] ?? 0, v); m.hi[k] = Math.max(m.hi[k] ?? -90, v); } };
    e.addEventListener('meters', m.on);
  });
  const warm = await sample();
  const series = [warm];
  for (let s = 0; s < SECONDS; s++) { await new Promise((r) => setTimeout(r, 1000)); series.push(await sample()); }
  R.meterMotion = await page.evaluate(() => {
    const e = window.rig.engine, m = window.__meterMotion;
    e.removeEventListener('meters', m.on);
    return { events: m.events, rmsRangeDb: Object.fromEntries(Object.keys(m.lo).map((k) => [k, +(m.hi[k] - m.lo[k]).toFixed(1)])) };
  });
  const last = series.at(-1);
  const played = last.t - warm.t, wall = last.wall - warm.wall;
  const cpus = series.slice(1).map((x) => x.cpuUs).sort((a, b) => a - b);
  const envMoves = {};
  for (const k of Object.keys(last.env)) { const v = series.map((x) => x.env[k]); envMoves[k] = +(Math.max(...v) - Math.min(...v)).toFixed(3); }
  R.live = {
    playedSeconds: +played.toFixed(2), wallSeconds: +wall.toFixed(2),
    underruns: { total: last.ps, sinceWarm: last.ps && warm.ps ? { events: last.ps.underrunEvents - warm.ps.underrunEvents, seconds: +(last.ps.underrunDuration - warm.ps.underrunDuration).toFixed(4) } : null },
    processCalls: { quanta: last.quanta - warm.quanta, expected: Math.round((played * 48000) / 128), perSecond: +((last.quanta - warm.quanta) / played).toFixed(1) },
    cpuPerBlockUs: { median: +cpus[cpus.length >> 1].toFixed(1), max: +cpus.at(-1).toFixed(1), budget: +last.budgetUs.toFixed(1), medianPct: +((100 * cpus[cpus.length >> 1]) / last.budgetUs).toFixed(1), perNode: Object.fromEntries(Object.entries(last.per).map(([k, v]) => [k, +v.toFixed(1)])) },
    meters: { updatesPerSecond: +((last.seq - warm.seq) / wall).toFixed(1), masterRmsDb: +(20 * Math.log10(last.master.rms || 1e-9)).toFixed(1), masterPeakDb: +(20 * Math.log10(last.master.peak || 1e-9)).toFixed(1), clips: last.master.clips, envRangePerNode: envMoves },
    loadAvg: os.loadavg().map((x) => +x.toFixed(1)),
  };
  // A/B: the level-matched dry DI must SOUND different, not just set a flag.
  // A test-only analyser on the master bus averages the spectrum over 2 s
  // windows: rig, rig again (how much the loop alone moves the spectrum),
  // dry, then back. Each window's octave-band profile is normalised to its
  // own total power, so the level match cancels and only timbre is compared.
  // The analyser is read on its own 50 ms timer, not on the UI meter events,
  // which follow requestAnimationFrame and stalled to 19 in 2 s on a busy host.
  g.stage('ab');
  R.ab = await page.evaluate(async (sabotage) => {
    const e = window.rig.engine;
    if (sabotage === 'ab') e.setBypass = function (on) { this.bypassed = !!on; this.meters.bypassed = this.bypassed; this.emit('transport'); };
    const an = new AnalyserNode(e.ctx, { fftSize: 4096, smoothingTimeConstant: 0 });
    e.masterBus.connect(an);
    const bin = new Float32Array(an.frequencyBinCount), td = new Float32Array(an.fftSize), hz = e.ctx.sampleRate / an.fftSize;
    const edges = [88, 177, 354, 707, 1414, 2828, 5657, 11314]; // octave bands centred 125 Hz .. 8 kHz
    const windowOf = () => new Promise((resolve) => {
      const acc = new Float64Array(bin.length); let n = 0, ss = 0;
      const on = () => {
        an.getFloatFrequencyData(bin); for (let i = 0; i < bin.length; i++) acc[i] += 10 ** (bin[i] / 10);
        an.getFloatTimeDomainData(td); let q = 0; for (const v of td) q += v * v; ss += q / td.length; n++;
      };
      const timer = setInterval(on, 50);
      setTimeout(() => {
        clearInterval(timer);
        const bands = edges.slice(0, -1).map((lo, b) => { let p = 0; for (let i = Math.ceil(lo / hz); i < edges[b + 1] / hz; i++) p += acc[i]; return p; });
        const tot = bands.reduce((a, b) => a + b, 0);
        resolve({ frames: n, db: +(10 * Math.log10(ss / n)).toFixed(1), profileDb: bands.map((p) => +(10 * Math.log10(p / tot)).toFixed(2)) });
      }, 2000);
    });
    const dist = (a, b) => +Math.sqrt(a.profileDb.reduce((s, v, i) => s + (v - b.profileDb[i]) ** 2, 0) / a.profileDb.length).toFixed(2);
    const toggle = async () => { document.querySelector('.tp-ab').click(); await new Promise((r) => setTimeout(r, 250)); };
    const rig = await windowOf(), rig2 = await windowOf();
    await toggle();
    const dry = await windowOf(), bypassed = e.meters.bypassed, dryLabel = document.querySelector('.tp-ab').textContent;
    await toggle();
    e.masterBus.disconnect(an);
    return { rigDb: rig.db, dryDb: dry.db, dryMakeupDb: +e.dryMakeupDb.toFixed(2), bypassed, back: !e.meters.bypassed, dryLabel, label: document.querySelector('.tp-ab').textContent,
      frames: [rig.frames, rig2.frames, dry.frames], profileDb: { rig: rig.profileDb, rig2: rig2.profileDb, dry: dry.profileDb },
      timbreDistDb: { rigVsRig: dist(rig, rig2), rigVsDry: dist(rig, dry) } };
  }, SABOTAGE);
  g.stage('loop');
  R.loopSwitch = await page.evaluate(async () => {
    const sel = document.querySelector('.tp-loop'); sel.value = 'picked-riff'; sel.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 1000));
    const title = window.rig.engine.loops.find((l) => l.id === 'picked-riff')?.title;
    return { loop: window.rig.engine.meters.loop, title, credit: document.querySelector('#credit').textContent.slice(0, 90) };
  });
  g.stage('record');
  const rec = await page.evaluate(async () => {
    const e = window.rig.engine;
    const t0 = e.ctx.currentTime;
    document.querySelector('.tp-rec').click();
    await new Promise((r) => setTimeout(r, 3000));
    const secs = e.recordedSeconds, t1 = e.ctx.currentTime;
    const blob = await e.stopRecording();
    return { secs, clockSeconds: t1 - t0, sampleRate: e.ctx.sampleRate, bytes: Array.from(new Uint8Array(await blob.arrayBuffer())) };
  });
  const w = decodeWav(Uint8Array.from(rec.bytes));
  const chPeak = w.channels.map((c) => { let p = 0; for (const v of c) p = Math.max(p, Math.abs(v)); return p; });
  const pk = Math.max(0, ...chPeak);
  R.record = { seconds: +(w.channels[0]?.length / w.sampleRate).toFixed(3), clockSeconds: +rec.clockSeconds.toFixed(3), channels: w.channels.length, sampleRate: w.sampleRate, peakDb: +(20 * Math.log10(pk || 1e-9)).toFixed(1), channelPeakDb: chPeak.map((p) => +(20 * Math.log10(p || 1e-9)).toFixed(1)), reportedSeconds: +rec.secs.toFixed(2) };
  fs.writeFileSync(path.join(out, 'live-record.wav'), Buffer.from(Uint8Array.from(rec.bytes)));

  // ---------------------------------------------------------------- assertions
  g.stage('assert');
  const L = R.live;
  const quantaErr = Math.abs(L.processCalls.quanta - L.processCalls.expected) / L.processCalls.expected;
  g.check('render quanta within 2% of the audio clock', L.processCalls.expected > 0 && quantaErr <= 0.02, { ...L.processCalls, relErr: +quantaErr.toFixed(4) }, '|quanta - expected| / expected <= 0.02, expected > 0');
  // Warm-up (model parse on the audio thread) is excluded; after it, allow one
  // underrun per started 30 s of playback, each no longer than a 10 ms glitch.
  const allowed = Math.ceil(L.playedSeconds / 30);
  const ur = L.underruns.sinceWarm;
  g.check('playbackStats available', !!L.underruns.total && ur != null, L.underruns.total, 'AudioContext.playbackStats present (null is a failure, not a pass)');
  g.check('post-warm-up underruns bounded', ur != null && ur.events <= allowed && ur.seconds <= 0.010 * allowed, ur, `events <= ${allowed} and seconds <= ${(0.010 * allowed).toFixed(3)} (1 per 30 s, 10 ms each)`);
  g.check('meters update', L.meters.updatesPerSecond >= 20, L.meters.updatesPerSecond, '>= 20 updates/s');
  g.check('master level is real audio', L.meters.masterRmsDb > -60 && L.meters.masterRmsDb < 0, L.meters.masterRmsDb, '-60 < master RMS dBFS < 0');
  const still = Object.entries(R.meterMotion.rmsRangeDb).filter(([, v]) => !(v >= 6));
  g.check('every node meter moves', R.meterMotion.events >= 15 * L.wallSeconds && Object.keys(R.meterMotion.rmsRangeDb).length > 0 && still.length === 0, { events: R.meterMotion.events, still: Object.fromEntries(still), minRangeDb: Math.min(...Object.values(R.meterMotion.rmsRangeDb)) }, '>= 15 meter events/s over playback and every node RMS range >= 6 dB');
  const A = R.ab;
  g.check('A/B switches to dry and back', A.bypassed === true && A.back === true && A.dryLabel === 'A/B · Dry DI' && A.label === 'A/B · Rig', { bypassed: A.bypassed, back: A.back, dryLabel: A.dryLabel, label: A.label }, 'bypassed, label Dry DI, then back to Rig');
  g.check('A/B changes the sound', A.frames.every((n) => n >= 20) && A.timbreDistDb.rigVsDry >= 3 && A.timbreDistDb.rigVsDry >= 3 * A.timbreDistDb.rigVsRig, A.timbreDistDb, '>= 20 analyser frames per 2 s window; rig-vs-dry octave-profile distance >= 3 dB and >= 3x rig-vs-rig');
  g.check('A/B is level-matched', Math.abs(A.rigDb - A.dryDb) <= 6, { rigDb: A.rigDb, dryDb: A.dryDb }, '|rig - dry| <= 6 dB');
  g.check('loop switch and credit', R.loopSwitch.loop === 'picked-riff' && !!R.loopSwitch.title && R.loopSwitch.credit.includes(R.loopSwitch.title), R.loopSwitch, "loop 'picked-riff', credit names its title");
  const Rc = R.record;
  g.check('recording is 48 kHz stereo', Rc.channels === 2 && Rc.sampleRate === rec.sampleRate && Rc.sampleRate === 48000, { channels: Rc.channels, sampleRate: Rc.sampleRate }, '2 channels at the context rate (48000)');
  g.check('recording length matches the audio clock', Math.abs(Rc.seconds - Rc.clockSeconds) <= 0.05 && Math.abs(Rc.seconds - 3) <= 0.15, { seconds: Rc.seconds, clockSeconds: Rc.clockSeconds }, '|wav - clock| <= 0.05 s and |wav - 3 s| <= 0.15 s');
  g.check('recording has signal in both channels', Rc.channelPeakDb.length === 2 && Rc.channelPeakDb.every((d) => d > -60), Rc.channelPeakDb, 'each channel peak > -60 dBFS');
  g.check('recording stays under the limiter ceiling', Rc.peakDb <= -0.9, Rc.peakDb, '<= -0.9 dBFS (limiter ceiling -1 dBFS + 0.1 dB)');
  const errors = logs.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]'));
  g.check('no console errors', errors.length === 0, errors.slice(0, 5), 'no [error] or [pageerror] entries');
} catch (e) {
  g.fail(e);
} finally {
  R.console = logs.slice(0, 30);
  const code = g.finish();
  fs.writeFileSync(path.join(out, 'live-check.json'), JSON.stringify(R, null, 1));
  console.log(JSON.stringify(R, null, 1));
  await browser?.close().catch(() => {});
  process.exitCode = code;
}
