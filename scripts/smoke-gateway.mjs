#!/usr/bin/env node
/**
 * End-to-end smoke test for the local Windows gateway.
 * Spawns a throwaway gateway with a temporary data directory, then exercises
 * setup, auth, DVR guards, live/media token rules, FFmpeg HLS self-test and a
 * synthetic rolling-buffer export (labeled synthetic: it is testsrc footage,
 * not CCTV).
 *
 * Anything that needs the real CP Plus DVR stays NOT TESTED here.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { signJwt } from '../gateway/src/crypto.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'smoke_gateway_secret_0123456789_abcdefghijklmnop';
const SETUP_TOKEN = 'smoke_gateway_setup_1234567890';
const EMAIL = 'smoke.gateway@example.com';
const PASSWORD = 'GatewayHorse2026!';
const NEW_PASSWORD = 'GatewayHorse2026x!';
const DVR_PASSWORD = 'DvrPass12345!';
const ALLOWED_ORIGIN = 'http://localhost:5173';
const DVR_HOST = '10.255.255.254';

const results = [];
function record(status, name, detail = '') {
  results.push({ status, name, detail });
  console.log(`${status.padEnd(5)} ${name}${detail ? ` — ${detail}` : ''}`);
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
async function check(name, fn) {
  try {
    await fn();
    record('PASS', name);
  } catch (err) {
    record('FAIL', name, err.message);
  }
}
function skip(name, reason) {
  record('SKIP', name, reason);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(url, child, logs, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`gateway exited early (code ${child.exitCode})\n${logs()}`);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (res.status < 500) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`gateway did not become healthy\n${logs()}`);
}

function cookieValue(setCookies, name) {
  for (const raw of setCookies ?? []) {
    const match = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(raw);
    if (match) return decodeURIComponent(match[1]);
  }
  return null;
}

function makeClient(baseUrl) {
  return async function call(method, route, opts = {}) {
    const headers = { ...(opts.headers ?? {}) };
    let body;
    if (opts.body !== undefined) {
      headers['content-type'] = headers['content-type'] ?? 'application/json';
      body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    }
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (opts.client) headers['x-opps-client'] = 'web';
    if (opts.cookie) headers.cookie = opts.cookie;
    if (opts.origin) headers.origin = opts.origin;
    const res = await fetch(`${baseUrl}${route}`, {
      method,
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(opts.timeoutMs ?? 90_000),
    });
    const buffer = Buffer.from(await res.arrayBuffer());
    let json = null;
    try {
      json = JSON.parse(buffer.toString('utf8'));
    } catch {
      json = null;
    }
    return {
      status: res.status,
      headers: res.headers,
      text: buffer.toString('utf8'),
      buffer,
      json,
      setCookies: res.headers.getSetCookie?.() ?? [],
    };
  };
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.trim().split(/\r?\n/).pop() ?? ''}`));
    });
  });
}

function segmentName(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.ts`;
}

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opps-gw-smoke-'));
const staticDir = path.join(dataDir, 'static-not-built');
let childLog = '';
const child = spawn(process.execPath, ['src/index.mjs'], {
  cwd: path.join(ROOT, 'gateway'),
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    NODE_ENV: 'test',
    GATEWAY_PORT: String(port),
    GATEWAY_HOST: '127.0.0.1',
    GATEWAY_DATA_DIR: dataDir,
    STATIC_DIR: staticDir,
    AUTH_SECRET: SECRET,
    GATEWAY_SETUP_TOKEN: SETUP_TOKEN,
    GATEWAY_ALLOWED_ORIGINS: ALLOWED_ORIGIN,
    COOKIE_SECURE: 'false',
    BACKEND_URL: '',
    GATEWAY_TOKEN: '',
    LOG_LEVEL: 'warn',
    MAX_STREAMS: '1',
  },
});
child.stdout.on('data', (chunk) => {
  childLog += chunk.toString();
});
child.stderr.on('data', (chunk) => {
  childLog += chunk.toString();
});

const call = makeClient(base);
let accessToken = null;
let refreshToken = null;
let cameraId = null;
let clipUrl = null;

try {
  console.log(`== OPPS CCTV gateway smoke test (port ${port}, data ${dataDir}) ==`);
  await waitFor(`${base}/gapi/health`, child, () => childLog);

  await check('health endpoint identifies gateway mode before setup', async () => {
    const res = await call('GET', '/gapi/health');
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.json?.mode === 'gateway', 'mode must be gateway');
    assert(res.json?.setupRequired === true, 'setup should be required on a fresh data dir');
    assert(res.json?.cloudConnected === false, 'cloud must not be claimed as connected');
  });

  await check('security headers protect gateway pages and API', async () => {
    const res = await call('GET', '/gapi/health');
    assert(res.headers.get('x-content-type-options') === 'nosniff', 'missing nosniff');
    assert(res.headers.get('x-frame-options') === 'DENY', 'missing frame deny');
    const csp = res.headers.get('content-security-policy') ?? '';
    assert(csp.includes("default-src 'self'"), 'missing default-src');
    assert(csp.includes("frame-ancestors 'none'"), 'missing frame-ancestors');
  });

  await check('CORS only echoes the configured origin', async () => {
    const preflight = await call('OPTIONS', '/gapi/health', { origin: ALLOWED_ORIGIN });
    assert(preflight.status === 204, `allowed preflight expected 204, got ${preflight.status}`);
    assert(preflight.headers.get('access-control-allow-origin') === ALLOWED_ORIGIN, 'allowed origin not echoed');
    const evil = await call('GET', '/gapi/meta', { origin: 'https://evil.example' });
    assert(evil.status === 200, 'read-only meta should still respond');
    assert(!evil.headers.get('access-control-allow-origin'), 'forbidden origin must not be echoed');
  });

  await check('unauthenticated API and media requests are refused', async () => {
    for (const route of ['/gapi/status', '/gapi/settings', '/gapi/dvr', '/gapi/cameras', '/gapi/audit']) {
      const res = await call('GET', route);
      assert(res.status === 401, `${route} expected 401, got ${res.status}`);
    }
    const media = await call('GET', '/stream/live/whatever/index.m3u8');
    assert(media.status === 401, `unauthenticated live expected 401, got ${media.status}`);
    const clip = await call('GET', '/media/clip/whatever');
    assert(clip.status === 401, `unauthenticated clip expected 401, got ${clip.status}`);
    const garbage = await call('GET', '/gapi/status', { token: 'not.a.jwt' });
    assert(garbage.status === 401, `garbage token expected 401, got ${garbage.status}`);
  });

  await check('owner setup is allowed from loopback on a fresh gateway', async () => {
    const res = await call('POST', '/gapi/auth/setup', {
      body: { email: EMAIL, password: PASSWORD },
    });
    assert(res.status === 201, `expected 201, got ${res.status}: ${res.text}`);
    assert(res.json?.accessToken, 'missing access token');
    assert(res.json?.user?.local === true, 'gateway user must be local');
    const cookie = res.setCookies.find((c) => c.startsWith('opps_rt=')) ?? '';
    assert(/HttpOnly/i.test(cookie), 'refresh cookie must be HttpOnly');
    assert(/Path=\/gapi\/auth/i.test(cookie), 'refresh cookie path must be /gapi/auth');
    accessToken = res.json.accessToken;
    refreshToken = cookieValue(res.setCookies, 'opps_rt');
  });

  await check('a second owner cannot be registered', async () => {
    const res = await call('POST', '/gapi/auth/setup', {
      body: { setupToken: SETUP_TOKEN, email: 'other@example.com', password: PASSWORD },
    });
    assert(res.status === 409, `expected 409, got ${res.status}`);
  });

  await check('login rejects a wrong password and accepts the owner', async () => {
    const bad = await call('POST', '/gapi/auth/login', { body: { email: EMAIL, password: 'WrongHorse2026!' } });
    assert(bad.status === 401, `wrong password expected 401, got ${bad.status}`);
    const ok = await call('POST', '/gapi/auth/login', { body: { email: EMAIL, password: PASSWORD } });
    assert(ok.status === 200, `expected 200, got ${ok.status}: ${ok.text}`);
    assert(ok.json?.accessToken, 'missing access token');
    accessToken = ok.json.accessToken;
    refreshToken = cookieValue(ok.setCookies, 'opps_rt');
    assert(refreshToken, 'missing refresh cookie');
  });

  await check('refresh requires the CSRF header and rotates the token', async () => {
    const noHeader = await call('POST', '/gapi/auth/refresh', { cookie: `opps_rt=${refreshToken}` });
    assert(noHeader.status === 403, `missing header expected 403, got ${noHeader.status}`);
    const first = await call('POST', '/gapi/auth/refresh', { client: true, cookie: `opps_rt=${refreshToken}` });
    assert(first.status === 200, `expected 200, got ${first.status}: ${first.text}`);
    const rotated = cookieValue(first.setCookies, 'opps_rt');
    assert(rotated && rotated !== refreshToken, 'refresh token was not rotated');
    const reused = await call('POST', '/gapi/auth/refresh', { client: true, cookie: `opps_rt=${refreshToken}` });
    assert(reused.status === 401, `reused token expected 401, got ${reused.status}`);
    refreshToken = rotated;
    accessToken = first.json.accessToken;
  });

  await check('gateway status never includes the DVR password', async () => {
    const res = await call('GET', '/gapi/status', { token: accessToken });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.json, 'status must be JSON');
    const text = res.text;
    assert(!text.includes('passwordEnc'), 'leaked passwordEnc');
    assert(!text.includes(DVR_PASSWORD), 'leaked DVR password');
  });

  await check('SSRF guard rejects public DVR hosts', async () => {
    for (const host of ['8.8.8.8', 'example.com', 'http://192.168.1.108', 'user@192.168.1.108']) {
      const res = await call('PUT', '/gapi/dvr', {
        token: accessToken,
        body: { host, username: 'dvradmin', password: DVR_PASSWORD },
      });
      assert(res.status === 400, `host ${host} expected 400, got ${res.status}`);
    }
  });

  await check('DVR template validation blocks host and whitespace injection', async () => {
    const hostOverride = await call('PUT', '/gapi/dvr', {
      token: accessToken,
      body: { host: '192.168.1.108', rtspTemplate: 'rtsp://evil.example/x?channel={ch}' },
    });
    assert(hostOverride.status === 400, `host override expected 400, got ${hostOverride.status}`);
    const whitespace = await call('PUT', '/gapi/dvr', {
      token: accessToken,
      body: { host: '192.168.1.108', rtspTemplate: '/cam/realmonitor?channel={ch} -i evil' },
    });
    assert(whitespace.status === 400, `whitespace template expected 400, got ${whitespace.status}`);
  });

  await check('DVR details save without exposing the password', async () => {
    const res = await call('PUT', '/gapi/dvr', {
      token: accessToken,
      body: {
        host: '192.168.1.108',
        rtspPort: 554,
        httpPort: 80,
        username: 'dvradmin',
        password: DVR_PASSWORD,
        channels: 4,
        rtspTemplate: '/cam/realmonitor?channel={ch}&subtype={sub}',
        playbackTemplate: '/cam/playback?channel={ch}&subtype=0&starttime={start}&endtime={end}',
        onvif: false,
      },
    });
    assert(res.status === 200, `expected 200, got ${res.status}: ${res.text}`);
    assert(res.json?.hasPassword === true, 'hasPassword should be true');
    assert(!('passwordEnc' in (res.json ?? {})), 'passwordEnc leaked');
    assert(!res.text.includes(DVR_PASSWORD), 'DVR password leaked');
    assert(res.json?.capabilities?.rtspLive === true, 'RTSP capability should be reported');
    assert(res.json?.capabilities?.dvrPlayback === true, 'playback capability should be reported');
  });

  await check('cameras can be added, labelled, and guarded against duplicate channels', async () => {
    const created = await call('POST', '/gapi/cameras', {
      token: accessToken,
      body: { camera: { name: 'Synthetic Test Camera', channel: 1, buffer: false } },
    });
    assert(created.status === 201, `expected 201, got ${created.status}: ${created.text}`);
    cameraId = created.json?.camera?.id;
    assert(cameraId, 'missing camera id');
    const duplicate = await call('POST', '/gapi/cameras', {
      token: accessToken,
      body: { camera: { name: 'Duplicate', channel: 1 } },
    });
    assert(duplicate.status === 409, `duplicate channel expected 409, got ${duplicate.status}`);
    const list = await call('GET', '/gapi/cameras', { token: accessToken });
    assert(list.json?.cameras?.length === 1, 'expected exactly one camera');
    assert(list.json?.cameras?.[0]?.name === 'Synthetic Test Camera', 'camera name mismatch');
  });

  await check('live start refuses to fake a stream when the DVR is unreachable', async () => {
    const missing = await call('POST', '/gapi/live/missing-camera', { token: accessToken });
    assert(missing.status === 404, `missing camera expected 404, got ${missing.status}`);
    const live = await call('POST', `/gapi/live/${cameraId}`, { token: accessToken });
    assert(live.status === 504, `unreachable DVR must time out honestly, got ${live.status}: ${live.text}`);
    assert(live.json?.error?.code === 'stream_timeout', 'expected stream_timeout');
    assert(!live.json?.url, 'no stream URL may be returned on failure');

    const liveToken = signJwt(
      { sub: 'local', kind: 'live', cid: cameraId },
      { secret: SECRET, expiresInSec: 60, issuer: 'opps-gateway', audience: 'media' },
    ).token;
    const unsigned = await call('GET', `/stream/live/${cameraId}/index.m3u8`);
    assert(unsigned.status === 401, `unsigned playlist expected 401, got ${unsigned.status}`);
    const wrongCamera = await call('GET', `/stream/live/other-camera/index.m3u8?token=${encodeURIComponent(liveToken)}`);
    assert(wrongCamera.status === 401, `token bound to another camera expected 401, got ${wrongCamera.status}`);
    const wrongKind = signJwt(
      { sub: 'local', kind: 'clip', jid: cameraId },
      { secret: SECRET, expiresInSec: 60, issuer: 'opps-gateway', audience: 'media' },
    ).token;
    const crossed = await call('GET', `/stream/live/${cameraId}/index.m3u8?token=${encodeURIComponent(wrongKind)}`);
    assert(crossed.status === 401, `clip token must not open a live stream, got ${crossed.status}`);
  });

  await check('media tokens cannot escape the export directory', async () => {
    const forgedClip = signJwt(
      { sub: 'local', kind: 'clip', jid: '../../state' },
      { secret: SECRET, expiresInSec: 60, issuer: 'opps-gateway', audience: 'media' },
    ).token;
    const clip = await call('GET', `/media/clip/${encodeURIComponent('../../state')}?token=${encodeURIComponent(forgedClip)}`);
    assert(clip.status === 404, `traversal clip expected 404, got ${clip.status}`);
    assert(!clip.text.includes('owner'), 'clip response leaked state content');
    const forgedSnapshot = signJwt(
      { sub: 'local', kind: 'snapshot', cid: '../../state' },
      { secret: SECRET, expiresInSec: 60, issuer: 'opps-gateway', audience: 'media' },
    ).token;
    const snapshot = await call('GET', `/media/snapshot/${encodeURIComponent('../../state')}?token=${encodeURIComponent(forgedSnapshot)}`);
    assert(snapshot.status === 404, `traversal snapshot expected 404, got ${snapshot.status}`);
  });

  let ffmpegOk = false;
  const sys = await call('GET', '/gapi/system', { token: accessToken });
  ffmpegOk = sys.status === 200 && sys.json?.ffmpeg?.ok === true;
  if (!ffmpegOk) {
    skip('FFmpeg HLS self-test produces fMP4 segments from a synthetic source', 'ffmpeg binary not available');
  } else {
    await check('FFmpeg HLS self-test produces fMP4 segments from a synthetic source', async () => {
      const res = await call('POST', '/gapi/system/selftest', { token: accessToken, timeoutMs: 60_000 });
      assert(res.status === 200, `expected 200, got ${res.status}: ${res.text}`);
      assert(res.json?.ok === true, 'self-test failed');
      assert(res.json?.segments >= 1, 'no HLS segments were produced');
      assert(res.json?.ffmpeg?.ok === true, 'ffmpeg version check failed');
    });
  }

  if (!ffmpegOk) {
    skip('synthetic buffer export produces a playable MP4', 'ffmpeg is not installed');
  } else {
    await check('synthetic buffer export produces a playable MP4 with range support', async () => {
      const startMs = Math.floor((Date.now() - 120_000) / 1000) * 1000;
      const bufferDir = path.join(dataDir, 'buffer', String(cameraId).replace(/[^A-Za-z0-9_-]/g, '_'));
      fs.mkdirSync(bufferDir, { recursive: true });
      const pattern = path.join(bufferDir, 'synth%d.ts').replace(/\\/g, '/');
      await runFfmpeg([
        '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=15',
        '-t', '30',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '15',
        '-f', 'segment', '-segment_time', '10', '-reset_timestamps', '1',
        '-segment_format', 'mpegts', pattern,
      ]);
      const segments = fs.readdirSync(bufferDir).filter((n) => /^synth\d+\.ts$/.test(n)).sort();
      assert(segments.length >= 3, `expected 3 synthetic segments, got ${segments.length}`);
      segments.slice(0, 3).forEach((name, index) => {
        const at = startMs + index * 10_000;
        const target = path.join(bufferDir, segmentName(at));
        fs.renameSync(path.join(bufferDir, name), target);
        fs.utimesSync(target, new Date(at + 10_000), new Date(at + 10_000));
      });

      const patch = await call('PATCH', '/gapi/buffer', {
        token: accessToken,
        body: { bufferEnabled: true, bufferRetentionMinutes: 60 },
      });
      assert(patch.status === 200, `enabling buffer expected 200, got ${patch.status}: ${patch.text}`);
      assert(patch.json?.enabled === true, 'buffer was not enabled');

      const queued = await call('POST', '/gapi/jobs', {
        token: accessToken,
        body: {
          cameraId,
          start: new Date(startMs + 2_000).toISOString(),
          end: new Date(startMs + 27_000).toISOString(),
          source: 'buffer',
        },
      });
      assert(queued.status === 202, `expected 202, got ${queued.status}: ${queued.text}`);
      const jobId = queued.json?.job?.id;
      assert(jobId, 'missing job id');

      let job = null;
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const res = await call('GET', `/gapi/jobs/${jobId}`, { token: accessToken });
        job = res.json?.job ?? null;
        if (job && ['completed', 'failed'].includes(job.status)) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      assert(job, 'export job disappeared');
      assert(job.status === 'completed', `export failed: ${job.error ?? job.status}`);
      assert(job.file?.source === 'buffer', `expected buffer source, got ${job.file?.source}`);
      assert(job.file?.sizeBytes > 0, 'exported file is empty');
      assert(job.mediaUrl, 'completed job has no media URL');

      clipUrl = job.mediaUrl;
      const inline = await call('GET', clipUrl);
      assert(inline.status === 200, `clip download expected 200, got ${inline.status}`);
      assert(inline.headers.get('content-type') === 'video/mp4', 'clip content type mismatch');
      assert(inline.buffer.length > 10_000, 'clip is too small to be real output');
      const ranged = await call('GET', clipUrl, { headers: { range: 'bytes=0-1023' } });
      assert(ranged.status === 206, `range request expected 206, got ${ranged.status}`);
      assert(ranged.buffer.length === 1024, `range length expected 1024, got ${ranged.buffer.length}`);
      assert(/^bytes 0-1023\//.test(ranged.headers.get('content-range') ?? ''), 'bad Content-Range');
      const download = await call('GET', `${clipUrl}&download=1`);
      assert(/attachment/.test(download.headers.get('content-disposition') ?? ''), 'download disposition missing');
      assert(/opps-/.test(download.headers.get('content-disposition') ?? ''), 'download filename missing');

      const removed = await call('DELETE', `/gapi/jobs/${jobId}`, { token: accessToken });
      assert(removed.status === 200, `delete expected 200, got ${removed.status}`);
      assert(removed.json?.job?.status === 'deleted', 'job was not marked deleted');
      const gone = await call('GET', clipUrl);
      assert(gone.status === 404, `deleted clip expected 404, got ${gone.status}`);
      clipUrl = null;
    });

    await check('buffer export rejects ranges the buffer does not hold', async () => {
      const queued = await call('POST', '/gapi/jobs', {
        token: accessToken,
        body: {
          cameraId,
          start: new Date(Date.now() - 10 * 60_000).toISOString(),
          end: new Date(Date.now() - 9 * 60_000).toISOString(),
          source: 'buffer',
        },
      });
      assert(queued.status === 202, `expected 202, got ${queued.status}`);
      const jobId = queued.json?.job?.id;
      let job = null;
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const res = await call('GET', `/gapi/jobs/${jobId}`, { token: accessToken });
        job = res.json?.job ?? null;
        if (job && ['completed', 'failed'].includes(job.status)) break;
        await new Promise((r) => setTimeout(r, 300));
      }
      assert(job?.status === 'failed', `out-of-range export should fail, got ${job?.status}`);
      assert(/buffer/i.test(job.error ?? ''), `failure should name the buffer: ${job?.error}`);
      await call('DELETE', `/gapi/jobs/${jobId}`, { token: accessToken });
    });
  }

  await check('audit log captures setup, config, camera and export events', async () => {
    const res = await call('GET', '/gapi/audit?limit=200', { token: accessToken });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const actions = (res.json?.entries ?? []).map((e) => e.action);
    for (const expected of ['owner.setup', 'login.success', 'dvr.save', 'camera.created']) {
      assert(actions.includes(expected), `audit is missing ${expected}`);
    }
    if (ffmpegOk) assert(actions.includes('export.completed'), 'audit is missing export.completed');
    assert(!res.text.includes(DVR_PASSWORD), 'audit leaked the DVR password');
  });

  await check('password change invalidates the current session', async () => {
    const res = await call('POST', '/gapi/auth/password', {
      token: accessToken,
      body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    });
    assert(res.status === 200, `expected 200, got ${res.status}: ${res.text}`);
    const stale = await call('GET', '/gapi/auth/me', { token: accessToken });
    assert(stale.status === 401, `old token expected 401, got ${stale.status}`);
    const oldLogin = await call('POST', '/gapi/auth/login', { body: { email: EMAIL, password: PASSWORD } });
    assert(oldLogin.status === 401, `old password expected 401, got ${oldLogin.status}`);
    const newLogin = await call('POST', '/gapi/auth/login', { body: { email: EMAIL, password: NEW_PASSWORD } });
    assert(newLogin.status === 200, `new password expected 200, got ${newLogin.status}: ${newLogin.text}`);
    accessToken = newLogin.json.accessToken;
  });

  await check('gateway login rate limiting blocks brute force', async () => {
    let limited = false;
    for (let i = 0; i < 12; i += 1) {
      const res = await call('POST', '/gapi/auth/login', { body: { email: EMAIL, password: `Brute${i}Horse!` } });
      if (res.status === 429) {
        assert(res.headers.get('retry-after'), '429 without Retry-After');
        limited = true;
        break;
      }
      assert(res.status === 401, `unexpected status ${res.status} during brute force`);
    }
    assert(limited, 'gateway rate limiter never triggered');
  });

  record('NOT TESTED', 'real CP Plus DVR live view, ONVIF discovery, playback export', 'requires the physical DVR, credentials and LAN access');
  record('NOT TESTED', 'rolling buffer captures from a real RTSP stream', 'requires the physical DVR (synthetic pipeline covered above)');
} catch (err) {
  record('FAIL', 'suite aborted', err.message);
} finally {
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 3000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  try {
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } catch (err) {
    console.log(`WARN  could not remove temp data dir: ${err.message}`);
  }
}

const passed = results.filter((r) => r.status === 'PASS').length;
const failed = results.filter((r) => r.status === 'FAIL');
const skipped = results.filter((r) => r.status === 'SKIP').length;
console.log(`\nSummary: ${passed} passed, ${failed.length} failed, ${skipped} skipped`);
if (failed.length) {
  console.log('\nFailed checks:');
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  process.exitCode = 1;
}
