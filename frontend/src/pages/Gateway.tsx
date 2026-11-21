import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { errorMessage, useApp, usePolling } from '../state';
import { Badge, Card, DefinitionList, Empty, ErrorNote, InfoNote, Kpi, PageHeader, Spinner, Toggle } from '../ui';
import { formatBytes, formatDuration, relativeTime } from '../format';
import type { AuditEntry, CloudGateway, GatewaySettings, GatewayStatus } from '../types';

export default function GatewayPage() {
  const { mode } = useApp();
  return mode === 'gateway' ? <LocalGateway /> : <CloudGatewayPage />;
}

function SettingsEditor({ settings, onSaved }: { settings: GatewaySettings; onSaved: (next: GatewaySettings) => void }) {
  const { client, toast } = useApp();
  const [values, setValues] = useState(settings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setValues(settings);
  }, [settings]);

  function patch<K extends keyof GatewaySettings>(key: K, value: GatewaySettings[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const next = await client.request<GatewaySettings>('/settings', {
        method: 'PATCH',
        body: {
          timezone: values.timezone,
          defaultClipMinutes: Number(values.defaultClipMinutes),
          bufferRetentionMinutes: Number(values.bufferRetentionMinutes),
          bufferEnabled: Boolean(values.bufferEnabled),
          bufferDiskCapGb: Number(values.bufferDiskCapGb),
          clipRetentionDays: Number(values.clipRetentionDays),
          hlsEncoder: values.hlsEncoder,
          maxStreams: Number(values.maxStreams),
          publicBaseUrl: values.publicBaseUrl,
        },
      });
      onSaved(next);
      toast('Gateway settings saved.', 'ok');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={save}>
      <div className="form-grid">
        <label className="field">
          <span>Timezone</span>
          <input
            list="tz-list"
            value={values.timezone}
            onChange={(e) => patch('timezone', e.target.value)}
            placeholder="Asia/Kolkata"
          />
          <datalist id="tz-list">
            {['Asia/Kolkata', 'UTC', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London', 'America/New_York', 'Australia/Sydney'].map((tz) => (
              <option key={tz} value={tz} />
            ))}
          </datalist>
          <small className="muted">Used for DVR playback timestamps and buffer segment times.</small>
        </label>
        <label className="field">
          <span>Default clip length (minutes)</span>
          <input
            type="number"
            min={1}
            max={180}
            value={values.defaultClipMinutes}
            onChange={(e) => patch('defaultClipMinutes', Number(e.target.value))}
          />
        </label>
        <label className="field">
          <span>Clip retention (days)</span>
          <input
            type="number"
            min={1}
            max={365}
            value={values.clipRetentionDays}
            onChange={(e) => patch('clipRetentionDays', Number(e.target.value))}
          />
          <small className="muted">Exported copies older than this are deleted automatically. DVR footage is never touched.</small>
        </label>
        <label className="field">
          <span>HLS encoder</span>
          <select value={values.hlsEncoder} onChange={(e) => patch('hlsEncoder', e.target.value)}>
            <option value="copy">copy — no transcode (lowest CPU)</option>
            <option value="x264">x264 — CPU transcode</option>
            <option value="nvenc">nvenc — NVIDIA GPU transcode</option>
          </select>
          <small className="muted">Use copy unless the DVR stream is not browser compatible.</small>
        </label>
        <label className="field">
          <span>Max simultaneous live streams</span>
          <input
            type="number"
            min={1}
            max={8}
            value={values.maxStreams}
            onChange={(e) => patch('maxStreams', Number(e.target.value))}
          />
          <small className="muted">Keep this low on an 8 GB PC.</small>
        </label>
        <label className="field">
          <span>Gateway public / Tailscale URL</span>
          <input
            value={values.publicBaseUrl}
            onChange={(e) => patch('publicBaseUrl', e.target.value)}
            placeholder="http://100.101.102.103:8089"
          />
          <small className="muted">Used in cloud media links. Leave empty to auto-detect the LAN address.</small>
        </label>
        <label className="field">
          <span>Buffer retention (minutes)</span>
          <input
            type="number"
            min={5}
            max={1440}
            value={values.bufferRetentionMinutes}
            onChange={(e) => patch('bufferRetentionMinutes', Number(e.target.value))}
          />
        </label>
        <label className="field">
          <span>Buffer disk cap (GB)</span>
          <input
            type="number"
            min={1}
            max={500}
            value={values.bufferDiskCapGb}
            onChange={(e) => patch('bufferDiskCapGb', Number(e.target.value))}
          />
        </label>
      </div>
      <Toggle
        checked={Boolean(values.bufferEnabled)}
        onChange={(value) => patch('bufferEnabled', value)}
        label="Enable the local rolling buffer"
      />
      <p className="muted small">
        The rolling buffer records live streams on this PC into temporary segments. It is separate from the DVR recordings
        and is only used when DVR playback cannot provide the requested interval.
      </p>
      <ErrorNote message={error} />
      <div>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save settings'}
        </button>
      </div>
    </form>
  );
}

