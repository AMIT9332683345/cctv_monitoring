import { randomUUID } from 'node:crypto';
import { HttpError } from './http.mjs';
import { clampInt } from './util.mjs';

export function createCameraService({ state, save, ffmpeg, tv, audit }) {
  function list() {
    return state.cameras
      .slice()
      .sort((a, b) => a.channel - b.channel);
  }

  function get(id) {
    return state.cameras.find((c) => c.id === id) ?? null;
  }

  function sanitizeChannel(value, fallback) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 64) {
      throw new HttpError(400, 'bad_channel', 'Channel must be a whole number between 1 and 64');
    }
    return n || fallback;
  }

  async function upsert(input, { actor = 'local' } = {}) {
    const channel = sanitizeChannel(input.channel);
    const name = String(input.name ?? '').trim().slice(0, 60) || `Camera ${channel}`;
    const existingById = input.id ? get(String(input.id)) : null;
    if (input.id && !existingById && !input.allowCreate) {
      throw new HttpError(404, 'camera_not_found', 'Camera not found');
    }
    const duplicate = state.cameras.find((c) => c.channel === channel && c.id !== existingById?.id);
    if (duplicate) {
      throw new HttpError(409, 'channel_in_use', `Channel ${channel} is already assigned to "${duplicate.name}"`);
    }
    const now = new Date().toISOString();
    if (existingById) {
      existingById.name = name;
      existingById.channel = channel;
      if (input.subtype !== undefined) existingById.subtype = input.subtype === 1 ? 1 : 0;
      if (input.enabled !== undefined) existingById.enabled = Boolean(input.enabled);
      if (input.buffer !== undefined) existingById.buffer = Boolean(input.buffer);
      if (input.dvrPlayback !== undefined) existingById.dvrPlayback = input.dvrPlayback === null ? null : Boolean(input.dvrPlayback);
      if (input.audio !== undefined) existingById.audio = Boolean(input.audio);
      existingById.updatedAt = now;
      await save();
      await audit({ actor, action: 'camera.updated', meta: { cameraId: existingById.id, channel, name } });
      return existingById;
    }
    const camera = {
      id: randomUUID(),
      name,
      channel,
      subtype: input.subtype === 1 ? 1 : 0,
      enabled: input.enabled !== false,
      buffer: Boolean(input.buffer),
      dvrPlayback: input.dvrPlayback === false ? false : null,
      audio: Boolean(input.audio),
      lastProbe: input.lastProbe ?? null,
      createdAt: now,
      updatedAt: now,
    };
    state.cameras.push(camera);
    await save();
    await audit({ actor, action: 'camera.created', meta: { cameraId: camera.id, channel, name } });
    return camera;
  }

  async function remove(id, { actor = 'local' } = {}) {
    const camera = get(id);
    if (!camera) throw new HttpError(404, 'camera_not_found', 'Camera not found');
    state.cameras = state.cameras.filter((c) => c.id !== id);
    await save();
    await audit({ actor, action: 'camera.deleted', meta: { cameraId: id, channel: camera.channel } });
    return camera;
  }

  async function probe(camera) {
    if (!tv.dvrConfigured()) {
      throw new HttpError(409, 'dvr_not_configured', 'Save the DVR connection details first');
    }
    const password = tv.dvrPassword();
    const { buildRtspUrl } = await import('./adapters/dvr.mjs');
    const url = buildRtspUrl({
      dvr: state.dvr,
      channel: camera.channel,
      subtype: camera.subtype ?? 0,
      password,
    });
    const result = await ffmpeg.probeStream(url, { timeoutMs: 12_000 });
    camera.lastProbe = {
      online: result.ok,
      at: new Date().toISOString(),
      codec: result.video?.codec ?? null,
      resolution: result.video ? `${result.video.width}x${result.video.height}` : null,
      error: result.ok ? null : result.error,
    };
    await save();
    return result;
  }

  async function applyScanResults(results, { actor = 'local', enableNew = true } = {}) {
    const found = results.filter((r) => r.online);
    const created = [];
    const updated = [];
    for (const result of found) {
      const existing = state.cameras.find((c) => c.channel === result.channel);
      const probe = {
        online: true,
        at: new Date().toISOString(),
        codec: result.probe.video?.codec ?? null,
        resolution: result.probe.video ? `${result.probe.video.width}x${result.probe.video.height}` : null,
        error: null,
      };
      if (existing) {
        existing.lastProbe = probe;
        if (result.template) state.dvr.rtspTemplate = result.template;
        existing.updatedAt = new Date().toISOString();
        updated.push(existing);
      } else {
        const camera = {
          id: randomUUID(),
          name: `Camera ${result.channel}`,
          channel: result.channel,
          subtype: 0,
          enabled: enableNew,
          buffer: false,
          dvrPlayback: null,
          audio: false,
          lastProbe: probe,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        state.cameras.push(camera);
        created.push(camera);
      }
    }
    // Channels that previously existed but were not found keep their config,
    // but their status is marked offline so the UI tells the truth.
    const foundChannels = new Set(found.map((r) => r.channel));
    for (const camera of state.cameras) {
      if (!foundChannels.has(camera.channel) && camera.lastProbe?.online) {
        camera.lastProbe = { ...camera.lastProbe, online: false, at: new Date().toISOString(), error: 'Not detected in the last channel scan' };
      }
    }
    if (found.length) {
      state.dvr.channels = Math.max(state.dvr.channels, ...found.map((r) => r.channel));
    }
    await save();
    await audit({ actor, action: 'camera.scan_applied', meta: { created: created.length, updated: updated.length } });
    return { created, updated, foundChannels: [...foundChannels].sort((a, b) => a - b) };
  }

  async function count() {
    return { total: state.cameras.length, enabled: state.cameras.filter((c) => c.enabled).length };
  }

  return { list, get, upsert, remove, probe, applyScanResults, count, sanitizeChannel, clampInt };
}
