import { wsDiscover, onvifProbe } from './adapters/onvif.mjs';
import { scanChannels, testConnection } from './adapters/dvr.mjs';
import { applySettingsPatch } from './settings.mjs';
import { dirSize, diskInfo, lanAddresses, tcpCheck } from './util.mjs';
import { log } from './log.mjs';

export class SyncAgent {
  constructor({ config, state, save, ffmpeg, buffer, jobs, cameras, tv, audit }) {
    this.config = config;
    this.state = state;
    this.save = save;
    this.ffmpeg = ffmpeg;
    this.buffer = buffer;
    this.jobs = jobs;
    this.cameras = cameras;
    this.tv = tv;
    this.audit = audit;
    this.connected = false;
    this.lastError = null;
    this.lastHeartbeatAt = null;
    this.dvrOnline = false;
    this.dvrError = null;
    this.stopped = false;
    this.storageCache = { at: 0, data: null };
    this.taskTimer = null;
    this.heartbeatTimer = null;
  }

  get configured() {
    return Boolean(this.config.backendUrl && this.config.gatewayToken);
  }

  start() {
    this.healthLoop();
    if (!this.configured) {
      log.info('sync.disabled', { reason: 'BACKEND_URL or GATEWAY_TOKEN is not set' });
      return;
    }
    this.heartbeatLoop();
    this.taskLoop();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.taskTimer);
    clearTimeout(this.heartbeatTimer);
  }

  status() {
    return {
      configured: this.configured,
      connected: this.connected,
      backendUrl: this.config.backendUrl || null,
      lastHeartbeatAt: this.lastHeartbeatAt,
      lastError: this.lastError,
      dvrOnline: this.dvrOnline,
      dvrError: this.dvrError,
    };
  }

  async healthLoop() {
    if (this.stopped) return;
    try {
      if (this.tv.dvrConfigured()) {
        const { ok, error } = await tcpCheck(this.state.dvr.host, this.state.dvr.rtspPort, 3000);
        if (ok !== this.dvrOnline) {
          log.info('dvr.reachability', { online: ok, host: this.state.dvr.host, port: this.state.dvr.rtspPort });
        }
        this.dvrOnline = ok;
        this.dvrError = ok ? null : `Cannot reach DVR at ${this.state.dvr.host}:${this.state.dvr.rtspPort} (${error})`;
      } else {
        this.dvrOnline = false;
        this.dvrError = 'DVR is not configured';
      }
    } catch (err) {
      this.dvrError = err.message;
    }
    setTimeout(() => this.healthLoop(), 25_000).unref?.();
  }

  async heartbeatLoop() {
    if (this.stopped) return;
    try {
      await this.heartbeat();
      if (!this.connected) {
        this.connected = true;
        this.lastError = null;
        log.info('sync.connected', { backend: this.config.backendUrl });
      }
    } catch (err) {
      if (this.connected || !this.lastError) {
        log.warn('sync.heartbeat_failed', { error: err.message });
      }
      this.connected = false;
      this.lastError = err.message;
    }
    this.heartbeatTimer = setTimeout(() => this.heartbeatLoop(), this.connected ? 10_000 : 20_000);
    this.heartbeatTimer.unref?.();
  }

  async storageStats() {
    if (this.storageCache.data && Date.now() - this.storageCache.at < 60_000) {
      return this.storageCache.data;
    }
    const disk = await diskInfo(this.config.mediaDir);
    const bufferBytes = await this.buffer.dirBytes().catch(() => 0);
    const clipsBytes = await dirSize(this.jobs.exportsDir()).catch(() => 0);
    const data = {
      freeBytes: disk.freeBytes,
      totalBytes: disk.totalBytes,
      clipsBytes,
      bufferBytes,
    };
    this.storageCache = { at: Date.now(), data };
    return data;
  }

  publicBaseUrl() {
    if (this.config.publicBaseUrl) return this.config.publicBaseUrl;
    if (this.state.settings.publicBaseUrl) return this.state.settings.publicBaseUrl;
    const lan = lanAddresses().lan[0]?.address;
    if (!lan) return '';
    const proto = this.config.tlsCert ? 'https' : 'http';
    return `${proto}://${lan}:${this.config.port}`;
  }

  cameraSnapshot() {
    const settings = this.tv.settings();
    return this.cameras.list().map((camera) => {
      const session = this.ffmpeg.getSession(camera.id);
      const buffering = this.buffer.procs.has(camera.id);
      let stateLabel;
      if (!camera.enabled) stateLabel = 'disabled';
      else if (session?.state === 'running' || buffering) stateLabel = 'live';
      else if (!this.dvrOnline) stateLabel = 'offline';
      else if (camera.lastProbe?.online) stateLabel = 'ready';
      else stateLabel = 'unknown';
      return {
        id: camera.id,
        name: camera.name,
        channel: camera.channel,
        enabled: camera.enabled,
        online: stateLabel === 'live' || stateLabel === 'ready',
        state: stateLabel,
        dvrPlayback: camera.dvrPlayback !== false,
        buffer: Boolean(camera.buffer && settings.bufferEnabled),
        resolution: camera.lastProbe?.resolution ?? null,
        codec: camera.lastProbe?.codec ?? null,
        lastSeen: camera.lastProbe?.at ?? null,
        error: camera.lastProbe?.error ?? null,
      };
    });
  }

  async buildHeartbeat() {
    const storage = await this.storageStats();
    const setting = this.tv.settings();
    return {
      gatewayId: this.config.gatewayId,
      name: this.config.gatewayName,
      version: this.config.version,
      platform: `${process.platform} ${process.arch} / Node ${process.version}`,
      publicBaseUrl: this.publicBaseUrl(),
      firstSeen: this.state.createdAt,
      cameras: this.cameraSnapshot(),
      dvr: {
        configured: this.tv.dvrConfigured(),
        online: this.dvrOnline,
        model: this.state.dvr.model || '',
        firmware: this.state.dvr.firmware || '',
        host: this.state.dvr.host || '',
        port: this.state.dvr.rtspPort,
        channels: Math.max(this.state.dvr.channels || 0, this.state.cameras.length),
        rtspPlayback: this.state.cameras.some((c) => c.dvrPlayback !== false),
        onvif: Boolean(this.state.dvr.onvif),
        error: this.dvrError,
        checkedAt: new Date().toISOString(),
      },
      storage,
      buffer: {
        enabled: Boolean(setting.bufferEnabled),
        retentionMinutes: setting.bufferRetentionMinutes,
        cameraIds: this.state.cameras.filter((c) => c.buffer).map((c) => c.id),
        diskUsedBytes: storage.bufferBytes,
      },
    };
  }

  async heartbeat() {
    const body = await this.buildHeartbeat();
    const res = await fetch(`${this.config.backendUrl}/api/gateway/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Gateway-Token': this.config.gatewayToken,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300);
      throw new Error(`Heartbeat rejected: HTTP ${res.status} ${text}`);
    }
    this.lastHeartbeatAt = new Date().toISOString();
  }

  async taskLoop() {
    if (this.stopped) return;
    let delay = 3000;
    try {
      if (this.connected) {
        const res = await fetch(
          `${this.config.backendUrl}/api/gateway/task?gatewayId=${encodeURIComponent(this.config.gatewayId)}`,
          {
            headers: { 'X-Gateway-Token': this.config.gatewayToken },
            signal: AbortSignal.timeout(15_000),
          },
        );
        if (res.status !== 204 && res.ok) {
          const { task } = await res.json();
          if (task?.id) {
            await this.runTask(task);
          }
        } else if (res.status === 401) {
          this.lastError = 'Backend rejected the gateway token';
          this.connected = false;
          delay = 30_000;
        }
      }
    } catch (err) {
      log.debug('sync.task_poll_failed', { error: err.message });
      delay = 10_000;
    }
    this.taskTimer = setTimeout(() => this.taskLoop(), delay);
    this.taskTimer.unref?.();
  }

  async runTask(task) {
    log.info('sync.task_received', { id: task.id, type: task.type });
    try {
      const data = await this.executeTask(task);
      await this.reportTask(task.id, { ok: true, data: compact(data) });
    } catch (err) {
      log.warn('sync.task_failed', { id: task.id, type: task.type, error: err.message });
      await this.reportTask(task.id, { ok: false, error: String(err.message ?? err).slice(0, 500) });
    }
  }

  async executeTask(task) {
    const payload = task.payload ?? {};
    switch (task.type) {
      case 'export': {
        const job = await this.jobs.create({
          cameraId: payload.cameraId,
          start: payload.start,
          end: payload.end,
          source: payload.source ?? 'auto',
          requestedBy: 'cloud',
          jobId: payload.jobId,
        });
        return { job };
      }
      case 'camera.save': {
        const camera = await this.cameras.upsert(payload.camera ?? payload, { actor: 'cloud' });
        return { camera };
      }
      case 'camera.delete': {
        await this.cameras.remove(payload.cameraId, { actor: 'cloud' });
        return { ok: true };
      }
      case 'dvr.discover': {
        const devices = await wsDiscover({ timeoutMs: 4000 });
        const enriched = [];
        for (const device of devices.slice(0, 5)) {
          let onvif = null;
          try {
            onvif = await onvifProbe({
              xaddr: device.xaddr,
              username: this.state.dvr.username,
              password: this.tv.dvrPassword(),
              timeoutMs: 5000,
            });
          } catch (err) {
            onvif = { ok: false, error: err.message };
          }
          enriched.push({ ...device, onvif });
        }
        return { devices: enriched };
      }
      case 'dvr.test': {
        const result = await testConnection({
          dvr: this.state.dvr,
          ffmpeg: this.ffmpeg,
          decrypt: this.tv.decrypt,
          allowPublicHosts: this.config.allowPublicDvrHosts,
        });
        if (result.onvif?.ok) {
          this.state.dvr.model = result.onvif.device?.model || this.state.dvr.model;
          this.state.dvr.firmware = result.onvif.device?.firmware || this.state.dvr.firmware;
          if (result.onvif.channels) this.state.dvr.channels = Math.min(Math.max(result.onvif.channels, this.state.dvr.channels), 64);
        }
        this.state.dvr.lastTest = { at: result.testedAt, ok: result.ok, message: result.message };
        await this.save();
        return result;
      }
      case 'dvr.scan': {
        const maxChannels = Math.min(Math.max(Number(payload.maxChannels) || 16, 1), 64);
        const results = await scanChannels({
          dvr: this.state.dvr,
          ffmpeg: this.ffmpeg,
          decrypt: this.tv.decrypt,
          maxChannels,
        });
        let applied = null;
        if (payload.apply) {
          applied = await this.cameras.applyScanResults(results, { actor: 'cloud' });
        }
        return {
          results: results.map((r) => ({
            channel: r.channel,
            online: r.online,
            template: r.template ?? null,
            video: r.probe?.video ?? null,
          })),
          applied,
        };
      }
      case 'settings.update': {
        const changed = applySettingsPatch(this.state.settings, payload.settings ?? payload);
        await this.save();
        if (changed.includes('bufferEnabled')) await this.buffer.sync();
        await this.audit({ actor: 'cloud', action: 'settings.update', meta: { keys: changed } });
        return { settings: this.state.settings };
      }
      case 'buffer.update': {
        const patch = { ...payload };
        if (payload.diskCapGb !== undefined) {
          patch.bufferDiskCapGb = payload.diskCapGb;
          delete patch.diskCapGb;
        }
        const changed = applySettingsPatch(this.state.settings, patch);
        await this.save();
        await this.buffer.sync();
        await this.audit({ actor: 'cloud', action: 'buffer.update', meta: { keys: changed } });
        return { settings: this.state.settings };
      }
      case 'clip.delete': {
        const job = await this.jobs.deleteClip(payload.jobId);
        return { job };
      }
      default:
        throw new Error(`Unsupported task type: ${task.type}`);
    }
  }

  async reportTask(taskId, body) {
    try {
      const res = await fetch(`${this.config.backendUrl}/api/gateway/task/${encodeURIComponent(taskId)}/result`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Gateway-Token': this.config.gatewayToken,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) log.warn('sync.task_report_rejected', { taskId, status: res.status });
    } catch (err) {
      log.warn('sync.task_report_failed', { taskId, error: err.message });
    }
  }

  async reportJob(job) {
    if (!this.configured) return;
    try {
      const res = await fetch(`${this.config.backendUrl}/api/gateway/jobs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Gateway-Token': this.config.gatewayToken,
        },
        body: JSON.stringify({ job }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) log.debug('sync.job_report_rejected', { jobId: job.id, status: res.status });
    } catch (err) {
      log.debug('sync.job_report_failed', { jobId: job.id, error: err.message });
    }
  }
}

function compact(data) {
  try {
    const text = JSON.stringify(data);
    if (text.length <= 60_000) return data;
    return { truncated: true, note: 'Result too large to sync; view details on the gateway.' };
  } catch {
    return null;
  }
}
