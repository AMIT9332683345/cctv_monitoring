import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { loadGatewayConfig } from './config.mjs';
import { log } from './log.mjs';
import { lanAddresses } from './util.mjs';
import { loadOrCreateMasterKey, decryptSecret } from './secret.mjs';
import { openState } from './state.mjs';
import { buildRtspUrl, buildPlaybackUrl } from './adapters/dvr.mjs';
import { createGatewayAuth } from './auth.mjs';
import { createCameraService } from './cameras.mjs';
import { FfmpegService } from './ffmpeg.mjs';
import { BufferManager } from './buffer.mjs';
import { JobManager } from './jobs.mjs';
import { SyncAgent } from './sync.mjs';
import { createGatewayApi } from './api.mjs';
import { createStaticHandler } from './static.mjs';

const config = loadGatewayConfig();

for (const dir of [config.dataDir, config.hlsDir, config.bufferDir, config.mediaDir, path.join(config.mediaDir, 'exports'), config.tmpDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

const masterKey = loadOrCreateMasterKey(config.dataDir, process.env.GATEWAY_KEY);
const { state, save, audit } = await openState({ dataDir: config.dataDir });

const tv = {
  settings: () => state.settings,
  cameras: () => state.cameras,
  getCamera: (id) => state.cameras.find((c) => c.id === id) ?? null,
  dvrConfigured: () => Boolean(state.dvr.host && state.dvr.username && state.dvr.passwordEnc),
  dvrPassword: () => (state.dvr.passwordEnc ? decryptSecret(state.dvr.passwordEnc, masterKey) : ''),
  decrypt: (value) => decryptSecret(value, masterKey),
  rtspUrl: (camera) =>
    buildRtspUrl({
      dvr: state.dvr,
      channel: camera.channel,
      subtype: camera.subtype ?? 0,
      password: tv.dvrPassword(),
    }),
  playbackUrl: (camera, start, end) =>
    buildPlaybackUrl({
      dvr: state.dvr,
      channel: camera.channel,
      start,
      end,
      password: tv.dvrPassword(),
      timezone: state.settings.timezone,
    }),
};

const ffmpeg = new FfmpegService({ config, tv });
const buffer = new BufferManager({ config, ffmpeg, tv, saveState: save });
const jobs = new JobManager({ config, state, save, ffmpeg, buffer, tv, audit });
const auth = createGatewayAuth({ state, save, config, audit });
const cameras = createCameraService({ state, save, ffmpeg, tv, audit });
const sync = new SyncAgent({ config, state, save, ffmpeg, buffer, jobs, cameras, tv, audit });
jobs.setReporter((job) => sync.reportJob(job));

const api = createGatewayApi({ config, state, save, auth, audit, cameras, jobs, buffer, ffmpeg, sync, tv, masterKey });
const serveStatic = createStaticHandler({ config });

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "connect-src 'self'",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '));
  if (config.tlsCert && config.tlsKey) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  }
}

function corsForApi(req, res) {
  const origin = req.headers.origin;
  if (!origin || !config.allowedOrigins.includes(origin)) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Opps-Client, X-Gateway-Token');
    res.setHeader('Access-Control-Max-Age', '600');
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}

async function requestHandler(req, res) {
  securityHeaders(res);
  const pathname = (req.url ?? '/').split('?')[0];
  try {
    if (pathname.startsWith('/gapi/') && corsForApi(req, res)) return;
    if (await api(req, res)) return;
    if (await serveStatic(req, res)) return;
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  } catch (err) {
    log.error('gateway.unhandled_request_error', { path: pathname, method: req.method, error: err.message });
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { code: 'internal_error', message: 'Internal server error' } }));
    } else {
      res.end();
    }
  }
}

let server;
if (config.tlsCert && config.tlsKey) {
  server = https.createServer(
    { cert: fs.readFileSync(path.resolve(process.cwd(), config.tlsCert)), key: fs.readFileSync(path.resolve(process.cwd(), config.tlsKey)) },
    requestHandler,
  );
} else {
  server = http.createServer(requestHandler);
}
server.requestTimeout = 60_000;
server.headersTimeout = 20_000;
server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});
server.on('upgrade', (req, socket) => {
  socket.destroy();
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(config.port, config.host, resolve);
});

const scheme = config.tlsCert && config.tlsKey ? 'https' : 'http';
const lan = lanAddresses();
log.info('gateway.started', {
  version: config.version,
  port: config.port,
  host: config.host,
  dataDir: config.dataDir,
  staticDir: config.staticDir,
  frontendBuilt: fs.existsSync(path.join(config.staticDir, 'index.html')),
  cloudConfigured: Boolean(config.backendUrl && config.gatewayToken),
  dvrConfigured: tv.dvrConfigured(),
  lan: lan.all.map((iface) => `${scheme}://${iface.address}:${config.port}`),
});

buffer.startAll().catch((err) => log.warn('buffer.start_all_failed', { error: err.message }));
jobs.cleanupExpiredClips().catch((err) => log.warn('clip.cleanup_failed', { error: err.message }));
sync.start();

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('gateway.shutdown', { signal });
  server.close();
  sync.stop();
  jobs.shutdown();
  buffer.stopAll();
  await ffmpeg.shutdown().catch(() => {});
  await save().catch(() => {});
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => {
  log.error('gateway.unhandled_rejection', { error: err?.message ?? String(err) });
});
process.on('uncaughtException', (err) => {
  log.error('gateway.uncaught_exception', { error: err?.message ?? String(err) });
  shutdown('uncaughtException');
});
