import {
  badRequest,
  clientIp,
  createRouter,
  HttpError,
  notFound,
  parseCookies,
  query,
  readJson,
  sendError,
  sendJson,
  tooMany,
  unauthorized,
  rateLimiter,
} from './http.mjs';
import { newId, signJwt } from './crypto.mjs';
import { createAuthService, createGatewayGuard, publicUser } from './services/auth.mjs';
import { log } from './log.mjs';

const COMMAND_TYPES = new Set([
  'camera.save',
  'camera.delete',
  'dvr.discover',
  'dvr.test',
  'dvr.scan',
  'settings.update',
  'buffer.update',
  'clip.delete',
]);

const JOB_SOURCES = new Set(['auto', 'dvr', 'buffer']);
const MAX_CLIP_SECONDS = 6 * 60 * 60;

export function createApp({ store, config }) {
  const gatewayGuard = createGatewayGuard(config);

  const audit = ({ actor, action, ip, ua, meta }) =>
    store.appendAudit({
      id: newId(),
      ts: new Date().toISOString(),
      actor,
      action,
      ip: ip ?? null,
      ua: ua ? String(ua).slice(0, 200) : null,
      meta: meta ?? null,
    });

  const auth = createAuthService({ store, config, audit });

  const limiters = {
    global: rateLimiter({ windowMs: 60_000, max: 600, scope: 'global', keyFn: (req) => clientIp(req, config.trustProxy) }),
    login: rateLimiter({ windowMs: 15 * 60_000, max: 10, scope: 'login' }),
    setup: rateLimiter({ windowMs: 15 * 60_000, max: 5, scope: 'setup' }),
    refresh: rateLimiter({ windowMs: 15 * 60_000, max: 120, scope: 'refresh' }),
    export: rateLimiter({ windowMs: 60 * 60_000, max: 30, scope: 'export' }),
    command: rateLimiter({ windowMs: 60 * 60_000, max: 120, scope: 'command' }),
  };

  function ctx(req) {
    return {
      ip: clientIp(req, config.trustProxy),
      ua: req.headers['user-agent'],
    };
  }

  async function requireOwner(req) {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const owner = token ? await auth.ownerFromAccessToken(token) : null;
    if (!owner) throw unauthorized();
    return owner;
  }

  const requireOwnerChecked = requireOwner;

  async function gatewayDoc() {
    const gateways = await store.listGateways();
    return gateways.sort((a, b) => String(b.lastHeartbeat ?? '').localeCompare(String(a.lastHeartbeat ?? '')))[0] ?? null;
  }

  function gatewayOnline(gateway) {
    if (!gateway?.lastHeartbeat) return false;
    return Date.now() - Date.parse(gateway.lastHeartbeat) < config.gatewayOnlineWindowSec * 1000;
  }

  function mediaUrlFor(job, gateway, owner) {
    if (!gateway?.publicBaseUrl || !job?.file?.sizeBytes) return null;
    const { token } = signJwt(
      { sub: owner.id, kind: 'clip', jid: job.id },
      {
        secret: config.authSecret,
        expiresInSec: 600,
        issuer: config.jwtIssuer,
        audience: 'media',
      },
    );
    return {
      mediaUrl: `${gateway.publicBaseUrl.replace(/\/+$/, '')}/media/clip/${encodeURIComponent(job.id)}?token=${encodeURIComponent(token)}`,
    };
  }

  async function decorateJob(job, owner, gateway) {
    if (!job) return null;
    const extra = job.status === 'completed' ? mediaUrlFor(job, gateway, owner) : null;
    return { ...job, ...(extra ?? {}) };
  }

  const routes = [
    {
      method: 'GET',
      path: '/healthz',
      handler: async (req, res) => {
        let storeOk = true;
        try {
          await store.getOwner();
        } catch {
          storeOk = false;
        }
        sendJson(res, storeOk ? 200 : 503, {
          ok: storeOk,
          store: store.kind,
          version: config.version,
          uptimeSec: Math.round(process.uptime()),
          time: new Date().toISOString(),
        });
      },
    },
    {
      method: 'GET',
      path: '/api/meta',
      handler: async (req, res) => {
        const owner = await store.getOwner();
        sendJson(res, 200, {
          mode: 'cloud',
          version: config.version,
          setupRequired: !owner,
          registrationEnabled: false,
          auth: {
            totpEnabled: Boolean(owner?.totpEnabled),
            refreshCookie: 'opps_rt',
          },
          limits: { maxClipHours: MAX_CLIP_SECONDS / 3600 },
        });
      },
    },
    {
      method: 'POST',
      path: '/api/setup',
      handler: async (req, res) => {
        limiters.setup.check(clientIp(req, config.trustProxy));
        const body = await readJson(req);
        const result = await auth.setup({ setupToken: body.setupToken, email: body.email, password: body.password }, ctx(req));
        res.setHeader('Set-Cookie', auth.cookieHeader(result.refreshToken));
        await audit({ ...ctx(req), actor: result.owner.id, action: 'setup.completed', meta: { email: result.owner.email } });
        sendJson(res, 201, { accessToken: result.accessToken, expiresIn: result.expiresIn, user: result.user });
      },
    },
    {
      method: 'POST',
      path: '/api/auth/login',
      handler: async (req, res) => {
        const ip = clientIp(req, config.trustProxy);
        limiters.login.check(ip);
        const body = await readJson(req);
        limiters.login.check(`email:${String(body.email ?? '').toLowerCase().slice(0, 120)}`);
        const result = await auth.login(
          { email: body.email, password: body.password, totpCode: body.totpCode },
          ctx(req),
        );
        res.setHeader('Set-Cookie', auth.cookieHeader(result.refreshToken));
        sendJson(res, 200, { accessToken: result.accessToken, expiresIn: result.expiresIn, user: result.user });
      },
    },
    {
      method: 'POST',
      path: '/api/auth/refresh',
      handler: async (req, res) => {
        limiters.refresh.check(clientIp(req, config.trustProxy));
        if (req.headers['x-opps-client'] !== 'web') throw unauthorized('Missing client header');
        const cookies = parseCookies(req);
        const result = await auth.refresh(cookies.opps_rt);
        res.setHeader('Set-Cookie', auth.cookieHeader(result.refreshToken));
        sendJson(res, 200, { accessToken: result.accessToken, expiresIn: result.expiresIn, user: result.user });
      },
    },
    {
      method: 'POST',
      path: '/api/auth/logout',
      handler: async (req, res) => {
        if (req.headers['x-opps-client'] !== 'web') throw unauthorized('Missing client header');
        let owner = null;
        try {
          owner = await requireOwner(req);
        } catch {
          owner = null;
        }
        await auth.logout(owner?.id, ctx(req));
        res.setHeader('Set-Cookie', auth.clearedCookie());
        sendJson(res, 200, { ok: true });
      },
    },
    {
      method: 'GET',
      path: '/api/auth/me',
      handler: async (req, res) => {
        const owner = await requireOwnerChecked(req);
        sendJson(res, 200, { user: publicUser(owner) });
      },
    },
    {
      method: 'POST',
      path: '/api/auth/password',
      handler: async (req, res) => {
        const owner = await requireOwnerChecked(req);
        const body = await readJson(req);
        await auth.changePassword(
          owner.id,
          { currentPassword: body.currentPassword, newPassword: body.newPassword },
          ctx(req),
        );
        res.setHeader('Set-Cookie', auth.clearedCookie());
        sendJson(res, 200, { ok: true, message: 'Password changed. All sessions were signed out.' });
      },
    },
    {
      method: 'POST',
      path: '/api/auth/2fa/setup',
      handler: async (req, res) => {
        const owner = await requireOwnerChecked(req);
        const result = await auth.beginTotp(owner.id, ctx(req));
        sendJson(res, 200, result);
      },
    },
    {
      method: 'POST',
      path: '/api/auth/2fa/enable',
      handler: async (req, res) => {
        const owner = await requireOwnerChecked(req);
        const body = await readJson(req);
        await auth.enableTotp(owner.id, { secret: body.secret, code: body.code }, ctx(req));
        sendJson(res, 200, { ok: true });
      },
    },
    {
      method: 'POST',
      path: '/api/auth/2fa/disable',
      handler: async (req, res) => {
        const owner = await requireOwnerChecked(req);
        const body = await readJson(req);
        await auth.disableTotp(owner.id, { password: body.password, code: body.code }, ctx(req));
        res.setHeader('Set-Cookie', auth.clearedCookie());
        sendJson(res, 200, { ok: true });
      },
    },
    {
      method: 'GET',
      path: '/api/settings',
      handler: async (req, res) => {
        await requireOwnerChecked(req);
        const settings = (await store.getSettings()) ?? {};
        sendJson(res, 200, {
          timezone: settings.timezone ?? 'Asia/Kolkata',
          defaultClipMinutes: settings.defaultClipMinutes ?? 15,
          bufferRetentionMinutes: settings.bufferRetentionMinutes ?? 60,
        });
      },
    },
    {
      method: 'PATCH',
      path: '/api/settings',
      handler: async (req, res) => {
        const owner = await requireOwnerChecked(req);
        const body = await readJson(req);
        const patch = {};
        if (body.timezone !== undefined) {
          const tz = String(body.timezone);
          if (tz.length > 64) throw badRequest('Invalid timezone');
          try {
            new Intl.DateTimeFormat('en-US', { timeZone: tz });
          } catch {
            throw badRequest('Unknown timezone');
          }
          patch.timezone = tz;
        }
        if (body.defaultClipMinutes !== undefined) {
          const n = Number(body.defaultClipMinutes);
          if (!Number.isInteger(n) || n < 1 || n > 180) throw badRequest('defaultClipMinutes must be 1-180');
          patch.defaultClipMinutes = n;
        }
        if (body.bufferRetentionMinutes !== undefined) {
          const n = Number(body.bufferRetentionMinutes);
          if (!Number.isInteger(n) || n < 5 || n > 1440) throw badRequest('bufferRetentionMinutes must be 5-1440');
          patch.bufferRetentionMinutes = n;
        }
        if (!Object.keys(patch).length) throw badRequest('No supported settings supplied');
        const saved = await store.updateSettings(patch);
        await audit({ ...ctx(req), actor: owner.id, action: 'settings.update', meta: { keys: Object.keys(patch) } });
        sendJson(res, 200, {
          timezone: saved.timezone,
          defaultClipMinutes: saved.defaultClipMinutes,
          bufferRetentionMinutes: saved.bufferRetentionMinutes,
        });
      },
    },
    {
      method: 'GET',
      path: '/api/cameras',
      handler: async (req, res) => {
        await requireOwnerChecked(req);
        const cameras = await store.listCameras();
        sendJson(res, 200, { cameras });
      },
    },
    {
      method: 'GET',
      path: '/api/gateway',
      handler: async (req, res) => {
        await requireOwnerChecked(req);
        const gateway = await gatewayDoc();
        const cameras = await store.listCameras();
        const online = gatewayOnline(gateway);
        sendJson(res, 200, {
          gateway: gateway
            ? {
                id: gateway.id,
                name: gateway.name,
                version: gateway.version,
                platform: gateway.platform,
                publicBaseUrl: gateway.publicBaseUrl ?? null,
                lastHeartbeat: gateway.lastHeartbeat,
                online,
                dvr: gateway.dvr ?? null,
                storage: gateway.storage ?? null,
                buffer: gateway.buffer ?? null,
                connectionMode: online ? 'cloud-relay' : 'offline',
              }
            : null,
          cameras: {
            total: cameras.length,
            online: cameras.filter((c) => c.online).length,
          },
        });
      },
    },
    {
      method: 'POST',
      path: '/api/commands',
      handler: async (req, res) => {
        const owner = await requireOwnerChecked(req);
        limiters.command.check(owner.id);
        const body = await readJson(req);
        const type = String(body.type ?? '');
        if (!COMMAND_TYPES.has(type)) throw badRequest('Unsupported command type');
        const payload = body.payload ?? {};
        if (JSON.stringify(payload).length > 16_384) throw badRequest('Command payload too large');
        const gateway = await gatewayDoc();
        if (!gateway) throw new HttpError(409, 'gateway_unavailable', 'No gateway has registered with this backend yet');
        if (!gatewayOnline(gateway)) {
          throw new HttpError(409, 'gateway_offline', 'Gateway is offline. Start it on the Windows PC and check Tailscale.');
        }
        const task = {
          id: newId(),
          gatewayId: gateway.id,
          type,
          payload,
          status: 'pending',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        await store.createTask(task);
        await audit({ ...ctx(req), actor: owner.id, action: 'command.queue', meta: { type, taskId: task.id } });
        sendJson(res, 202, { taskId: task.id, status: task.status });
      },
    },
    {
      method: 'GET',
      path: '/api/commands/:id',
      handler: async (req, res, params) => {
        await requireOwnerChecked(req);
        const task = await store.getTask(params.id);
        if (!task) throw notFound('Command not found');
        sendJson(res, 200, {
          id: task.id,
          type: task.type,
          status: task.status,
          result: task.result ?? null,
          error: task.error ?? null,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
        });
      },
    },
    {
      method: 'GET',
      path: '/api/jobs',
      handler: async (req, res) => {
        const owner = await requireOwnerChecked(req);
        const limit = Math.min(Math.max(Number(query(req).get('limit') ?? 50), 1), 200);
        const jobs = await store.listJobs(limit);
        const gateway = await gatewayDoc();
        const decorated = await Promise.all(jobs.map((job) => decorateJob(job, owner, gateway)));
        sendJson(res, 200, { jobs: decorated.filter(Boolean) });
      },
    },
    {
      method: 'POST',
      path: '/api/jobs',
      handler: async (req, res) => {
        const owner = await requireOwnerChecked(req);
        limiters.export.check(owner.id);
        const body = await readJson(req);
        const camera = await store.getCamera(String(body.cameraId ?? ''));
        if (!camera) throw notFound('Camera not found. Refresh cameras and try again.');
        const { start, end, durationSec } = parseRange(body.start, body.end);
        const source = String(body.source ?? 'auto');
        if (!JOB_SOURCES.has(source)) throw badRequest('source must be auto, dvr, or buffer');
        const gateway = await gatewayDoc();
        if (!gateway) throw new HttpError(409, 'gateway_unavailable', 'No gateway has registered yet');
        if (!gatewayOnline(gateway)) throw new HttpError(409, 'gateway_offline', 'Gateway is offline');
        const job = {
          id: newId(),
          gatewayId: gateway.id,
          cameraId: camera.id,
          cameraName: camera.name,
          channel: camera.channel,
          start,
          end,
          durationSec,
          source,
          status: 'queued',
          progress: 0,
          error: null,
          file: null,
          requestedBy: owner.id,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        await store.createJob(job);
        await store.createTask({
          id: newId(),
          gatewayId: gateway.id,
          type: 'export',
          payload: { jobId: job.id, cameraId: camera.id, start, end, source },
          status: 'pending',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        await audit({
          ...ctx(req),
          actor: owner.id,
          action: 'job.create',
          meta: { jobId: job.id, cameraId: camera.id, start, end, source },
        });
        sendJson(res, 201, { job });
      },
    },
    {
      method: 'GET',
      path: '/api/jobs/:id',
      handler: async (req, res, params) => {
        const owner = await requireOwnerChecked(req);
        const job = await store.getJob(params.id);
        if (!job) throw notFound('Export not found');
        const gateway = await gatewayDoc();
        sendJson(res, 200, { job: await decorateJob(job, owner, gateway) });
      },
    },
    {
      method: 'DELETE',
      path: '/api/jobs/:id',
      handler: async (req, res, params) => {
        const owner = await requireOwnerChecked(req);
        const job = await store.getJob(params.id);
        if (!job) throw notFound('Export not found');
        if (['queued', 'running', 'deleting'].includes(job.status)) {
          throw new HttpError(409, 'job_busy', 'Wait for the export to finish before deleting it');
        }
        const gateway = await gatewayDoc();
        if (!gateway || !gatewayOnline(gateway)) {
          throw new HttpError(409, 'gateway_offline', 'The gateway must be online to delete the local file');
        }
        await store.updateJob(job.id, { status: 'deleting' });
        await store.createTask({
          id: newId(),
          gatewayId: gateway.id,
          type: 'clip.delete',
          payload: { jobId: job.id },
          status: 'pending',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        await audit({ ...ctx(req), actor: owner.id, action: 'job.delete', meta: { jobId: job.id } });
        sendJson(res, 202, { ok: true, status: 'deleting' });
      },
    },
    {
      method: 'POST',
      path: '/api/snapshots',
      handler: async (req, res) => {
        const owner = await requireOwnerChecked(req);
        const body = await readJson(req);
        const camera = await store.getCamera(String(body.cameraId ?? ''));
        if (!camera) throw notFound('Camera not found');
        const gateway = await gatewayDoc();
        if (!gateway || !gatewayOnline(gateway)) throw new HttpError(409, 'gateway_offline', 'Gateway is offline');
        if (!gateway.publicBaseUrl) throw new HttpError(409, 'gateway_url_missing', 'Gateway has no public base URL configured');
        const { token } = signJwt(
          { sub: owner.id, kind: 'snapshot', cid: camera.id },
          { secret: config.authSecret, expiresInSec: 120, issuer: config.jwtIssuer, audience: 'media' },
        );
        sendJson(res, 200, {
          url: `${gateway.publicBaseUrl.replace(/\/+$/, '')}/media/snapshot/${encodeURIComponent(camera.id)}?token=${encodeURIComponent(token)}`,
          camera: { id: camera.id, name: camera.name },
        });
      },
    },
    {
      method: 'GET',
      path: '/api/audit',
      handler: async (req, res) => {
        await requireOwnerChecked(req);
        const limit = Math.min(Math.max(Number(query(req).get('limit') ?? 100), 1), 500);
        const entries = await store.listAudit(limit);
        sendJson(res, 200, { entries });
      },
    },

    // ---- Gateway-facing endpoints (shared-secret authenticated) ----
    {
      method: 'POST',
      path: '/api/gateway/heartbeat',
      handler: async (req, res) => {
        gatewayGuard(req);
        const body = await readJson(req, { limit: 128 * 1024 });
        const gatewayId = sanitizeId(body.gatewayId) || 'gw-primary';
        const cameras = sanitizeCameras(body.cameras);
        const now = new Date().toISOString();
        const doc = {
          id: gatewayId,
          name: str(body.name, 80) || 'Home gateway',
          version: str(body.version, 32) || 'unknown',
          platform: str(body.platform, 120) || 'unknown',
          publicBaseUrl: sanitizeBaseUrl(body.publicBaseUrl),
          dvr: sanitizeDvr(body.dvr),
          storage: sanitizeStorage(body.storage),
          buffer: sanitizeBuffer(body.buffer),
          lastHeartbeat: now,
          updatedAt: now,
        };
        if (body.firstSeen) doc.createdAt = str(body.firstSeen, 40);
        await store.upsertGateway(doc);
        await store.replaceCameras(gatewayId, cameras);
        sendJson(res, 200, {
          ok: true,
          serverTime: now,
          gatewayId,
          onlineWindowSec: config.gatewayOnlineWindowSec,
        });
      },
    },
    {
      method: 'GET',
      path: '/api/gateway/task',
      handler: async (req, res) => {
        gatewayGuard(req);
        const gatewayId = sanitizeId(query(req).get('gatewayId')) || 'gw-primary';
        const task = await store.claimNextTask(gatewayId);
        if (!task) {
          res.writeHead(204);
          res.end();
          return;
        }
        sendJson(res, 200, { task });
      },
    },
    {
      method: 'POST',
      path: '/api/gateway/task/:id/result',
      handler: async (req, res, params) => {
        gatewayGuard(req);
        const body = await readJson(req, { limit: 128 * 1024 });
        const task = await store.getTask(params.id);
        if (!task) throw notFound('Task not found');
        const status = body.ok ? 'done' : 'failed';
        await store.completeTask(task.id, {
          status,
          result: body.data ?? null,
          error: body.ok ? null : str(body.error, 500) || 'Gateway reported failure',
        });
        if (task.type === 'clip.delete' && body.ok) {
          await store.updateJob(String(task.payload?.jobId ?? ''), { status: 'deleted' });
        }
        sendJson(res, 200, { ok: true });
      },
    },
    {
      method: 'POST',
      path: '/api/gateway/jobs',
      handler: async (req, res) => {
        gatewayGuard(req);
        const body = await readJson(req, { limit: 64 * 1024 });
        const job = sanitizeJob(body.job ?? body);
        if (!job.id) throw badRequest('job.id is required');
        const existing = await store.getJob(job.id);
        if (existing) {
          await store.updateJob(job.id, job);
        } else {
          await store.createJob({ ...job, gatewayId: job.gatewayId ?? 'gw-primary', requestedBy: job.requestedBy ?? null });
        }
        sendJson(res, 200, { ok: true });
      },
    },
    {
      method: 'POST',
      path: '/api/gateway/jobs/:id/status',
      handler: async (req, res, params) => {
        gatewayGuard(req);
        const body = await readJson(req, { limit: 64 * 1024 });
        const job = await store.getJob(params.id);
        if (!job) throw notFound('Export job not found');
        const patch = {};
        if (body.status !== undefined) {
          if (!['queued', 'running', 'completed', 'failed', 'deleting', 'deleted'].includes(body.status)) {
            throw badRequest('Invalid job status');
          }
          patch.status = body.status;
        }
        if (body.progress !== undefined) {
          const n = Number(body.progress);
          if (!Number.isFinite(n)) throw badRequest('Invalid progress');
          patch.progress = Math.max(0, Math.min(100, Math.round(n)));
        }
        if (body.error !== undefined) patch.error = str(body.error, 600) || null;
        if (body.file !== undefined) {
          const file = body.file ?? {};
          patch.file = {
            sizeBytes: Math.max(0, Number(file.sizeBytes) || 0),
            durationSec: Math.max(0, Number(file.durationSec) || 0),
            source: JOB_SOURCES.has(file.source) ? file.source : 'buffer',
            createdAt: str(file.createdAt, 40) || new Date().toISOString(),
          };
        }
        const updated = await store.updateJob(job.id, patch);
        if (patch.status === 'completed') {
          await audit({ actor: 'gateway', action: 'job.completed', meta: { jobId: job.id, source: patch.file?.source } });
        }
        if (patch.status === 'failed') {
          await audit({ actor: 'gateway', action: 'job.failed', meta: { jobId: job.id, error: patch.error } });
        }
        sendJson(res, 200, { ok: true, job: updated });
      },
    },
  ];

  const dispatch = createRouter(routes);

  return async function app(req, res) {
    const started = Date.now();
    const requestId = newId();
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Cache-Control', 'no-store');
    try {
      const url = new URL(req.url, 'http://localhost');
      limiters.global.check(clientIp(req, config.trustProxy));
      const handled = await dispatch(req, res);
      if (!handled) throw notFound('Unknown endpoint');
    } catch (err) {
      if (err?.retryAfter) res.setHeader('Retry-After', String(err.retryAfter));
      if (!(err instanceof HttpError) && err?.status !== 400) {
        log.error('request.failed', {
          path: req.url?.split('?')[0],
          method: req.method,
          err,
          requestId,
        });
      }
      if (!res.headersSent) sendError(res, err, requestId);
      else res.end();
    } finally {
      if (req.url?.startsWith('/api/')) {
        log.debug('http.done', {
          method: req.method,
          path: req.url.split('?')[0],
          status: res.statusCode,
          ms: Date.now() - started,
          ip: clientIp(req, config.trustProxy),
          requestId,
        });
      }
    }
  };
}

function parseRange(rawStart, rawEnd) {
  const start = new Date(String(rawStart ?? ''));
  const end = new Date(String(rawEnd ?? ''));
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw badRequest('start and end must be valid ISO timestamps');
  }
  if (end <= start) throw badRequest('End time must be after start time');
  const durationSec = Math.round((end.getTime() - start.getTime()) / 1000);
  if (durationSec > MAX_CLIP_SECONDS) {
    throw badRequest('Clip range is too long (maximum 6 hours)');
  }
  if (durationSec < 5) throw badRequest('Clip range must be at least 5 seconds');
  const now = Date.now();
  if (start.getTime() > now + 120_000) throw badRequest('Start time is in the future');
  if (end.getTime() > now + 120_000) throw badRequest('End time is in the future');
  return { start: start.toISOString(), end: end.toISOString(), durationSec };
}

function str(value, max) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

function sanitizeId(value) {
  if (typeof value !== 'string') return '';
  return /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : '';
}

function sanitizeBaseUrl(value) {
  if (typeof value !== 'string' || !value) return '';
  try {
    const u = new URL(value);
    if (!['http:', 'https:'].includes(u.protocol)) return '';
    if (u.username || u.password) return '';
    return u.origin + u.pathname.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function sanitizeDvr(dvr) {
  const d = dvr ?? {};
  return {
    configured: Boolean(d.configured),
    online: Boolean(d.online),
    model: str(d.model, 80),
    firmware: str(d.firmware, 80),
    host: str(d.host, 80),
    port: Number(d.port) || 0,
    channels: Math.min(Math.max(Number(d.channels) || 0, 0), 64),
    rtspPlayback: Boolean(d.rtspPlayback),
    onvif: Boolean(d.onvif),
    error: str(d.error, 300) || null,
    checkedAt: str(d.checkedAt, 40) || null,
  };
}

function sanitizeStorage(storage) {
  const s = storage ?? {};
  return {
    freeBytes: Math.max(0, Number(s.freeBytes) || 0),
    totalBytes: Math.max(0, Number(s.totalBytes) || 0),
    clipsBytes: Math.max(0, Number(s.clipsBytes) || 0),
    bufferBytes: Math.max(0, Number(s.bufferBytes) || 0),
  };
}

function sanitizeBuffer(buffer) {
  const b = buffer ?? {};
  return {
    enabled: Boolean(b.enabled),
    retentionMinutes: Math.min(Math.max(Number(b.retentionMinutes) || 0, 0), 1440),
    cameraIds: Array.isArray(b.cameraIds) ? b.cameraIds.slice(0, 64).map((x) => str(x, 64)) : [],
    diskUsedBytes: Math.max(0, Number(b.diskUsedBytes) || 0),
  };
}

function sanitizeCameras(cameras) {
  if (!Array.isArray(cameras)) return [];
  return cameras.slice(0, 64).map((c, index) => {
    const id = sanitizeId(c?.id) || `cam-${index + 1}`;
    return {
      id,
      name: str(c?.name, 60) || `Camera ${index + 1}`,
      channel: Math.min(Math.max(Number(c?.channel) || index + 1, 1), 64),
      enabled: c?.enabled !== false,
      online: Boolean(c?.online),
      dvrPlayback: Boolean(c?.dvrPlayback),
      buffer: Boolean(c?.buffer),
      resolution: str(c?.resolution, 24) || null,
      codec: str(c?.codec, 24) || null,
      lastSeen: str(c?.lastSeen, 40) || null,
      error: str(c?.error, 200) || null,
    };
  });
}

function sanitizeJob(raw) {
  const j = raw ?? {};
  const statuses = ['queued', 'running', 'completed', 'failed', 'deleting', 'deleted'];
  return {
    id: sanitizeId(j.id),
    gatewayId: sanitizeId(j.gatewayId) || 'gw-primary',
    cameraId: str(j.cameraId, 64),
    cameraName: str(j.cameraName, 60),
    channel: Math.min(Math.max(Number(j.channel) || 1, 1), 64),
    start: str(j.start, 40),
    end: str(j.end, 40),
    durationSec: Math.max(0, Number(j.durationSec) || 0),
    source: JOB_SOURCES.has(j.source) ? j.source : 'auto',
    status: statuses.includes(j.status) ? j.status : 'queued',
    progress: Math.max(0, Math.min(100, Number(j.progress) || 0)),
    error: str(j.error, 600) || null,
    file: j.file
      ? {
          sizeBytes: Math.max(0, Number(j.file.sizeBytes) || 0),
          durationSec: Math.max(0, Number(j.file.durationSec) || 0),
          source: JOB_SOURCES.has(j.file.source) ? j.file.source : 'buffer',
          createdAt: str(j.file.createdAt, 40) || new Date().toISOString(),
        }
      : null,
    requestedBy: str(j.requestedBy, 64) || null,
    createdAt: str(j.createdAt, 40) || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
