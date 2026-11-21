import type { Mode, User } from './types';

const envGatewayUrls = String(import.meta.env.VITE_GATEWAY_URL ?? '')
  .split(',')
  .map((s) => s.trim().replace(/\/+$/, ''))
  .filter(Boolean);

const envCloudUrl = String(import.meta.env.VITE_API_URL ?? '')
  .trim()
  .replace(/\/+$/, '');

export type ApiTarget = { mode: Mode; base: string; label: string };

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;
  requestId?: string;

  constructor(status: number, code: string, message: string, details?: unknown, requestId?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
}

function cloudBase(): string {
  return envCloudUrl ? `${envCloudUrl}/api` : '/api';
}

function gatewayBase(url: string): string {
  return url ? `${url}/gapi` : '/gapi';
}

export function describeMode(mode: Mode): string {
  return mode === 'gateway' ? 'Local gateway' : 'Cloud';
}

/**
 * Prefers the local gateway (same origin or VITE_GATEWAY_URL) and falls back to
 * the cloud API. Browser mixed-content rules can block http gateways from an
 * https page; that simply results in cloud mode and is shown in the UI.
 */
export async function detectTarget(): Promise<ApiTarget> {
  const candidates = ['', ...envGatewayUrls];
  for (const candidate of candidates) {
    const base = gatewayBase(candidate);
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000), cache: 'no-store' });
      if (!res.ok) continue;
      const body = await res.json();
      if (body?.mode === 'gateway') {
        return { mode: 'gateway', base, label: candidate || window.location.origin };
      }
    } catch {
      /* not reachable */
    }
  }
  return { mode: 'cloud', base: cloudBase(), label: envCloudUrl || window.location.origin };
}

type RequestOptions = {
  method?: string;
  body?: unknown;
  auth?: boolean;
  noRetry?: boolean;
  signal?: AbortSignal;
  headers?: Record<string, string>;
};

export class ApiClient {
  readonly mode: Mode;
  readonly base: string;
  token: string | null = null;
  user: User | null = null;

  constructor(target: ApiTarget) {
    this.mode = target.mode;
    this.base = target.base;
  }

  get isGateway(): boolean {
    return this.mode === 'gateway';
  }

  private async raw(path: string, opts: RequestOptions = {}): Promise<Response> {
    const headers: Record<string, string> = { 'X-Opps-Client': 'web', ...(opts.headers ?? {}) };
    if (this.token && opts.auth !== false) headers.Authorization = `Bearer ${this.token}`;
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    return fetch(`${this.base}${path}`, {
      method: opts.method ?? 'GET',
      headers,
      body,
      credentials: 'include',
      cache: 'no-store',
      signal: opts.signal,
    });
  }

  async request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    let res: Response;
    try {
      res = await this.raw(path, opts);
    } catch (err) {
      const message = err instanceof DOMException && err.name === 'TimeoutError'
        ? 'The request timed out. Check your connection.'
        : 'Cannot reach the server. Check your network connection.';
      throw new ApiError(0, 'network_error', message);
    }
    if (res.status === 401 && opts.auth !== false && !opts.noRetry) {
      const refreshed = await this.refresh();
      if (refreshed) {
        try {
          res = await this.raw(path, opts);
        } catch {
          throw new ApiError(0, 'network_error', 'Cannot reach the server after re-authenticating.');
        }
      }
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let data: any = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    if (!res.ok) {
      const error = data?.error ?? {};
      throw new ApiError(
        res.status,
        error.code ?? `http_${res.status}`,
        error.message ?? `Request failed (HTTP ${res.status})`,
        error.details,
        error.requestId,
      );
    }
    return data as T;
  }

  async refresh(): Promise<boolean> {
    try {
      const res = await fetch(`${this.base}/auth/refresh`, {
        method: 'POST',
        headers: { 'X-Opps-Client': 'web' },
        credentials: 'include',
        cache: 'no-store',
      });
      if (!res.ok) {
        this.token = null;
        this.user = null;
        return false;
      }
      const data = await res.json();
      this.token = data.accessToken;
      this.user = data.user;
      return true;
    } catch {
      return false;
    }
  }

  async login(email: string, password: string, totpCode?: string): Promise<User> {
    const data = await this.request<{ accessToken: string; user: User }>('/auth/login', {
      method: 'POST',
      auth: false,
      noRetry: true,
      body: { email, password, totpCode: totpCode || undefined },
    });
    this.token = data.accessToken;
    this.user = data.user;
    return data.user;
  }

  async setup(email: string, password: string, setupToken?: string): Promise<User> {
    const data = await this.request<{ accessToken: string; user: User }>('/setup', {
      method: 'POST',
      auth: false,
      noRetry: true,
      body: { email, password, setupToken: setupToken || undefined },
    });
    this.token = data.accessToken;
    this.user = data.user;
    return data.user;
  }

  async logout(): Promise<void> {
    try {
      await this.request('/auth/logout', { method: 'POST', noRetry: true });
    } catch {
      /* the cookie is cleared server-side when possible; local state is dropped below */
    }
    this.token = null;
    this.user = null;
  }

  /** Converts a relative media/stream URL returned by an API into an absolute URL. */
  mediaUrl(url: string): string {
    if (!url) return url;
    if (/^https?:/i.test(url)) return url;
    if (this.base.startsWith('http')) {
      return new URL(url, new URL(this.base).origin).toString();
    }
    return new URL(url, window.location.origin).toString();
  }
}
