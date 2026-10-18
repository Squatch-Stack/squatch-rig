#!/usr/bin/env node
// The public-release guard: scans EVERY file of a tree that is about to be published, binaries included, for what no
// public tree may hold whoever wrote it: home-directory paths, the secrets folder, private network addresses
// and the shapes of personal data (phone numbers, street addresses, account hosts and the like,
// from tools/register-shapes.json).
//
//   node tools/public-guard.mjs DIR            exit 1 and list every finding
//   node tools/public-guard.mjs --self-test    plant a failure in a scratch tree; exit 0 only if the guard catches it
//
// This guard knows no private NAME, on purpose: a list of names in a public tree is itself the leak. Names are checked
// only where the private register lives (the development repository and its exporters, tools/private-guard.mjs).
// Text files are scanned as text. Every file, whatever its extension, is also scanned as bytes: printable runs of five
// or more characters (what `strings -n 5` prints) are matched against the generic patterns, which catches paths left
// in .wasm data, comments in minified bundles, PNG tEXt and EXIF fields, and WAV LIST/INFO chunks.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Shapes } from './shape-reader.mjs';

// Generic patterns: found in text and in a binary's strings. Case-insensitive.
export const GENERIC_PATTERNS = [
  new RegExp(['\\/Us', 'ers\\/[^\\s/]'].join(''), 'i'), // a macOS home directory
  new RegExp(['\\/ho', 'me\\/[a-z][\\w.-]*\\/[.\\w]'].join(''), 'i'), // a Linux home directory
  new RegExp(['\\.secr', 'ets\\/'].join(''), 'i'), // the secrets folder
];
// Extra patterns for TEXT files only (digit runs and addresses are noise inside binaries).
export const TEXT_ONLY_PATTERNS = [/\b(?:192\.168|10\.\d{1,3})\.\d{1,3}\.\d{1,3}\b/];

const TEXT_EXT = /\.(?:html?|css|js|mjs|cjs|json|map|md|txt|svg|xml|yml|yaml|toml|sh|webmanifest|csv|cpp|h|patch)$/i;
const MIN_RUN = 5;

// Reviewed exceptions: [file regex, pattern source, reason]. Keep this list short; each entry needs a reason.
export const ALLOW = [
  // The shapes file is made of patterns, which match their own text.
  [/(?:^|\/)tools\/register-shapes\.json$/, '*', 'patterns match themselves'],
];

let shapes = null;
const loadShapes = () => (shapes ||= Shapes.load());

function stringsOf(buf) {
  const runs = [];
  let start = -1;
  for (let i = 0; i <= buf.length; i++) {
    const c = i < buf.length ? buf[i] : 0;
    const printable = c >= 0x20 && c < 0x7f;
    if (printable) { if (start < 0) start = i; continue; }
    if (start >= 0 && i - start >= MIN_RUN) runs.push(buf.toString('latin1', start, i));
    start = -1;
  }
  return runs;
}

function allowed(file, pattern) {
  return ALLOW.some(([f, p]) => f.test(file) && (p === '*' || p === pattern.source));
}

export function scanBuffer(file, buf) {
  const findings = [];
  const isText = TEXT_EXT.test(file);
  const add = (pattern, how, sample) => {
    if (!allowed(file, pattern)) findings.push({ file, pattern: String(pattern), how, sample: sample.slice(0, 80) });
  };
  if (isText) {
    const text = buf.toString('utf8');
    for (const p of [...GENERIC_PATTERNS, ...TEXT_ONLY_PATTERNS]) {
      const m = p.exec(text);
      if (m) add(p, 'text', text.slice(Math.max(0, m.index - 20), m.index + 40).replace(/\s+/g, ' '));
    }
    // Shapes of personal data. A finding names the rule and the line, never the matched text.
    for (const f of allowed(file, { source: '' }) ? [] : loadShapes().scanText(text, file)) findings.push({ file, pattern: f.rule, how: `shape ${f.kind}`, sample: `line ${f.line}` });
    return findings;
  }
  // Everything else is bytes: the printable runs, as `strings -n 5` prints them.
  const runs = stringsOf(buf);
  for (const p of GENERIC_PATTERNS) {
    for (const run of runs) {
      const m = p.exec(run);
      if (m) { add(p, 'strings', run.slice(Math.max(0, m.index - 20), m.index + 40)); break; }
    }
  }
  return findings;
}

