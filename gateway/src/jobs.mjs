import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HttpError } from './http.mjs';
import { log } from './log.mjs';
import { safeFilePath } from './util.mjs';

const MAX_CLIP_SECONDS = 6 * 60 * 60;
const ALLOWED_SOURCES = new Set(['auto', 'dvr', 'buffer']);

export function validateClipRange(rawStart, rawEnd) {
  const start = new Date(String(rawStart ?? ''));
  const end = new Date(String(rawEnd ?? ''));
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new HttpError(400, 'bad_range', 'Start and end must be valid timestamps');
  }
  const durationSec = Math.round((end.getTime() - start.getTime()) / 1000);
  if (durationSec < 5) throw new HttpError(400, 'bad_range', 'Clip must be at least 5 seconds long');
  if (durationSec > MAX_CLIP_SECONDS) throw new HttpError(400, 'bad_range', 'Clip is longer than the 6 hour maximum');
  const now = Date.now();
  if (start.getTime() > now + 120_000) throw new HttpError(400, 'bad_range', 'Start time is in the future');
  if (end.getTime() > now + 120_000) throw new HttpError(400, 'bad_range', 'End time is in the future');
  return { start: start.toISOString(), end: end.toISOString(), startMs: start.getTime(), endMs: end.getTime(), durationSec };
}

