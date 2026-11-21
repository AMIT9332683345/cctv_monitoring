import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiClient, ApiError, detectTarget } from './api';
import type { ApiTarget } from './api';
import type { Meta, Mode, User } from './types';

type Toast = { id: number; tone: 'ok' | 'bad' | 'info'; text: string };

type AppContextValue = {
  client: ApiClient;
  mode: Mode;
  targetLabel: string;
  meta: Meta;
  user: User;
  refreshMeta: () => Promise<Meta | null>;
  logout: () => Promise<void>;
  toast: (text: string, tone?: Toast['tone']) => void;
  toasts: Toast[];
  dismissToast: (id: number) => void;
};

const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp must be used inside AppProvider');
  return value;
}

export function AppProvider({
  client,
  target,
  meta,
  user,
  onMeta,
  onSignedOut,
  children,
}: {
  client: ApiClient;
  target: ApiTarget;
  meta: Meta;
  user: User;
  onMeta: (meta: Meta) => void;
  onSignedOut: () => void;
  children: ReactNode;
}) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const toast = useCallback((text: string, tone: Toast['tone'] = 'info') => {
    const id = nextId.current++;
    setToasts((prev) => [...prev.slice(-3), { id, tone, text }]);
    window.setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 6000);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const refreshMeta = useCallback(async () => {
    try {
      const fresh = await client.request<Meta>('/meta', { auth: false });
      onMeta(fresh);
      return fresh;
    } catch {
      return null;
    }
  }, [client, onMeta]);

  const logout = useCallback(async () => {
    await client.logout();
    onSignedOut();
  }, [client, onSignedOut]);

  const value = useMemo<AppContextValue>(
    () => ({
      client,
      mode: target.mode,
      targetLabel: target.label,
      meta,
      user,
      refreshMeta,
      logout,
      toast,
      toasts,
      dismissToast,
    }),
    [client, target, meta, user, refreshMeta, logout, toast, toasts, dismissToast],
  );

  return (
    <AppContext.Provider value={value}>
      {children}
      <div className="toast-host" aria-live="polite">
        {toasts.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`toast toast-${item.tone}`}
            onClick={() => dismissToast(item.id)}
          >
            {item.text}
          </button>
        ))}
      </div>
    </AppContext.Provider>
  );
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

export function usePolling(fn: () => Promise<void>, intervalMs: number, deps: unknown[] = []) {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const tick = async () => {
      if (cancelled) return;
      try {
        await fnRef.current();
      } catch {
        /* callers surface their own errors */
      }
      if (!cancelled) timer = window.setTimeout(tick, intervalMs);
    };
    tick();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

export function useRoute(): [string, (path: string) => void] {
  const [path, setPath] = useState(() => window.location.pathname.replace(/\/+$/, '') || '/');
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname.replace(/\/+$/, '') || '/');
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const navigate = useCallback((next: string) => {
    navigateTo(next);
  }, []);
  return [path, navigate];
}

export function navigateTo(next: string): void {
  if (next === window.location.pathname) return;
  window.history.pushState({}, '', next);
  window.dispatchEvent(new PopStateEvent('popstate'));
  window.scrollTo({ top: 0 });
}
