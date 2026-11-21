import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { errorMessage, useApp, usePolling } from '../state';
import { Badge, Card, DefinitionList, Empty, ErrorNote, InfoNote, PageHeader, Progress, Spinner, Toggle } from '../ui';
import { relativeTime, statusTone } from '../format';
import type { Camera, CloudGateway, CommandResult, DvrConfig, DvrTestResult, ScanState } from '../types';

export default function DvrConfigPage() {
  const { mode } = useApp();
  return mode === 'gateway' ? <LocalDvrConfig /> : <CloudDvrConfig />;
}

type DiscoveredDevice = {
  xaddr: string;
  scopes?: string[];
  name?: string;
  onvif?: { ok: boolean; device?: { manufacturer?: string; model?: string; firmware?: string } | null; channels?: number | null; error?: string | null } | null;
};

function portOpen(check: boolean | { ok?: boolean; error?: string | null } | null | undefined): boolean {
  return typeof check === 'object' && check !== null ? Boolean(check.ok) : Boolean(check);
}

function TestResultCard({ result }: { result: DvrTestResult | null }) {
  if (!result) return null;
  const checks = result.checks ?? {};
  return (
    <Card title="DVR test result" actions={<Badge tone={result.ok ? 'ok' : 'bad'}>{result.ok ? 'reachable' : 'failed'}</Badge>}>
      <p className={result.ok ? 'text-ok' : 'text-bad'}>{result.message}</p>
      <DefinitionList
        rows={[
          [
            'Ports',
            <span key="ports">
              RTSP {portOpen(checks.rtspPort) ? 'open' : 'closed'} · HTTP {portOpen(checks.httpPort) ? 'open' : 'closed'}
            </span>,
          ],
          [
            'Stream probe',
            result.stream
              ? result.stream.ok
                ? `${result.stream.video?.codec ?? 'video'}${result.stream.video?.width ? ` · ${result.stream.video.width}x${result.stream.video.height}` : ''}${result.stream.audio ? ` · audio ${result.stream.audio.codec}` : ' · no audio'}`
                : result.stream.error ?? 'failed'
              : 'not attempted',
          ],
          [
            'ONVIF',
            result.onvif
              ? result.onvif.ok
                ? `${result.onvif.device?.manufacturer ?? ''} ${result.onvif.device?.model ?? ''}`.trim() || 'reachable'
                : result.onvif.error ?? 'not available'
              : 'not attempted',
          ],
          ['Device', result.onvif?.device ? `${result.onvif.device.model ?? 'unknown model'} · FW ${result.onvif.device.firmware ?? '—'}` : '—'],
          ['Channels', result.onvif?.channels ? String(result.onvif.channels) : 'not reported'],
        ]}
      />
      {result.stream && !result.stream.ok ? (
        <InfoNote>
          If the RTSP port is open but the stream probe fails, the RTSP path template or substream may differ. Try
          another template or enable RTSP/ONVIF in the DVR settings. The gateway does not bypass DVR authentication.
        </InfoNote>
      ) : null}
    </Card>
  );
}

