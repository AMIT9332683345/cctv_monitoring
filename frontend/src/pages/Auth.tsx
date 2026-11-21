import { useState } from 'react';
import type { FormEvent } from 'react';
import { ApiClient, ApiError } from '../api';
import type { Meta, Mode, User } from '../types';
import { Dot, ErrorNote, Spinner } from '../ui';

function AuthShell({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="boot-screen">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="brand-mark">OPPS</span>
          <span className="muted small">CCTV</span>
        </div>
        <h1>{title}</h1>
        <p className="muted">{subtitle}</p>
        {children}
      </div>
      <p className="auth-foot muted small">Single owner · registration disabled · private footage stays on your DVR</p>
    </div>
  );
}

export function LoginPage({
  client,
  meta,
  mode,
  onDone,
  onRetryConnection,
}: {
  client: ApiClient;
  meta: Meta;
  mode: Mode;
  onDone: (user: User, meta: Meta) => void;
  onRetryConnection: () => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [needsTotp, setNeedsTotp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const user = await client.login(email, password, needsTotp ? totpCode : undefined);
      let fresh = meta;
      try {
        fresh = await client.request<Meta>('/meta', { auth: false });
      } catch {
        /* keep the last known meta */
      }
      onDone(user, fresh);
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'totp_required' || err.code === 'invalid_totp')) {
        setNeedsTotp(true);
        setError(err.code === 'totp_required' ? 'Enter the 6-digit code from your authenticator app.' : err.message);
      } else {
        setError(err instanceof Error ? err.message : 'Sign-in failed');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      title="Sign in"
      subtitle={mode === 'gateway' ? 'Local gateway sign-in on your private network.' : 'Cloud sign-in for the OPPS CCTV dashboard.'}
    >
      <form onSubmit={submit} className="stack">
        <label className="field">
          <span>Email</span>
          <input
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="owner@example.com"
          />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Your owner password"
          />
        </label>
        {needsTotp ? (
          <label className="field">
            <span>Two-factor code</span>
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ''))}
              placeholder="123456"
            />
          </label>
        ) : null}
        <ErrorNote message={error} />
        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        {meta.cloud?.configured ? (
          <p className="muted small">
            <Dot tone={meta.cloud.connected ? 'ok' : 'warn'} /> Cloud gateway {meta.cloud.connected ? 'online' : 'offline'}
            {meta.cloud.lastError ? ` · ${meta.cloud.lastError}` : ''}
          </p>
        ) : null}
        <button type="button" className="link-btn" onClick={onRetryConnection}>
          Re-detect connection
        </button>
      </form>
    </AuthShell>
  );
}

export function SetupPage({
  client,
  mode,
  onDone,
}: {
  client: ApiClient;
  mode: Mode;
  onDone: (user: User, meta: Meta) => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [setupToken, setSetupToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    if (password.length < 12) {
      setError('Password must be at least 12 characters and include a number.');
      return;
    }
    setBusy(true);
    try {
      const user = await client.setup(email, password, setupToken);
      const fresh = await client.request<Meta>('/meta', { auth: false });
      onDone(user, fresh);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Setup failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      title="Create the owner account"
      subtitle={
        mode === 'gateway'
          ? 'One-time setup for this gateway. Run this from the gateway PC, or supply the gateway setup token.'
          : 'One-time setup for your private cloud dashboard. You will need the backend SETUP_TOKEN.'
      }
    >
      <form onSubmit={submit} className="stack">
        <label className="field">
          <span>Owner email</span>
          <input type="email" required autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            type="password"
            required
            minLength={12}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <small className="muted">At least 12 characters, including a number. Avoid using your email name.</small>
        </label>
        <label className="field">
          <span>Confirm password</span>
          <input
            type="password"
            required
            minLength={12}
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </label>
        <label className="field">
          <span>{mode === 'gateway' ? 'Gateway setup token (optional on the gateway PC)' : 'Backend setup token'}</span>
          <input
            type="password"
            autoComplete="off"
            required={mode === 'cloud'}
            value={setupToken}
            onChange={(e) => setSetupToken(e.target.value)}
            placeholder={mode === 'gateway' ? 'GATEWAY_SETUP_TOKEN' : 'SETUP_TOKEN'}
          />
        </label>
        <ErrorNote message={error} />
        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
          {busy ? <Spinner /> : 'Create owner account'}
        </button>
        <p className="muted small">
          DVR credentials are configured later inside the gateway and are never stored in this browser or in the cloud database.
        </p>
      </form>
    </AuthShell>
  );
}
