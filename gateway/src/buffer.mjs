import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { log } from './log.mjs';
import { HttpError } from './http.mjs';
import { dirSize } from './util.mjs';

const SEGMENT_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\.ts$/;

function parseSegmentName(name) {
  const match = SEGMENT_RE.exec(name);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match.map(Number);
  return new Date(y, mo - 1, d, h, mi, s).getTime();
}

function iso(ms) {
  return new Date(ms).toISOString();
}

export class BufferManager {
  constructor({ config, ffmpeg, tv, saveState }) {
    this.config = config;
    this.ffmpeg = ffmpeg;
    this.tv = tv;
    this.saveState = saveState;
    this.procs = new Map();
    this.indexCache = new Map();
    this.cleanupTimer = setInterval(() => {
      this.cleanup().catch((err) => log.warn('buffer.cleanup_failed', { error: err.message }));
    }, 60_000);
    this.cleanupTimer.unref?.();
  }

  settings() {
    return this.tv.settings();
  }

  isCameraEnabled(camera) {
    return Boolean(camera?.enabled !== false && camera.buffer !== false);
  }

  async startAll() {
    if (!this.settings().bufferEnabled) return;
    for (const camera of this.tv.cameras()) {
      if (this.isCameraEnabled(camera)) this.start(camera);
    }
  }

  async sync() {
    const enabled = this.settings().bufferEnabled;
    for (const camera of this.tv.cameras()) {
      const shouldRun = enabled && this.isCameraEnabled(camera);
      const running = this.procs.has(camera.id);
      if (shouldRun && !running) this.start(camera);
      if (!shouldRun && running) this.stop(camera.id, { reason: 'disabled' });
    }
    for (const cameraId of [...this.procs.keys()]) {
      if (!this.tv.getCamera(cameraId)) this.stop(cameraId, { reason: 'camera removed' });
    }
  }

  dirFor(cameraId) {
    return path.join(this.config.bufferDir, String(cameraId).replace(/[^A-Za-z0-9_-]/g, '_'));
  }

  start(camera) {
    if (!this.settings().bufferEnabled) return;
    if (!this.isCameraEnabled(camera)) return;
    if (this.procs.has(camera.id)) return;
    const dir = this.dirFor(camera.id);
    fs.mkdirSync(dir, { recursive: true });
    let url;
    try {
      url = this.tv.rtspUrl(camera);
    } catch (err) {
      log.warn('buffer.rtsp_url_failed', { camera: camera.id, error: err.message });
      return;
    }
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-rtsp_transport', 'tcp',
      '-rw_timeout', '15000000',
      '-i', url,
      '-map', '0:v:0',
      '-c:v', 'copy',
      '-an',
      '-f', 'segment',
      '-segment_time', String(this.config.bufferSegmentSec),
      '-segment_atclocktime', '1',
      '-reset_timestamps', '1',
      '-strftime', '1',
      '-segment_format', 'mpegts',
      '-segment_filename', path.join(dir, '%Y%m%dT%H%M%S.ts'),
    ];
    let child;
    try {
      child = spawn(this.ffmpeg.ffmpeg(), args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      log.error('buffer.spawn_failed', { camera: camera.id, error: err.message });
      return;
    }
    const entry = {
      cameraId: camera.id,
      proc: child,
      startedAt: Date.now(),
      stderr: '',
      restarts: 0,
      timer: null,
      stopped: false,
      lastError: null,
    };
    this.procs.set(camera.id, entry);
    child.stderr.on('data', (chunk) => {
      entry.stderr = (entry.stderr + chunk.toString()).slice(-3000);
    });
    child.once('error', (err) => {
      entry.lastError = err.message;
      log.warn('buffer.process_error', { camera: camera.id, error: err.message });
    });
    child.once('close', (code) => {
      entry.proc = null;
      if (entry.stopped) return;
      entry.lastError = entry.stderr.trim().split(/\r?\n/).pop() || `ffmpeg exited (${code})`;
      entry.restarts += 1;
      log.warn('buffer.process_exit', { camera: camera.id, code, restarts: entry.restarts });
      if (entry.restarts <= 8) {
        entry.timer = setTimeout(() => {
          this.procs.delete(camera.id);
          const fresh = this.tv.getCamera(camera.id);
          if (fresh && this.settings().bufferEnabled && this.isCameraEnabled(fresh)) {
            this.start(fresh);
            const now = this.procs.get(camera.id);
            if (now) now.restarts = entry.restarts;
          }
        }, Math.min(30_000, 5000 * entry.restarts));
      } else {
        this.procs.delete(camera.id);
      }
    });
    log.info('buffer.start', { camera: camera.id, dir });
  }

