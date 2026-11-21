import fs from 'node:fs';
import path from 'node:path';
import { log } from './log.mjs';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

const MISSING_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OPPS CCTV gateway</title>
<style>
body{background:#0a0e13;color:#e6edf5;font-family:ui-sans-serif,system-ui,Segoe UI,Arial;margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}
main{max-width:620px;background:#111823;border:1px solid #223041;border-radius:16px;padding:28px}
h1{font-size:20px;margin:0 0 12px;color:#67e8f9;letter-spacing:.02em}
code{background:#0b1118;border:1px solid #223041;border-radius:6px;padding:2px 6px;color:#a5f3fc}
p{line-height:1.6;color:#b6c3d1}
ol{line-height:1.9;color:#c8d4e1}
</style></head>
<body><main>
<h1>Gateway is running — dashboard not built yet</h1>
<p>The gateway API is alive and local authentication is available, but this machine has no production frontend build at the configured static directory.</p>
<ol>
<li>From the project root run <code>npm run build</code></li>
<li>Restart the gateway (or just reload this page)</li>
<li>Open <code>http://localhost:8089</code></li>
</ol>
<p>API health: <a style="color:#67e8f9" href="/gapi/health">/gapi/health</a></p>
</main></body></html>`;

export function createStaticHandler({ config }) {
  const dist = config.staticDir;
  const indexFile = path.join(dist, 'index.html');

  function sendFile(req, res, file, { cacheControl }) {
    const ext = path.extname(file).toLowerCase();
    const stat = fs.statSync(file);
    res.writeHead(200, {
      'Content-Type': TYPES[ext] ?? 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': cacheControl,
      'Last-Modified': stat.mtime.toUTCString(),
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(file).pipe(res);
  }

  return async function serveStatic(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const url = new URL(req.url, 'http://localhost');
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return false;
    }
    if (pathname === '/robots.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('User-agent: *\nDisallow: /\n');
      return true;
    }
    if (!fs.existsSync(indexFile)) {
      if (pathname !== '/' && path.extname(pathname)) return false;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(MISSING_PAGE);
      return true;
    }
    const isAsset = pathname.startsWith('/assets/');
    if (pathname !== '/' && !isAsset) {
      const candidate = path.resolve(dist, `.${pathname}`);
      if (candidate === path.resolve(dist) || !candidate.startsWith(path.resolve(dist) + path.sep)) {
        return false;
      }
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        sendFile(req, res, candidate, { cacheControl: 'public, max-age=300' });
        return true;
      }
      if (path.extname(pathname)) return false;
    }
    if (isAsset) {
      const candidate = path.resolve(dist, `.${pathname}`);
      if (!candidate.startsWith(path.resolve(dist) + path.sep) || !fs.existsSync(candidate)) return false;
      sendFile(req, res, candidate, { cacheControl: 'public, max-age=31536000, immutable' });
      return true;
    }
    try {
      sendFile(req, res, indexFile, { cacheControl: 'no-store' });
      return true;
    } catch (err) {
      log.error('static.index_failed', { error: err.message });
      return false;
    }
  };
}
