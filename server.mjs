// Static server for web/ (plus /design/ and /docs/), bound to loopback. AudioWorklet and getUserMedia need a secure
// context, and loopback counts as one. No build step: the browser loads the ES modules directly.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const PORT = +(process.env.PORT || 7491);
const HOST = process.env.HOST || '127.0.0.1';
// Longest prefix first; '/' (the app) last.
const MOUNTS = [
  ['/design/', path.join(root, 'design')],
  ['/docs/', path.join(root, 'docs')],
  ['/', path.join(root, 'web')],
];
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.map': 'application/json', '.wasm': 'application/wasm',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.nam': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2', '.webp': 'image/webp', '.mp4': 'video/mp4', '.md': 'text/plain; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.flac': 'audio/flac', '.pdf': 'application/pdf',
};

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let p = decodeURIComponent(url.pathname);
  // No dotfiles or dot-directories (the demo checkout has a .git).
  if (p.split('/').some((seg) => seg.startsWith('.'))) { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found'); return; }
  const [prefix, dir] = MOUNTS.find(([m]) => p.startsWith(m));
  let file = path.normalize(path.join(dir, p.slice(prefix.length)));
  if (file !== dir && !file.startsWith(dir + path.sep)) { res.writeHead(403).end(); return; }
  if (p.endsWith('/')) file = path.join(file, 'index.html');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found'); return; }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      'content-length': st.size,
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}).listen(PORT, HOST, () => console.log(`squatch-rig on http://${HOST}:${PORT}`));
