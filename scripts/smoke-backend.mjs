#!/usr/bin/env node
/**
 * End-to-end smoke test for the cloud backend.
 * Spawns a throwaway backend on a free port with the in-memory store,
 * then exercises auth, CORS, rate limiting, gateway task flow and audit.
 *
 * Hardware-dependent CCTV checks do not belong here; see smoke-gateway.mjs.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'smoke_secret_0123456789_abcdefghijklmnopqrstuvwxyz';
const SETUP_TOKEN = 'smoke_setup_token_1234567890';
const GATEWAY_TOKEN = 'smoke_gateway_token_1234567890';
const EMAIL = 'smoke.owner@example.com';
const PASSWORD = 'SmokeHorse2026!';
const NEW_PASSWORD = 'SmokeHorse2026x!';
const ALLOWED_ORIGIN = 'http://localhost:5173';

const results = [];
function record(status, name, detail = '') {
  results.push({ status, name, detail });
  const suffix = detail ? ` — ${detail}` : '';
  console.log(`${status.padEnd(5)} ${name}${suffix}`);
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
    if (child.exitCode !== null) throw new Error(`backend exited early (code ${child.exitCode})\n${logs()}`);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (res.status < 500) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`backend did not become healthy\n${logs()}`);
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
    if (opts.gatewayToken) headers['x-gateway-token'] = opts.gatewayToken;
    if (opts.client) headers['x-opps-client'] = 'web';
    if (opts.cookie) headers.cookie = opts.cookie;
    if (opts.origin) headers.origin = opts.origin;
    const res = await fetch(`${baseUrl}${route}`, {
      method,
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return {
      status: res.status,
      headers: res.headers,
      text,
      json,
      setCookies: res.headers.getSetCookie?.() ?? [],
    };
  };
}

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
let childLog = '';
const child = spawn(process.execPath, ['src/index.mjs'], {
  cwd: path.join(ROOT, 'backend'),
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(port),
    HOST: '127.0.0.1',
    AUTH_SECRET: SECRET,
    SETUP_TOKEN,
    GATEWAY_TOKEN,
    ALLOW_MEMORY_STORE: 'true',
    MONGODB_URI: '',
    MONGODB_DB: '',
    CORS_ORIGINS: ALLOWED_ORIGIN,
    COOKIE_SAMESITE: 'lax',
    COOKIE_SECURE: 'false',
    TRUST_PROXY: 'false',
    LOG_LEVEL: 'warn',
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
let gatewayTaskId = null;

try {
  console.log(`== OPPS CCTV backend smoke test (port ${port}) ==`);
  await waitFor(`${base}/healthz`, child, () => childLog);

  await check('health endpoint reports a working store', async () => {
    const res = await call('GET', '/healthz');
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.json?.ok === true, 'ok must be true');
    assert(res.json?.store === 'memory', `expected memory store, got ${res.json?.store}`);
  });

  await check('security headers are present on every response', async () => {
    const res = await call('GET', '/healthz');
    assert(res.headers.get('x-content-type-options') === 'nosniff', 'missing nosniff');
    assert(res.headers.get('x-frame-options') === 'DENY', 'missing frame deny');
    assert(res.headers.get('referrer-policy') === 'no-referrer', 'missing referrer policy');
    assert((res.headers.get('content-security-policy') ?? '').includes("default-src 'none'"), 'missing CSP');
    assert(res.headers.get('cache-control') === 'no-store', 'missing no-store');
    assert(res.headers.get('x-request-id'), 'missing request id');
  });

  await check('untrusted CORS origin is rejected before routing', async () => {
    const res = await call('GET', '/api/meta', { origin: 'https://evil.example' });
    assert(res.status === 403, `expected 403, got ${res.status}`);
    assert(res.json?.error?.code === 'cors_rejected', 'expected cors_rejected');
    assert(!res.headers.get('access-control-allow-origin'), 'must not echo the forbidden origin');
  });

  await check('preflight for the configured origin is allowed', async () => {
    const res = await call('OPTIONS', '/api/meta', { origin: ALLOWED_ORIGIN });
    assert(res.status === 204, `expected 204, got ${res.status}`);
    assert(res.headers.get('access-control-allow-origin') === ALLOWED_ORIGIN, 'origin not echoed');
    assert(res.headers.get('access-control-allow-credentials') === 'true', 'credentials flag missing');
  });

  await check('meta advertises locked-down registration', async () => {
    const res = await call('GET', '/api/meta');
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.json?.mode === 'cloud', 'mode must be cloud');
    assert(res.json?.setupRequired === true, 'setup should be required on a fresh store');
    assert(res.json?.registrationEnabled === false, 'registration must be disabled');
  });

  await check('setup rejects a wrong token and a weak password', async () => {
    const wrong = await call('POST', '/api/setup', {
      body: { setupToken: 'not-the-token-0000', email: EMAIL, password: PASSWORD },
    });
    assert(wrong.status === 401, `wrong token expected 401, got ${wrong.status}`);
    const weak = await call('POST', '/api/setup', {
      body: { setupToken: SETUP_TOKEN, email: EMAIL, password: 'short' },
    });
    assert(weak.status === 400, `weak password expected 400, got ${weak.status}`);
  });

  await check('setup requires a JSON content type', async () => {
    const res = await call('POST', '/api/setup', {
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ setupToken: SETUP_TOKEN, email: EMAIL, password: PASSWORD }),
    });
    assert(res.status === 415, `expected 415, got ${res.status}`);
  });

  await check('owner setup returns an access token and HttpOnly refresh cookie', async () => {
    const res = await call('POST', '/api/setup', {
      body: { setupToken: SETUP_TOKEN, email: EMAIL, password: PASSWORD },
    });
    assert(res.status === 201, `expected 201, got ${res.status}: ${res.text}`);
    assert(typeof res.json?.accessToken === 'string' && res.json.accessToken.split('.').length === 3, 'missing JWT');
    assert(res.json?.user?.email === EMAIL, 'email mismatch');
    const cookie = res.setCookies.find((c) => c.startsWith('opps_rt=')) ?? '';
    assert(cookie, 'refresh cookie missing');
    assert(/HttpOnly/i.test(cookie), 'refresh cookie must be HttpOnly');
    assert(/Path=\/api\/auth/i.test(cookie), 'refresh cookie path must be /api/auth');
    accessToken = res.json.accessToken;
    refreshToken = cookieValue(res.setCookies, 'opps_rt');
  });

  await check('registration is closed after the owner exists', async () => {
    const res = await call('POST', '/api/setup', {
      body: { setupToken: SETUP_TOKEN, email: 'second@example.com', password: PASSWORD },
    });
    assert(res.status === 409, `expected 409, got ${res.status}`);
  });

  await check('protected endpoints require a bearer token', async () => {
    for (const route of ['/api/auth/me', '/api/settings', '/api/gateway', '/api/audit', '/api/jobs']) {
      const res = await call('GET', route);
      assert(res.status === 401, `${route} expected 401, got ${res.status}`);
    }
  });

  await check('login rejects a wrong password and accepts the owner', async () => {
    const bad = await call('POST', '/api/auth/login', { body: { email: EMAIL, password: 'WrongHorse2026!' } });
    assert(bad.status === 401, `wrong password expected 401, got ${bad.status}`);
    const ok = await call('POST', '/api/auth/login', { body: { email: EMAIL, password: PASSWORD } });
    assert(ok.status === 200, `expected 200, got ${ok.status}: ${ok.text}`);
    assert(ok.json?.accessToken, 'missing access token');
    accessToken = ok.json.accessToken;
    refreshToken = cookieValue(ok.setCookies, 'opps_rt');
    assert(refreshToken, 'missing refresh cookie');
  });

  await check('refresh requires the CSRF client header and rotates the token', async () => {
    const noHeader = await call('POST', '/api/auth/refresh', { cookie: `opps_rt=${refreshToken}` });
    assert(noHeader.status === 401, `missing header expected 401, got ${noHeader.status}`);
    const first = await call('POST', '/api/auth/refresh', { client: true, cookie: `opps_rt=${refreshToken}` });
    assert(first.status === 200, `expected 200, got ${first.status}: ${first.text}`);
    const rotated = cookieValue(first.setCookies, 'opps_rt');
    assert(rotated && rotated !== refreshToken, 'refresh token was not rotated');
    const reused = await call('POST', '/api/auth/refresh', { client: true, cookie: `opps_rt=${refreshToken}` });
    assert(reused.status === 401, `reused token expected 401, got ${reused.status}`);
    refreshToken = rotated;
    accessToken = first.json.accessToken;
  });

  await check('authenticated profile resolves the owner', async () => {
    const res = await call('GET', '/api/auth/me', { token: accessToken });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.json?.user?.email === EMAIL, 'email mismatch');
  });

  await check('settings validate input and persist valid values', async () => {
    const empty = await call('PATCH', '/api/settings', { token: accessToken, body: {} });
    assert(empty.status === 400, `empty patch expected 400, got ${empty.status}`);
    const badTz = await call('PATCH', '/api/settings', { token: accessToken, body: { timezone: 'Mars/Olympus' } });
    assert(badTz.status === 400, `bad timezone expected 400, got ${badTz.status}`);
    const ok = await call('PATCH', '/api/settings', {
      token: accessToken,
      body: { timezone: 'Asia/Kolkata', defaultClipMinutes: 15 },
    });
    assert(ok.status === 200, `expected 200, got ${ok.status}`);
    assert(ok.json?.defaultClipMinutes === 15, 'setting not applied');
  });

  await check('unknown API routes do not leak filesystem content', async () => {
    const res = await call('GET', '/api/%2e%2e/%2e%2e/etc/passwd');
    assert(res.status === 404, `expected 404, got ${res.status}`);
    assert(/json/i.test(res.headers.get('content-type') ?? ''), 'expected JSON error');
    assert(!res.text.includes('root:'), 'path traversal leaked a file');
  });

  await check('gateway endpoints reject missing or wrong shared secret', async () => {
    const missing = await call('POST', '/api/gateway/heartbeat', { body: {} });
    assert(missing.status === 401, `missing token expected 401, got ${missing.status}`);
    const wrong = await call('POST', '/api/gateway/heartbeat', { gatewayToken: 'nope', body: {} });
    assert(wrong.status === 401, `wrong token expected 401, got ${wrong.status}`);
    const pull = await call('GET', '/api/gateway/task?gatewayId=gw-smoke', { gatewayToken: 'nope' });
    assert(pull.status === 401, `task pull expected 401, got ${pull.status}`);
  });

  await check('commands fail honestly before any gateway registers', async () => {
    const res = await call('POST', '/api/commands', {
      token: accessToken,
      body: { type: 'dvr.test', payload: {} },
    });
    assert(res.status === 409, `expected 409, got ${res.status}`);
    assert(res.json?.error?.code === 'gateway_unavailable', 'expected gateway_unavailable');
    const invalid = await call('POST', '/api/commands', {
      token: accessToken,
      body: { type: 'rm -rf', payload: {} },
    });
    assert(invalid.status === 400, `unsupported command expected 400, got ${invalid.status}`);
  });

  await check('gateway heartbeat registers the gateway and cameras', async () => {
    const res = await call('POST', '/api/gateway/heartbeat', {
      gatewayToken: GATEWAY_TOKEN,
      body: {
        gatewayId: 'gw-smoke',
        name: 'Smoke Gateway',
        version: '1.0.0',
        platform: 'win32 test',
        publicBaseUrl: 'https://gw.example.test',
        dvr: { configured: true, online: false, host: '192.168.1.108', port: 554, channels: 4, error: 'timeout' },
        storage: { freeBytes: 1000, totalBytes: 2000, clipsBytes: 10, bufferBytes: 20 },
        buffer: { enabled: false },
        cameras: [
          { id: 'cam-1', name: 'Front Door', channel: 1, enabled: true, online: false },
          { id: 'cam-2', name: 'Back Yard', channel: 2, enabled: true, online: false },
        ],
      },
    });
    assert(res.status === 200, `expected 200, got ${res.status}: ${res.text}`);
    assert(res.json?.ok === true, 'heartbeat not acknowledged');

    const status = await call('GET', '/api/gateway', { token: accessToken });
    assert(status.status === 200, `gateway status expected 200, got ${status.status}`);
    assert(status.json?.gateway?.online === true, 'gateway should be online');
    assert(status.json?.gateway?.dvr?.host === '192.168.1.108', 'dvr host missing');
    assert(status.json?.cameras?.total === 2, `expected 2 cameras, got ${status.json?.cameras?.total}`);
    assert(!JSON.stringify(status.json).includes('password'), 'gateway status leaked a credential field');
  });

  await check('queued command is pulled by the gateway and its result is stored', async () => {
    const queued = await call('POST', '/api/commands', {
      token: accessToken,
      body: { type: 'dvr.test', payload: { reason: 'smoke' } },
    });
    assert(queued.status === 202, `expected 202, got ${queued.status}: ${queued.text}`);
    assert(queued.json?.taskId, 'missing taskId');
    gatewayTaskId = queued.json.taskId;

    const empty = await call('GET', '/api/gateway/task?gatewayId=gw-other', { gatewayToken: GATEWAY_TOKEN });
    assert(empty.status === 204, `other gateway expected 204, got ${empty.status}`);

    const pulled = await call('GET', '/api/gateway/task?gatewayId=gw-smoke', { gatewayToken: GATEWAY_TOKEN });
    assert(pulled.status === 200, `expected 200, got ${pulled.status}`);
    assert(pulled.json?.task?.id === gatewayTaskId, 'pulled the wrong task');
    assert(pulled.json?.task?.type === 'dvr.test', 'task type mismatch');

    const reported = await call('POST', `/api/gateway/task/${gatewayTaskId}/result`, {
      gatewayToken: GATEWAY_TOKEN,
      body: { ok: true, data: { reachable: false, error: 'timeout' } },
    });
    assert(reported.status === 200, `result expected 200, got ${reported.status}`);

    const stored = await call('GET', `/api/commands/${gatewayTaskId}`, { token: accessToken });
    assert(stored.status === 200, `expected 200, got ${stored.status}`);
    assert(stored.json?.status === 'done', `expected done, got ${stored.json?.status}`);
    assert(stored.json?.result?.reachable === false, 'result payload was not stored');
  });

  await check('jobs and snapshots validate camera ids before queueing work', async () => {
    const job = await call('POST', '/api/jobs', {
      token: accessToken,
      body: {
        cameraId: 'missing-camera',
        start: new Date(Date.now() - 60_000).toISOString(),
        end: new Date(Date.now() - 30_000).toISOString(),
        source: 'buffer',
      },
    });
    assert(job.status === 404, `unknown camera expected 404, got ${job.status}`);

    const badRange = await call('POST', '/api/jobs', {
      token: accessToken,
      body: { cameraId: 'cam-1', start: 'not-a-date', end: 'also-not', source: 'auto' },
    });
    assert(badRange.status === 400, `bad range expected 400, got ${badRange.status}`);

    const badSource = await call('POST', '/api/jobs', {
      token: accessToken,
      body: {
        cameraId: 'cam-1',
        start: new Date(Date.now() - 60_000).toISOString(),
        end: new Date(Date.now() - 30_000).toISOString(),
        source: 'ftp',
      },
    });
    assert(badSource.status === 400, `bad source expected 400, got ${badSource.status}`);

    const snapshot = await call('POST', '/api/snapshots', { token: accessToken, body: { cameraId: 'cam-1' } });
    assert(snapshot.status === 200, `expected 200, got ${snapshot.status}: ${snapshot.text}`);
    assert(snapshot.json?.url?.startsWith('https://gw.example.test/media/snapshot/cam-1?token='), 'snapshot URL not signed against the gateway');
  });

  await check('audit log records setup, auth, settings and commands', async () => {
    const res = await call('GET', '/api/audit?limit=100', { token: accessToken });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const actions = (res.json?.entries ?? []).map((e) => e.action);
    for (const expected of ['owner.setup', 'login.success', 'command.queue', 'settings.update']) {
      assert(actions.includes(expected), `audit is missing ${expected}`);
    }
    const failed = (res.json?.entries ?? []).filter((e) => e.action === 'login.failed');
    assert(failed.length >= 1, 'failed login was not audited');
  });

  await check('password change invalidates existing access tokens', async () => {
    const wrong = await call('POST', '/api/auth/password', {
      token: accessToken,
      body: { currentPassword: 'WrongHorse2026!', newPassword: NEW_PASSWORD },
    });
    assert(wrong.status === 401, `wrong current password expected 401, got ${wrong.status}`);
    const ok = await call('POST', '/api/auth/password', {
      token: accessToken,
      body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    });
    assert(ok.status === 200, `expected 200, got ${ok.status}: ${ok.text}`);
    const stale = await call('GET', '/api/auth/me', { token: accessToken });
    assert(stale.status === 401, `old token expected 401, got ${stale.status}`);
    const oldLogin = await call('POST', '/api/auth/login', { body: { email: EMAIL, password: PASSWORD } });
    assert(oldLogin.status === 401, `old password expected 401, got ${oldLogin.status}`);
    const newLogin = await call('POST', '/api/auth/login', { body: { email: EMAIL, password: NEW_PASSWORD } });
    assert(newLogin.status === 200, `new password expected 200, got ${newLogin.status}: ${newLogin.text}`);
    accessToken = newLogin.json.accessToken;
    refreshToken = cookieValue(newLogin.setCookies, 'opps_rt');
  });

  await check('logout clears the refresh cookie and revokes the session', async () => {
    const res = await call('POST', '/api/auth/logout', {
      token: accessToken,
      client: true,
      cookie: `opps_rt=${refreshToken}`,
    });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.setCookies.some((c) => /^opps_rt=;/.test(c)), 'cookie was not cleared');
    const reuse = await call('POST', '/api/auth/refresh', { client: true, cookie: `opps_rt=${refreshToken}` });
    assert(reuse.status === 401, `revoked session expected 401, got ${reuse.status}`);
  });

  await check('login rate limiting kicks in after repeated failures', async () => {
    let limited = false;
    let last = 0;
    for (let i = 0; i < 12; i += 1) {
      const res = await call('POST', '/api/auth/login', { body: { email: EMAIL, password: `BruteForce${i}!` } });
      last = res.status;
      if (res.status === 429) {
        assert(res.headers.get('retry-after'), '429 without Retry-After');
        limited = true;
        break;
      }
      assert(res.status === 401, `unexpected status ${res.status} during brute force`);
    }
    assert(limited, `rate limiter never triggered (last status ${last})`);
  });
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
}

const passed = results.filter((r) => r.status === 'PASS').length;
const failed = results.filter((r) => r.status === 'FAIL');
console.log(`\nSummary: ${passed} passed, ${failed.length} failed`);
if (failed.length) {
  console.log('\nFailed checks:');
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  process.exitCode = 1;
}
