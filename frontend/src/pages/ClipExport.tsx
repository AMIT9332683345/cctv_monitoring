import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { errorMessage, navigateTo, useApp, usePolling } from '../state';
import { Badge, Card, Empty, ErrorNote, InfoNote, PageHeader, Progress, Spinner } from '../ui';
import { formatBytes, formatDateTime, formatDuration, formatTime, fromDateTimeLocal, isActiveJob, jobFileSource, sourceLabel, statusTone, toDateTimeLocal } from '../format';
import type { Camera, GatewayStatus, Job, JobSource } from '../types';

type Settings = { timezone: string; defaultClipMinutes: number };

export default function ClipExport() {
  const { mode } = useApp();
  return (
    <>
      <PageHeader
        title="Clip Export"
        subtitle={
          mode === 'gateway'
            ? 'Copy a time range from the DVR or the local rolling buffer. The original DVR recording is never modified.'
            : 'Queue an export on your gateway. The gateway must be online to run the job.'
        }
      />
      <ExportForm />
    </>
  );
}

function ExportForm() {
  const { client, mode, toast } = useApp();
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  const [cameraId, setCameraId] = useState('');
  const [source, setSource] = useState<JobSource>('auto');
  const [end, setEnd] = useState(() => toDateTimeLocal(new Date()));
  const [start, setStart] = useState(() => toDateTimeLocal(new Date(Date.now() - 15 * 60_000)));
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [loading, setLoading] = useState(true);
  const jobTimer = useRef<number | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const cameraData = await client.request<{ cameras: Camera[] }>('/cameras');
      setCameras(cameraData.cameras);
      const settingsData = await client.request<Settings & { defaultClipMinutes: number }>('/settings');
      setSettings({ timezone: settingsData.timezone, defaultClipMinutes: settingsData.defaultClipMinutes });
      if (mode === 'gateway') {
        setStatus(await client.request<GatewayStatus>('/status'));
      }
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [client, mode]);

  usePolling(load, 20_000, [load]);

  useEffect(() => {
    if (!settings || touched) return;
    const now = new Date();
    const minutes = Math.min(Math.max(settings.defaultClipMinutes || 15, 1), 180);
    setEnd(toDateTimeLocal(now));
    setStart(toDateTimeLocal(new Date(now.getTime() - minutes * 60_000)));
  }, [settings, touched]);

  useEffect(() => {
    if (!cameraId && cameras.length) setCameraId(cameras[0].id);
  }, [cameras, cameraId]);

  useEffect(() => {
    return () => {
      if (jobTimer.current) window.clearTimeout(jobTimer.current);
    };
  }, []);

  const startDate = fromDateTimeLocal(start);
  const endDate = fromDateTimeLocal(end);
  const durationSec = startDate && endDate ? Math.round((endDate.getTime() - startDate.getTime()) / 1000) : 0;
  const camera = cameras.find((c) => c.id === cameraId) ?? null;

  const bufferInfo = useMemo(() => {
    if (!status || !camera) return null;
    const entry = status.buffer.cameras.find((c) => c.cameraId === camera.id);
    if (!entry) return null;
    return entry;
  }, [status, camera]);

  const rangeProblem = useMemo(() => {
    if (!startDate || !endDate) return 'Choose a start and end time.';
    if (endDate.getTime() <= startDate.getTime()) return 'End time must be after the start time.';
    if (durationSec < 5) return 'Clips must be at least 5 seconds long.';
    if (durationSec > 6 * 3600) return 'The maximum clip length is 6 hours.';
    if (endDate.getTime() > Date.now() + 120_000) return 'End time cannot be in the future.';
    return null;
  }, [startDate, endDate, durationSec]);

  const bufferWarning = useMemo(() => {
    if (mode !== 'gateway' || source === 'dvr' || !status?.buffer.enabled) return null;
    if (!bufferInfo?.running && source === 'buffer') return 'The rolling buffer is not recording this camera.';
    if (bufferInfo?.oldest && startDate && startDate.getTime() < new Date(bufferInfo.oldest).getTime()) {
      return `The buffer starts at ${formatDateTime(bufferInfo.oldest, settings?.timezone)}. Footage before that is not available locally.`;
    }
    return null;
  }, [mode, source, status, bufferInfo, startDate, settings]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!cameraId) {
      setError('Select a camera.');
      return;
    }
    if (rangeProblem || !startDate || !endDate) {
      setError(rangeProblem ?? 'Choose a valid range.');
      return;
    }
    setBusy(true);
    try {
      const data = await client.request<{ job: Job }>('/jobs', {
        method: 'POST',
        body: {
          cameraId,
          start: startDate.toISOString(),
          end: endDate.toISOString(),
          source,
        },
      });
      setJob(data.job);
      toast('Export queued on the gateway.', 'ok');
      void watch(data.job.id);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function watch(jobId: string) {
    if (jobTimer.current) window.clearTimeout(jobTimer.current);
    const tick = async () => {
      try {
        const data = await client.request<{ job: Job }>(`/jobs/${encodeURIComponent(jobId)}`);
        setJob(data.job);
        if (isActiveJob(data.job.status)) {
          jobTimer.current = window.setTimeout(tick, 1800);
        } else if (data.job.status === 'completed') {
          toast('Export completed.', 'ok');
        } else if (data.job.status === 'failed') {
          toast('Export failed. See the job details.', 'bad');
        }
      } catch (err) {
        setError(errorMessage(err));
      }
    };
    void tick();
  }

  function quick(minutes: number) {
    setTouched(true);
    const now = new Date();
    setEnd(toDateTimeLocal(now));
    setStart(toDateTimeLocal(new Date(now.getTime() - minutes * 60_000)));
  }

  async function deleteJob() {
    if (!job) return;
    try {
      if (mode === 'gateway') {
        await client.request(`/jobs/${encodeURIComponent(job.id)}`, { method: 'DELETE' });
        setJob({ ...job, status: 'deleted' });
      } else {
        await client.request(`/jobs/${encodeURIComponent(job.id)}`, { method: 'DELETE' });
        setJob({ ...job, status: 'deleting' });
      }
      toast('Clip deleted.', 'ok');
    } catch (err) {
      toast(errorMessage(err), 'bad');
    }
  }

  const dvrConfigured = status?.dvr.configured ?? true;
  const bufferEnabled = status?.buffer.enabled ?? false;

  return (
    <div className="stack-lg">
      {error ? <ErrorNote message={error} onRetry={load} /> : null}
      {loading ? <Spinner label="Loading cameras and settings…" block /> : null}
      {!loading && !cameras.length ? (
        <Card>
          <Empty title="No cameras yet">Add cameras in DVR Configuration, then return here to export a clip.</Empty>
          <button type="button" className="btn btn-primary" onClick={() => navigateTo('/dvr')}>
            Open DVR Configuration
          </button>
        </Card>
      ) : null}

      {cameras.length ? (
        <Card title="Select the interval">
          <form className="stack" onSubmit={submit}>
            <div className="form-grid">
              <label className="field">
                <span>Camera</span>
                <select value={cameraId} onChange={(e) => setCameraId(e.target.value)}>
                  {cameras.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} · ch {c.channel}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Source</span>
                <select value={source} onChange={(e) => setSource(e.target.value as JobSource)}>
                  <option value="auto">Auto — DVR playback, then rolling buffer</option>
                  <option value="dvr" disabled={!dvrConfigured}>DVR playback only</option>
                  <option value="buffer" disabled={mode === 'gateway' && !bufferEnabled}>Rolling buffer only</option>
                </select>
              </label>
              <label className="field">
                <span>Start</span>
                <input
                  type="datetime-local"
                  value={start}
                  onChange={(e) => {
                    setTouched(true);
                    setStart(e.target.value);
                  }}
                  required
                />
              </label>
              <label className="field">
                <span>End</span>
                <input
                  type="datetime-local"
                  value={end}
                  onChange={(e) => {
                    setTouched(true);
                    setEnd(e.target.value);
                  }}
                  required
                />
              </label>
            </div>

            <div className="inline-row">
              <span className="muted small">Quick range:</span>
              {[15, 30, 60].map((m) => (
                <button key={m} type="button" className="btn btn-small" onClick={() => quick(m)}>
                  Last {m} min
                </button>
              ))}
              <span className={`duration-pill${rangeProblem ? ' is-bad' : ''}`}>{formatDuration(durationSec)}</span>
            </div>

            <p className="muted small">
              DVR playback timestamps use the gateway timezone{settings ? ` (${settings.timezone})` : ''}. The DVR recording
              stays untouched; the gateway reads the interval and writes a new MP4.
            </p>
            {mode === 'gateway' && source !== 'dvr' && !bufferEnabled ? (
              <InfoNote>
                The rolling buffer is currently disabled. Auto mode will only succeed if the DVR supports playback for this
                interval. Enable the buffer in Gateway Status for live-capture fallback.
              </InfoNote>
            ) : null}
            {bufferWarning ? <InfoNote>{bufferWarning}</InfoNote> : null}
            {source === 'buffer' && bufferInfo ? (
              <p className="muted small">
                Buffer window: {bufferInfo.oldest ? formatDateTime(bufferInfo.oldest, settings?.timezone) : '—'} →{' '}
                {bufferInfo.newest ? formatDateTime(bufferInfo.newest, settings?.timezone) : '—'} ·{' '}
                {formatBytes(bufferInfo.bytes)} · {bufferInfo.running ? 'recording' : 'not recording'}
              </p>
            ) : null}
            {source === 'dvr' && camera?.dvrPlayback === false ? (
              <InfoNote>This camera is marked as having no DVR playback support in the gateway configuration.</InfoNote>
            ) : null}

            <div className="inline-row">
              <button type="submit" className="btn btn-primary" disabled={busy || Boolean(rangeProblem)}>
                {busy ? 'Queueing…' : 'Export clip'}
              </button>
              {rangeProblem && start && end ? <span className="text-warn small">{rangeProblem}</span> : null}
            </div>
          </form>
        </Card>
      ) : null}

      {job ? (
        <Card
          title="Export status"
          actions={<Badge tone={statusTone(job.status)}>{job.status}</Badge>}
        >
          <div className="stack">
            <div className="inline-row space-between">
              <span>
                <strong>{job.cameraName}</strong> · {formatDateTime(job.start)} → {formatTime(job.end)} (
                {formatDuration(job.durationSec)})
              </span>
              <span className="muted small">{sourceLabel(job.source)}</span>
            </div>
            {job.status === 'running' || job.status === 'queued' ? (
              <>
                <Progress value={job.progress} />
                <p className="muted small">{job.progress}% · the gateway is extracting the interval with FFmpeg</p>
              </>
            ) : null}
            {job.status === 'failed' ? (
              <ErrorNote message={job.error ?? 'Export failed.'} />
            ) : null}
            {job.status === 'completed' ? (
              <>
                <div className="meta-row">
                  <span>Source: {sourceLabel(jobFileSource(job))}</span>
                  <span>Size: {formatBytes(job.file?.sizeBytes)}</span>
                  {job.file?.resolution ? <span>{job.file.resolution}</span> : null}
                  {job.file?.codec ? <span>{job.file.codec}</span> : null}
                </div>
                {jobMediaUrl(job) ? (
                  <video className="clip-video" controls playsInline src={jobMediaUrl(job) ?? undefined} />
                ) : (
                  <InfoNote>The clip file exists on the gateway, but no playback URL is available in this mode.</InfoNote>
                )}
                <div className="inline-row">
                  {jobMediaUrl(job) ? (
                    <a className="btn btn-primary" href={jobDownloadUrl(job)} download>
                      Download MP4
                    </a>
                  ) : null}
                  <button type="button" className="btn" onClick={() => navigateTo('/clips')}>
                    Export history
                  </button>
                  <button type="button" className="btn btn-danger" onClick={() => { void deleteJob(); }}>
                    Delete copy
                  </button>
                </div>
              </>
            ) : null}
            {(job.status === 'deleted' || job.status === 'deleting') ? (
              <p className="muted small">The exported copy has been removed from the gateway storage.</p>
            ) : null}
          </div>
        </Card>
      ) : null}

      <p className="muted small">
        Exports are labelled by source. “DVR playback” means the clip was read from the DVR without modifying the original
        recording. “Local buffer” means the gateway recorded it from the live stream in its temporary rolling buffer.
      </p>
    </div>
  );

  function jobMediaUrl(value: Job): string | null {
    const url = value.mediaUrl ?? value.downloadUrl ?? null;
    return url ? client.mediaUrl(url) : null;
  }

  function jobDownloadUrl(value: Job): string {
    const media = value.mediaUrl ? client.mediaUrl(value.mediaUrl) : value.downloadUrl ? client.mediaUrl(value.downloadUrl) : '';
    if (!media) return '#';
    if (/[?&]download=1/.test(media)) return media;
    return `${media}${media.includes('?') ? '&' : '?'}download=1`;
  }
}
