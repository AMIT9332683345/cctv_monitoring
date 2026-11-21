import { assertDvrHost, dvrLocalTimestamp, tcpCheck } from '../util.mjs';
import { onvifProbe } from './onvif.mjs';
import { HttpError } from '../http.mjs';
import { log } from '../log.mjs';

const RTSP_TEMPLATES = [
  { name: 'CP Plus / Dahua', template: '/cam/realmonitor?channel={ch}&subtype={sub}' },
  { name: 'Hikvision', template: '/Streaming/Channels/{ch}0{sub}' },
  { name: 'Generic ONVIF', template: '/onvif1' },
];

export function dvrConfigured(dvr) {
  return Boolean(dvr?.host && dvr?.username && dvr?.passwordEnc);
}

export function normalizeTemplate(value, { requireTimestamps = false } = {}) {
  const template = String(value ?? '').trim();
  if (!template.startsWith('/')) {
    throw new HttpError(400, 'invalid_template', 'RTSP path must start with "/" and must not include the host or credentials');
  }
  if (!template.includes('{ch}')) {
    throw new HttpError(400, 'invalid_template', 'RTSP path must include the {ch} channel placeholder');
  }
  if (requireTimestamps && (!template.includes('{start}') || !template.includes('{end}') || !template.includes('{ch}'))) {
    throw new HttpError(400, 'invalid_template', 'Playback path must include {ch}, {start} and {end} placeholders');
  }
  if (/[\s]/.test(template)) {
    throw new HttpError(400, 'invalid_template', 'RTSP path must not contain whitespace');
  }
  return template;
}

function fillTemplate(template, values) {
  return Object.entries(values).reduce((acc, [key, value]) => acc.split(`{${key}}`).join(String(value)), template);
}

export function buildRtspUrl({ dvr, channel, subtype = 0, password, template }) {
  const path = fillTemplate(template ?? dvr.rtspTemplate, {
    ch: channel,
    sub: subtype,
  });
  return `rtsp://${encodeURIComponent(dvr.username)}:${encodeURIComponent(password ?? '')}@${dvr.host}:${dvr.rtspPort}${path}`;
}

export function buildPlaybackUrl({ dvr, channel, start, end, password, timezone }) {
  if (!dvr.playbackTemplate) return null;
  const path = fillTemplate(dvr.playbackTemplate, {
    ch: channel,
    sub: 0,
    start: dvrLocalTimestamp(new Date(start), timezone),
    end: dvrLocalTimestamp(new Date(end), timezone),
  });
  return `rtsp://${encodeURIComponent(dvr.username)}:${encodeURIComponent(password ?? '')}@${dvr.host}:${dvr.rtspPort}${path}`;
}

export function playbackPathExamples() {
  return [
    'CP Plus/Dahua: /cam/playback?channel={ch}&subtype=0&starttime={start}&endtime={end}',
  ];
}

export async function testConnection({ dvr, ffmpeg, decrypt, allowPublicHosts }) {
  const started = Date.now();
  const ip = await assertDvrHost(dvr.host, allowPublicHosts);
  const checks = {};
  checks.rtspPort = await tcpCheck(ip, dvr.rtspPort, 3000);
  checks.httpPort = await tcpCheck(ip, dvr.httpPort || 80, 3000);
  let stream = null;
  let onvif = null;
  let password = '';
  if (dvr.passwordEnc) password = decrypt(dvr.passwordEnc);

  if (dvr.username && password) {
    const url = buildRtspUrl({ dvr: { ...dvr, host: ip }, channel: 1, subtype: 0, password });
    stream = await ffmpeg.probeStream(url, { timeoutMs: 12_000 });
    if (!stream.ok) {
      const sub = await ffmpeg.probeStream(
        buildRtspUrl({ dvr: { ...dvr, host: ip }, channel: 1, subtype: 1, password }),
        { timeoutMs: 10_000 },
      );
      if (sub.ok) stream = { ...sub, note: 'Main stream failed; substream works' };
    }
  }

  if (dvr.onvif) {
    try {
      onvif = await onvifProbe({
        xaddr: `http://${ip}:${dvr.httpPort || 80}/onvif/device_service`,
        username: dvr.username,
        password,
        timeoutMs: 9000,
      });
    } catch (err) {
      onvif = { ok: false, error: err.message };
    }
  }

  const ok = Boolean(checks.rtspPort.ok && (stream?.ok || onvif?.ok));
  let message;
  if (!checks.rtspPort.ok) {
    message = `Cannot reach ${ip}:${dvr.rtspPort}. Check the DVR IP, that it is on the same network, and that RTSP is enabled on the DVR.`;
  } else if (!dvr.username || !password) {
    message = 'Port 554 is reachable. Enter the DVR username and password to test the video stream.';
  } else if (!stream?.ok) {
    message = `RTSP port is open but the stream failed: ${stream?.error ?? 'unknown error'}. Check credentials and the RTSP path template.`;
  } else {
    message = 'DVR stream is reachable.';
  }

  log.info('dvr.test', { host: ip, ok, ms: Date.now() - started, rtsp: Boolean(stream?.ok), onvif: Boolean(onvif?.ok) });
  return {
    ok,
    ip,
    message,
    checks,
    stream,
    onvif,
    testedAt: new Date().toISOString(),
    templates: RTSP_TEMPLATES,
  };
}

export function candidateTemplates() {
  return RTSP_TEMPLATES;
}

export async function scanChannels({
  dvr,
  ffmpeg,
  decrypt,
  maxChannels = 16,
  onProgress,
  isCancelled,
}) {
  const ip = await assertDvrHost(dvr.host, false);
  const password = dvr.passwordEnc ? decrypt(dvr.passwordEnc) : '';
  if (!dvr.username || !password) {
    throw new HttpError(400, 'dvr_credentials_missing', 'Save the DVR username and password before scanning channels');
  }
  const total = Math.min(Math.max(maxChannels, 1), 64);
  const results = [];
  let next = 1;
  let done = 0;
  const templates = [{ template: dvr.rtspTemplate, label: 'configured' }, ...RTSP_TEMPLATES];

  async function probeChannel(channel) {
    for (const candidate of templates) {
      if (!candidate.template) continue;
      const url = buildRtspUrl({
        dvr: { ...dvr, host: ip },
        channel,
        subtype: 0,
        password,
        template: candidate.template,
      });
      const probe = await ffmpeg.probeStream(url, { timeoutMs: 9000 });
      if (probe.ok) {
        return { channel, online: true, probe, template: candidate.template, templateLabel: candidate.label };
      }
      if (candidate.label === 'configured') continue;
      // Fallbacks are only tried once per channel; avoid a 3x penalty on empty channels.
      break;
    }
    return { channel, online: false, probe: null };
  }

  async function worker() {
    while (next <= total && !isCancelled?.()) {
      const channel = next;
      next += 1;
      const result = await probeChannel(channel);
      results.push(result);
      done += 1;
      onProgress?.({ done, total, found: results.filter((r) => r.online).length, channel });
    }
  }

  await Promise.all([worker(), worker()]);
  return results.sort((a, b) => a.channel - b.channel);
}

export async function probeCamera({ camera, dvr, ffmpeg, decrypt }) {
  const password = dvr.passwordEnc ? decrypt(dvr.passwordEnc) : '';
  const url = buildRtspUrl({ dvr, channel: camera.channel, subtype: camera.subtype ?? 0, password });
  const probe = await ffmpeg.probeStream(url, { timeoutMs: 12_000 });
  return { online: probe.ok, probe, checkedAt: new Date().toISOString() };
}