  stop(cameraId, { reason = 'stopped' } = {}) {
    const entry = this.procs.get(cameraId);
    if (!entry) return false;
    entry.stopped = true;
    if (entry.timer) clearTimeout(entry.timer);
    try {
      entry.proc?.kill();
    } catch {
      /* noop */
    }
    this.procs.delete(cameraId);
    log.info('buffer.stop', { camera: cameraId, reason });
    return true;
  }

  stopAll() {
    for (const cameraId of [...this.procs.keys()]) this.stop(cameraId, { reason: 'shutdown' });
    clearInterval(this.cleanupTimer);
  }

  async listSegments(cameraId) {
    const cached = this.indexCache.get(cameraId);
    if (cached && Date.now() - cached.at < 3000) return cached.segments;
    const dir = this.dirFor(cameraId);
    let names = [];
    try {
      names = await fs.promises.readdir(dir);
    } catch {
      names = [];
    }
    const starts = names
      .map((name) => ({ name, startMs: parseSegmentName(name) }))
      .filter((e) => e.startMs !== null)
      .sort((a, b) => a.startMs - b.startMs);
    const segments = [];
    for (let i = 0; i < starts.length; i += 1) {
      const current = starts[i];
      const next = starts[i + 1];
      const full = path.join(dir, current.name);
      let stat = null;
      try {
        stat = await fs.promises.stat(full);
      } catch {
        continue;
      }
      const cutAt = next ? next.startMs : Math.max(stat.mtimeMs, current.startMs + 1000);
      const startMs = current.startMs;
      const endMs = Math.max(startMs + 1000, Math.min(cutAt, next ? next.startMs : stat.mtimeMs + 1000));
      segments.push({
        file: full,
        name: current.name,
        startMs,
        endMs,
        sizeBytes: stat.size,
        complete: Date.now() - stat.mtimeMs > 3000 || Boolean(next),
      });
    }
    this.indexCache.set(cameraId, { at: Date.now(), segments });
    return segments;
  }

  async coverage(cameraId, startIso, endIso) {
    const startMs = new Date(startIso).getTime();
    const endMs = new Date(endIso).getTime();
    const segments = await this.listSegments(cameraId);
    const completeSegments = segments.filter((s) => s.complete);
    const overlapping = completeSegments.filter((s) => s.startMs < endMs && s.endMs > startMs);
    const maxGapMs = (this.config.bufferSegmentSec + 20) * 1000;
    let available = overlapping.length > 0;
    let gap = null;
    for (let i = 1; i < overlapping.length; i += 1) {
      const prev = overlapping[i - 1];
      const cur = overlapping[i];
      if (cur.startMs - prev.endMs > maxGapMs) {
        gap = { start: iso(prev.endMs), end: iso(cur.startMs) };
        break;
      }
    }
    if (available && startMs < overlapping[0].startMs - 5_000) available = false;
    if (available && endMs > overlapping[overlapping.length - 1].endMs - 1_000) available = false;
    if (gap && gap.start < iso(endMs) && gap.end > iso(startMs)) available = false;
    const first = completeSegments[0]?.startMs ?? null;
    const last = completeSegments.length ? completeSegments[completeSegments.length - 1].endMs : null;
    return {
      available,
      overlapping,
      gap,
      availableFrom: first ? iso(first) : null,
      availableTo: last ? iso(last) : null,
      segmentCount: segments.length,
    };
  }

