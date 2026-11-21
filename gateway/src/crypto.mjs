import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  scrypt as scryptCb,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);

const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

export function newId() {
  return randomUUID();
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(input) {
  return createHash('sha256').update(input).digest('hex');
}

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 128 * 1024 * 1024,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  try {
    const parts = String(stored).split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, n, r, p, saltB64, hashB64] = parts;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const key = await scrypt(password, salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: 128 * 1024 * 1024,
    });
    return key.length === expected.length && timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

function b64urlDecode(input) {
  return Buffer.from(input, 'base64url').toString('utf8');
}

export function signJwt(payload, { secret, expiresInSec = 900, issuer = 'opps-cloud', audience = 'opps-cctv' }) {
  const now = Math.floor(Date.now() / 1000);
  const body = {
    iss: issuer,
    aud: audience,
    iat: now,
    exp: now + expiresInSec,
    jti: randomToken(9),
    ...payload,
  };
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify(body));
  const signature = createHmac('sha256', secret).update(`${header}.${claims}`).digest('base64url');
  return { token: `${header}.${claims}.${signature}`, expiresIn: expiresInSec, claims: body };
}

export function verifyJwt(token, { secret, audience = 'opps-cctv', issuer = null, clockToleranceSec = 30 }) {
  if (typeof token !== 'string' || token.split('.').length !== 3) return null;
  const [header, claims, signature] = token.split('.');
  try {
    const expected = createHmac('sha256', secret).update(`${header}.${claims}`).digest();
    const actual = Buffer.from(signature, 'base64url');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    const head = JSON.parse(b64urlDecode(header));
    if (head.alg !== 'HS256') return null;
    const body = JSON.parse(b64urlDecode(claims));
    const now = Math.floor(Date.now() / 1000);
    if (typeof body.exp !== 'number' || body.exp + clockToleranceSec < now) return null;
    if (audience && body.aud !== audience) return null;
    if (issuer && body.iss !== issuer) return null;
    return body;
  } catch {
    return null;
  }
}

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateTotpSecret() {
  return base32Encode(randomBytes(20));
}

function hotp(secret, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code = ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, '0');
}

export function totpCode(secret, step = Math.floor(Date.now() / 30_000)) {
  return hotp(secret, step);
}

export function verifyTotp(secret, code, { window = 1, lastUsedStep = 0 } = {}) {
  const normalized = String(code ?? '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(normalized)) return null;
  const current = Math.floor(Date.now() / 30_000);
  for (let offset = -window; offset <= window; offset += 1) {
    const step = current + offset;
    if (step <= lastUsedStep) continue;
    if (hotp(secret, step) === normalized) return step;
  }
  return null;
}

export function otpauthUri({ secret, account, issuer = 'OPPS CCTV' }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
