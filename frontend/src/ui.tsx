import { useEffect } from 'react';
import type { ReactNode } from 'react';

export type Tone = 'ok' | 'warn' | 'bad' | 'idle' | 'info';

export function Badge({ tone = 'idle', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Dot({ tone = 'idle', pulse = false }: { tone?: Tone; pulse?: boolean }) {
  return <span className={`dot dot-${tone}${pulse ? ' dot-pulse' : ''}`} aria-hidden="true" />;
}

export function Spinner({ label, block = false }: { label?: string; block?: boolean }) {
  return (
    <div className={`spinner-wrap${block ? ' spinner-block' : ''}`} role="status">
      <span className="spinner" aria-hidden="true" />
      {label ? <span className="spinner-label">{label}</span> : null}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle ? <p className="page-subtitle">{subtitle}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}

export function Card({ children, className = '', title, actions }: { children: ReactNode; className?: string; title?: ReactNode; actions?: ReactNode }) {
  return (
    <section className={`card ${className}`}>
      {title || actions ? (
        <div className="card-head">
          {title ? <h2>{title}</h2> : <span />}
          {actions ? <div className="card-actions">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Kpi({ label, value, tone = 'idle', detail }: { label: string; value: ReactNode; tone?: Tone; detail?: ReactNode }) {
  return (
    <div className={`kpi kpi-${tone}`}>
      <span className="kpi-label">{label}</span>
      <strong className="kpi-value">{value}</strong>
      {detail ? <span className="kpi-detail">{detail}</span> : null}
    </div>
  );
}

export function ErrorNote({ message, onRetry }: { message: string | null | undefined; onRetry?: () => void }) {
  if (!message) return null;
  return (
    <div className="notice notice-bad" role="alert">
      <span>{message}</span>
      {onRetry ? (
        <button type="button" className="btn btn-small btn-ghost" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

export function InfoNote({ children }: { children: ReactNode }) {
  return <div className="notice notice-info">{children}</div>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children ? <p>{children}</p> : null}
    </div>
  );
}

export function Progress({ value, tone = 'info' }: { value: number; tone?: Tone }) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className={`progress progress-${tone}`} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (value: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <label className={`toggle${disabled ? ' is-disabled' : ''}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track" aria-hidden="true">
        <span className="toggle-thumb" />
      </span>
      <span className="toggle-label">{label}</span>
    </label>
  );
}

export function Modal({ open, title, onClose, children, footer }: { open: boolean; title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    document.body.classList.add('modal-open');
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.classList.remove('modal-open');
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => (e.target === e.currentTarget ? onClose() : null)}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

export function DefinitionList({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="def-list">
      {rows.map(([term, value]) => (
        <div key={term} className="def-row">
          <dt>{term}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