export class JobManager {
  constructor({ config, state, save, ffmpeg, buffer, tv, audit }) {
    this.config = config;
    this.state = state;
    this.save = save;
    this.ffmpeg = ffmpeg;
    this.buffer = buffer;
    this.tv = tv;
    this.audit = audit;
    this.active = new Map();
    this.reporter = null;
    this.lastReportAt = new Map();
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpiredClips().catch((err) => log.warn('clip.cleanup_failed', { error: err.message }));
    }, 60 * 60_000);
    this.cleanupTimer.unref?.();
  }

  setReporter(fn) {
    this.reporter = fn;
  }

  exportsDir() {
    return path.join(this.config.mediaDir, 'exports');
  }

  filePath(jobId) {
    return safeFilePath(this.exportsDir(), `${jobId}.mp4`);
  }

  list(limit = 50) {
    return this.state.jobs.slice(0, Math.min(Math.max(limit, 1), 200));
  }

  get(id) {
    return this.state.jobs.find((j) => j.id === id) ?? null;
  }

  async create({ cameraId, start, end, source = 'auto', requestedBy = 'local', jobId = null }) {
    const camera = this.tv.getCamera(cameraId);
    if (!camera) throw new HttpError(404, 'camera_not_found', 'Camera not found');
    if (!ALLOWED_SOURCES.has(source)) throw new HttpError(400, 'bad_source', 'source must be auto, dvr or buffer');
    const range = validateClipRange(start, end);
    if (this.active.size >= Math.max(1, this.config.maxConcurrentExports)) {
      throw new HttpError(429, 'export_limit', 'Another export is already running on this gateway. Wait for it to finish.');
    }
    const job = {
      id: jobId ?? randomUUID(),
      gatewayId: this.config.gatewayId,
      cameraId,
      cameraName: camera.name,
      channel: camera.channel,
      start: range.start,
      end: range.end,
      durationSec: range.durationSec,
      source,
      status: 'queued',
      progress: 0,
      error: null,
      errorCode: null,
      file: null,
      requestedBy,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.state.jobs.unshift(job);
    await this.save();
    await this.report(job);
    await this.audit({ actor: requestedBy, action: 'export.queued', meta: { jobId: job.id, cameraId, start: range.start, end: range.end, source } });
    this.run(job).catch((err) => log.error('export.unhandled', { jobId: job.id, err }));
    return job;
  }

  async run(job) {
    const controller = new AbortController();
    this.active.set(job.id, controller);
    const camera = this.tv.getCamera(job.cameraId);
    let lastPersist = 0;
    let lastReport = 0;
    const touch = async ({ persist = false } = {}) => {
      job.updatedAt = new Date().toISOString();
      if (persist && Date.now() - lastPersist > 4000) {
        lastPersist = Date.now();
        await this.save();
      }
      if (this.reporter && Date.now() - lastReport > 4000) {
        lastReport = Date.now();
        Promise.resolve(this.reporter(job)).catch(() => {});
      }
    };
    const onProgress = (value) => {
      job.progress = Math.min(99, Math.max(1, Math.round(value)));
      touch().catch(() => {});
    };

    job.status = 'running';
    job.progress = 1;
    await this.save();
    await this.report(job);
    await this.audit({ actor: job.requestedBy, action: 'export.started', meta: { jobId: job.id, cameraId: job.cameraId } });

    if (!camera) {
      await this.fail(job, 'Camera no longer exists in the gateway configuration', 'camera_not_found');
      return;
    }
    if (!this.tv.dvrConfigured()) {
      await this.fail(job, 'DVR is not configured in the gateway yet. Open DVR Configuration and save the DVR details.', 'dvr_not_configured');
      return;
    }

    const outPath = this.filePath(job.id);
    const errors = [];
    const wantsDvr = job.source === 'dvr' || job.source === 'auto';
    const wantsBuffer = job.source === 'buffer' || job.source === 'auto';

    if (wantsDvr && camera.dvrPlayback !== false) {
      try {
        const result = await this.ffmpeg.exportFromDvr({
          camera,
          start: job.start,
          end: job.end,
          outPath,
          onProgress,
          signal: controller.signal,
        });
        if (result.ok) {
          await this.complete(job, outPath, result.sizeBytes, result.durationSec, 'dvr');
          return;
        }
        if (result.cancelled) {
          await this.fail(job, 'Export cancelled', 'cancelled');
          return;
        }
        errors.push({ source: 'dvr', message: result.error, code: result.code });
        log.warn('export.dvr_failed', { jobId: job.id, error: result.error, code: result.code });
      } catch (err) {
        errors.push({ source: 'dvr', message: err.message, code: err.code });
        log.warn('export.dvr_error', { jobId: job.id, error: err.message });
      }
    } else if (job.source === 'dvr') {
      errors.push({ source: 'dvr', message: 'DVR playback was disabled for this camera in gateway settings.', code: 'dvr_playback_disabled' });
    }

    if (wantsBuffer) {
      if (!this.tv.settings().bufferEnabled) {
        errors.push({
          source: 'buffer',
          message: 'Rolling buffer is disabled. Enable it in Gateway configuration to record live streams locally, then retry the export.',
          code: 'buffer_disabled',
        });
      } else {
        try {
          const result = await this.buffer.exportRange({
            camera,
            start: job.start,
            end: job.end,
            outPath,
            onProgress,
            signal: controller.signal,
          });
          if (result.ok) {
            await this.complete(job, outPath, result.sizeBytes, result.durationSec, 'buffer');
            return;
          }
          if (result.cancelled) {
            await this.fail(job, 'Export cancelled', 'cancelled');
            return;
          }
          errors.push({ source: 'buffer', message: result.error, code: result.code });
        } catch (err) {
          errors.push({ source: 'buffer', message: err.message, code: err.code });
        }
      }
    }

    await fs.promises.rm(outPath, { force: true }).catch(() => {});
    const message = errors.length
      ? errors.map((e) => `${e.source === 'dvr' ? 'DVR playback' : 'Local buffer'}: ${e.message}`).join(' · ')
      : 'No export source available';
    const code = errors[errors.length - 1]?.code ?? 'export_unavailable';
    await this.fail(job, message, code);
  }

  async complete(job, outPath, sizeBytes, durationSec, source) {
    const probe = await this.ffmpeg.probeFile(outPath).catch(() => null);
    job.status = 'completed';
    job.progress = 100;
    job.error = null;
    job.errorCode = null;
    job.file = {
      sizeBytes,
      durationSec: probe?.durationSec ? Math.round(probe.durationSec) : Math.round(durationSec),
      source,
      createdAt: new Date().toISOString(),
      fileName: `exports/${job.id}.mp4`,
      resolution: probe?.video ? `${probe.video.width}x${probe.video.height}` : null,
      codec: probe?.video?.codec ?? null,
    };
    job.updatedAt = new Date().toISOString();
    this.active.delete(job.id);
    await this.save();
    await this.report(job);
    await this.audit({ actor: 'gateway', action: 'export.completed', meta: { jobId: job.id, source, sizeBytes } });
    log.info('export.completed', { jobId: job.id, source, sizeBytes, durationSec });
  }

  async fail(job, message, code) {
    job.status = 'failed';
    job.error = message;
    job.errorCode = code ?? null;
    job.updatedAt = new Date().toISOString();
    this.active.delete(job.id);
    await this.save();
    await this.report(job);
    await this.audit({ actor: 'gateway', action: 'export.failed', meta: { jobId: job.id, code, message } });
    log.warn('export.failed', { jobId: job.id, code, message });
  }

  async report(job) {
    if (!this.reporter) return;
    try {
      await this.reporter(job);
    } catch (err) {
      log.warn('export.report_failed', { jobId: job.id, error: err.message });
    }
  }

  async deleteClip(jobId) {
    const job = this.get(jobId);
    if (!job) throw new HttpError(404, 'job_not_found', 'Export not found');
    if (this.active.has(jobId)) {
      throw new HttpError(409, 'job_running', 'This export is still running');
    }
    const filePath = this.filePath(jobId);
    if (filePath) await fs.promises.rm(filePath, { force: true }).catch(() => {});
    job.status = 'deleted';
    job.deletedAt = new Date().toISOString();
    job.updatedAt = job.deletedAt;
    await this.save();
    await this.report(job);
    await this.audit({ actor: 'local', action: 'export.deleted', meta: { jobId } });
    return job;
  }

  async cleanupExpiredClips() {
    const days = Math.max(1, Number(this.tv.settings().clipRetentionDays) || 7);
    const cutoff = Date.now() - days * 24 * 60 * 60_000;
    let removed = 0;
    for (const job of this.state.jobs) {
      if (job.status !== 'completed' || !job.file) continue;
      const created = Date.parse(job.file.createdAt ?? job.updatedAt);
      if (!Number.isFinite(created) || created >= cutoff) continue;
      const filePath = this.filePath(job.id);
      if (filePath) await fs.promises.rm(filePath, { force: true }).catch(() => {});
      job.status = 'deleted';
      job.deletedAt = new Date().toISOString();
      job.updatedAt = job.deletedAt;
      removed += 1;
      await this.report(job);
    }
    if (removed) {
      await this.save();
      await this.audit({ actor: 'system', action: 'export.expired', meta: { count: removed, retentionDays: days } });
      log.info('export.expired', { removed, retentionDays: days });
    }
    return removed;
  }

  busyCount() {
    return this.active.size;
  }

  shutdown() {
    for (const controller of this.active.values()) {
      try {
        controller.abort();
      } catch {
        /* noop */
      }
    }
    this.active.clear();
    clearInterval(this.cleanupTimer);
  }
}