function LocalGateway() {
  const { client, toast } = useApp();
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  const [settings, setSettings] = useState<GatewaySettings | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selfTest, setSelfTest] = useState<{ ok: boolean; segments?: number; error?: string | null; ffmpeg?: { version?: string } } | null>(null);
  const [testing, setTesting] = useState(false);

  const load = useCallback(async () => {
    try {
      const [statusData, settingsData, auditData] = await Promise.all([
        client.request<GatewayStatus>('/status'),
        client.request<GatewaySettings>('/settings'),
        client.request<{ entries: AuditEntry[] }>('/audit?limit=20').catch(() => ({ entries: [] })),
      ]);
      setStatus(statusData);
      setSettings(settingsData);
      setAudit(auditData.entries ?? []);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [client]);

  usePolling(load, 15_000, [load]);

  async function runSelfTest() {
    setTesting(true);
    try {
      const result = await client.request<{ ok: boolean; segments?: number; error?: string | null; ffmpeg?: { version?: string } }>(
        '/system/selftest',
        { method: 'POST' },
      );
      setSelfTest(result);
      toast(result.ok ? 'FFmpeg HLS self-test passed.' : 'FFmpeg self-test failed.', result.ok ? 'ok' : 'bad');
    } catch (err) {
      toast(errorMessage(err), 'bad');
    } finally {
      setTesting(false);
    }
  }

  if (!status || !settings) {
    return (
      <>
        <PageHeader title="Gateway Status" subtitle="Local gateway health, settings and storage" />
        {loading ? <Spinner label="Loading gateway…" block /> : <ErrorNote message={error} onRetry={load} />}
      </>
    );
  }

  const disk = status.storage.disk;
  const usedPct = disk ? Math.round(((disk.totalBytes - disk.freeBytes) / disk.totalBytes) * 100) : 0;

  return (
    <>
      <PageHeader
        title="Gateway Status"
        subtitle={`${status.gateway.name} · v${status.version} · uptime ${formatDuration(status.uptimeSec)}`}
        actions={
          <>
            <button type="button" className="btn" onClick={runSelfTest} disabled={testing}>
              {testing ? 'Testing…' : 'FFmpeg self-test'}
            </button>
            <button type="button" className="btn" onClick={() => { void load(); }}>
              Refresh
            </button>
          </>
        }
      />
      {error ? <ErrorNote message={error} onRetry={load} /> : null}

      <div className="kpi-grid">
        <Kpi label="Gateway" value="Running" tone="ok" detail={`port ${window.location.port || '8089'}`} />
        <Kpi
          label="Cloud link"
          value={status.cloud.configured ? (status.cloud.connected ? 'Connected' : 'Disconnected') : 'Off'}
          tone={!status.cloud.configured ? 'idle' : status.cloud.connected ? 'ok' : 'bad'}
          detail={status.cloud.lastError ?? `heartbeat ${relativeTime(status.cloud.lastHeartbeatAt)}`}
        />
        <Kpi label="FFmpeg" value={status.ffmpeg.ok ? 'Ready' : 'Missing'} tone={status.ffmpeg.ok ? 'ok' : 'bad'} detail={status.ffmpeg.version ?? status.ffmpeg.error ?? ''} />
        <Kpi label="Disk used" value={`${usedPct}%`} tone={usedPct > 90 ? 'bad' : usedPct > 75 ? 'warn' : 'ok'} detail={`${formatBytes(disk?.freeBytes)} free`} />
      </div>

      <div className="grid-2">
        <Card title="Network endpoints">
          <DefinitionList
            rows={[
              ['Gateway ID', <code key="id">{status.gateway.id}</code>],
              ['Public / Tailscale URL', status.gateway.publicBaseUrl ? <code key="pub">{status.gateway.publicBaseUrl}</code> : '—'],
              [
                'LAN addresses',
                status.gateway.lanUrls.length
                  ? status.gateway.lanUrls.map((u) => (
                      <div key={u.address}>
                        <code>{u.url}</code> <span className="muted small">({u.name})</span>
                      </div>
                    ))
                  : '—',
              ],
              [
                'Tailscale addresses',
                status.gateway.tailnetUrls.length
                  ? status.gateway.tailnetUrls.map((u) => (
                      <div key={u.address}>
                        <code>{u.url}</code>
                      </div>
                    ))
                  : 'Not detected (install Tailscale on this PC)',
              ],
              ['Cloud backend', status.cloud.backendUrl ? <code key="b">{status.cloud.backendUrl}</code> : 'Not configured'],
            ]}
          />
        </Card>

        <Card title="Storage" actions={<span className="muted small">{formatBytes(disk?.freeBytes)} free of {formatBytes(disk?.totalBytes)}</span>}>
          <div className="storage-bar">
            <span style={{ width: `${usedPct}%` }} />
          </div>
          <DefinitionList
            rows={[
              ['Exported clips', formatBytes(status.storage.clipsBytes)],
              ['Rolling buffer', formatBytes(status.storage.bufferBytes)],
              ['Buffer cap', `${settings.bufferDiskCapGb} GB`],
              ['Clip retention', `${settings.clipRetentionDays} days`],
            ]}
          />
        </Card>

        <Card title="Rolling buffer">
          {status.buffer.cameras.length ? (
            <ul className="list">
              {status.buffer.cameras.map((cam) => (
                <li key={cam.cameraId} className="list-row">
                  <div>
                    <strong>{cam.name}</strong>
                    <span className="muted small">
                      {' '}
                      · {cam.segments} segments · {formatBytes(cam.bytes)}
                      {cam.newest ? ` · newest ${relativeTime(cam.newest)}` : ''}
                    </span>
                    {cam.error ? <div className="text-bad small">{cam.error}</div> : null}
                  </div>
                  <Badge tone={cam.running ? 'ok' : status.buffer.enabled ? 'warn' : 'idle'}>
                    {cam.running ? 'recording' : status.buffer.enabled ? 'stopped' : 'off'}
                  </Badge>
                </li>
              ))}
            </ul>
          ) : (
            <Empty title="No cameras for buffering">Enable the buffer per camera in DVR Configuration.</Empty>
          )}
        </Card>

        <Card title="Recent activity">
          {audit.length ? (
            <ul className="audit-list">
              {audit.map((entry) => (
                <li key={entry.id}>
                  <div>
                    <strong>{entry.action}</strong>
                    <span className="muted small"> · {relativeTime(entry.ts)} · {entry.actor ?? 'system'}</span>
                  </div>
                  {entry.meta ? <code className="small muted">{JSON.stringify(entry.meta).slice(0, 140)}</code> : null}
                </li>
              ))}
            </ul>
          ) : (
            <Empty title="No audit entries yet" />
          )}
        </Card>
      </div>

      {selfTest ? (
        <Card title="FFmpeg self-test result">
          <p className={selfTest.ok ? 'text-ok' : 'text-bad'}>
            {selfTest.ok
              ? `Generated a real HLS segment set with FFmpeg (${selfTest.segments ?? 0} segments).`
              : `Self-test failed: ${selfTest.error ?? 'unknown error'}`}
          </p>
          <p className="muted small">{selfTest.ffmpeg?.version ?? status.ffmpeg.version ?? ''}</p>
        </Card>
      ) : null}

      <Card title="Gateway settings">
        <SettingsEditor settings={settings} onSaved={setSettings} />
      </Card>
    </>
  );
}

function CloudGatewayPage() {
  const { client, toast } = useApp();
  const [data, setData] = useState<CloudGateway | null>(null);
  const [settings, setSettings] = useState<{ timezone: string; defaultClipMinutes: number; bufferRetentionMinutes: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [gatewayData, settingsData] = await Promise.all([
        client.request<CloudGateway>('/gateway'),
        client.request<{ timezone: string; defaultClipMinutes: number; bufferRetentionMinutes: number }>('/settings'),
      ]);
      setData(gatewayData);
      setSettings(settingsData);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [client]);

  usePolling(load, 15_000, [load]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!settings) return;
    setBusy(true);
    try {
      const next = await client.request<typeof settings>('/settings', {
        method: 'PATCH',
        body: settings,
      });
      setSettings(next);
      toast('Cloud settings saved.', 'ok');
    } catch (err) {
      toast(errorMessage(err), 'bad');
    } finally {
      setBusy(false);
    }
  }

  if (!data) {
    return (
      <>
        <PageHeader title="Gateway Status" subtitle="Cloud view of your home gateway" />
        {loading ? <Spinner label="Loading gateway…" block /> : <ErrorNote message={error} onRetry={load} />}
      </>
    );
  }

  const gw = data.gateway;
  return (
    <>
      <PageHeader
        title="Gateway Status"
        subtitle="Cloud view · live video requires opening the gateway on Wi-Fi or Tailscale"
        actions={
          <>
            {gw?.publicBaseUrl && gw.online ? (
              <a className="btn" href={gw.publicBaseUrl} target="_blank" rel="noreferrer">
                Open gateway
              </a>
            ) : null}
            <button type="button" className="btn" onClick={() => { void load(); }}>
              Refresh
            </button>
          </>
        }
      />
      {error ? <ErrorNote message={error} onRetry={load} /> : null}
      {!gw ? (
        <Card>
          <Empty title="Gateway never registered">
            Start the gateway with BACKEND_URL and GATEWAY_TOKEN configured. The backend only learns about the gateway
            through its outbound heartbeat.
          </Empty>
        </Card>
      ) : (
        <>
          <div className="kpi-grid">
            <Kpi label="Gateway" value={gw.online ? 'Online' : 'Offline'} tone={gw.online ? 'ok' : 'bad'} detail={`heartbeat ${relativeTime(gw.lastHeartbeat)}`} />
            <Kpi
              label="DVR"
              value={gw.dvr?.configured ? (gw.dvr.online ? 'Reachable' : 'Unreachable') : 'Not configured'}
              tone={gw.dvr?.configured ? (gw.dvr.online ? 'ok' : 'bad') : 'warn'}
              detail={gw.dvr?.error ?? `${gw.dvr?.host ?? ''}:${gw.dvr?.port ?? ''}`}
            />
            <Kpi label="Cameras online" value={`${data.cameras.online}/${data.cameras.total}`} tone={data.cameras.online ? 'ok' : 'warn'} detail="from last heartbeat" />
            <Kpi label="Free disk" value={formatBytes(gw.storage?.freeBytes)} tone="idle" detail={`of ${formatBytes(gw.storage?.totalBytes)}`} />
          </div>

          <div className="grid-2">
            <Card title="Gateway details">
              <DefinitionList
                rows={[
                  ['Name', gw.name],
                  ['Gateway ID', <code key="id">{gw.id}</code>],
                  ['Version', gw.version ?? '—'],
                  ['Platform', gw.platform ?? '—'],
                  ['Public / Tailscale URL', gw.publicBaseUrl ? <code key="u">{gw.publicBaseUrl}</code> : '—'],
                  ['Last heartbeat', relativeTime(gw.lastHeartbeat)],
                ]}
              />
            </Card>
            <Card title="DVR reported by gateway">
              <DefinitionList
                rows={[
                  ['Configured', gw.dvr?.configured ? 'Yes' : 'No'],
                  ['Reachable', gw.dvr?.online ? 'Yes' : 'No'],
                  ['Model', gw.dvr?.model || '—'],
                  ['Firmware', gw.dvr?.firmware || '—'],
                  ['Channels', String(gw.dvr?.channels ?? '—')],
                  ['RTSP playback', gw.dvr?.rtspPlayback ? 'Supported / configured' : 'Not reported'],
                  ['ONVIF', gw.dvr?.onvif ? 'Enabled' : 'Disabled'],
                ]}
              />
              <InfoNote>
                DVR credentials are only stored encrypted on the gateway. Editing them requires opening the gateway
                dashboard on your private network.
              </InfoNote>
            </Card>
            <Card title="Storage reported by gateway">
              <DefinitionList
                rows={[
                  ['Free', formatBytes(gw.storage?.freeBytes)],
                  ['Exported clips', formatBytes(gw.storage?.clipsBytes)],
                  ['Rolling buffer', formatBytes(gw.storage?.bufferBytes)],
                  ['Buffer enabled', gw.buffer?.enabled ? 'Yes' : 'No'],
                  ['Buffer retention', `${gw.buffer?.retentionMinutes ?? '—'} min`],
                ]}
              />
            </Card>
            <Card title="Cloud settings">
              {settings ? (
                <form className="stack" onSubmit={save}>
                  <label className="field">
                    <span>Timezone</span>
                    <input
                      list="cloud-tz-list"
                      value={settings.timezone}
                      onChange={(e) => setSettings({ ...settings, timezone: e.target.value })}
                    />
                    <datalist id="cloud-tz-list">
                      {['Asia/Kolkata', 'UTC', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London', 'America/New_York', 'Australia/Sydney'].map((tz) => (
                        <option key={tz} value={tz} />
                      ))}
                    </datalist>
                  </label>
                  <label className="field">
                    <span>Default clip length (minutes)</span>
                    <input
                      type="number"
                      min={1}
                      max={180}
                      value={settings.defaultClipMinutes}
                      onChange={(e) => setSettings({ ...settings, defaultClipMinutes: Number(e.target.value) })}
                    />
                  </label>
                  <label className="field">
                    <span>Buffer retention hint (minutes)</span>
                    <input
                      type="number"
                      min={5}
                      max={1440}
                      value={settings.bufferRetentionMinutes}
                      onChange={(e) => setSettings({ ...settings, bufferRetentionMinutes: Number(e.target.value) })}
                    />
                  </label>
                  <p className="muted small">These cloud values do not configure the gateway itself; it keeps its own settings.</p>
                  <div>
                    <button type="submit" className="btn btn-primary" disabled={busy}>
                      {busy ? 'Saving…' : 'Save cloud settings'}
                    </button>
                  </div>
                </form>
              ) : (
                <Spinner />
              )}
            </Card>
          </div>
        </>
      )}
    </>
  );
}