function LocalDvrConfig() {
  const { client, toast } = useApp();
  const [dvr, setDvr] = useState<(DvrConfig & { password?: string }) | null>(null);
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<DvrTestResult | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [devices, setDevices] = useState<DiscoveredDevice[] | null>(null);
  const [scan, setScan] = useState<ScanState | null>(null);
  const [scanBusy, setScanBusy] = useState(false);
  const scanTimer = useRef<number | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const [dvrData, cameraData] = await Promise.all([
        client.request<DvrConfig>('/dvr'),
        client.request<{ cameras: Camera[] }>('/cameras'),
      ]);
      setDvr((prev) => ({
        ...dvrData,
        password: '',
        ...(prev && prev.host === dvrData.host ? { password: prev.password } : {}),
      }));
      setCameras(cameraData.cameras);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [client]);

  usePolling(load, 30_000, [load]);

  useEffect(() => {
    return () => {
      if (scanTimer.current) window.clearTimeout(scanTimer.current);
    };
  }, []);

  if (!dvr) {
    return (
      <>
        <PageHeader title="DVR Configuration" subtitle="Connect the gateway to your CP Plus DVR" />
        {loading ? <Spinner label="Loading DVR configuration…" block /> : <ErrorNote message={error} onRetry={load} />}
      </>
    );
  }

  function patch<K extends keyof (DvrConfig & { password?: string })>(key: K, value: (DvrConfig & { password?: string })[K]) {
    setDvr((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  async function save(event?: FormEvent) {
    event?.preventDefault();
    if (!dvr) return;
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        host: dvr.host,
        rtspPort: Number(dvr.rtspPort),
        httpPort: Number(dvr.httpPort),
        username: dvr.username,
        channels: Number(dvr.channels),
        rtspTemplate: dvr.rtspTemplate,
        playbackTemplate: dvr.playbackTemplate,
        onvif: Boolean(dvr.onvif),
      };
      if (dvr.password) body.password = dvr.password;
      const saved = await client.request<DvrConfig>('/dvr', { method: 'PUT', body });
      setDvr({ ...saved, password: '' });
      toast('DVR settings saved. Credentials are encrypted on the gateway.', 'ok');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await client.request<DvrTestResult>('/dvr/test', { method: 'POST' }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setTesting(false);
    }
  }

  async function discover() {
    setDiscovering(true);
    setDevices(null);
    try {
      const data = await client.request<{ devices: DiscoveredDevice[] }>('/dvr/discover', { method: 'POST' });
      setDevices(data.devices);
      if (!data.devices.length) toast('No ONVIF devices answered the discovery probe.', 'info');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setDiscovering(false);
    }
  }

  async function startScan() {
    setScanBusy(true);
    setScan(null);
    try {
      const started = await client.request<ScanState>('/dvr/scan', {
        method: 'POST',
        body: { maxChannels: Number(dvr?.channels ?? 8), apply: true },
      });
      setScan(started);
      pollScan(started.id);
    } catch (err) {
      setScanBusy(false);
      setError(errorMessage(err));
    }
  }

  function pollScan(id: string) {
    if (scanTimer.current) window.clearTimeout(scanTimer.current);
    const tick = async () => {
      try {
        const current = await client.request<ScanState>(`/dvr/scan/${encodeURIComponent(id)}`);
        setScan(current);
        if (current.status === 'running') {
          scanTimer.current = window.setTimeout(tick, 1500);
        } else {
          setScanBusy(false);
          if (current.status === 'done') {
            toast(`Scan finished: ${current.found} channel(s) online.`, 'ok');
            void load();
          }
        }
      } catch (err) {
        setScanBusy(false);
        setError(errorMessage(err));
      }
    };
    void tick();
  }

  function useDevice(device: DiscoveredDevice) {
    try {
      const url = new URL(device.xaddr);
      patch('host', url.hostname);
      if (url.port) {
        const port = Number(url.port);
        if (port !== 80 && port !== 443) patch('rtspPort', port);
      }
      toast(`Filled DVR host from ${device.xaddr}. Save and test the connection.`, 'info');
    } catch {
      toast('Could not parse the discovered address.', 'bad');
    }
  }

  const caps = dvr.capabilities;

  return (
    <div className="stack-lg">
      <PageHeader
        title="DVR Configuration"
        subtitle="The exact CP Plus model may vary. Verify the model, RTSP path and ONVIF support before relying on playback."
        actions={
          <>
            <button type="button" className="btn" onClick={test} disabled={testing || !dvr.host}>
              {testing ? 'Testing…' : 'Test DVR'}
            </button>
            <button type="button" className="btn btn-primary" onClick={() => { void save(); }} disabled={saving}>
              {saving ? 'Saving…' : 'Save DVR settings'}
            </button>
          </>
        }
      />
      {error ? <ErrorNote message={error} onRetry={load} /> : null}
      {dvr.lastTest ? (
        <p className="muted small">
          Last test {relativeTime(dvr.lastTest.at)} · {dvr.lastTest.ok ? 'passed' : 'failed'} · {dvr.lastTest.message}
        </p>
      ) : null}

      <div className="grid-2">
        <Card title="Connection">
          <form className="stack" onSubmit={save}>
            <div className="form-grid">
              <label className="field">
                <span>DVR host / IP</span>
                <input value={dvr.host} onChange={(e) => patch('host', e.target.value)} placeholder="192.168.1.108" required />
                <small className="muted">Private LAN address only. The gateway refuses public addresses.</small>
              </label>
              <label className="field">
                <span>RTSP port</span>
                <input type="number" min={1} max={65535} value={dvr.rtspPort} onChange={(e) => patch('rtspPort', Number(e.target.value))} />
              </label>
              <label className="field">
                <span>HTTP port</span>
                <input type="number" min={1} max={65535} value={dvr.httpPort} onChange={(e) => patch('httpPort', Number(e.target.value))} />
              </label>
              <label className="field">
                <span>DVR username</span>
                <input value={dvr.username} onChange={(e) => patch('username', e.target.value)} placeholder="your DVR user" autoComplete="off" />
              </label>
              <label className="field">
                <span>DVR password</span>
                <input
                  type="password"
                  value={dvr.password ?? ''}
                  onChange={(e) => patch('password', e.target.value)}
                  placeholder={dvr.hasPassword ? 'Saved — leave blank to keep' : 'Enter DVR password'}
                  autoComplete="new-password"
                />
                <small className="muted">Encrypted at rest on this PC. Never sent to the cloud.</small>
              </label>
              <label className="field">
                <span>Maximum channels to scan</span>
                <input type="number" min={1} max={64} value={dvr.channels} onChange={(e) => patch('channels', Number(e.target.value))} />
              </label>
            </div>
            <Toggle checked={Boolean(dvr.onvif)} onChange={(value) => patch('onvif', value)} label="Try ONVIF discovery and device info" />
            <div className="inline-row">
              <Badge tone={caps?.rtspLive ? 'ok' : 'warn'}>{caps?.rtspLive ? 'RTSP ready' : 'RTSP not verified'}</Badge>
              <Badge tone={caps?.dvrPlayback ? 'ok' : 'warn'}>{caps?.dvrPlayback ? 'Playback path set' : 'No playback path'}</Badge>
              <Badge tone={caps?.onvif ? 'ok' : 'idle'}>{caps?.onvif ? 'ONVIF enabled' : 'ONVIF off'}</Badge>
            </div>
            <div className="inline-row">
              <button type="submit" className="btn" disabled={saving}>
                Save
              </button>
            </div>
          </form>
        </Card>

        <Card title="RTSP templates">
          <div className="stack">
            <label className="field">
              <span>Live RTSP path</span>
              <select
                value={dvr.templates?.some((t) => t.template === dvr.rtspTemplate) ? dvr.rtspTemplate : 'custom'}
                onChange={(e) => {
                  if (e.target.value !== 'custom') patch('rtspTemplate', e.target.value);
                }}
              >
                {(dvr.templates ?? []).map((t) => (
                  <option key={t.template} value={t.template}>
                    {t.name}
                  </option>
                ))}
                <option value="custom">Custom path (edit below)</option>
              </select>
              <input value={dvr.rtspTemplate} onChange={(e) => patch('rtspTemplate', e.target.value)} placeholder="/cam/realmonitor?channel={ch}&subtype={sub}" />
              <small className="muted">Must start with “/”, include {'{ch}'} and no host or credentials.</small>
            </label>
            <label className="field">
              <span>DVR playback path (for clip export)</span>
              <input
                value={dvr.playbackTemplate}
                onChange={(e) => patch('playbackTemplate', e.target.value)}
                placeholder="/cam/playback?channel={ch}&subtype=0&starttime={start}&endtime={end}"
              />
              <small className="muted">
                Leave empty when the DVR cannot play back over RTSP. Plain live RTSP cannot recover past footage. Timestamps
                are inserted in the gateway timezone as YYYY_MM_DD_HH_MM_SS.
              </small>
            </label>
            <p className="muted small">
              CP Plus/Dahua commonly uses <code>/cam/realmonitor?channel=1&amp;subtype=0</code>. Hikvision uses{' '}
              <code>/Streaming/Channels/101</code>. Confirm against your model&apos;s manual; do not assume port 554 or ONVIF
              support.
            </p>
          </div>
        </Card>
      </div>

      <TestResultCard result={testResult} />

      <Card
        title="Discover DVR on the LAN"
        actions={
          <button type="button" className="btn" onClick={discover} disabled={discovering}>
            {discovering ? 'Searching…' : 'Search ONVIF devices'}
          </button>
        }
      >
        <p className="muted small">
          Uses WS-Discovery multicast (239.255.255.255:3702). It only detects devices that expose ONVIF; many CP Plus models
          have ONVIF disabled by default. If nothing appears, enter the IP address manually.
        </p>
        {devices ? (
          devices.length ? (
            <ul className="list">
              {devices.map((device) => (
                <li key={device.xaddr} className="list-row">
                  <div>
                    <strong>{device.onvif?.device?.model ?? device.name ?? device.xaddr}</strong>
                    <div className="muted small">
                      <code>{device.xaddr}</code>
                      {device.onvif?.ok ? ' · ONVIF responded' : device.onvif?.error ? ` · ${device.onvif.error}` : ''}
                    </div>
                  </div>
                  <button type="button" className="btn btn-small" onClick={() => useDevice(device)}>
                    Use address
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <Empty title="No ONVIF devices found">
              Enable ONVIF in the DVR network settings, or configure the DVR IP address manually above.
            </Empty>
          )
        ) : null}
      </Card>

      <Card
        title="Channel scan"
        actions={
          <button type="button" className="btn btn-primary" onClick={startScan} disabled={scanBusy || !dvr.host}>
            {scanBusy ? 'Scanning…' : 'Scan channels'}
          </button>
        }
      >
        <p className="muted small">
          Probes channels with the configured RTSP template and creates camera entries for channels that respond. The
          camera count comes from the scan, never from a hardcoded number.
        </p>
        {scan ? (
          <>
            <div className="inline-row space-between">
              <span>
                {scan.status === 'running' ? `Scanning channel ${scan.currentChannel ?? '…'} (${scan.done}/${scan.total})` : `Scan ${scan.status}`}
              </span>
              <Badge tone={scan.status === 'done' ? 'ok' : scan.error ? 'bad' : 'info'}>{scan.found} online</Badge>
            </div>
            <Progress value={scan.total ? (scan.done / scan.total) * 100 : 0} />
            {scan.error ? <ErrorNote message={scan.error} /> : null}
            {scan.results?.length ? (
              <ul className="list">
                {scan.results.map((row) => (
                  <li key={row.channel} className="list-row">
                    <span>
                      Channel {row.channel} · {row.online ? row.video?.codec ?? 'video' : 'no stream'}
                      {row.video?.width ? ` · ${row.video.width}x${row.video.height}` : ''}
                      {row.template ? ` · ${row.template}` : ''}
                    </span>
                    <Badge tone={row.online ? 'ok' : 'idle'}>{row.online ? 'online' : 'offline'}</Badge>
                  </li>
                ))}
              </ul>
            ) : null}
            {scan.applied ? (
              <p className="muted small">
                Added {scan.applied.created?.length ?? 0} camera(s), updated {scan.applied.updated?.length ?? 0}.
              </p>
            ) : null}
          </>
        ) : null}
      </Card>

      <CamerasPanel cameras={cameras} reload={load} />
    </div>
  );
}

function CamerasPanel({ cameras, reload }: { cameras: Camera[]; reload: () => Promise<void> }) {
  const { client, toast } = useApp();
  const [edits, setEdits] = useState<Record<string, Partial<Camera>>>({});
  const [adding, setAdding] = useState(false);
  const [newCamera, setNewCamera] = useState({ name: '', channel: 1, subtype: 0, buffer: false, audio: false });
  const [busy, setBusy] = useState<string | null>(null);

  function update(id: string, key: keyof Camera, value: unknown) {
    setEdits((prev) => ({ ...prev, [id]: { ...prev[id], [key]: value } }));
  }

  function valueOf<K extends keyof Camera>(camera: Camera, key: K): Camera[K] {
    const edit = edits[camera.id];
    return (edit && key in edit ? edit[key] : camera[key]) as Camera[K];
  }

  async function save(camera: Camera) {
    const edit = edits[camera.id] ?? {};
    setBusy(camera.id);
    try {
      await client.request(`/cameras/${encodeURIComponent(camera.id)}`, {
        method: 'PATCH',
        body: {
          name: edit.name ?? camera.name,
          channel: Number(edit.channel ?? camera.channel),
          subtype: Number(edit.subtype ?? camera.subtype ?? 0),
          enabled: edit.enabled ?? camera.enabled,
          buffer: edit.buffer ?? Boolean(camera.buffer),
          audio: edit.audio ?? Boolean(camera.audio),
          dvrPlayback: edit.dvrPlayback !== undefined ? edit.dvrPlayback : camera.dvrPlayback,
        },
      });
      setEdits((prev) => {
        const next = { ...prev };
        delete next[camera.id];
        return next;
      });
      toast('Camera saved.', 'ok');
      await reload();
    } catch (err) {
      toast(errorMessage(err), 'bad');
    } finally {
      setBusy(null);
    }
  }

  async function probe(camera: Camera) {
    setBusy(camera.id);
    try {
      const result = await client.request<{ ok: boolean; video?: { codec?: string; width?: number; height?: number }; error?: string }>(
        `/cameras/${encodeURIComponent(camera.id)}/test`,
        { method: 'POST' },
      );
      toast(
        result.ok
          ? `Camera online${result.video?.codec ? ` (${result.video.codec}${result.video.width ? ` ${result.video.width}x${result.video.height}` : ''})` : ''}.`
          : `Camera probe failed: ${result.error ?? 'no stream'}`,
        result.ok ? 'ok' : 'bad',
      );
      await reload();
    } catch (err) {
      toast(errorMessage(err), 'bad');
    } finally {
      setBusy(null);
    }
  }

  async function remove(camera: Camera) {
    if (!window.confirm(`Remove "${camera.name}" from the gateway? DVR recordings are not affected.`)) return;
    setBusy(camera.id);
    try {
      await client.request(`/cameras/${encodeURIComponent(camera.id)}`, { method: 'DELETE' });
      toast('Camera removed.', 'ok');
      await reload();
    } catch (err) {
      toast(errorMessage(err), 'bad');
    } finally {
      setBusy(null);
    }
  }

  async function add(event: FormEvent) {
    event.preventDefault();
    setBusy('new');
    try {
      await client.request('/cameras', { method: 'POST', body: newCamera });
      setAdding(false);
      setNewCamera({ name: '', channel: 1, subtype: 0, buffer: false, audio: false });
      toast('Camera added.', 'ok');
      await reload();
    } catch (err) {
      toast(errorMessage(err), 'bad');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card
      title="Cameras"
      actions={
        <button type="button" className="btn btn-small" onClick={() => setAdding((v) => !v)}>
          {adding ? 'Cancel' : 'Add camera'}
        </button>
      }
    >
      {adding ? (
        <form className="stack" onSubmit={add}>
          <div className="form-grid">
            <label className="field">
              <span>Name</span>
              <input value={newCamera.name} onChange={(e) => setNewCamera({ ...newCamera, name: e.target.value })} placeholder="Front Door" />
            </label>
            <label className="field">
              <span>Channel</span>
              <input
                type="number"
                min={1}
                max={64}
                value={newCamera.channel}
                onChange={(e) => setNewCamera({ ...newCamera, channel: Number(e.target.value) })}
              />
            </label>
            <label className="field">
              <span>Stream</span>
              <select value={newCamera.subtype} onChange={(e) => setNewCamera({ ...newCamera, subtype: Number(e.target.value) })}>
                <option value={0}>Main stream</option>
                <option value={1}>Sub stream</option>
              </select>
            </label>
            <label className="field checkbox-field">
              <input
                type="checkbox"
                checked={newCamera.buffer}
                onChange={(e) => setNewCamera({ ...newCamera, buffer: e.target.checked })}
              />
              <span>Include in rolling buffer</span>
            </label>
            <label className="field checkbox-field">
              <input type="checkbox" checked={newCamera.audio} onChange={(e) => setNewCamera({ ...newCamera, audio: e.target.checked })} />
              <span>Camera has audio</span>
            </label>
          </div>
          <div>
            <button type="submit" className="btn btn-primary" disabled={busy === 'new'}>
              Add camera
            </button>
          </div>
        </form>
      ) : null}

      {!cameras.length ? (
        <Empty title="No cameras configured">Scan channels or add a camera manually.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Ch</th>
                <th>Stream</th>
                <th>Enabled</th>
                <th>Buffer</th>
                <th>Audio</th>
                <th>DVR playback</th>
                <th>State</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {cameras.map((camera) => (
                <tr key={camera.id}>
                  <td>
                    <input className="table-input" value={String(valueOf(camera, 'name') ?? '')} onChange={(e) => update(camera.id, 'name', e.target.value)} />
                  </td>
                  <td>
                    <input
                      className="table-input narrow"
                      type="number"
                      min={1}
                      max={64}
                      value={Number(valueOf(camera, 'channel'))}
                      onChange={(e) => update(camera.id, 'channel', Number(e.target.value))}
                    />
                  </td>
                  <td>
                    <select
                      className="table-input"
                      value={Number(valueOf(camera, 'subtype') ?? 0)}
                      onChange={(e) => update(camera.id, 'subtype', Number(e.target.value))}
                    >
                      <option value={0}>Main</option>
                      <option value={1}>Sub</option>
                    </select>
                  </td>
                  <td>
                    <input type="checkbox" checked={Boolean(valueOf(camera, 'enabled'))} onChange={(e) => update(camera.id, 'enabled', e.target.checked)} />
                  </td>
                  <td>
                    <input type="checkbox" checked={Boolean(valueOf(camera, 'buffer'))} onChange={(e) => update(camera.id, 'buffer', e.target.checked)} />
                  </td>
                  <td>
                    <input type="checkbox" checked={Boolean(valueOf(camera, 'audio'))} onChange={(e) => update(camera.id, 'audio', e.target.checked)} />
                  </td>
                  <td>
                    <select
                      className="table-input"
                      value={valueOf(camera, 'dvrPlayback') === null || valueOf(camera, 'dvrPlayback') === undefined ? 'auto' : valueOf(camera, 'dvrPlayback') ? 'yes' : 'no'}
                      onChange={(e) =>
                        update(camera.id, 'dvrPlayback', e.target.value === 'auto' ? null : e.target.value === 'yes')
                      }
                    >
                      <option value="auto">Auto / try</option>
                      <option value="yes">Supported</option>
                      <option value="no">Not supported</option>
                    </select>
                  </td>
                  <td>
                    <div className="stack-tight">
                      <Badge tone={statusTone(camera.state ?? (camera.online ? 'ready' : 'unknown'))}>{camera.state ?? 'unknown'}</Badge>
                      {camera.lastProbe?.at ? <span className="muted tiny">{relativeTime(camera.lastProbe.at)}</span> : null}
                    </div>
                  </td>
                  <td>
                    <div className="row-actions">
                      <button type="button" className="btn btn-small" onClick={() => { void save(camera); }} disabled={busy === camera.id}>
                        Save
                      </button>
                      <button type="button" className="btn btn-small" onClick={() => { void probe(camera); }} disabled={busy === camera.id}>
                        Test
                      </button>
                      <button type="button" className="btn btn-small btn-danger" onClick={() => { void remove(camera); }} disabled={busy === camera.id}>
                        Remove
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {cameras.some((c) => c.lastProbe?.error) ? (
        <p className="muted small">
          Last probe errors: {cameras.filter((c) => c.lastProbe?.error).map((c) => `${c.name}: ${c.lastProbe?.error}`).join(' · ')}
        </p>
      ) : null}
    </Card>
  );
}

function CloudDvrConfig() {
  const { client, toast } = useApp();
  const [data, setData] = useState<CloudGateway | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<DvrTestResult | null>(null);
  const [scan, setScan] = useState<ScanState | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await client.request<CloudGateway>('/gateway'));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [client]);

  usePolling(load, 15_000, [load]);

  async function runCommand(label: string, type: string, payload: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    setRunning(label);
    const queued = await client.request<{ taskId: string }>('/commands', { method: 'POST', body: { type, payload } });
    const deadline = Date.now() + timeoutMs;
    try {
      while (Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 1500));
        const task = await client.request<CommandResult>(`/commands/${encodeURIComponent(queued.taskId)}`);
        if (task.status === 'done') return task.result;
        if (task.status === 'failed') throw new Error(task.error ?? 'Gateway command failed');
      }
      throw new Error('The gateway did not report a result in time. Check Gateway Status.');
    } finally {
      setRunning(null);
    }
  }

  async function testDvr() {
    try {
      const result = (await runCommand('test', 'dvr.test', {}, 90_000)) as DvrTestResult;
      setTestResult(result ?? null);
      toast(result?.ok ? 'DVR reachable.' : 'DVR test failed.', result?.ok ? 'ok' : 'bad');
      void load();
    } catch (err) {
      toast(errorMessage(err), 'bad');
    }
  }

  async function scanChannels() {
    try {
      const result = (await runCommand('scan', 'dvr.scan', { maxChannels: 16, apply: true }, 180_000)) as { results?: { channel: number; online: boolean; video?: { codec?: string; width?: number; height?: number } }[]; applied?: { created?: unknown[]; updated?: unknown[] } };
      const results = result?.results ?? [];
      setScan({
        id: 'cloud-scan',
        status: 'done',
        running: false,
        done: true,
        total: results.length,
        found: results.filter((r) => r.online).length,
        results,
        applied: result?.applied ?? null,
      } as unknown as ScanState);
      toast(`Scan finished: ${results.filter((r) => r.online).length} channel(s) online.`, 'ok');
      void load();
    } catch (err) {
      toast(errorMessage(err), 'bad');
    }
  }

  if (!data) {
    return (
      <>
        <PageHeader title="DVR Configuration" subtitle="Cloud view · credentials stay on the gateway" />
        {loading ? <Spinner label="Loading gateway…" block /> : <ErrorNote message={error} onRetry={load} />}
      </>
    );
  }

  const gw = data.gateway;
  return (
    <div className="stack-lg">
      <PageHeader
        title="DVR Configuration"
        subtitle="Cloud control · read the DVR state from the gateway heartbeat"
        actions={
          <>
            <button type="button" className="btn" onClick={testDvr} disabled={Boolean(running) || !gw?.online}>
              {running === 'test' ? 'Testing…' : 'Test DVR'}
            </button>
            <button type="button" className="btn" onClick={scanChannels} disabled={Boolean(running) || !gw?.online}>
              {running === 'scan' ? 'Scanning…' : 'Scan channels'}
            </button>
          </>
        }
      />
      {error ? <ErrorNote message={error} onRetry={load} /> : null}
      {!gw ? (
        <Card>
          <Empty title="No gateway registered">Start the gateway so the backend can receive its heartbeat.</Empty>
        </Card>
      ) : (
        <>
          <InfoNote>
            DVR credentials are entered only on the gateway PC (DVR Configuration there). The cloud UI can trigger tests and
            scans, but it never receives the DVR password.
          </InfoNote>
          {!gw.online ? <ErrorNote message="Gateway is offline. Tests and scans require it to be online." /> : null}
          <div className="grid-2">
            <Card title="Reported DVR">
              <DefinitionList
                rows={[
                  ['Configured', gw.dvr?.configured ? 'Yes' : 'No'],
                  ['Reachable', gw.dvr?.online ? 'Yes' : 'No'],
                  ['Host', gw.dvr?.host ?? '—'],
                  ['Model', gw.dvr?.model || '—'],
                  ['Firmware', gw.dvr?.firmware || '—'],
                  ['Channels', String(gw.dvr?.channels ?? '—')],
                  ['Last error', gw.dvr?.error ?? '—'],
                ]}
              />
            </Card>
            <Card title="Capabilities">
              <DefinitionList
                rows={[
                  ['RTSP playback configured', gw.dvr?.rtspPlayback ? 'Yes' : 'Not reported'],
                  ['ONVIF enabled', gw.dvr?.onvif ? 'Yes' : 'No'],
                  ['Buffer enabled', gw.buffer?.enabled ? 'Yes' : 'No'],
                  ['Buffer retention', `${gw.buffer?.retentionMinutes ?? '—'} min`],
                ]}
              />
            </Card>
          </div>
        </>
      )}
      <TestResultCard result={testResult} />
      {scan ? (
        <Card title="Channel scan result" actions={<Badge tone="ok">{scan.found} online</Badge>}>
          {scan.results?.length ? (
            <ul className="list">
              {scan.results.map((row) => (
                <li key={row.channel} className="list-row">
                  <span>
                    Channel {row.channel} · {row.online ? row.video?.codec ?? 'video' : 'no stream'}
                    {row.video?.width ? ` · ${row.video.width}x${row.video.height}` : ''}
                  </span>
                  <Badge tone={row.online ? 'ok' : 'idle'}>{row.online ? 'online' : 'offline'}</Badge>
                </li>
              ))}
            </ul>
          ) : (
            <Empty title="No channels returned" />
          )}
          {scan.applied ? (
            <p className="muted small">Applied to the gateway camera list. Open the gateway dashboard for per-camera checks.</p>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}
