import { useCallback, useEffect, useState } from 'react';
import { ApiClient, detectTarget } from './api';
import type { ApiTarget } from './api';
import type { Meta, User } from './types';
import { AppProvider, errorMessage, useApp, useRoute } from './state';
import { Badge, Dot, Modal, Spinner } from './ui';
import { LoginPage, SetupPage } from './pages/Auth';
import Dashboard from './pages/Dashboard';
import Live from './pages/Live';
import ClipExport from './pages/ClipExport';
import Clips from './pages/Clips';
import GatewayPage from './pages/Gateway';
import DvrConfig from './pages/DvrConfig';
import Security from './pages/Security';

type Root = { client: ApiClient; target: ApiTarget; meta: Meta };

type Phase =
  | { kind: 'loading' }
  | { kind: 'fatal'; message: string }
  | { kind: 'setup'; root: Root }
  | { kind: 'login'; root: Root }
  | { kind: 'ready'; root: Root; user: User };

const NAV = [
  { path: '/', label: 'Dashboard' },
  { path: '/live', label: 'Live Cameras' },
  { path: '/export', label: 'Clip Export' },
  { path: '/clips', label: 'Export History' },
  { path: '/gateway', label: 'Gateway Status' },
  { path: '/dvr', label: 'DVR Configuration' },
  { path: '/security', label: 'Security Settings' },
];

