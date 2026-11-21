import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  badRequest,
  clientIp,
  conflict,
  createRouter,
  HttpError,
  notFound,
  query,
  rateLimiter,
  readJson,
  sendError,
  sendJson,
  unauthorized,
} from './http.mjs';
import { applySettingsPatch } from './settings.mjs';
import { normalizeTemplate, dvrConfigured, testConnection, scanChannels, candidateTemplates } from './adapters/dvr.mjs';
import { wsDiscover } from './adapters/onvif.mjs';
import { assertDvrHost, clampInt, diskInfo, dvrLocalTimestamp, lanAddresses, nowIso } from './util.mjs';
import { log } from './log.mjs';

const ENCODER_OPTIONS = ['copy', 'x264', 'nvenc'];

export function createGatewayApi(ctx) {
  const { config, state, save, auth, audit, cameras, jobs, buffer, ffmpeg, sync, tv, masterKey } = ctx;
  const ip = (req) => clientIp(req, false);
  const meta = (req) => ({ ip: ip(req), ua: req.headers['user-agent'] });

  const limiters = {
    global: rateLimiter({ windowMs: 60_000, max: 900, scope: 'gw-global' }),
    login: rateLimiter({ windowMs: 15 * 60_000, max: 10, scope: 'gw-login' }),
    setup: rateLimiter({ windowMs: 15 * 60_000, max: 5, scope: 'gw-setup' }),
    export: rateLimiter({ windowMs: 60 * 60_000, max: 30, scope: 'gw-export' }),
    snapshot: rateLimiter({ windowMs: 60 * 60_000, max: 60, scope: 'gw-snapshot' }),
    live: rateLimiter({ windowMs: 60 * 60_000, max: 120, scope: 'gw-live' }),
    media: rateLimiter({ windowMs: 60_000, max: 1200, scope: 'gw-media' }),
  };

  let scan = null;
  let startedAt = Date.now();

  const owner = (req) => auth.requireOwner(req);
  const requireClientHeader = (req) => {
    if (req.headers['x-opps-client'] !== 'web') throw new HttpError(403, 'forbidden', 'Missing X-Opps-Client header');
  };

  function settingsPublic() {
    return {
      ...state.settings,
      encoderOptions: ENCODER_OPTIONS,
      setupRequired: !state.owner,
      cloud: sync.status(),
    };
  }

  function dvrPublic() {
    const { passwordEnc, ...rest } = state.dvr;
    return {
      ...rest,
      hasPassword: Boolean(passwordEnc),
      templates: candidateTemplates(),
      playbackExample: '/cam/playback?channel={ch}&subtype=0&starttime={start}&endtime={end}',
      capabilities: {
        rtspLive: Boolean(state.dvr.host && passwordEnc),
        dvrPlayback: Boolean(state.dvr.playbackTemplate),
        onvif: Boolean(state.dvr.onvif),
      },
    };
  }

  function mediaToken(claims, expiresInSec) {
    return auth.issueMediaToken(claims, expiresInSec);
  }

  function decorateJob(job) {
    if (!job) return null;
    if (job.status !== 'completed' || !job.file) return job;
    const token = mediaToken({ sub: 'local', kind: 'clip', jid: job.id }, 900);
    return {
      ...job,
      mediaUrl: `/media/clip/${encodeURIComponent(job.id)}?token=${encodeURIComponent(token)}`,
      downloadUrl: `/media/clip/${encodeURIComponent(job.id)}?token=${encodeURIComponent(token)}&download=1`,
    };
  }

  function decorateCamera(camera) {
    const session = ffmpeg.getSession(camera.id);
    const buffering = buffer.procs.has(camera.id);
    const snapshot = sync.cameraSnapshot().find((c) => c.id === camera.id);
    return {
      ...camera,
      live: session?.state === 'running',
      buffering,
      state: snapshot?.state ?? 'unknown',
      online: Boolean(snapshot?.online),
      resolution: snapshot?.resolution ?? null,
      codec: snapshot?.codec ?? null,
    };
  }

  async function saveDvr(body) {
    const current = state.dvr;
    const hostInput = body.host !== undefined ? String(body.host) : current.host;
    const host = hostInput ? await assertDvrHost(hostInput, config.allowPublicDvrHosts) : '';
    const rtspPort = clampInt(body.rtspPort ?? current.rtspPort ?? 554, 1, 65535, 554);
    const httpPort = clampInt(body.httpPort ?? current.httpPort ?? 80, 1, 65535, 80);
    const username = String(body.username ?? current.username ?? '').trim().slice(0, 64);
    const channels = clampInt(body.channels ?? current.channels ?? 4, 1, 64, 4);
    const rtspTemplate = normalizeTemplate(body.rtspTemplate ?? current.rtspTemplate);
    const playbackTemplate = body.playbackTemplate !== undefined
      ? (String(body.playbackTemplate).trim() ? normalizeTemplate(body.playbackTemplate, { requireTimestamps: true }) : '')
      : current.playbackTemplate;
    let passwordEnc = current.passwordEnc;
    if (body.clearPassword) {
      passwordEnc = '';
    } else if (typeof body.password === 'string' && body.password.length > 0) {
      if (body.password.length > 128) throw badRequest('DVR password is too long');
      const { encryptSecret } = await import('./secret.mjs');
      passwordEnc = encryptSecret(body.password, masterKey);
    }
    Object.assign(state.dvr, {
      host,
      rtspPort,
      httpPort,
      username,
      passwordEnc,
      channels,
      rtspTemplate,
      playbackTemplate,
      onvif: body.onvif !== undefined ? Boolean(body.onvif) : current.onvif,
    });
    await save();
    return dvrPublic();
  }

  function startScan({ maxChannels, apply }) {
    if (scan?.status === 'running') throw conflict('A channel scan is already running');
    if (!dvrConfigured(state.dvr)) throw new HttpError(409, 'dvr_not_configured', 'Save the DVR connection details first');
    const id = randomUUID();
    scan = {
      id,
      status: 'running',
      startedAt: nowIso(),
      total: Math.min(Math.max(maxChannels, 1), 64),
      done: 0,
      found: 0,
      currentChannel: null,
      results: [],
      applied: null,
      error: null,
    };
    const activeScan = scan;
    (async () => {
      try {
        const results = await scanChannels({
          dvr: state.dvr,
          ffmpeg,
          decrypt: tv.decrypt,
          maxChannels: activeScan.total,
          onProgress: (p) => {
            activeScan.done = p.done;
            activeScan.found = p.found;
            activeScan.currentChannel = p.channel;
          },
        });
        activeScan.results = results.map((r) => ({
          channel: r.channel,
          online: r.online,
          template: r.template ?? null,
          video: r.probe?.video ?? null,
        }));
        activeScan.found = activeScan.results.filter((r) => r.online).length;
        if (apply) {
          activeScan.applied = await cameras.applyScanResults(results, { actor: state.owner?.email ?? 'local' });
        }
        activeScan.status = 'done';
      } catch (err) {
        activeScan.error = err.message;
        activeScan.status = 'failed';
        log.warn('dvr.scan_failed', { error: err.message });
      }
    })();
    return { scanId: id, total: activeScan.total };
  }

  const routes = [
    { method: 'GET', path: '/healthz', handler: async (req, res) => sendJson(res, 200, { ok: true, uptimeSec: Math.round((Date.now() - startedAt) / 1000) }) },
    {
      method: 'GET',
      path: '/gapi/health',
      handler: async (req, res) =>
        sendJson(res, 200, {
          ok: true,
          mode: 'gateway',
          version: config.version,
          name: config.gatewayName,
          setupRequired: !state.owner,
          dvrConfigured: dvrConfigured(state.dvr),
          dvrReachable: sync.status().dvrOnline,
          cloudConnected: sync.status().connected,
          time: nowIso(),
        }),
    },
    {
      method: 'GET',
      path: '/gapi/meta',
      handler: async (req, res) =>
        sendJson(res, 200, {
          mode: 'gateway',
          version: config.version,
          setupRequired: !state.owner,
          registrationEnabled: false,
          gatewayName: config.gatewayName,
          cloud: sync.status(),
          auth: { totpEnabled: false },
        }),
    },
    {
      method: 'POST',
      path: '/gapi/auth/setup',
      handler: async (req, res) => {
        limiters.setup.check(ip(req));
        const body = await readJson(req);
        const result = await auth.setup(
          { setupToken: body.setupToken, email: body.email, password: body.password },
          meta(req),
        );
        res.setHeader('Set-Cookie', auth.cookieHeader(result.refreshToken));
        sendJson(res, 201, { accessToken: result.accessToken, expiresIn: result.expiresIn, user: result.user });
      },
    },
    {
      method: 'POST',
      path: '/gapi/auth/login',
      handler: async (req, res) => {
        limiters.login.check(ip(req));
        const body = await readJson(req);
        limiters.login.check(`email:${String(body.email ?? '').toLowerCase().slice(0, 120)}`);
        const result = await auth.login({ email: body.email, password: body.password }, meta(req));
        res.setHeader('Set-Cookie', auth.cookieHeader(result.refreshToken));
        sendJson(res, 200, { accessToken: result.accessToken, expiresIn: result.expiresIn, user: result.user });
      },
    },
    {
      method: 'POST',
      path: '/gapi/auth/refresh',
      handler: async (req, res) => {
        requireClientHeader(req);
        const result = await auth.refresh(auth.refreshCookie(req), meta(req));
        res.setHeader('Set-Cookie', auth.cookieHeader(result.refreshToken));
        sendJson(res, 200, { accessToken: result.accessToken, expiresIn: result.expiresIn, user: result.user });
      },
    },
    {
      method: 'POST',
      path: '/gapi/auth/logout',
      handler: async (req, res) => {
        requireClientHeader(req);
        await auth.logout(auth.refreshCookie(req), meta(req));
        res.setHeader('Set-Cookie', auth.clearedCookie());
        sendJson(res, 200, { ok: true });
      },
    },
    {
      method: 'GET',
      path: '/gapi/auth/me',
      handler: async (req, res) => {
        const user = await owner(req);
        sendJson(res, 200, { user: { id: user.id, email: user.email, totpEnabled: false, local: true, source: user.source } });
      },
    },
    {
      method: 'POST',
      path: '/gapi/auth/password',
      handler: async (req, res) => {
        await owner(req);
        const body = await readJson(req);
        await auth.changePassword({ currentPassword: body.currentPassword, newPassword: body.newPassword }, meta(req));
        res.setHeader('Set-Cookie', auth.clearedCookie());
        sendJson(res, 200, { ok: true, message: 'Password changed. Sign in again.' });
      },
    },
    {
      method: 'GET',
      path: '/gapi/settings',
      handler: async (req, res) => {
        await owner(req);
        sendJson(res, 200, settingsPublic());
      },
    },
    {
      method: 'PATCH',
      path: '/gapi/settings',
      handler: async (req, res) => {
        const user = await owner(req);
        const body = await readJson(req);
        const changed = applySettingsPatch(state.settings, body);
        await save();
        if (changed.includes('bufferEnabled')) await buffer.sync();
        await audit({ ...meta(req), actor: user.email, action: 'settings.update', meta: { keys: changed } });
        sendJson(res, 200, settingsPublic());
      },
    },
    {
      method: 'GET',
      path: '/gapi/status',
      handler: async (req, res) => {
        await owner(req);
        const storage = await buildStorage();
        const bufferStats = await buffer.stats();
        sendJson(res, 200, {
          version: config.version,
          uptimeSec: Math.round((Date.now() - startedAt) / 1000),
          gateway: {
            id: config.gatewayId,
            name: config.gatewayName,
            publicBaseUrl: sync.publicBaseUrl(),
            lanUrls: lanUrls(),
            tailnetUrls: tailnetUrls(),
            dataDirConfigured: Boolean(config.dataDir),
          },
          cloud: sync.status(),
          dvr: {
            configured: dvrConfigured(state.dvr),
            online: sync.status().dvrOnline,
            host: state.dvr.host,
            port: state.dvr.rtspPort,
            channels: state.dvr.channels,
            model: state.dvr.model,
            firmware: state.dvr.firmware,
            onvif: state.dvr.onvif,
            error: sync.status().dvrError,
            lastTest: state.dvr.lastTest,
          },
          cameras: {
            total: state.cameras.length,
            enabled: state.cameras.filter((c) => c.enabled).length,
            online: sync.cameraSnapshot().filter((c) => c.online).length,
          },
          streams: ffmpeg.listSessions(),
          buffer: {
            enabled: state.settings.bufferEnabled,
            retentionMinutes: state.settings.bufferRetentionMinutes,
            ...bufferStats,
          },
          storage,
          jobs: {
            total: state.jobs.length,
            active: jobs.busyCount(),
            latest: jobs.list(5).map((j) => ({ id: j.id, name: j.cameraName, status: j.status, progress: j.progress, createdAt: j.createdAt })),
          },
          ffmpeg: await ffmpeg.version(),
          setupRequired: !state.owner,
        });
      },
    },
    {
      method: 'GET',
      path: '/gapi/system',
      handler: async (req, res) => {
        await owner(req);
        sendJson(res, 200, {
          node: process.version,
          platform: `${process.platform} ${process.arch}`,
          cpus: (await import('node:os')).cpus().length,
          memoryTotalBytes: (await import('node:os')).totalmem(),
          ffmpeg: await ffmpeg.version(),
          lanUrls: lanUrls(),
          tailnetUrls: tailnetUrls(),
          publicBaseUrl: sync.publicBaseUrl(),
          timezone: state.settings.timezone,
          dvrLocalTime: dvrLocalTimestamp(new Date(), state.settings.timezone),
        });
      },
    },
    {
      method: 'POST',
      path: '/gapi/system/selftest',
      handler: async (req, res) => {
        await owner(req);
        const result = await ffmpeg.selfTest();
        sendJson(res, result.ok ? 200 : 500, result);
      },
    },
    {
      method: 'GET',
      path: '/gapi/dvr',
      handler: async (req, res) => {
        await owner(req);
        sendJson(res, 200, dvrPublic());
      },
    },
    {
      method: 'PUT',
      path: '/gapi/dvr',
      handler: async (req, res) => {
        const user = await owner(req);
        const body = await readJson(req);
        const saved = await saveDvr(body);
        await audit({ ...meta(req), actor: user.email, action: 'dvr.save', meta: { host: saved.host } });
        sendJson(res, 200, saved);
      },
    },
    {
      method: 'POST',
      path: '/gapi/dvr/test',
      handler: async (req, res) => {
        await owner(req);
        if (!state.dvr.host) throw new HttpError(409, 'dvr_not_configured', 'Enter and save the DVR details first');
        const result = await testConnection({
          dvr: state.dvr,
          ffmpeg,
          decrypt: tv.decrypt,
          allowPublicHosts: config.allowPublicDvrHosts,
        });
        if (result.onvif?.ok) {
          state.dvr.model = result.onvif.device?.model || state.dvr.model;
          state.dvr.firmware = result.onvif.device?.firmware || state.dvr.firmware;
          if (result.onvif.channels) state.dvr.channels = Math.min(Math.max(result.onvif.channels, 1), 64);
        }
        state.dvr.lastTest = { at: result.testedAt, ok: result.ok, message: result.message };
        await save();
        sendJson(res, 200, result);
      },
    },
    {
      method: 'POST',
      path: '/gapi/dvr/discover',
      handler: async (req, res) => {
        await owner(req);
        const devices = await wsDiscover({ timeoutMs: 4000 });
        const { onvifProbe } = await import('./adapters/onvif.mjs');
        const enriched = [];
        for (const device of devices.slice(0, 6)) {
          let onvif = null;
          try {
            onvif = await onvifProbe({
              xaddr: device.xaddr,
              username: state.dvr.username,
              password: tv.dvrPassword(),
              timeoutMs: 5000,
            });
          } catch (err) {
            onvif = { ok: false, error: err.message };
          }
          enriched.push({ ...device, onvif });
        }
        sendJson(res, 200, { devices: enriched });
      },
    },
    {
      method: 'POST',
      path: '/gapi/dvr/scan',
      handler: async (req, res) => {
        await owner(req);
        const body = await readJson(req);
        const result = startScan({ maxChannels: Number(body.maxChannels) || 16, apply: Boolean(body.apply) });
        sendJson(res, 202, result);
      },
    },
    {
      method: 'GET',
      path: '/gapi/dvr/scan/:id',
      handler: async (req, res, params) => {
        await owner(req);
        if (!scan || scan.id !== params.id) throw notFound('Scan not found');
        sendJson(res, 200, scan);
      },
    },
    {
      method: 'GET',
      path: '/gapi/cameras',
      handler: async (req, res) => {
        await owner(req);
        sendJson(res, 200, { cameras: cameras.list().map(decorateCamera) });
      },
    },
    {
      method: 'POST',
      path: '/gapi/cameras',
      handler: async (req, res) => {
        const user = await owner(req);
        const body = await readJson(req);
        const camera = await cameras.upsert({ ...(body.camera ?? body), allowCreate: true }, { actor: user.email });
        sendJson(res, 201, { camera: decorateCamera(camera) });
      },
    },
    {
      method: 'PATCH',
      path: '/gapi/cameras/:id',
      handler: async (req, res, params) => {
        const user = await owner(req);
        const body = await readJson(req);
        const camera = await cameras.upsert({ id: params.id, ...body }, { actor: user.email });
        sendJson(res, 200, { camera: decorateCamera(camera) });
      },
    },
    {
      method: 'DELETE',
      path: '/gapi/cameras/:id',
      handler: async (req, res, params) => {
        const user = await owner(req);
        ffmpeg.stopLive(params.id);
        buffer.stop(params.id, { reason: 'camera removed' });
        await cameras.remove(params.id, { actor: user.email });
        sendJson(res, 200, { ok: true });
      },
    },
    {
      method: 'POST',
      path: '/gapi/cameras/:id/test',
      handler: async (req, res, params) => {
        await owner(req);
        const camera = tv.getCamera(params.id);
        if (!camera) throw notFound('Camera not found');
        const result = await cameras.probe(camera);
        sendJson(res, result.ok ? 200 : 502, {
          ok: result.ok,
          video: result.video,
          audio: result.audio,
          error: result.error,
          testedAt: nowIso(),
        });
      },
    },
    {
      method: 'POST',
      path: '/gapi/live/:id',
      handler: async (req, res, params) => {
        await owner(req);
        limiters.live.check(params.id);
        const camera = tv.getCamera(params.id);
        if (!camera) throw notFound('Camera not found');
        if (!camera.enabled) throw new HttpError(409, 'camera_disabled', 'Camera is disabled in the gateway configuration');
        if (!dvrConfigured(state.dvr)) throw new HttpError(409, 'dvr_not_configured', 'Save the DVR details first');
        await ffmpeg.ensureLive(camera);
        const token = mediaToken({ sub: state.owner?.email ?? 'local', kind: 'live', cid: camera.id }, 8 * 3600);
        sendJson(res, 200, {
          cameraId: camera.id,
          url: `/stream/live/${encodeURIComponent(camera.id)}/index.m3u8?token=${encodeURIComponent(token)}`,
          expiresAt: new Date(Date.now() + 8 * 3600 * 1000).toISOString(),
        });
      },
    },
    {
      method: 'DELETE',
      path: '/gapi/live/:id',
      handler: async (req, res, params) => {
        await owner(req);
        ffmpeg.stopLive(params.id);
        sendJson(res, 200, { ok: true });
      },
    },
    {
      method: 'GET',
      path: '/gapi/jobs',
      handler: async (req, res) => {
        await owner(req);
        const limit = Number(query(req).get('limit') ?? 50);
        sendJson(res, 200, { jobs: jobs.list(limit).map(decorateJob) });
      },
    },
    {
      method: 'POST',
      path: '/gapi/jobs',
      handler: async (req, res) => {
        const user = await owner(req);
        limiters.export.check(ip(req));
        const body = await readJson(req);
        const job = await jobs.create({
          cameraId: String(body.cameraId ?? ''),
          start: body.start,
          end: body.end,
          source: String(body.source ?? 'auto'),
          requestedBy: user.email,
        });
        sendJson(res, 202, { job: decorateJob(job) });
      },
    },
    {
      method: 'GET',
      path: '/gapi/jobs/:id',
      handler: async (req, res, params) => {
        await owner(req);
        const job = jobs.get(params.id);
        if (!job) throw notFound('Export not found');
        sendJson(res, 200, { job: decorateJob(job) });
      },
    },
    {
      method: 'DELETE',
      path: '/gapi/jobs/:id',
      handler: async (req, res, params) => {
        const user = await owner(req);
        const job = await jobs.deleteClip(params.id);
        await audit({ ...meta(req), actor: user.email, action: 'export.deleted', meta: { jobId: job.id } });
        sendJson(res, 200, { ok: true, job: decorateJob(job) });
      },
    },
    {
      method: 'POST',
      path: '/gapi/snapshots',
      handler: async (req, res) => {
        const user = await owner(req);
        limiters.snapshot.check(ip(req));
        const body = await readJson(req);
        const camera = tv.getCamera(String(body.cameraId ?? ''));
        if (!camera) throw notFound('Camera not found');
        const token = mediaToken({ sub: user.email, kind: 'snapshot', cid: camera.id }, 120);
        sendJson(res, 200, {
          url: `/media/snapshot/${encodeURIComponent(camera.id)}?token=${encodeURIComponent(token)}`,
          camera: { id: camera.id, name: camera.name },
        });
      },
    },
    {
      method: 'GET',
      path: '/gapi/buffer',
      handler: async (req, res) => {
        await owner(req);
        const stats = await buffer.stats();
        sendJson(res, 200, {
          enabled: state.settings.bufferEnabled,
          retentionMinutes: state.settings.bufferRetentionMinutes,
          diskCapGb: state.settings.bufferDiskCapGb,
          ...stats,
        });
      },
    },
    {
      method: 'PATCH',
      path: '/gapi/buffer',
      handler: async (req, res) => {
        const user = await owner(req);
        const body = await readJson(req);
        const changed = applySettingsPatch(state.settings, body);
        await save();
        await buffer.sync();
        await audit({ ...meta(req), actor: user.email, action: 'buffer.update', meta: { keys: changed } });
        const stats = await buffer.stats();
        sendJson(res, 200, {
          enabled: state.settings.bufferEnabled,
          retentionMinutes: state.settings.bufferRetentionMinutes,
          diskCapGb: state.settings.bufferDiskCapGb,
          ...stats,
        });
      },
    },
    {
      method: 'GET',
      path: '/gapi/storage',
      handler: async (req, res) => {
        await owner(req);
        sendJson(res, 200, await buildStorage());
      },
    },
    {
      method: 'GET',
      path: '/gapi/audit',
      handler: async (req, res) => {
        await owner(req);
        const limit = Number(query(req).get('limit') ?? 100);
        sendJson(res, 200, { entries: state.audit.slice(0, Math.min(Math.max(limit, 1), 500)) });
      },
    },

    // ---- Token-authenticated media (used cross-origin by the cloud UI) ----
    {
      method: 'GET',
      path: '/stream/live/:id/index.m3u8',
      handler: async (req, res, params) => servePlaylist(req, res, params),
    },
    {
      method: 'GET',
      path: '/stream/live/:id/:file',
      handler: async (req, res, params) => serveSegment(req, res, params),
    },
    {
      method: 'GET',
      path: '/media/clip/:id',
      handler: async (req, res, params) => serveClip(req, res, params),
    },
    {
      method: 'GET',
      path: '/media/snapshot/:id',
      handler: async (req, res, params) => serveSnapshot(req, res, params),
    },
  ];

  async function buildStorage() {
    const disk = await diskInfo(config.mediaDir);
    const bufferBytes = await buffer.dirBytes().catch(() => 0);
    let clipsBytes = 0;
    try {
      const files = await fs.promises.readdir(jobs.exportsDir());
      for (const name of files) {
        const stat = await fs.promises.stat(path.join(jobs.exportsDir(), name)).catch(() => null);
        if (stat) clipsBytes += stat.size;
      }
    } catch {
      clipsBytes = 0;
    }
    return {
      disk,
      bufferBytes,
      clipsBytes,
      exportsDirConfigured: true,
      stateBytes: await fs.promises.stat(ctx.statePath).then((s) => s.size).catch(() => 0),
    };
  }

  function lanUrls() {
    const proto = config.tlsCert ? 'https' : 'http';
    return lanAddresses().lan.map((entry) => ({ ...entry, url: `${proto}://${entry.address}:${config.port}` }));
  }

  function tailnetUrls() {
    const proto = config.tlsCert ? 'https' : 'http';
    return lanAddresses().tailnet.map((entry) => ({ ...entry, url: `${proto}://${entry.address}:${config.port}` }));
  }

  function corsForMedia(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length,Content-Range,Accept-Ranges');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  }

  async function servePlaylist(req, res, params) {
    corsForMedia(res);
    limiters.media.check(ip(req));
    const claims = auth.verifyMediaToken(query(req).get('token'), 'live');
    if (!claims || claims.cid !== params.id) throw unauthorized('This live link is invalid or expired');
    const camera = tv.getCamera(params.id);
    if (!camera) throw notFound('Camera not found');
    if (!camera.enabled) throw new HttpError(409, 'camera_disabled', 'Camera is disabled');
    if (!dvrConfigured(state.dvr)) throw new HttpError(409, 'dvr_not_configured', 'DVR connection details are not configured');
    await ffmpeg.ensureLive(camera);
    ffmpeg.touch(camera.id);
    const session = ffmpeg.getSession(camera.id);
    if (!session) throw new HttpError(502, 'stream_unavailable', 'Live session stopped');
    const playlistPath = path.join(session.dir, 'index.m3u8');
    let text;
    try {
      text = await fs.promises.readFile(playlistPath, 'utf8');
    } catch {
      throw new HttpError(502, 'stream_unavailable', 'Playlist is not ready yet');
    }
    const token = query(req).get('token');
    const rewritten = text
      .split(/\r?\n/)
      .map((line) => {
        if (!line) return line;
        if (line.startsWith('#')) {
          return line.replace(/URI="([^"]+)"/g, (m, uri) => `URI="${uri}${uri.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}"`);
        }
        return `${line}${line.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
      })
      .join('\n');
    res.writeHead(200, {
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Cache-Control': 'no-store',
    });
    res.end(rewritten);
  }

  async function serveSegment(req, res, params) {
    corsForMedia(res);
    limiters.media.check(ip(req));
    const claims = auth.verifyMediaToken(query(req).get('token'), 'live');
    if (!claims || claims.cid !== params.id) throw unauthorized('This live link is invalid or expired');
    const session = ffmpeg.getSession(params.id);
    if (!session) throw notFound('Live session is not running');
    ffmpeg.touch(params.id);
    const file = path.resolve(session.dir, params.file);
    if (!file.startsWith(path.resolve(session.dir) + path.sep)) throw notFound('Invalid segment');
    let stat;
    try {
      stat = await fs.promises.stat(file);
    } catch {
      throw notFound('Segment expired');
    }
    const type = file.endsWith('.m3u8')
      ? 'application/vnd.apple.mpegurl'
      : file.endsWith('.m4s')
        ? 'video/iso.segment'
        : 'video/mp4';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(file).pipe(res);
  }

  async function serveClip(req, res, params) {
    corsForMedia(res);
    limiters.media.check(ip(req));
    const claims = auth.verifyMediaToken(query(req).get('token'), 'clip');
    if (!claims || claims.jid !== params.id) throw unauthorized('This clip link is invalid or expired');
    const job = jobs.get(params.id);
    if (!job || job.status !== 'completed' || !job.file) throw notFound('Clip not available');
    const file = jobs.filePath(job.id);
    if (!file) throw notFound('Clip path is invalid');
    let stat;
    try {
      stat = await fs.promises.stat(file);
    } catch {
      throw notFound('Clip file was removed');
    }
    const download = query(req).get('download') === '1';
    const safeName = `opps-${String(job.cameraName).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 40)}-${job.start.slice(0, 19).replace(/[:T]/g, '-')}.mp4`;
    const headers = {
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, no-store',
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${safeName}"`,
    };
    const range = req.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(String(range));
      if (match) {
        const start = match[1] ? Number(match[1]) : Math.max(0, stat.size - Number(match[2] || 0));
        const end = match[2] && match[1] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
        if (Number.isFinite(start) && start <= end) {
          res.writeHead(206, {
            ...headers,
            'Content-Range': `bytes ${start}-${end}/${stat.size}`,
            'Content-Length': end - start + 1,
          });
          fs.createReadStream(file, { start, end }).pipe(res);
          return;
        }
      }
    }
    res.writeHead(200, { ...headers, 'Content-Length': stat.size });
    fs.createReadStream(file).pipe(res);
  }

  async function serveSnapshot(req, res, params) {
    corsForMedia(res);
    limiters.snapshot.check(ip(req));
    const claims = auth.verifyMediaToken(query(req).get('token'), 'snapshot');
    if (!claims || claims.cid !== params.id) throw unauthorized('This snapshot link is invalid or expired');
    const camera = tv.getCamera(params.id);
    if (!camera) throw notFound('Camera not found');
    const result = await ffmpeg.snapshot(camera);
    if (!result.ok) throw new HttpError(502, 'snapshot_failed', result.error || 'Snapshot failed');
    res.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Content-Length': result.buffer.length,
      'Cache-Control': 'no-store',
      'Content-Disposition': `inline; filename="snapshot-${camera.channel}-${Date.now()}.jpg"`,
    });
    res.end(result.buffer);
  }

  const dispatch = createRouter(routes);

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    if (!pathname.startsWith('/gapi/') && pathname !== '/healthz' && !pathname.startsWith('/media/') && !pathname.startsWith('/stream/')) {
      return false;
    }
    const isMedia = pathname.startsWith('/media/') || pathname.startsWith('/stream/');
    limiters.global.check(ip(req));
    try {
      if (req.method === 'OPTIONS') {
        if (isMedia) corsForMedia(res);
        res.writeHead(204);
        res.end();
        return true;
      }
      const handled = await dispatch(req, res);
      if (!handled) throw notFound('Unknown endpoint');
      return true;
    } catch (err) {
      if (res.headersSent) {
        res.end();
        return true;
      }
      const requestId = randomUUID();
      if (err?.retryAfter) res.setHeader('Retry-After', String(err.retryAfter));
      if (!(err instanceof HttpError) && !(err?.status >= 400 && err?.status < 500)) {
        log.error('gateway.request_failed', { path: pathname, method: req.method, err, requestId });
      }
      sendError(res, err, requestId);
      return true;
    }
  };
}