export function scanTree(dir) {
  const findings = [];
  let files = 0;
  const walk = (d) => {
    for (const item of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, item.name);
      if (item.name === '.git') continue;
      // a link is never followed (it could point outside the tree) and never published
      if (item.isSymbolicLink()) { findings.push({ file: path.relative(dir, abs).split(path.sep).join('/'), pattern: 'symlink', how: 'link', sample: '' }); continue; }
      if (item.isDirectory()) walk(abs);
      else if (item.isFile()) {
        files++;
        findings.push(...scanBuffer(path.relative(dir, abs).split(path.sep).join('/'), fs.readFileSync(abs)));
      }
    }
  };
  walk(dir);
  return { files, findings };
}

// Plant each failure in a scratch tree and check the guard flags it, and that a clean tree passes. Returns problems.
// The planted values are fictional: a made-up home directory, a 555-01xx telephone number, a documentation-range address.
export function selfTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'public-guard-'));
  const problems = [];
  try {
    const HOME = ['/Us', 'ers/'].join(''); // pieces: this file is scanned with the tree it ships in
    const HOME_L = ['/ho', 'me/'].join('');
    const SECRETS = ['.secr', 'ets/'].join('');
    const wasmHeader = Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 0xff, 0]);
    const planted = {
      'wasm/nam.wasm': Buffer.concat([wasmHeader, Buffer.from(HOME + 'someone/build/nam.cpp'), Buffer.from([0, 0xfe])]),
      'img/pic.png': Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]), Buffer.from('tEXtComment\0made in ' + HOME_L + 'someone/art'), Buffer.from([0, 1])]),
      'audio/loop.wav': Buffer.concat([Buffer.from('RIFF....WAVE'), Buffer.from([0, 1]), Buffer.from('LIST....INFOISFT\0' + HOME + 'someone/render'), Buffer.from([0])]),
      'js/bundle.min.js': Buffer.from('var x=1;/* see ~/' + SECRETS + 'key */'),
      'notes.txt': Buffer.from('call (417) 555-' + '0142 after noon\n'),
      'net.json': Buffer.from('{"host":"' + ['192', '168', '7', '20'].join('.') + '"}'),
    };
    for (const [file, bytes] of Object.entries(planted)) {
      const dir = path.join(tmp, 'bad-' + file.replace(/\W+/g, '_'));
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), bytes);
      if (scanTree(dir).findings.length === 0) problems.push(`planted failure not caught: ${file}`);
    }
    const clean = path.join(tmp, 'clean');
    fs.mkdirSync(path.join(clean, 'wasm'), { recursive: true });
    fs.writeFileSync(path.join(clean, 'wasm/nam.wasm'), Buffer.concat([Buffer.from([0, 0x61, 0x73, 0x6d]), Buffer.from('lkA4lj\0a1a2a3a4a5a6\0create_experimental_fast_config\0')]));
    fs.writeFileSync(path.join(clean, 'index.html'), 'Squatch Rig, A2 and experimental fast paths. Tuned to A 440 Hz, 48000 samples per second, 2147483647.');
    const res = scanTree(clean);
    if (res.findings.length) problems.push(`clean tree flagged: ${JSON.stringify(res.findings)}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = process.argv[2];
  if (arg === '--self-test') {
    const problems = selfTest();
    for (const p of problems) console.error(`public-guard self-test: ${p}`);
    console.log(problems.length ? 'public-guard self-test FAILED' : 'public-guard self-test ok');
    process.exit(problems.length ? 1 : 0);
  }
  if (!arg) { console.error('usage: public-guard.mjs DIR | --self-test'); process.exit(2); }
  const { files, findings } = scanTree(path.resolve(arg));
  for (const f of findings) console.error(`public-guard: ${f.file}: ${f.pattern} (${f.how}): ${f.sample}`);
  console.log(`public-guard: ${files} files scanned, ${findings.length} finding(s)`);
  process.exit(findings.length ? 1 : 0);
}
