#!/usr/bin/env node
// Check that a README's Mermaid diagrams and images say what the code does.
//
//   node tools/check-readme-diagrams.mjs README.md [--root DIR] [--workflows a.yml,b.yml]
//
// The diagrams are drawn by hand, so this compares the FACTS behind them with the code, never the pictures. Node ids carry
// the fact (a diagram may use any of them):
//   n_<type>[_2]  a device of the demo rig, in signal order: the `chain` of web/js/graph/demo-public.js
//   f_<name>      a source file: web/js/{audio,graph,ui}/<name>.js, web/worklets/<name>.js or tools/<name>.mjs must exist
//   k_<name>      an effect kernel: the drawn set must equal web/worklets/dsp/*.js, less the helpers (fxrun, oversample, svf, util)
//   j_<job>       a workflow job: the drawn set must equal the top-level jobs of the given workflow files
// Every relative image the README embeds must exist, and so must every plate it shows (design/assets/plates/*.svg), all of
// them. Exit 1 with a list of differences. tests/readme-diagrams.test.mjs plants one of each and requires a failure.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HELPERS = new Set(['fxrun', 'oversample', 'svf', 'util']);
const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const fences = (md) => [...md.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1]);
const ids = (diagrams, prefix) => {
  const seen = [];
  for (const d of diagrams) for (const m of d.matchAll(new RegExp(`\\b${prefix}_([a-z0-9_]+)\\b`, 'g'))) if (!seen.includes(m[1])) seen.push(m[1]);
  return seen;
};
const list = (dir, re) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => re.test(f)).map((f) => f.replace(re, '')).sort() : []);

function chainTypes(root) {
  const src = fs.readFileSync(path.join(root, 'web/js/graph/demo-public.js'), 'utf8');
  const block = src.slice(src.indexOf('const chain = ['), src.indexOf('];', src.indexOf('const chain = [')));
  return [...block.matchAll(/add\('([a-z]+)'/g)].map((m) => m[1]);
}
function jobs(files, root) {
  return files.flatMap((f) => {
    const text = fs.readFileSync(path.resolve(root, f), 'utf8');
    const body = text.split(/\njobs:\n/)[1] || '';
    return [...body.matchAll(/^ {2}([a-z][a-z0-9-]*):\s*$/gm)].map((m) => m[1].replace(/-/g, '_'));
  }).sort();
}
const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

export function check(readmePath, root, workflows = []) {
  const md = fs.readFileSync(readmePath, 'utf8');
  const diagrams = fences(md);
  const problems = [];
  if (!diagrams.length) problems.push('the README has no mermaid diagrams');
  const n = ids(diagrams, 'n').map((id) => id.replace(/_\d+$/, ''));
  if (n.length && JSON.stringify(n) !== JSON.stringify(chainTypes(root))) problems.push(`devices: the diagram shows ${n} but the demo rig's chain is ${chainTypes(root)}`);
  for (const f of ids(diagrams, 'f')) {
    const name = f.replace(/_/g, '-');
    const found = ['web/js/audio', 'web/js/graph', 'web/js/ui', 'web/worklets', 'tools'].some((d) => ['.js', '.mjs'].some((e) => fs.existsSync(path.join(root, d, name + e))));
    if (!found) problems.push(`files: f_${f} is drawn but no such file exists`);
  }
  const k = ids(diagrams, 'k');
  const kernels = list(path.join(root, 'web/worklets/dsp'), /\.js$/).filter((x) => !HELPERS.has(x));
  if (k.length && !sameSet(k, kernels)) problems.push(`kernels: the diagram shows ${k.sort()} but web/worklets/dsp has ${kernels}`);
  const j = ids(diagrams, 'j');
  if (workflows.length && !sameSet(j, jobs(workflows, root))) problems.push(`jobs: the diagram shows ${j.sort()} but the workflows have ${jobs(workflows, root)}`);
  for (const [, ref] of md.matchAll(/(?:src|srcset)="([^"#?]+)"/g)) {
    if (!/^[a-z]+:/.test(ref) && !fs.existsSync(path.resolve(path.dirname(readmePath), ref)) && !fs.existsSync(path.join(root, ref))) problems.push(`images: ${ref} does not exist`);
  }
  const shown = [...md.matchAll(/design\/assets\/plates\/([a-z0-9-]+)\.svg/g)].map((m) => m[1]);
  const plates = list(path.join(root, 'design/assets/plates'), /\.svg$/);
  if (shown.length && !sameSet(new Set(shown), plates)) problems.push(`plates: the README shows ${[...new Set(shown)].sort()} but design/assets/plates has ${plates}`);
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
  const readme = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
  const problems = check(path.resolve(readme), path.resolve(flag('--root') || here), (flag('--workflows') || '').split(',').filter(Boolean));
  for (const p of problems) console.log('FAIL', p);
  console.log('check-readme-diagrams:', problems.length ? 'FAIL' : 'ok');
  process.exit(problems.length ? 1 : 0);
}
