#!/usr/bin/env node
// Build a self-contained static copy of the client into dist/ (for GitHub Pages or any static host).
// The static page has no game server behind it: players use Direct P2P (invite links) or type a server address.
// usage: node tools/build_static.mjs [--out dist] [--serve 8080]
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true] : []).filter(Boolean));
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(ROOT, args.out || 'dist');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const copyDir = (from, to, filter = () => true) => {
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, e.name), dst = path.join(to, e.name);
    if (e.isDirectory()) { copyDir(src, dst, filter); continue; }
    if (!filter(src)) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst);
  }
};
copyDir(path.join(ROOT, 'client'), path.join(OUT, 'client'), (f) => !f.endsWith('index.html'));
copyDir(path.join(ROOT, 'shared'), path.join(OUT, 'shared'));
copyDir(path.join(ROOT, 'maps'), path.join(OUT, 'maps'), (f) => f.endsWith('.js'));
// three.js: the core build plus only the addons the client imports (and their transitive imports)
const three = path.join(ROOT, 'node_modules/three');
fs.mkdirSync(path.join(OUT, 'vendor/three/build'), { recursive: true });
fs.copyFileSync(path.join(three, 'build/three.module.js'), path.join(OUT, 'vendor/three/build/three.module.js'));
const jsm = path.join(three, 'examples/jsm');
const needed = new Set(); const queue = [];
for (const f of fs.readdirSync(path.join(ROOT, 'client/render'))) {
  const s = fs.readFileSync(path.join(ROOT, 'client/render', f), 'utf8');
  for (const m of s.matchAll(/three\/addons\/([^'"]+)/g)) queue.push(m[1]);
}
while (queue.length) {
  const rel = queue.pop(); if (needed.has(rel)) continue; needed.add(rel);
  const file = path.join(jsm, rel); if (!fs.existsSync(file)) continue;
  const s = fs.readFileSync(file, 'utf8');
  for (const m of s.matchAll(/from\s+['"](\.\.?\/[^'"]+)['"]/g)) queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1])));
}
for (const rel of needed) {
  const src = path.join(jsm, rel); if (!fs.existsSync(src)) continue;
  const dst = path.join(OUT, 'vendor/three/examples/jsm', rel); fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst);
}
fs.mkdirSync(path.join(OUT, 'vendor/peerjs'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'node_modules/peerjs/dist/peerjs.min.js'), path.join(OUT, 'vendor/peerjs/peerjs.min.js'));
fs.copyFileSync(path.join(ROOT, 'client/index.html'), path.join(OUT, 'index.html'));
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
const size = (dir) => fs.readdirSync(dir, { withFileTypes: true }).reduce((a, e) => a + (e.isDirectory() ? size(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0);
console.log(`static build written to ${OUT} (${(size(OUT) / 1024 / 1024).toFixed(1)} MB, ${needed.size} three addon files)`);

if (args.serve) {
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.wav': 'audio/wav' };
  const port = +args.serve;
  http.createServer((req, res) => {
    let url = decodeURIComponent((req.url || '/').split('?')[0]); if (url === '/') url = '/index.html';
    const file = path.join(OUT, url);
    if (!file.startsWith(OUT)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' }); res.end(data);
    });
  }).listen(port, () => console.log(`static preview (no game server): http://localhost:${port}/`));
}
