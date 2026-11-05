// Serves a build the way GitHub Pages does: under the repo's path, with 404.html (and a 404
// status) for anything else, so client-side routes only work through that fallback.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const root = process.env.PAGES_ROOT ?? 'dist/brew-focus/browser';
const base = process.env.PAGES_BASE ?? '/BrewFocus/';
const port = Number(process.env.PAGES_PORT ?? 5078);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
};

function send(res, status, file) {
  res.writeHead(status, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
}

createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://local').pathname);
  if (path === '/health') return void res.writeHead(200).end('ok');
  if (path.startsWith(base)) {
    const file = join(root, normalize(path.slice(base.length)).replace(/^(\.\.[/\\])+/, ''));
    if (existsSync(file)) {
      if (statSync(file).isFile()) return send(res, 200, file);
      const index = join(file, 'index.html');
      if (existsSync(index)) {
        // Pages redirects a folder to its trailing slash, so routes go through that here too.
        if (!path.endsWith('/')) return void res.writeHead(301, { Location: `${path}/` }).end();
        return send(res, 200, index);
      }
    }
  }
  send(res, 404, join(root, '404.html'));
}).listen(port, '127.0.0.1');
