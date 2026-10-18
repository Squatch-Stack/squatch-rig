// Reads tools/register-shapes.json: the SHAPES of personal data (phone numbers, street addresses, private network
// addresses, home paths, account hosts, and the like) plus the few documented exceptions. It holds patterns only and
// names nothing. The public guard uses it, so a clone of this repository, or its CI, checks the same shapes.
// Standard library only.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SHAPES_FILE = path.join(HERE, 'register-shapes.json');

// '*' also matches '/', '?' one character: the same fnmatch the register uses
const globRx = (g) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
const pathGlob = (p, g) => globRx(g).test(p) || globRx('*/' + g.replace(/^[*/]+/, '')).test('/' + p);
const flagsOf = (s) => ((s || '').includes('i') ? 'i' : '');

export class Shapes {
  constructor(doc) {
    if (!doc || doc.version !== 1 || !Array.isArray(doc.patterns) || doc.patterns.length < 5) {
      throw new Error('register-shapes.json is missing or empty: refusing (fail closed)');
    }
    this.rules = doc.patterns.map((p) => ({ id: p.id, kind: p.kind, severity: p.severity || 'block', scope: p.scope || 'all', rx: new RegExp(p.re, flagsOf(p.flags)) }));
    this.allows = (doc.allow || []).map((a) => ({
      ids: a.ids || ['*'], paths: a.paths || [],
      text: (a.text || []).map((t) => new RegExp(t, 'i')), match: (a.match || []).map((t) => new RegExp(t, 'i')),
    }));
  }

  static load(file = SHAPES_FILE) {
    let doc;
    try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error(`cannot read ${file}: refusing (fail closed)`); }
    return new Shapes(doc);
  }

  names(a, rule) { return a.ids.includes('*') || a.ids.includes(rule.id) || a.ids.includes(rule.kind); }

  coveredByPath(a, rule, p, line) {
    if (a.match.length || !this.names(a, rule)) return false;
    const okPath = a.paths.length > 0 && a.paths.some((g) => pathGlob(p, g));
    const okText = a.text.length > 0 && a.text.some((t) => t.test(line));
    return a.paths.length && a.text.length ? okPath && okText : okPath || okText;
  }

  // an allowance with `match` excuses individual matches (the matched text only)
  uncoveredSpan(rule, p, line) {
    const spans = this.allows.filter((a) => a.match.length && this.names(a, rule) && (!a.paths.length || a.paths.some((g) => pathGlob(p, g))));
    if (!spans.length) return true;
    const rx = new RegExp(rule.rx.source, rule.rx.flags.includes('g') ? rule.rx.flags : `${rule.rx.flags}g`);
    return [...line.matchAll(rx)].some((m) => !spans.some((a) => a.match.some((t) => t.test(m[0]))));
  }

  /** Blocking findings in a text, as { rule, kind, line }. The matched text is never kept. */
  scanText(text, file) {
    const out = [];
    text.split('\n').forEach((raw, i) => {
      const line = raw.length > 4000 ? raw.slice(0, 4000) : raw;
      for (const r of this.rules) {
        if (r.severity !== 'block' || !r.rx.test(line)) continue;
        if (this.allows.some((a) => this.coveredByPath(a, r, file, line)) || !this.uncoveredSpan(r, file, line)) continue;
        out.push({ rule: r.id, kind: r.kind, line: i + 1 });
      }
    });
    return out;
  }
}
