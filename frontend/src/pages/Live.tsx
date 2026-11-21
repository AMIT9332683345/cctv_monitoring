import { useCallback, useEffect, useRef, useState } from 'react';
import { usePolling, useApp, navigateTo, errorMessage } from '../state';
import { Badge, Card, Empty, ErrorNote, InfoNote, PageHeader, Spinner } from '../ui';
import { statusTone } from '../format';
import type { CloudGateway, GatewayStatus, Camera, Snapshot } from '../types';
import { HlsPlayer } from '../player';

export default function Live() {
  const { mode } = useApp();
  return mode === 'gateway' ? <LocalLive /> : <RemoteLive />;
}

type Session = { url: string | null; starting: boolean; error: string | null };

function LocalLive() {
  const { client, toast } = useApp();
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  const [sessions, setSessions] = useState<Record<string, Session>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [snapshotBusy, setSnapshotBusy] = useState<string | null>(null);
  const sessionsRef = useRef<Record<string, Session>>({});
  sessionsRef.current = sessions;

  const load = useCallback(async () => {
    try {
      const [cameraData, statusData] = await Promise.all([
        client.request<{ cameras: Camera[] }>('/cameras'),
        client.request<GatewayStatus>('/status'),
      ]);
      setCameras(cameraData.cameras);
      setStatus(statusData);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [client]);

  usePolling(load, 12_000, [load]);

  useEffect(() => {
    return () => {
      for (const [cameraId, session] of Object.entries(sessionsRef.current)) {
        if (session.url) {
          void client.request(`/live/${encodeURIComponent(cameraId)}`, { method: 'DELETE' }).catch(() => {});
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function start(camera: Camera) {
    setSessions((prev) => ({ ...prev, [camera.id]: { url: null, starting: true, error: null } }));
    try {
      const data = await client.request<{ url: string }>(`/live/${encodeURIComponent(camera.id)}`, { method: 'POST' });
      setSessions((prev) => ({ ...prev, [camera.id]: { url: client.mediaUrl(data.url), starting: false, error: null } }));
    } catch (err) {
      const message = errorMessage(err);
      setSessions((prev) => ({ ...prev, [camera.id]: { url: null, starting: false, error: message } }));
      toast(message, 'bad');
    }
  }

  async function stop(camera: Camera) {
    setSessions((prev) => {
      const next = { ...prev };
      delete next[camera.id];
      return next;
    });
    try {
      await client.request(`/live/${encodeURIComponent(camera.id)}`, { method: 'DELETE' });
    } catch {
      /* the gateway sweep also releases idle streams */
    }
  }

  async function snapshot(camera: Camera) {
    setSnapshotBusy(camera.id);
    try {
      const shot = await client.request<Snapshot>('/snapshots', { method: 'POST', body: { cameraId: camera.id } });
      window.open(client.mediaUrl(shot.url), '_blank', 'noopener');
    } catch (err) {
      toast(errorMessage(err), 'bad');
    } finally {
      setSnapshotBusy(null);
    }
  }

  const dvrReady = Boolean(status?.dvr.configured && status.dvr.online);
  const activeCount = Object.values(sessions).filter((s) => s.url).length;

  return (
    <>
      <PageHeader
        title="Live Cameras"
        subtitle={
          status
            ? `${activeCount} active stream(s) · gateway local access · ${status.cameras.online}/${status.cameras.total} cameras online`
            : 'Live view from the local gateway'
        }
        actions={
          <button type="button" className="btn" onClick={() => { void load(); }}>
            Refresh status
          </button>
        }
      />
      {error ? <ErrorNote message={error} onRetry={load} /> : null}
      {!dvrReady ? (
        <InfoNote>
          {status?.dvr.configured
            ? `The DVR is unreachable (${status.dvr.error ?? 'connection failed'}). Live streams will fail until the gateway can reach ${status.dvr.host}:${status.dvr.port}.`
            : 'Live view needs the DVR connection details. Open DVR Configuration to add the DVR IP address, credentials and RTSP path.'}{' '}
          <button type="button" className="link-btn" onClick={() => navigateTo('/dvr')}>
            DVR Configuration
          </button>
        </InfoNote>
      ) : null}
      {loading ? <Spinner label="Loading cameras…" block /> : null}
      {!loading && !cameras.length ? (
        <Card>
          <Empty title="No cameras configured">
            Use DVR Configuration → Scan channels to detect cameras, or add channels manually. The gateway never hardcodes a
            camera count.
          </Empty>
          <button type="button" className="btn btn-primary" onClick={() => navigateTo('/dvr')}>
            Configure cameras
          </button>
        </Card>
      ) : null}

      <div className="camera-grid">
        {cameras.map((camera) => {
          const session = sessions[camera.id];
          const state = session?.url ? 'live' : camera.state ?? (camera.online ? 'ready' : 'unknown');
          return (
            <article key={camera.id} className={`camera-card${session?.url ? ' is-live' : ''}`}>
              <header className="camera-head">
                <div>
                  <strong>{camera.name}</strong>
                  <span className="muted small">
                    {' '}
                    · ch {camera.channel}
                    {camera.subtype === 1 ? ' · substream' : ''}
                    {camera.resolution ? ` · ${camera.resolution}` : ''}
                  </span>
                </div>
                <Badge tone={statusTone(state)}>{state}</Badge>
              </header>
              <div className="camera-body">
                {session?.url ? (
                  <HlsPlayer
                    src={session.url}
                    title={camera.name}
                    compact
                    onSnapshot={() => { void snapshot(camera); }}
                    snapshotBusy={snapshotBusy === camera.id}
                  />
                ) : (
                  <div className="camera-placeholder">
                    {session?.starting ? (
                      <>
                        <span className="spinner" />
                        <p>Starting stream…</p>
                      </>
                    ) : (
                      <>
                        <p className="muted">
                          {camera.enabled === false
                            ? 'Camera disabled in the gateway configuration.'
                            : session?.error
                              ? session.error
                              : 'Stream not started. Cameras run on demand to keep CPU and RAM low.'}
                        </p>
                        <button
                          type="button"
                          className="btn btn-primary"
                          disabled={camera.enabled === false || !dvrReady}
                          onClick={() => { void start(camera); }}
                        >
                          Start live view
                        </button>
                        <button type="button" className="btn btn-ghost" disabled={snapshotBusy === camera.id || !dvrReady} onClick={() => { void snapshot(camera); }}>
                          {snapshotBusy === camera.id ? 'Saving…' : 'Snapshot'}
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
              {session?.url ? (
                <footer className="camera-foot">
                  <span className="muted small">HLS · on-demand session</span>
                  <button type="button" className="btn btn-small" onClick={() => { void stop(camera); }}>
                    Stop stream
                  </button>
                </footer>
              ) : null}
            </article>
          );
        })}
      </div>
    </>
  );
}

function RemoteLive() {
  const { client } = useApp();
  const [gateway, setGateway] = useState<CloudGateway | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setGateway(await client.request<CloudGateway>('/gateway'));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [client]);

  usePolling(load, 15_000, [load]);

  const gw = gateway?.gateway;
  return (
    <>
      <PageHeader title="Live Cameras" subtitle="Cloud dashboard · live video is served by the gateway, not the cloud" />
      {error ? <ErrorNote message={error} onRetry={load} /> : null}
      {loading ? <Spinner label="Checking gateway…" block /> : null}
      <Card title="Open live video on the gateway">
        <p className="muted">
          Browsers on an HTTPS cloud page cannot open the gateway&apos;s local HTTP address. To watch live video, connect this
          device to your home Wi-Fi or to Tailscale and open the gateway directly.
        </p>
        {gw?.publicBaseUrl ? (
          <a className="btn btn-primary" href={gw.publicBaseUrl} target="_blank" rel="noreferrer">
            Open {gw.publicBaseUrl}
          </a>
        ) : (
          <p className="text-warn small">The gateway has not reported a public or Tailscale URL yet.</p>
        )}
        <ul className="hint-list">
          <li>Gateway: {gw ? (gw.online ? 'online' : 'offline') : 'not registered'}</li>
          <li>DVR: {gw?.dvr?.configured ? (gw.dvr.online ? 'reachable' : 'unreachable') : 'not configured on the gateway'}</li>
          <li>Cameras: {gateway ? `${gateway.cameras.online} online of ${gateway.cameras.total}` : '—'}</li>
        </ul>
      </Card>
      <Card title="Camera states">
        {gateway && gateway.cameras.total ? (
          <p className="muted small">
            The gateway reports {gateway.cameras.online} online camera(s). Open the gateway URL above for per-camera live
            status and playback controls.
          </p>
        ) : (
          <Empty title="No cameras reported">Configure cameras on the gateway first.</Empty>
        )}
      </Card>
    </>
  );
}
