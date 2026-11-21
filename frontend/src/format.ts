export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 100 || unit === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  const s = Math.max(0, Math.round(seconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  if (hours) return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(secs).padStart(2, '0')}s`;
  if (minutes) return `${minutes}m ${String(secs).padStart(2, '0')}s`;
  return `${secs}s`;
}

export function formatDateTime(iso: string | null | undefined, timezone?: string): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone || undefined,
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(date);
  } catch {
    return date.toLocaleString();
  }
}

export function formatTime(iso: string | null | undefined, timezone?: string): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone || undefined,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(date);
  } catch {
    return date.toLocaleTimeString();
  }
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'unknown';
  const diff = Math.round((date.getTime() - Date.now()) / 1000);
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? 'from now' : 'ago';
  if (abs < 10) return diff >= 0 ? 'in a moment' : 'just now';
  if (abs < 60) return `${abs}s ${suffix}`;
  if (abs < 3600) return `${Math.round(abs / 60)}m ${suffix}`;
  if (abs < 86400) return `${Math.round(abs / 3600)}h ${suffix}`;
  return `${Math.round(abs / 86400)}d ${suffix}`;
}

/** Value for <input type="datetime-local"> in the browser's local timezone. */
export function toDateTimeLocal(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function fromDateTimeLocal(value: string): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function sourceLabel(source: string | null | undefined): string {
  if (source === 'dvr') return 'DVR playback';
  if (source === 'buffer') return 'Local buffer';
  if (source === 'auto') return 'Auto (DVR → buffer)';
  return source ?? '—';
}

export function jobFileSource(job: { source?: string; file?: { source?: string | null } | null }): string {
  return job.file?.source ?? job.source ?? '—';
}

export function clipFileName(job: { cameraName?: string; start?: string; id?: string }): string {
  const camera = (job.cameraName ?? 'camera').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const stamp = job.start ? new Date(job.start).toISOString().replace(/[:.]/g, '-').slice(0, 19) : job.id ?? 'clip';
  return `opps-${camera || 'camera'}-${stamp}.mp4`;
}

export function isActiveJob(status: string | null | undefined): boolean {
  return status === 'queued' || status === 'running' || status === 'deleting';
}

export function statusTone(status: string | null | undefined): 'ok' | 'warn' | 'bad' | 'idle' | 'info' {
  switch (status) {
    case 'completed':
    case 'live':
    case 'ready':
    case 'online':
      return 'ok';
    case 'running':
    case 'queued':
    case 'deleting':
      return 'info';
    case 'failed':
      return 'bad';
    case 'disabled':
    case 'deleted':
      return 'idle';
    default:
      return 'warn';
  }
}
