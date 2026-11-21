import { randomUUID } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, details) => new HttpError(400, 'bad_request', message, details);
export const unauthorized = (message = 'Authentication required') => new HttpError(401, 'unauthorized', message);
export const forbidden = (message = 'Not allowed') => new HttpError(403, 'forbidden', message);
export const notFound = (message = 'Not found') => new HttpError(404, 'not_found', message);
export const conflict = (message) => new HttpError(409, 'conflict', message);
export const tooMany = (message = 'Too many requests, try again later') => new HttpError(429, 'rate_limited', message);

export function sendJson(res, status, body, extraHeaders = {}) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(json);
}

export function sendError(res, err, requestId) {
  const status = err instanceof HttpError
    ? err.status
    : Number.isInteger(err?.status) && err.status >= 400 && err.status < 600
      ? err.status
      : 500;
  const code = err instanceof HttpError ? err.code : typeof err?.code === 'string' ? err.code : 'internal_error';
  const message = status >= 500 && !(err instanceof HttpError) ? 'Internal server error' : err?.message || 'Internal server error';
  const payload = { error: { code, message, requestId } };
  if (err instanceof HttpError && err.details) payload.error.details = err.details;
  sendJson(res, status, payload);
}

export async function readJson(req, { limit = 64 * 1024 } = {}) {
  const type = req.headers['content-type'] ?? '';
  if (!/application\/json/i.test(type)) {
    throw new HttpError(415, 'unsupported_media_type', 'Content-Type must be application/json');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'payload_too_large', 'Request body too large');
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw badRequest('Invalid JSON body');
  }
}

export function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

export function serializeCookie(name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  if (opts.expires) parts.push(`Expires=${opts.expires.toUTCString()}`);
  parts.push(`Path=${opts.path ?? '/'}`);
  if (opts.httpOnly) parts.push('HttpOnly');
  if (opts.secure) parts.push('Secure');
  if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);
  return parts.join('; ');
}

export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      return forwarded.split(',')[0].trim();
    }
  }
  return req.socket?.remoteAddress ?? 'unknown';
}

export function query(req) {
  const url = new URL(req.url, 'http://localhost');
  return url.searchParams;
}

function compilePath(pathPattern) {
  const keys = [];
  const regexSource = pathPattern
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        keys.push(segment.slice(1));
        return '([^/]+)';
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp(`^${regexSource}$`), keys };
}

export function createRouter(routes) {
  const compiled = routes.map((route) => ({ ...route, ...compilePath(route.path) }));
  return async function dispatch(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    let matchedPath = false;
    for (const route of compiled) {
      const match = route.regex.exec(pathname);
      if (!match) continue;
      matchedPath = true;
      if (route.method !== req.method) continue;
      const params = {};
      route.keys.forEach((key, index) => {
        params[key] = decodeURIComponent(match[index + 1]);
      });
      await route.handler(req, res, params);
      return true;
    }
    if (matchedPath) throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
    return false;
  };
}

export function rateLimiter({ windowMs, max, scope = 'global', keyFn }) {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  }, 60_000);
  timer.unref?.();

  return {
    scope,
    check(key, cost = 1) {
      const now = Date.now();
      const composite = `${scope}:${key}`;
      let entry = hits.get(composite);
      if (!entry || entry.resetAt <= now) {
        entry = { count: 0, resetAt: now + windowMs };
        hits.set(composite, entry);
      }
      entry.count += cost;
      if (entry.count > max) {
        const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
        const err = new HttpError(429, 'rate_limited', `Too many requests. Retry in ${retryAfter}s.`);
        err.retryAfter = retryAfter;
        throw err;
      }
      return entry;
    },
    reset(key) {
      hits.delete(`${scope}:${key}`);
    },
  };
}

export function requestId() {
  return randomUUID();
}