export default function App() {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setPhase({ kind: 'loading' });
      const target = await detectTarget();
      const client = new ApiClient(target);
      try {
        const meta = await client.request<Meta>('/meta', { auth: false });
        if (cancelled) return;
        const root: Root = { client, target, meta };
        if (meta.setupRequired) {
          setPhase({ kind: 'setup', root });
          return;
        }
        const ok = await client.refresh();
        if (cancelled) return;
        setPhase(ok && client.user ? { kind: 'ready', root, user: client.user } : { kind: 'login', root });
      } catch (err) {
        if (cancelled) return;
        const where = target.mode === 'gateway' ? 'local gateway' : 'cloud backend';
        setPhase({
          kind: 'fatal',
          message: `Could not reach the ${where} (${target.label}). ${errorMessage(err)}`,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  if (phase.kind === 'loading') {
    return (
      <div className="boot-screen">
        <div className="brand-mark">OPPS</div>
        <Spinner label="Connecting…" />
      </div>
    );
  }

  if (phase.kind === 'fatal') {
    return (
      <div className="boot-screen">
        <div className="auth-card">
          <h1>Connection failed</h1>
          <p className="muted">{phase.message}</p>
          <ul className="boot-hints">
            <li>On your home Wi-Fi, make sure the gateway PC is on and <code>npm run start:gateway</code> is running.</li>
            <li>Outside home, connect to Tailscale first, then open the gateway address.</li>
            <li>Check that the backend URL in the deployment environment is correct.</li>
          </ul>
          <button type="button" className="btn btn-primary" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  const handleMeta = (meta: Meta) => {
    setPhase((current) =>
      current.kind === 'ready' || current.kind === 'login' || current.kind === 'setup'
        ? { ...current, root: { ...current.root, meta } }
        : current,
    );
  };

  if (phase.kind === 'setup') {
    const { root } = phase;
    return (
      <SetupPage
        client={root.client}
        mode={root.target.mode}
        onDone={(user, meta) => setPhase({ kind: 'ready', root: { ...root, meta }, user })}
      />
    );
  }

  if (phase.kind === 'login') {
    const { root } = phase;
    return (
      <LoginPage
        client={root.client}
        meta={root.meta}
        mode={root.target.mode}
        onDone={(user, meta) => setPhase({ kind: 'ready', root: { ...root, meta }, user })}
        onRetryConnection={() => setAttempt((n) => n + 1)}
      />
    );
  }

  return (
    <AppProvider
      client={phase.root.client}
      target={phase.root.target}
      meta={phase.root.meta}
      user={phase.user}
      onMeta={handleMeta}
      onSignedOut={() => setPhase({ kind: 'login', root: { ...phase.root, meta: { ...phase.root.meta, setupRequired: false } } })}
    >
      <Shell />
    </AppProvider>
  );
}

function Shell() {
  const [path, navigate] = useRoute();
  const [menuOpen, setMenuOpen] = useState(false);
  const [modeOpen, setModeOpen] = useState(false);
  const page = path === '/login' || path === '/setup' ? '/' : path;
  const title = NAV.find((n) => n.path === page)?.label ?? 'Dashboard';

  const go = useCallback(
    (next: string) => {
      setMenuOpen(false);
      navigate(next);
    },
    [navigate],
  );

  useEffect(() => {
    document.title = `${title} · OPPS CCTV`;
  }, [title]);

  const content = (() => {
    switch (page) {
      case '/live':
        return <Live />;
      case '/export':
        return <ClipExport />;
      case '/clips':
        return <Clips />;
      case '/gateway':
        return <GatewayPage />;
      case '/dvr':
        return <DvrConfig />;
      case '/security':
        return <Security />;
      default:
        return <Dashboard navigate={go} />;
    }
  })();

  return (
    <div className="shell">
      <aside className={`sidebar${menuOpen ? ' is-open' : ''}`}>
        <div className="sidebar-brand">
          <span className="brand-mark small">OPPS</span>
          <div>
            <strong>CCTV</strong>
            <span className="muted small">private monitor</span>
          </div>
        </div>
        <nav className="nav">
          {NAV.map((item) => (
            <button
              key={item.path}
              type="button"
              className={`nav-item${page === item.path ? ' active' : ''}`}
              onClick={() => go(item.path)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <ConnectionChip onOpen={() => setModeOpen(true)} />
      </aside>
      {menuOpen ? <button type="button" className="drawer-backdrop" aria-label="Close menu" onClick={() => setMenuOpen(false)} /> : null}
      <div className="main">
        <header className="topbar">
          <button type="button" className="icon-btn menu-btn" aria-label="Open menu" onClick={() => setMenuOpen(true)}>
            ☰
          </button>
          <strong className="topbar-title">{title}</strong>
          <ConnectionChip compact onOpen={() => setModeOpen(true)} />
        </header>
        <main className="content">{content}</main>
      </div>
      <ModeModal open={modeOpen} onClose={() => setModeOpen(false)} />
    </div>
  );
}

function ConnectionChip({ onOpen, compact = false }: { onOpen: () => void; compact?: boolean }) {
  const { mode, meta } = useApp();
  const gateway = mode === 'gateway';
  const cloudConnected = meta.cloud?.connected;
  return (
    <button type="button" className={`conn-chip${compact ? ' compact' : ''}`} onClick={onOpen} title="Connection details">
      <Dot tone={gateway ? 'ok' : cloudConnected ? 'warn' : 'bad'} pulse={gateway} />
      <span>{gateway ? 'Local' : 'Cloud'}</span>
      {!gateway ? <Badge tone={cloudConnected ? 'ok' : 'warn'}>{cloudConnected ? 'gateway online' : 'gateway offline'}</Badge> : null}
    </button>
  );
}

function ModeModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { mode, meta, targetLabel } = useApp();
  return (
    <Modal open={open} title="Connection" onClose={onClose}>
      <div className="stack">
        <dl className="def-list">
          <div className="def-row">
            <dt>Mode</dt>
            <dd>{mode === 'gateway' ? 'Local gateway (direct)' : 'Cloud backend'}</dd>
          </div>
          <div className="def-row">
            <dt>Endpoint</dt>
            <dd>
              <code>{targetLabel}</code>
            </dd>
          </div>
          {mode === 'cloud' ? (
            <>
              <div className="def-row">
                <dt>Gateway</dt>
                <dd>
                  {meta.cloud?.connected ? 'Online' : 'Offline'}
                  {meta.cloud?.lastHeartbeatAt ? <span className="muted"> · heartbeat {meta.cloud.lastHeartbeatAt}</span> : null}
                </dd>
              </div>
              {meta.cloud?.lastError ? (
                <div className="def-row">
                  <dt>Cloud error</dt>
                  <dd>{meta.cloud.lastError}</dd>
                </div>
              ) : null}
            </>
          ) : null}
        </dl>
        <p className="muted">
          Live video and clip files are always served by the gateway on your home PC. The cloud dashboard only coordinates
          clip jobs and metadata.
        </p>
        <div className="mode-grid">
          <div className="mode-card">
            <strong>Home Wi-Fi</strong>
            <p>
              Open the gateway address directly, for example <code>http://192.168.1.20:8089</code>. No VPN needed.
            </p>
          </div>
          <div className="mode-card">
            <strong>Outside home</strong>
            <p>Connect Tailscale on this device, then open the gateway Tailscale URL. No router port forwarding.</p>
          </div>
          <div className="mode-card">
            <strong>Cloud dashboard</strong>
            <p>This site coordinates clip jobs through the backend. The gateway must be online for remote export.</p>
          </div>
        </div>
        <button type="button" className="btn" onClick={() => window.location.reload()}>
          Re-detect connection
        </button>
      </div>
    </Modal>
  );
}
