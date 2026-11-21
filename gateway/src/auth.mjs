import {
  hashPassword,
  newId,
  randomToken,
  sha256,
  signJwt,
  verifyJwt,
  verifyPassword,
} from './crypto.mjs';
import { badRequest, forbidden, HttpError, parseCookies, serializeCookie, unauthorized } from './http.mjs';
import { log } from './log.mjs';

const REFRESH_TTL_SEC = 30 * 24 * 60 * 60;
const COOKIE = 'opps_rt';
const COOKIE_PATH = '/gapi/auth';

export function createGatewayAuth({ state, save, config, audit }) {
  function issueAccess(owner) {
    return signJwt(
      {
        sub: owner.id,
        email: owner.email,
        scope: 'owner',
        typ: 'access',
        tv: owner.tokenVersion ?? 1,
      },
      {
        secret: config.authSecret,
        expiresInSec: 900,
        issuer: 'opps-gateway',
        audience: 'opps-cctv',
      },
    );
  }

  function accessPayload(owner) {
    const { token, expiresIn } = issueAccess(owner);
    return {
      accessToken: token,
      expiresIn,
      user: { id: owner.id, email: owner.email, totpEnabled: false, local: true },
    };
  }

  function cookieHeader(refreshToken) {
    return serializeCookie(COOKIE, refreshToken, {
      maxAge: REFRESH_TTL_SEC,
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: 'Lax',
      path: COOKIE_PATH,
    });
  }

  function clearedCookie() {
    return serializeCookie(COOKIE, '', {
      maxAge: 0,
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: 'Lax',
      path: COOKIE_PATH,
    });
  }

  async function createSession(owner) {
    const refreshToken = randomToken(32);
    const now = new Date();
    state.sessions.push({
      id: newId(),
      userId: owner.id,
      refreshHash: sha256(refreshToken),
      createdAt: now.toISOString(),
      lastUsedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + REFRESH_TTL_SEC * 1000).toISOString(),
    });
    await save();
    return refreshToken;
  }

  function isLoopback(ip) {
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  }

  async function setup({ setupToken, email, password }, { ip, ua }) {
    if (state.owner) throw new HttpError(409, 'registration_disabled', 'Registration is disabled: the gateway owner already exists');
    const tokenOk = config.setupToken && String(setupToken ?? '') === config.setupToken;
    if (!tokenOk && !isLoopback(ip)) {
      throw forbidden('Gateway setup must be completed from this PC (http://localhost) or with GATEWAY_SETUP_TOKEN');
    }
    validateEmail(email);
    validatePassword(password, email);
    state.owner = {
      id: newId(),
      email: String(email).trim().toLowerCase(),
      passwordHash: await hashPassword(password),
      tokenVersion: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await save();
    const refreshToken = await createSession(state.owner);
    await audit({ actor: state.owner.id, action: 'owner.setup', ip, ua, meta: { email: state.owner.email } });
    return { ...accessPayload(state.owner), refreshToken };
  }

  async function login({ email, password }, { ip, ua }) {
    if (!state.owner) throw new HttpError(409, 'setup_required', 'Create the owner account first');
    const emailOk = String(email ?? '').trim().toLowerCase() === state.owner.email;
    const passwordOk = await verifyPassword(String(password ?? ''), state.owner.passwordHash);
    if (!emailOk || !passwordOk) {
      await audit({ actor: state.owner.id, action: 'login.failed', ip, ua });
      throw unauthorized('Invalid email or password');
    }
    const refreshToken = await createSession(state.owner);
    await audit({ actor: state.owner.id, action: 'login.success', ip, ua });
    return { ...accessPayload(state.owner), refreshToken };
  }

  async function refresh(rawToken, { ip, ua }) {
    if (!rawToken) throw unauthorized('Missing refresh token');
    const hash = sha256(rawToken);
    const session = state.sessions.find((s) => s.refreshHash === hash);
    if (!session) throw unauthorized('Session is invalid or expired');
    if (new Date(session.expiresAt).getTime() <= Date.now()) {
      state.sessions = state.sessions.filter((s) => s.id !== session.id);
      await save();
      throw unauthorized('Session has expired');
    }
    if (!state.owner || state.owner.id !== session.userId) throw unauthorized('Session owner no longer exists');
    const nextToken = randomToken(32);
    session.refreshHash = sha256(nextToken);
    session.lastUsedAt = new Date().toISOString();
    session.expiresAt = new Date(Date.now() + REFRESH_TTL_SEC * 1000).toISOString();
    await save();
    return { ...accessPayload(state.owner), refreshToken: nextToken };
  }

  async function logout(rawToken, { ip, ua }) {
    if (rawToken) {
      const hash = sha256(rawToken);
      state.sessions = state.sessions.filter((s) => s.refreshHash !== hash);
      await save();
    }
    if (state.owner) await audit({ actor: state.owner.id, action: 'logout', ip, ua });
  }

  async function changePassword({ currentPassword, newPassword }, { ip, ua }) {
    if (!state.owner) throw unauthorized();
    if (!(await verifyPassword(String(currentPassword ?? ''), state.owner.passwordHash))) {
      throw unauthorized('Current password is incorrect');
    }
    validatePassword(newPassword, state.owner.email);
    state.owner.passwordHash = await hashPassword(newPassword);
    state.owner.tokenVersion = (state.owner.tokenVersion ?? 1) + 1;
    state.owner.updatedAt = new Date().toISOString();
    state.sessions = [];
    await save();
    await audit({ actor: state.owner.id, action: 'password.change', ip, ua });
  }

  function bearer(req) {
    const header = req.headers.authorization ?? '';
    return header.startsWith('Bearer ') ? header.slice(7) : null;
  }

  async function requireOwner(req) {
    const token = bearer(req);
    if (!token) throw unauthorized();
    const claims = verifyJwt(token, { secret: config.authSecret, audience: 'opps-cctv', issuer: null });
    if (!claims || claims.typ !== 'access' || claims.scope !== 'owner') throw unauthorized();
    if (!state.owner) throw unauthorized('Gateway owner is not configured');
    if (claims.iss === 'opps-gateway') {
      if (claims.sub !== state.owner.id) throw unauthorized();
      if ((claims.tv ?? 1) !== (state.owner.tokenVersion ?? 1)) throw unauthorized('Session is no longer valid');
      return { id: state.owner.id, email: state.owner.email, source: 'gateway' };
    }
    if (claims.iss === 'opps-cloud') {
      if (String(claims.email ?? '').toLowerCase() !== state.owner.email) {
        throw forbidden('This cloud account is not paired with the gateway owner email');
      }
      return { id: state.owner.id, email: state.owner.email, source: 'cloud' };
    }
    throw unauthorized('Unknown token issuer');
  }

  function refreshCookie(req) {
    return parseCookies(req)[COOKIE] ?? null;
  }

  function issueMediaToken(claims, expiresInSec) {
    return signJwt(claims, {
      secret: config.authSecret,
      expiresInSec,
      issuer: 'opps-gateway',
      audience: 'media',
    }).token;
  }

  function verifyMediaToken(token, kind) {
    if (!token) return null;
    const claims = verifyJwt(String(token), { secret: config.authSecret, audience: 'media', issuer: null });
    if (!claims) return null;
    if (kind && claims.kind !== kind) return null;
    if (!['opps-gateway', 'opps-cloud'].includes(claims.iss)) return null;
    return claims;
  }

  return {
    setup,
    login,
    refresh,
    logout,
    changePassword,
    requireOwner,
    refreshCookie,
    cookieHeader,
    clearedCookie,
    issueMediaToken,
    verifyMediaToken,
    cookieName: COOKIE,
  };
}

function validateEmail(email) {
  const value = String(email ?? '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value) || value.length > 254) {
    throw badRequest('Enter a valid email address');
  }
}

function validatePassword(password, email) {
  const value = String(password ?? '');
  if (value.length < 12) throw badRequest('Password must be at least 12 characters');
  if (value.length > 200) throw badRequest('Password is too long');
  if (!/[a-z]/i.test(value) || !/\d/.test(value)) throw badRequest('Password must include letters and a number');
  if (email && value.toLowerCase().includes(String(email).split('@')[0].toLowerCase())) {
    throw badRequest('Password must not contain your email name');
  }
}

export function logAuthFailure(err) {
  log.warn('auth.failure', { error: err.message });
}
