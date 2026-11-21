import { forbidden } from './http.mjs';

export function baseSecurityHeaders(res, { production }) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  if (production) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

export function applyCors(req, res, allowedOrigins) {
  const origin = req.headers.origin;
  if (!origin) return null;
  if (!allowedOrigins.includes(origin)) {
    throw forbidden('Origin is not allowed');
  }
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Requested-With, X-Opps-Client, X-Gateway-Token',
  );
  res.setHeader('Access-Control-Max-Age', '600');
  return origin;
}

/**
 * Cookie-authenticated endpoints must reject cross-site form posts even when CORS
 * is misconfigured, so require a custom header that simple HTML forms cannot send.
 */
export function requireCustomClientHeader(req) {
  if (req.headers['x-opps-client'] !== 'web') {
    throw forbidden('Missing X-Opps-Client header');
  }
}

export function assertJsonObject(value, name = 'body') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    const err = new Error(`${name} must be a JSON object`);
    err.status = 400;
    throw err;
  }
}
