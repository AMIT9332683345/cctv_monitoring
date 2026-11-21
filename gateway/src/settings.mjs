import { HttpError } from './http.mjs';

const ENCODERS = new Set(['copy', 'x264', 'nvenc']);

export function validatePublicBaseUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, 'bad_public_url', 'Public gateway URL must be a full http(s) URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new HttpError(400, 'bad_public_url', 'Public gateway URL must use http or https');
  }
  if (url.username || url.password) {
    throw new HttpError(400, 'bad_public_url', 'Public gateway URL must not contain credentials');
  }
  return (url.origin + url.pathname).replace(/\/+$/, '');
}

/** Mutates state.settings with validated values. Returns the list of changed keys. */
export function applySettingsPatch(settings, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new HttpError(400, 'bad_settings', 'Settings must be an object');
  }
  const changed = [];
  if (patch.timezone !== undefined) {
    const tz = String(patch.timezone);
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
    } catch {
      throw new HttpError(400, 'bad_timezone', 'Unknown timezone');
    }
    settings.timezone = tz;
    changed.push('timezone');
  }
  if (patch.defaultClipMinutes !== undefined) {
    const n = Number(patch.defaultClipMinutes);
    if (!Number.isInteger(n) || n < 1 || n > 180) throw new HttpError(400, 'bad_settings', 'defaultClipMinutes must be 1-180');
    settings.defaultClipMinutes = n;
    changed.push('defaultClipMinutes');
  }
  if (patch.bufferRetentionMinutes !== undefined) {
    const n = Number(patch.bufferRetentionMinutes);
    if (!Number.isInteger(n) || n < 5 || n > 1440) throw new HttpError(400, 'bad_settings', 'bufferRetentionMinutes must be 5-1440');
    settings.bufferRetentionMinutes = n;
    changed.push('bufferRetentionMinutes');
  }
  if (patch.bufferEnabled !== undefined) {
    settings.bufferEnabled = Boolean(patch.bufferEnabled);
    changed.push('bufferEnabled');
  }
  if (patch.bufferDiskCapGb !== undefined) {
    const n = Number(patch.bufferDiskCapGb);
    if (!Number.isFinite(n) || n < 1 || n > 500) throw new HttpError(400, 'bad_settings', 'bufferDiskCapGb must be 1-500');
    settings.bufferDiskCapGb = n;
    changed.push('bufferDiskCapGb');
  }
  if (patch.clipRetentionDays !== undefined) {
    const n = Number(patch.clipRetentionDays);
    if (!Number.isInteger(n) || n < 1 || n > 365) throw new HttpError(400, 'bad_settings', 'clipRetentionDays must be 1-365');
    settings.clipRetentionDays = n;
    changed.push('clipRetentionDays');
  }
  if (patch.hlsEncoder !== undefined) {
    if (!ENCODERS.has(String(patch.hlsEncoder))) throw new HttpError(400, 'bad_settings', 'hlsEncoder must be copy, x264 or nvenc');
    settings.hlsEncoder = String(patch.hlsEncoder);
    changed.push('hlsEncoder');
  }
  if (patch.maxStreams !== undefined) {
    const n = Number(patch.maxStreams);
    if (!Number.isInteger(n) || n < 1 || n > 8) throw new HttpError(400, 'bad_settings', 'maxStreams must be 1-8');
    settings.maxStreams = n;
    changed.push('maxStreams');
  }
  if (patch.publicBaseUrl !== undefined) {
    settings.publicBaseUrl = validatePublicBaseUrl(patch.publicBaseUrl);
    changed.push('publicBaseUrl');
  }
  if (!changed.length) throw new HttpError(400, 'bad_settings', 'No supported settings supplied');
  return changed;
}
