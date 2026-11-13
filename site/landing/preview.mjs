// Optional local preview; no dependencies, build step or production runtime.
// Usage from the repository root: node site/landing/preview.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, resolve, sep } from 'node:path';
const root = fileURLToPath(new URL('.', import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
const server = createServer(async (request, response) => {
  let path;
  try { path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); }
  catch { response.writeHead(400).end('Bad request'); return; }
  if (path === '/en') { response.writeHead(308, { Location: '/en/' }).end(); return; }
  if (path.endsWith('/')) path += 'index.html';
  const file = resolve(root, '.' + path);
  if (!file.startsWith(resolve(root) + sep) || !types[extname(file)]) { response.writeHead(404).end('Not found'); return; }
  try {
    const bytes = await readFile(file);
    response.writeHead(200, { 'Content-Type': types[extname(file)], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(bytes);
  } catch { response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found in this static preview. Panel and legal routes are served by the application.'); }
});
server.listen(4173, '127.0.0.1', () => console.log('Jeeta landing preview: http://127.0.0.1:4173/'));
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
