import { useCallback, useMemo, useState } from 'react';
import { errorMessage, useApp, usePolling } from '../state';
import { Badge, Card, Empty, ErrorNote, Modal, PageHeader, Spinner } from '../ui';
import { formatBytes, formatDateTime, formatDuration, formatTime, isActiveJob, jobFileSource, sourceLabel, statusTone } from '../format';
import type { Job } from '../types';

type Filter = 'all' | 'completed' | 'active' | 'failed';

export default function Clips() {
  const { client, mode, toast } = useApp();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>('all');
  const [playing, setPlaying] = useState<Job | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await client.request<{ jobs: Job[] }>('/jobs?limit=100');
      setJobs(data.jobs);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [client]);

  usePolling(load, 8_000, [load]);

  const filtered = useMemo(() => {
    return jobs.filter((job) => {
      if (filter === 'all') return true;
      if (filter === 'completed') return job.status === 'completed';
      if (filter === 'failed') return job.status === 'failed';
      return isActiveJob(job.status);
    });
  }, [jobs, filter]);

  function mediaUrl(job: Job): string {
    const url = job.mediaUrl ?? job.downloadUrl ?? '';
    return url ? client.mediaUrl(url) : '';
  }

  function downloadUrl(job: Job): string {
    const media = mediaUrl(job);
    if (!media) return '';
    if (/[?&]download=1/.test(media)) return media;
    return `${media}${media.includes('?') ? '&' : '?'}download=1`;
  }

  async function remove(job: Job) {
    const label = `${job.cameraName} · ${formatDateTime(job.start)}`;
    if (!window.confirm(`Delete the exported copy for ${label}? The original DVR recording is not affected.`)) return;
    try {
      await client.request(`/jobs/${encodeURIComponent(job.id)}`, { method: 'DELETE' });
      toast(mode === 'gateway' ? 'Clip deleted.' : 'Delete requested. The gateway will remove the file.', 'ok');
      void load();
    } catch (err) {
      toast(errorMessage(err), 'bad');
    }
  }

  const active = jobs.filter((j) => isActiveJob(j.status)).length;

  return (
    <>
      <PageHeader
        title="Export History"
        subtitle={`${jobs.length} export(s) · ${active} active · exported copies only, DVR originals untouched`}
        actions={
          <button type="button" className="btn" onClick={() => { void load(); }}>
            Refresh
          </button>
        }
      />
      {error ? <ErrorNote message={error} onRetry={load} /> : null}
      <div className="segmented" role="tablist">
        {(['all', 'completed', 'active', 'failed'] as Filter[]).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={filter === value}
            className={`segment${filter === value ? ' active' : ''}`}
            onClick={() => setFilter(value)}
          >
            {value === 'all' ? 'All' : value === 'active' ? 'In progress' : value === 'completed' ? 'Completed' : 'Failed'}
          </button>
        ))}
      </div>

      {loading ? <Spinner label="Loading exports…" block /> : null}
      {!loading && !filtered.length ? (
        <Card>
          <Empty title="No exports in this view">
            Select a time range in Clip Export. Exported clips appear here with their source (DVR playback or local buffer).
          </Empty>
        </Card>
      ) : null}

      <div className="clip-list">
        {filtered.map((job) => {
          const playable = job.status === 'completed' && Boolean(mediaUrl(job));
          return (
            <article key={job.id} className="clip-row">
              <div className="clip-main">
                <div className="clip-title">
                  <strong>{job.cameraName}</strong>
                  <Badge tone={statusTone(job.status)}>{job.status}</Badge>
                  {job.status === 'completed' ? <Badge tone="idle">{sourceLabel(jobFileSource(job))}</Badge> : null}
                </div>
                <div className="muted small">
                  {formatDateTime(job.start)} → {formatTime(job.end)} · {formatDuration(job.durationSec)} · requested via{' '}
                  {sourceLabel(job.source)}
                </div>
                {job.file?.sizeBytes ? (
                  <div className="muted small">
                    {formatBytes(job.file.sizeBytes)}
                    {job.file.resolution ? ` · ${job.file.resolution}` : ''}
                    {job.file.codec ? ` · ${job.file.codec}` : ''}
                  </div>
                ) : null}
                {job.status === 'running' || job.status === 'queued' ? (
                  <div className="muted small">Progress {job.progress ?? 0}%</div>
                ) : null}
                {job.error ? <div className="text-bad small">{job.error}</div> : null}
              </div>
              <div className="clip-actions">
                {playable ? (
                  <button type="button" className="btn btn-small btn-primary" onClick={() => setPlaying(job)}>
                    Play
                  </button>
                ) : null}
                {playable ? (
                  <a className="btn btn-small" href={downloadUrl(job)} download>
                    Download
                  </a>
                ) : null}
                {!isActiveJob(job.status) && job.status !== 'deleted' ? (
                  <button type="button" className="btn btn-small btn-danger" onClick={() => { void remove(job); }}>
                    Delete
                  </button>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>

      <Modal
        open={Boolean(playing)}
        title={playing ? `${playing.cameraName} · ${formatDateTime(playing.start)}` : 'Clip'}
        onClose={() => setPlaying(null)}
        footer={
          playing && mediaUrl(playing) ? (
            <div className="inline-row">
              <a className="btn btn-primary" href={downloadUrl(playing)} download>
                Download MP4
              </a>
              <span className="muted small">{sourceLabel(jobFileSource(playing))}</span>
            </div>
          ) : null
        }
      >
        {playing && mediaUrl(playing) ? (
          <video className="clip-video" controls autoPlay playsInline src={mediaUrl(playing)} />
        ) : (
          <p className="muted">This export has no playable media URL in the current mode.</p>
        )}
        {playing?.file?.sizeBytes ? (
          <p className="muted small">
            {formatBytes(playing.file.sizeBytes)} · {formatDuration(playing.file.durationSec ?? playing.durationSec)}
          </p>
        ) : null}
      </Modal>
    </>
  );
}
