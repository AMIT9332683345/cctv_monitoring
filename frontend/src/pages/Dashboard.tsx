import { useCallback, useState } from 'react';
import { usePolling } from '../state';
import { useApp } from '../state';
import { Badge, Card, Dot, Empty, ErrorNote, Kpi, PageHeader, Spinner } from '../ui';
import { formatBytes, formatDateTime, formatDuration, formatTime, relativeTime, statusTone } from '../format';
import type { CloudGateway, GatewayStatus, Job } from '../types';

export default function Dashboard({ navigate }: { navigate: (path: string) => void }) {
  const { mode } = useApp();
  return mode === 'gateway' ? <GatewayDashboard navigate={navigate} /> : <CloudDashboard navigate={navigate} />;
}

function AccessHint({ lanUrls, tailnetUrls }: { lanUrls: { url: string; address: string }[]; tailnetUrls: { url: string; address: string }[] }) {
  const host = window.location.hostname;
  const onLan = lanUrls.some((u) => u.address === host);
  const onTailnet = tailnetUrls.some((u) => u.address === host);
  const label = onLan ? 'Home Wi-Fi (direct LAN)' : onTailnet ? 'Tailscale private network' : 'Private / other route';
  return (
    <span>
      <Dot tone={onLan || onTailnet ? 'ok' : 'warn'} /> {label}
    </span>
  );
}

