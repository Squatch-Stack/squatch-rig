// Copy browser builds of runtime dependencies into web/vendor (no bundler).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'web/vendor');
fs.mkdirSync(out, { recursive: true });
const pixiDist = path.join(root, 'node_modules/pixi.js/dist');
for (const f of ['pixi.min.mjs', 'pixi.min.mjs.map']) {
  const src = path.join(pixiDist, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(out, f.replace('pixi.min', 'pixi')));
}
fs.copyFileSync(path.join(root, 'node_modules/pixi.js/LICENSE'), path.join(out, 'LICENSE-pixi.js.txt'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/pixi.js/package.json'), 'utf8'));
console.log(`vendored pixi.js ${pkg.version} -> web/vendor`);
