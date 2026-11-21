import { useCallback, useState } from 'react';
import type { FormEvent } from 'react';
import { errorMessage, useApp, usePolling } from '../state';
import { Badge, Card, DefinitionList, Empty, ErrorNote, InfoNote, Modal, PageHeader, Spinner } from '../ui';
import { formatDateTime, relativeTime } from '../format';
import type { AuditEntry } from '../types';

export default function SecurityPage() {
  const { mode, client, meta, user, targetLabel, logout, refreshMeta, toast } = useApp();
  const [audit, setAudit] = useState<AuditEntry[] | null>(null);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [confirmSignOut, setConfirmSignOut] = useState(false);

  const loadAudit = useCallback(async () => {
    try {
      const data = await client.request<{ entries: AuditEntry[] }>('/audit?limit=50');
      setAudit(data.entries ?? []);
      setAuditError(null);
    } catch (err) {
      setAuditError(errorMessage(err));
    }
  }, [client]);

  usePolling(loadAudit, 20_000, [client]);

  return (
    <>
      <PageHeader
        title="Security"
        subtitle="Single-owner access. Registration is disabled; this account is the only way in."
      />
      <PasswordCard onChanged={async () => { await logout(); }} />
      {mode === 'cloud' ? <TotpCard onChange={refreshMeta} toast={toast} /> : (
        <Card title="Two-factor authentication">
          <InfoNote>
            Two-factor authentication is available on the cloud account. The local gateway uses the same password and
            is only reachable on your private network, so TOTP is not needed here.
          </InfoNote>
        </Card>
      )}
      <Card title="Session">
        <DefinitionList
          rows={[
            ['Signed in as', user.email],
            ['Mode', mode === 'gateway' ? 'Local gateway (direct)' : 'Cloud backend'],
            ['Endpoint', <code key="endpoint">{targetLabel}</code>],
            ['Account type', user.local ? 'Gateway-local' : 'Cloud owner'],
            ['Two-factor', meta.auth?.totpEnabled ? <Badge key="tfa" tone="ok">enabled</Badge> : <Badge key="tfa" tone="warn">disabled</Badge>],
          ]}
        />
        <div className="inline-row space-between">
          <span className="muted small">
            Sessions are HTTP-only refresh cookies with short-lived access tokens. Changing your password signs out
            every device.
          </span>
          <button type="button" className="btn" onClick={() => setConfirmSignOut(true)}>
            Sign out
          </button>
        </div>
      </Card>
      <Card title="Recent activity" actions={<button type="button" className="btn btn-small" onClick={loadAudit}>Refresh</button>}>
        <ErrorNote message={auditError} onRetry={loadAudit} />
        {!audit ? <Spinner label="Loading activity…" /> : null}
        {audit && audit.length === 0 ? <Empty title="No activity recorded yet" /> : null}
        {audit && audit.length > 0 ? (
          <ul className="audit-list">
            {audit.map((entry) => (
              <li key={entry.id}>
                <div className="inline-row space-between">
                  <strong>{entry.action}</strong>
                  <span className="muted small" title={formatDateTime(entry.ts)}>{relativeTime(entry.ts)}</span>
                </div>
                <div className="muted small">
                  {entry.actor ?? 'system'}
                  {entry.ip ? ` · ${entry.ip}` : ''}
                  {entry.meta && Object.keys(entry.meta).length ? ` · ${JSON.stringify(entry.meta)}` : ''}
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </Card>
      <Modal
        open={confirmSignOut}
        title="Sign out?"
        onClose={() => setConfirmSignOut(false)}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setConfirmSignOut(false)}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void logout()}>
              Sign out
            </button>
          </>
        }
      >
        <p>You will need your password (and two-factor code, if enabled) to sign back in.</p>
      </Modal>
    </>
  );
}

function PasswordCard({ onChanged }: { onChanged: () => Promise<void> }) {
  const { client, user, toast } = useApp();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const problem =
    !next
      ? null
      : next.length < 12
        ? 'Use at least 12 characters.'
        : !/\d/.test(next)
          ? 'Include at least one number.'
          : confirm && confirm !== next
            ? 'The confirmation does not match.'
            : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (problem) {
      setError(problem);
      return;
    }
    if (next !== confirm) {
      setError('The confirmation does not match.');
      return;
    }
    setBusy(true);
    try {
      const res = await client.request<{ message?: string }>('/auth/password', {
        method: 'POST',
        body: { currentPassword: current, newPassword: next },
      });
      toast(res.message ?? 'Password changed. Sign in again.', 'ok');
      await onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Password">
      <form className="form-grid" onSubmit={submit}>
        <input type="email" name="username" autoComplete="username" value={user.email} readOnly hidden />
        <label className="field span-2">
          <span>Current password</span>
          <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
        </label>
        <label className="field">
          <span>New password</span>
          <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} minLength={12} required />
        </label>
        <label className="field">
          <span>Confirm new password</span>
          <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </label>
        {problem ? <p className="text-warn small span-2">{problem}</p> : null}
        <ErrorNote message={error} />
        <div className="span-2">
          <button type="submit" className="btn btn-primary" disabled={busy || Boolean(problem) || !current || !next || !confirm}>
            {busy ? 'Changing…' : 'Change password'}
          </button>
        </div>
      </form>
    </Card>
  );
}

function TotpCard({ onChange, toast }: { onChange: () => Promise<unknown>; toast: (text: string, tone?: 'ok' | 'bad' | 'info') => void }) {
  const { client, user } = useApp();
  const enabled = Boolean(user.totpEnabled);
  const [setup, setSetup] = useState<{ secret: string; otpauth: string } | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [disablePassword, setDisablePassword] = useState('');
  const [disableCode, setDisableCode] = useState('');

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await client.request<{ secret: string; otpauth: string }>('/auth/2fa/setup', { method: 'POST' });
      setSetup(data);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const enable = async (e: FormEvent) => {
    e.preventDefault();
    if (!setup) return;
    setBusy(true);
    setError(null);
    try {
      await client.request('/auth/2fa/enable', { method: 'POST', body: { secret: setup.secret, code } });
      toast('Two-factor authentication enabled.', 'ok');
      setSetup(null);
      setCode('');
      await onChange();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const disable = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await client.request('/auth/2fa/disable', { method: 'POST', body: { password: disablePassword, code: disableCode } });
      toast('Two-factor authentication disabled.', 'ok');
      setDisablePassword('');
      setDisableCode('');
      await onChange();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Two-factor authentication"
      actions={enabled ? <Badge tone="ok">enabled</Badge> : <Badge tone="warn">disabled</Badge>}
    >
      <ErrorNote message={error} />
      {enabled ? (
        <form className="form-grid" onSubmit={disable}>
          <p className="muted span-2">
            Enter your password and a current code from your authenticator app to turn off two-factor authentication.
          </p>
          <label className="field">
            <span>Password</span>
            <input type="password" autoComplete="current-password" value={disablePassword} onChange={(e) => setDisablePassword(e.target.value)} required />
          </label>
          <label className="field">
            <span>Authenticator code</span>
            <input inputMode="numeric" pattern="[0-9]*" maxLength={6} value={disableCode} onChange={(e) => setDisableCode(e.target.value)} required />
          </label>
          <div className="span-2">
            <button type="submit" className="btn btn-danger" disabled={busy}>
              Disable two-factor
            </button>
          </div>
        </form>
      ) : setup ? (
        <form className="form-grid" onSubmit={enable}>
          <InfoNote>
            Add this secret to your authenticator app (Google Authenticator, Authy, 1Password…). It is shown once; the
            gateway and server store only what is required to verify codes.
          </InfoNote>
          <div className="field span-2">
            <span>Secret</span>
            <code className="secret-box">{setup.secret}</code>
          </div>
          <div className="field span-2">
            <span>Setup link</span>
            <code className="secret-box break">{setup.otpauth}</code>
          </div>
          <label className="field">
            <span>Code from your app</span>
            <input inputMode="numeric" pattern="[0-9]*" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} required />
          </label>
          <div className="span-2 inline-row">
            <button type="submit" className="btn btn-primary" disabled={busy || code.length < 6}>
              {busy ? 'Verifying…' : 'Enable two-factor'}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setSetup(null)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="inline-row space-between">
          <p className="muted">
            Require a 6-digit code from an authenticator app after your password. Strongly recommended for the cloud
            account that can start exports.
          </p>
          <button type="button" className="btn btn-primary" onClick={start} disabled={busy}>
            {busy ? 'Preparing…' : 'Set up two-factor'}
          </button>
        </div>
      )}
    </Card>
  );
}