  async exportRange({ camera, start, end, outPath, onProgress, signal }) {
    const result = await this.coverage(camera.id, start, end);
    if (!result.available) {
      const window = result.availableFrom
        ? `Buffer currently holds ${new Date(result.availableFrom).toLocaleString('en-IN')} to ${new Date(result.availableTo).toLocaleString('en-IN')}.`
        : 'The rolling buffer has not captured any complete segments yet.';
      const gapText = result.gap ? ` There is a recording gap between ${new Date(result.gap.start).toLocaleString('en-IN')} and ${new Date(result.gap.end).toLocaleString('en-IN')}.` : '';
      throw new HttpError(
        409,
        'buffer_coverage_unavailable',
        `The gateway buffer does not fully contain ${new Date(start).toLocaleString('en-IN')} - ${new Date(end).toLocaleString('en-IN')}. ${window}${gapText}`,
      );
    }
    if (!this.settings().bufferEnabled) {
      log.warn('buffer.export_while_disabled', { camera: camera.id });
    }
    const startMs = new Date(start).getTime();
    const endMs = new Date(end).getTime();
    const selected = result.overlapping.filter((s) => s.complete);
    if (!selected.length) throw new HttpError(409, 'buffer_incomplete', 'The newest segment is still being written. Try again in a few seconds.');
    const first = selected[0];
    const offsetSec = Math.max(0, (startMs - first.startMs) / 1000);
    const durationSec = Math.max(1, (endMs - startMs) / 1000);
    const listFile = path.join(this.config.tmpDir, `buffer-${camera.id}-${Date.now()}.txt`);
    await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
    await fs.promises.mkdir(this.config.tmpDir, { recursive: true });
    const listContent = selected
      .map((s) => `file '${s.file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
      .join('\n');
    await fs.promises.writeFile(listFile, `${listContent}\n`, 'utf8');
    try {
      const attempt = (extra) => this.runConcat({
        listFile,
        offsetSec,
        durationSec,
        outPath,
        extra,
        onProgress,
        signal,
      });
      let res = await attempt(['-c', 'copy']);
      if (!res.ok && !res.cancelled) {
        log.warn('buffer.export_copy_failed_retry', { camera: camera.id, error: res.error });
        res = await attempt(['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p']);
      }
      if (!res.ok) return res;
      const stat = await fs.promises.stat(outPath).catch(() => null);
      if (!stat || stat.size < 10_000) {
        return { ok: false, error: 'Buffer export produced an empty file' };
      }
      return { ok: true, sizeBytes: stat.size, durationSec, source: 'buffer' };
    } finally {
      fs.promises.rm(listFile, { force: true }).catch(() => {});
    }
  }

  runConcat({ listFile, offsetSec, durationSec, outPath, extra, onProgress, signal }) {
    return new Promise((resolve) => {
      const args = [
        '-y', '-hide_banner', '-loglevel', 'error', '-nostats',
        '-progress', 'pipe:1',
        '-ss', offsetSec.toFixed(3),
        '-t', durationSec.toFixed(3),
        '-f', 'concat', '-safe', '0',
        '-i', listFile,
        ...extra,
        '-an',
        '-movflags', '+faststart',
        '-f', 'mp4',
        outPath,
      ];
      let child;
      try {
        child = spawn(this.ffmpeg.ffmpeg(), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        resolve({ ok: false, error: err.message });
        return;
      }
      let buffered = '';
      let stderr = '';
      let cancelled = false;
      let lastReport = 0;
      const cancel = () => {
        cancelled = true;
        try {
          child.kill();
        } catch {
          /* noop */
        }
      };
      signal?.addEventListener('abort', cancel, { once: true });
      const timer = setTimeout(cancel, this.config.exportTimeoutMs);
      child.stdout.on('data', (chunk) => {
        buffered += chunk.toString();
        const lines = buffered.split(/\r?\n/);
        buffered = lines.pop() ?? '';
        for (const line of lines) {
          const match = /^out_time_us=(\d+)/.exec(line);
          if (match && Date.now() - lastReport > 700) {
            lastReport = Date.now();
            onProgress?.(Math.min(99, Math.round((Number(match[1]) / 1_000_000 / durationSec) * 100)));
          }
        }
      });
      child.stderr.on('data', (chunk) => {
        stderr = (stderr + chunk.toString()).slice(-4000);
      });
      child.once('error', (err) => {
        clearTimeout(timer);
        resolve({ ok: false, error: err.message, cancelled });
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        if (cancelled) {
          resolve({ ok: false, cancelled: true, error: 'Export cancelled' });
          return;
        }
        if (code !== 0) {
          resolve({ ok: false, error: stderr.trim().split(/\r?\n/).pop() || `FFmpeg exited with code ${code}` });
          return;
        }
        resolve({ ok: true });
      });
    });
  }

  async cleanup() {
    const retentionMs = Math.max(5, this.settings().bufferRetentionMinutes || 60) * 60_000;
    const capBytes = Math.max(0, this.settings().bufferDiskCapGb || 20) * 1024 ** 3;
    let total = 0;
    const all = [];
    let cameraDirs = [];
    try {
      cameraDirs = await fs.promises.readdir(this.config.bufferDir, { withFileTypes: true });
    } catch {
      return { removed: 0, bytes: 0 };
    }
    const cutoff = Date.now() - retentionMs;
    let removed = 0;
    let freed = 0;
    for (const dirEntry of cameraDirs) {
      if (!dirEntry.isDirectory()) continue;
      const dir = path.join(this.config.bufferDir, dirEntry.name);
      let names = [];
      try {
        names = await fs.promises.readdir(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        const full = path.join(dir, name);
        const startMs = parseSegmentName(name);
        let stat;
        try {
          stat = await fs.promises.stat(full);
        } catch {
          continue;
        }
        if (startMs === null || startMs < cutoff) {
          await fs.promises.rm(full, { force: true }).catch(() => {});
          removed += 1;
          continue;
        }
        total += stat.size;
        all.push({ full, mtimeMs: stat.mtimeMs, sizeBytes: stat.size });
      }
    }
    if (total > capBytes) {
      all.sort((a, b) => a.mtimeMs - b.mtimeMs);
      let excess = total - capBytes;
      for (const entry of all) {
        if (excess <= 0) break;
        await fs.promises.rm(entry.full, { force: true }).catch(() => {});
        excess -= entry.sizeBytes;
        freed += entry.sizeBytes;
        removed += 1;
      }
    }
    if (removed) {
      this.indexCache.clear();
      log.info('buffer.cleanup', { removed, freedBytes: freed });
    }
    return { removed, freedBytes: freed, totalBytes: total };
  }

  async stats() {
    const cameras = [];
    for (const camera of this.tv.cameras()) {
      const segments = await this.listSegments(camera.id);
      const bytes = segments.reduce((sum, s) => sum + s.sizeBytes, 0);
      const entry = this.procs.get(camera.id);
      cameras.push({
        cameraId: camera.id,
        name: camera.name,
        running: Boolean(entry?.proc),
        restarts: entry?.restarts ?? 0,
        error: entry?.lastError ?? null,
        segments: segments.length,
        bytes,
        oldest: segments[0] ? iso(segments[0].startMs) : null,
        newest: segments.length ? iso(segments[segments.length - 1].endMs) : null,
      });
    }
    const bytesUsed = cameras.reduce((sum, c) => sum + c.bytes, 0);
    return { bytesUsed, cameras };
  }

  async dirBytes() {
    return dirSize(this.config.bufferDir);
  }
}
