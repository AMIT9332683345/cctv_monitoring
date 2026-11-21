import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { log } from './log.mjs';
import { HttpError } from './http.mjs';

function run(cmd, args, { timeoutMs = 30_000, maxBuffer = 2 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: `spawn failed: ${err.message}`, timedOut: false });
      return;
    }
    const out = [];
    const err = [];
    let outSize = 0;
    let errSize = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      if (outSize < maxBuffer) {
        out.push(chunk);
        outSize += chunk.length;
      }
    });
    child.stderr.on('data', (chunk) => {
      if (errSize < maxBuffer) {
        err.push(chunk);
        errSize += chunk.length;
      }
    });
    child.once('error', (spawnErr) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: Buffer.concat(out).toString(), stderr: `spawn failed: ${spawnErr.message}`, timedOut });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(out).toString(),
        stderr: Buffer.concat(err).toString(),
        timedOut,
      });
    });
  });
}

function tail(text, max = 500) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? clean.slice(clean.length - max) : clean;
}

export class FfmpegService {
  constructor({ config, tv }) {
    this.config = config;
    this.tv = tv;
    this.sessions = new Map();
    this.children = new Set();
    this.activeExports = 0;
    this.versionCache = null;
    this.sweeper = setInterval(() => this.sweepIdle(), 10_000);
    this.sweeper.unref?.();
  }

  ffmpeg() {
    return this.config.ffmpegPath;
  }

  ffprobe() {
    return this.config.ffprobePath;
  }

  track(child) {
    this.children.add(child);
    child.once('close', () => this.children.delete(child));
    return child;
  }

  async version() {
    if (this.versionCache) return this.versionCache;
    const res = await run(this.ffmpeg(), ['-version'], { timeoutMs: 8000 });
    const firstLine = res.stdout.split(/\r?\n/)[0] ?? '';
    this.versionCache = res.code === 0
      ? { ok: true, version: firstLine.replace(/^ffmpeg version /, '').split(' ')[0], raw: firstLine }
      : { ok: false, version: null, error: 'FFmpeg not found on PATH. Install FFmpeg or set FFMPEG_PATH.' };
    return this.versionCache;
  }

  async probeStream(url, { timeoutMs = 12_000 } = {}) {
    const res = await run(
      this.ffprobe(),
      [
        '-v', 'error',
        '-rtsp_transport', 'tcp',
        '-rw_timeout', String(Math.max(3_000, timeoutMs - 3_000) * 1000),
        '-print_format', 'json',
        '-show_streams',
        '-show_format',
        '-i', url,
      ],
      { timeoutMs },
    );
    if (res.code !== 0) {
      return {
        ok: false,
        error: res.timedOut ? 'Timed out while connecting to the stream' : tail(res.stderr),
      };
    }
    let parsed;
    try {
      parsed = JSON.parse(res.stdout);
    } catch {
      return { ok: false, error: 'ffprobe returned unparseable output' };
    }
    const video = (parsed.streams ?? []).find((s) => s.codec_type === 'video');
    const audio = (parsed.streams ?? []).find((s) => s.codec_type === 'audio');
    return {
      ok: Boolean(video),
      video: video
        ? { codec: video.codec_name, width: video.width, height: video.height, profile: video.profile ?? null }
        : null,
      audio: audio ? { codec: audio.codec_name, channels: audio.channels } : null,
      durationSec: Number(parsed.format?.duration) || null,
      error: video ? null : 'No video stream found',
    };
  }