function RecentJobs({ jobs }: { jobs: { id: string; name?: string; cameraName?: string; status: string; progress?: number; createdAt: string }[] }) {
  if (!jobs.length) return <Empty title="No exports yet">Select a time range in Clip Export to create your first clip.</Empty>;
  return (
    <ul className="list">
      {jobs.map((job) => (
        <li key={job.id} className="list-row">
          <div>
            <strong>{job.cameraName ?? job.name ?? 'Camera'}</strong>
            <span className="muted small"> · {relativeTime(job.createdAt)}</span>
          </div>
          <Badge tone={statusTone(job.status)}>
            {job.status}
            {job.status === 'running' ? ` ${job.progress ?? 0}%` : ''}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

function GatewayDashboard({ navigate }: { navigate: (path: string) => void }) {
  const { client, toast } = useApp();
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [statusData, jobData] = await Promise.all([
        client.request<GatewayStatus>('/status'),
        client.request<{ jobs: Job[] }>('/jobs?limit=5'),
      ]);
      setStatus(statusData);
      setJobs(jobData.jobs);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load dashboard');
    } finally {
      setLoading(false);
    }
  }, [client]);

  usePolling(load, 10_000, [load]);

  if (!status) {
    return (
      <>
        <PageHeader title="Dashboard" subtitle="Local gateway overview" />
        {loading ? <Spinner label="Loading gateway status…" block /> : <ErrorNote message={error} onRetry={load} />}
      </>
    );
  }

  const dvr = status.dvr;
  const bufferCams = status.buffer.cameras.filter((c) => c.running).length;
  const diskFree = status.storage.disk?.freeBytes ?? 0;
  const diskTotal = status.storage.disk?.totalBytes ?? 0;
  const usedPct = diskTotal ? Math.round(((diskTotal - diskFree) / diskTotal) * 100) : 0;
  const playing = status.streams.length;

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle={
          <AccessHint
            lanUrls={status.gateway.lanUrls}
            tailnetUrls={status.gateway.tailnetUrls}
          />
        }
        actions={
          <>
            <button type="button" className="btn" onClick={() => navigate('/live')}>
              Open live cameras
            </button>
            <button type="button" className="btn btn-primary" onClick={() => navigate('/export')}>
              Export a clip
            </button>
          </>
        }
      />
      {error ? <ErrorNote message={error} onRetry={load} /> : null}
      <div className="kpi-grid">
        <Kpi label="Gateway" value="Online" tone="ok" detail={`v${status.version} · ${formatDuration(status.uptimeSec)} uptime`} />
        <Kpi
          label="DVR"
          value={dvr.configured ? (dvr.online ? 'Reachable' : 'Unreachable') : 'Not configured'}
          tone={dvr.configured ? (dvr.online ? 'ok' : 'bad') : 'warn'}
          detail={dvr.configured ? `${dvr.host}:${dvr.port}` : 'Open DVR Configuration'}
        />
        <Kpi
          label="Cameras"
          value={`${status.cameras.online}/${status.cameras.total}`}
          tone={status.cameras.online > 0 ? 'ok' : 'warn'}
          detail={`${status.cameras.enabled} enabled`}
        />
        <Kpi label="Active streams" value={playing} tone={playing ? 'ok' : 'idle'} detail={`max ${status.streams.length ? 'per config' : 'per config'}`} />
        <Kpi
          label="Cloud link"
          value={status.cloud.configured ? (status.cloud.connected ? 'Connected' : 'Disconnected') : 'Not configured'}
          tone={!status.cloud.configured ? 'idle' : status.cloud.connected ? 'ok' : 'bad'}
          detail={status.cloud.configured ? (status.cloud.lastError ?? `heartbeat ${relativeTime(status.cloud.lastHeartbeatAt)}`) : 'Local only'}
        />
      </div>

      <div className="grid-2">
        <Card title="Storage" actions={<span className="muted small">{usedPct}% disk used</span>}>
          <div className="storage-bar">
            <span style={{ width: `${usedPct}%` }} />
          </div>
          <div className="storage-legend">
            <span>
              <strong>{formatBytes(diskFree)}</strong> free of {formatBytes(diskTotal)}
            </span>
            <span className="muted">Clips {formatBytes(status.storage.clipsBytes)} · Buffer {formatBytes(status.storage.bufferBytes)}</span>
          </div>
        </Card>

        <Card
          title="Rolling buffer"
          actions={
            <Badge tone={status.buffer.enabled ? 'ok' : 'idle'}>{status.buffer.enabled ? 'Enabled' : 'Disabled'}</Badge>
          }
        >
          <p className="muted small">
            {status.buffer.enabled
              ? `${bufferCams} camera(s) recording locally · ${status.buffer.retentionMinutes} min retention · ${formatBytes(status.buffer.bytesUsed)} used`
              : 'The local rolling buffer is off. Clip export relies on DVR playback until you enable it.'}
          </p>
          <button type="button" className="btn btn-ghost" onClick={() => navigate('/gateway')}>
            Manage buffer
          </button>
        </Card>

        <Card title="DVR" actions={<Badge tone={dvr.online ? 'ok' : dvr.configured ? 'bad' : 'warn'}>{dvr.configured ? (dvr.online ? 'reachable' : 'unreachable') : 'not configured'}</Badge>}>
          {dvr.configured ? (
            <dl className="def-list compact">
              <div className="def-row">
                <dt>Address</dt>
                <dd>{dvr.host}:{dvr.port}</dd>
              </div>
              <div className="def-row">
                <dt>Channels</dt>
                <dd>{dvr.channels}</dd>
              </div>
              <div className="def-row">
                <dt>Model</dt>
                <dd>{dvr.model || 'Not detected'}</dd>
              </div>
              <div className="def-row">
                <dt>Playback</dt>
                <dd>{status.cameras.total ? 'Configured per camera' : 'Not configured'}</dd>
              </div>
            </dl>
          ) : (
            <p className="muted small">Add the DVR IP address, credentials and RTSP path in the setup wizard.</p>
          )}
          <button type="button" className="btn btn-ghost" onClick={() => navigate('/dvr')}>
            {dvr.configured ? 'DVR settings' : 'Configure DVR'}
          </button>
        </Card>

        <Card title="Recent exports" actions={<button type="button" className="btn btn-ghost btn-small" onClick={() => navigate('/clips')}>All clips</button>}>
          <RecentJobs jobs={jobs} />
        </Card>
      </div>

      {status.ffmpeg && !status.ffmpeg.ok ? (
        <Card title="FFmpeg problem">
          <p className="text-bad">FFmpeg is not available to the gateway. Install FFmpeg and restart the gateway.</p>
          <p className="muted small">{status.ffmpeg.error ?? 'Unknown error'}</p>
        </Card>
      ) : null}

      <div className="quick-grid">
        <button type="button" className="quick" onClick={() => navigate('/export')}>
          <strong>New clip</strong>
          <span>Export a time range as MP4</span>
        </button>
        <button type="button" className="quick" onClick={() => navigate('/dvr')}>
          <strong>DVR check</strong>
          <span>Test RTSP, ONVIF and channels</span>
        </button>
        <button type="button" className="quick" onClick={() => navigate('/security')}>
          <strong>Security</strong>
          <span>Password and sessions</span>
        </button>
        <button type="button" className="quick" onClick={() => { void load(); toast('Status refreshed', 'ok'); }}>
          <strong>Refresh</strong>
          <span>Reload gateway status</span>
        </button>
      </div>
    </>
  );
}

function CloudDashboard({ navigate }: { navigate: (path: string) => void }) {
  const { client } = useApp();
  const [gw, setGw] = useState<CloudGateway | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [gatewayData, jobData] = await Promise.all([
        client.request<CloudGateway>('/gateway'),
        client.request<{ jobs: Job[] }>('/jobs?limit=5'),
      ]);
      setGw(gatewayData);
      setJobs(jobData.jobs);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load dashboard');
    } finally {
      setLoading(false);
    }
  }, [client]);

  usePolling(load, 15_000, [load]);

  if (!gw) {
    return (
      <>
        <PageHeader title="Dashboard" subtitle="Cloud dashboard" />
        {loading ? <Spinner label="Loading gateway status…" block /> : <ErrorNote message={error} onRetry={load} />}
      </>
    );
  }

  const gateway = gw.gateway;
  const dvr = gateway?.dvr;
  const storage = gateway?.storage;
  const recent = jobs.map((j) => ({ ...j, name: j.cameraName }));

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle="Cloud dashboard · live video stays on your gateway"
        actions={
          <>
            {gateway?.publicBaseUrl && gateway.online ? (
              <a className="btn" href={gateway.publicBaseUrl} target="_blank" rel="noreferrer">
                Open live dashboard
              </a>
            ) : null}
            <button type="button" className="btn btn-primary" onClick={() => navigate('/export')}>
              Export a clip
            </button>
          </>
        }
      />
      {error ? <ErrorNote message={error} onRetry={load} /> : null}
      <div className="kpi-grid">
        <Kpi
          label="Gateway"
          value={gateway ? (gateway.online ? 'Online' : 'Offline') : 'Not registered'}
          tone={gateway ? (gateway.online ? 'ok' : 'bad') : 'warn'}
          detail={gateway ? `heartbeat ${relativeTime(gateway.lastHeartbeat)}` : 'Start the gateway on your PC'}
        />
        <Kpi
          label="DVR"
          value={dvr?.configured ? (dvr.online ? 'Reachable' : 'Unreachable') : 'Not configured'}
          tone={dvr?.configured ? (dvr.online ? 'ok' : 'bad') : 'warn'}
          detail={dvr?.configured ? `${dvr.host ?? ''}:${dvr.port ?? ''}` : 'Configure on the gateway'}
        />
        <Kpi
          label="Cameras"
          value={`${gw.cameras.online}/${gw.cameras.total}`}
          tone={gw.cameras.online > 0 ? 'ok' : 'warn'}
          detail="online / configured"
        />
        <Kpi
          label="Browser connection"
          value="Cloud"
          tone="info"
          detail="Open the gateway directly on Wi-Fi or via Tailscale for live video"
        />
      </div>

      <div className="grid-2">
        <Card title="Gateway storage" actions={gateway?.publicBaseUrl ? <code className="small">{gateway.publicBaseUrl}</code> : null}>
          {storage ? (
            <>
              <div className="storage-legend">
                <span>
                  <strong>{formatBytes(storage.freeBytes)}</strong> free of {formatBytes(storage.totalBytes)}
                </span>
                <span className="muted">Clips {formatBytes(storage.clipsBytes)} · Buffer {formatBytes(storage.bufferBytes)}</span>
              </div>
            </>
          ) : (
            <Empty title="No storage data">The gateway has not reported storage yet.</Empty>
          )}
        </Card>

        <Card title="Rolling buffer" actions={<Badge tone={gateway?.buffer?.enabled ? 'ok' : 'idle'}>{gateway?.buffer?.enabled ? 'Enabled' : 'Disabled'}</Badge>}>
          <p className="muted small">
            {gateway?.buffer?.enabled
              ? `${gateway.buffer.cameraIds?.length ?? 0} camera(s) · ${gateway.buffer.retentionMinutes} min retention · ${formatBytes(gateway.buffer.diskUsedBytes)} used`
              : 'The rolling buffer is off on the gateway. DVR playback is used for exports.'}
          </p>
          <button type="button" className="btn btn-ghost" onClick={() => navigate('/gateway')}>
            Gateway details
          </button>
        </Card>

        <Card title="Recent exports" actions={<button type="button" className="btn btn-ghost btn-small" onClick={() => navigate('/clips')}>All clips</button>}>
          <RecentJobs jobs={recent} />
        </Card>

        <Card title="Remote viewing">
          <p className="muted small">
            For live video outside your home, connect this device to Tailscale and open the gateway URL. The cloud
            dashboard is used for exports and status, not for streaming through a public relay.
          </p>
          {gateway?.publicBaseUrl ? (
            <a className="btn btn-ghost" href={gateway.publicBaseUrl} target="_blank" rel="noreferrer">
              Gateway URL
            </a>
          ) : (
            <p className="text-warn small">The gateway has not reported a public/Tailscale URL.</p>
          )}
        </Card>
      </div>

      {dvr?.error ? <ErrorNote message={`DVR: ${dvr.error}`} /> : null}
      {gateway && !gateway.online ? (
        <Card title="Gateway offline">
          <p className="muted small">
            Start the gateway on the Windows PC. Remote export jobs are queued only while the gateway is online; existing
            clips remain listed with their real status.
          </p>
        </Card>
      ) : null}
      {jobs.length ? (
        <p className="muted small">
          Last clip: {jobs[0].cameraName} · {formatDateTime(jobs[0].start)} → {formatTime(jobs[0].end)} ({formatDuration(jobs[0].durationSec)})
        </p>
      ) : null}
    </>
  );
}