  async snapshot(camera) {
    const url = this.tv.rtspUrl(camera);
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(
          this.ffmpeg(),
          [
            '-hide_banner', '-loglevel', 'error',
            '-rtsp_transport', 'tcp',
            '-rw_timeout', '8000000',
            '-i', url,
            '-frames:v', '1',
            '-q:v', '3',
            '-f', 'image2pipe',
            '-vcodec', 'mjpeg',
            'pipe:1',
          ],
          { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
        );
      } catch (err) {
        resolve({ ok: false, error: err.message });
        return;
      }
      this.track(child);
      const chunks = [];
      let size = 0;
      let stderr = '';
      let done = false;
      const finish = (result) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        resolve(result);
      };
      const timer = setTimeout(() => finish({ ok: false, error: 'Snapshot timed out' }), 20_000);
      child.stdout.on('data', (chunk) => {
        if (size < 10 * 1024 * 1024) chunks.push(chunk);
        size += chunk.length;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString().slice(0, 2000);
      });
      child.once('error', (err) => finish({ ok: false, error: err.message }));
      child.once('close', () => {
        const buffer = Buffer.concat(chunks);
        if (buffer.length > 1000 && buffer[0] === 0xff && buffer[1] === 0xd8) {
          finish({ ok: true, buffer });
        } else {
          finish({ ok: false, error: tail(stderr) || 'Camera did not return a JPEG frame' });
        }
      });
    });
  }

  // ----- Live HLS -----

  async ensureLive(camera) {
    const existing = this.sessions.get(camera.id);
    if (existing) {
      existing.lastAccess = Date.now();
      if (existing.state === 'failed') {
        throw new HttpError(502, 'stream_failed', existing.error || 'Stream failed to start');
      }
      return existing;
    }
    const maxStreams = Math.min(Math.max(this.tv.settings().maxStreams ?? 2, 1), 8);
    if (this.sessions.size >= maxStreams) {
      throw new HttpError(429, 'stream_limit', `Gateway is already running ${this.sessions.size} live stream(s). Close another camera first.`);
    }
    const url = this.tv.rtspUrl(camera);
    const dir = path.join(this.config.hlsDir, `${camera.id}-${Date.now()}`);
    await fs.promises.mkdir(dir, { recursive: true });
    const encoder = this.tv.settings().hlsEncoder || this.config.hlsEncoder || 'copy';
    const session = {
      cameraId: camera.id,
      cameraName: camera.name,
      dir,
      encoder,
      state: 'starting',
      startedAt: Date.now(),
      lastAccess: Date.now(),
      attempts: 0,
      error: null,
      proc: null,
      audio: Boolean(camera.audio),
    };
    this.sessions.set(camera.id, session);
    this.startLiveProcess(session, url, encoder);
    try {
      await this.waitForPlaylist(session, 20_000);
      return session;
    } catch (err) {
      this.stopLive(camera.id, { removeDir: true });
      throw err;
    }
  }

  startLiveProcess(session, url, encoder) {
    session.attempts += 1;
    session.state = 'starting';
    const videoArgs = encoder === 'x264'
      ? ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-g', '30', '-sc_threshold', '0', '-pix_fmt', 'yuv420p', '-b:v', '1500k', '-maxrate', '2000k', '-bufsize', '3000k']
      : encoder === 'nvenc'
        ? ['-c:v', 'h264_nvenc', '-preset', 'p1', '-tune', 'll', '-g', '30', '-b:v', '1500k', '-maxrate', '3000k', '-bufsize', '4000k']
        : ['-c:v', 'copy'];
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-rtsp_transport', 'tcp',
      '-rw_timeout', '15000000',
      '-i', url,
      '-map', '0:v:0',
      ...videoArgs,
      ...(session.audio
        ? ['-map', '0:a:0?', '-c:a', 'aac', '-b:a', '64k']
        : ['-an']),
      '-f', 'hls',
      '-hls_time', '1',
      '-hls_list_size', '8',
      '-hls_delete_threshold', '2',
      '-hls_flags', 'delete_segments+append_list+independent_segments+omit_endlist',
      '-hls_segment_type', 'fmp4',
      '-hls_fmp4_init_filename', 'init.mp4',
      '-hls_segment_filename', path.join(session.dir, 'seg%06d.m4s'),
      path.join(session.dir, 'index.m3u8'),
    ];
    let child;
    try {
      child = spawn(this.ffmpeg(), args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      session.state = 'failed';
      session.error = `Could not start FFmpeg: ${err.message}`;
      return;
    }
    this.track(child);
    session.proc = child;
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-3000);
    });
    child.once('close', (code) => {
      if (session.stopped) return;
      session.proc = null;
      if (session.state === 'running' || session.state === 'starting') {
        session.state = 'failed';
        session.error = `Live stream stopped (ffmpeg exit ${code}): ${tail(stderr, 300)}`;
        log.warn('hls.process_exit', { camera: session.cameraId, code, stderr: tail(stderr, 300) });
      }
    });
    log.info('hls.start', { camera: session.cameraId, encoder, dir: path.basename(session.dir) });
  }

  async waitForPlaylist(session, timeoutMs) {
    const playlistPath = path.join(session.dir, 'index.m3u8');
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (session.state === 'failed') {
        throw new HttpError(502, 'stream_failed', session.error || 'FFmpeg could not read the camera stream');
      }
      try {
        const text = await fs.promises.readFile(playlistPath, 'utf8');
        if (/\.m4s/.test(text)) {
          session.state = 'running';
          return;
        }
      } catch {
        /* playlist not written yet */
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new HttpError(504, 'stream_timeout', 'Timed out waiting for the camera stream to start. Check the gateway logs and camera status.');
  }

  touch(cameraId) {
    const session = this.sessions.get(cameraId);
    if (session) session.lastAccess = Date.now();
    return session;
  }

  getSession(cameraId) {
    return this.sessions.get(cameraId) ?? null;
  }

  listSessions() {
    return [...this.sessions.values()].map((s) => ({
      cameraId: s.cameraId,
      cameraName: s.cameraName,
      state: s.state,
      encoder: s.encoder,
      startedAt: new Date(s.startedAt).toISOString(),
      idleSec: Math.round((Date.now() - s.lastAccess) / 1000),
    }));
  }

  stopLive(cameraId, { removeDir = true } = {}) {
    const session = this.sessions.get(cameraId);
    if (!session) return false;
    session.stopped = true;
    try {
      session.proc?.kill();
    } catch {
      /* noop */
    }
    this.sessions.delete(cameraId);
    if (removeDir) {
      const dir = session.dir;
      setTimeout(() => fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {}), 2_000).unref?.();
    }
    log.info('hls.stop', { camera: cameraId });
    return true;
  }

  sweepIdle() {
    const idleMs = 45_000;
    for (const [cameraId, session] of this.sessions) {
      if (Date.now() - session.lastAccess > idleMs) {
        this.stopLive(cameraId);
      }
    }
  }

  // ----- DVR playback export -----

  async exportFromDvr({ camera, start, end, outPath, onProgress, signal }) {
    const url = this.tv.playbackUrl(camera, start, end);
    if (!url) {
      return { ok: false, code: 'playback_not_configured', error: 'DVR playback URL template is not configured' };
    }
    const probe = await this.probeStream(url, { timeoutMs: 15_000 });
    if (!probe.ok) {
      return {
        ok: false,
        code: 'dvr_playback_unavailable',
        error: `DVR playback is not available for ${new Date(start).toLocaleString('en-IN')} to ${new Date(end).toLocaleString('en-IN')}: ${probe.error}`,
      };
    }
    const durationSec = Math.round((new Date(end).getTime() - new Date(start).getTime()) / 1000);
    const attempt = async (videoArgs) => {
      await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
      return this.runExportProcess({
        url,
        durationSec,
        outPath,
        videoArgs,
        onProgress,
        signal,
      });
    };
    let result = await attempt(['-map', '0:v:0', '-c:v', 'copy']);
    if (!result.ok && !result.cancelled) {
      log.warn('export.copy_failed_retry', { camera: camera.id, error: result.error });
      result = await attempt([
        '-map', '0:v:0',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
      ]);
    }
    if (!result.ok) return result;
    const stat = await fs.promises.stat(outPath).catch(() => null);
    if (!stat || stat.size < 10_000) {
      return { ok: false, code: 'export_empty', error: 'The DVR returned no usable video for that interval' };
    }
    return { ok: true, sizeBytes: stat.size, durationSec, source: 'dvr', codecProbe: probe };
  }

  runExportProcess({ url, durationSec, outPath, videoArgs, onProgress, signal }) {
    return new Promise((resolve) => {
      const args = [
        '-y', '-hide_banner', '-loglevel', 'error', '-nostats',
        '-progress', 'pipe:1',
        '-rtsp_transport', 'tcp',
        '-rw_timeout', '20000000',
        '-i', url,
        '-t', String(durationSec),
        ...videoArgs,
        '-an',
        '-movflags', '+faststart',
        '-f', 'mp4',
        outPath,
      ];
      let child;
      try {
        child = spawn(this.ffmpeg(), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        resolve({ ok: false, error: err.message });
        return;
      }
      this.track(child);
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
            const progress = Math.min(99, Math.round((Number(match[1]) / 1_000_000 / durationSec) * 100));
            onProgress?.(progress);
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
          resolve({ ok: false, error: tail(stderr) || `FFmpeg exited with code ${code}` });
          return;
        }
        resolve({ ok: true });
      });
    });
  }

  async probeFile(file) {
    const res = await run(
      this.ffprobe(),
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
      { timeoutMs: 20_000 },
    );
    if (res.code !== 0) return null;
    try {
      const parsed = JSON.parse(res.stdout);
      const video = (parsed.streams ?? []).find((s) => s.codec_type === 'video');
      return {
        durationSec: Number(parsed.format?.duration) || null,
        video: video ? { codec: video.codec_name, width: video.width, height: video.height } : null,
      };
    } catch {
      return null;
    }
  }

  /** Diagnostic only: verifies the local FFmpeg HLS pipeline with a synthetic source. */
  async selfTest() {
    const version = await this.version();
    if (!version.ok) return { ok: false, ffmpeg: version, error: version.error };
    const dir = path.join(this.config.tmpDir, `selftest-${Date.now()}`);
    await fs.promises.mkdir(dir, { recursive: true });
    const playlist = path.join(dir, 'index.m3u8');
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=15',
      '-t', '4',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-f', 'hls', '-hls_time', '1', '-hls_list_size', '0',
      '-hls_segment_type', 'fmp4',
      '-hls_fmp4_init_filename', 'init.mp4',
      '-hls_segment_filename', path.join(dir, 'seg%03d.m4s'),
      playlist,
    ];
    const res = await run(this.ffmpeg(), args, { timeoutMs: 20_000 });
    let ok = false;
    let segCount = 0;
    try {
      const text = await fs.promises.readFile(playlist, 'utf8');
      segCount = (text.match(/\.m4s/g) ?? []).length;
      ok = res.code === 0 && segCount > 0;
    } catch {
      ok = false;
    }
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    return {
      ok,
      ffmpeg: version,
      segments: segCount,
      error: ok ? null : tail(res.stderr, 400) || 'HLS self-test produced no segments',
    };
  }

  shutdown() {
    for (const cameraId of [...this.sessions.keys()]) this.stopLive(cameraId, { removeDir: false });
    for (const child of this.children) {
      try {
        child.kill();
      } catch {
        /* noop */
      }
    }
  }
}
