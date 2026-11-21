import {
  generateTotpSecret,
  hashPassword,
  newId,
  otpauthUri,
  randomToken,
  safeEqual,
  sha256,
  signJwt,
  verifyJwt,
  verifyPassword,
  verifyTotp,
} from '../crypto.mjs';
import { badRequest, conflict, forbidden, HttpError, unauthorized } from '../http.mjs';
import { log } from '../log.mjs';

const OWNER_SCOPE = 'owner';

export function createAuthService({ store, config, audit }) {
  function cookieOptions(extra = {}) {
    return {
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: config.cookieSameSite,
      path: '/api/auth',
      ...extra,
    };
  }

  function issueAccessToken(owner) {
    return signJwt(
      {
        sub: owner.id,
        email: owner.email,
        scope: OWNER_SCOPE,
        typ: 'access',
        tv: owner.tokenVersion ?? 1,
      },
      {
        secret: config.authSecret,
        expiresInSec: config.accessTokenTtlSec,
        issuer: config.jwtIssuer,
        audience: config.jwtAudience,
      },
    );
  }

  async function createSession(owner) {
    const refreshToken = randomToken(32);
    const now = new Date();
    const session = {
      id: newId(),
      userId: owner.id,
      refreshHash: sha256(refreshToken),
      createdAt: now.toISOString(),
      lastUsedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + config.refreshTokenTtlSec * 1000),
    };
    await store.createSession(session);
    return { refreshToken, session };
  }

  function accessPayload(owner) {
    const { token, expiresIn } = issueAccessToken(owner);
    return {
      accessToken: token,
      expiresIn,
      user: publicUser(owner),
    };
  }

  async function setup({ setupToken, email, password }, ctx = {}) {
    const existing = await store.getOwner();
    if (existing) throw conflict('Registration is disabled: the owner account already exists');
    if (!config.setupToken) {
      throw forbidden('SETUP_TOKEN is not configured on the server; owner setup is disabled');
    }
    if (!setupToken || !safeEqual(setupToken, config.setupToken)) {
      throw unauthorized('Invalid setup token');
    }
    validateEmail(email);
    validatePassword(password, email);
    const owner = {
      id: newId(),
      email: String(email).trim().toLowerCase(),
      passwordHash: await hashPassword(password),
      tokenVersion: 1,
      totpEnabled: false,
      totpSecret: null,
      totpPendingSecret: null,
      totpLastStep: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await store.createOwner(owner);
    await store.updateSettings({
      id: 'app',
      timezone: 'Asia/Kolkata',
      defaultClipMinutes: 15,
      bufferRetentionMinutes: 60,
      createdAt: new Date().toISOString(),
    });
    const { refreshToken, session } = await createSession(owner);
    await audit({ ...ctx, actor: owner.id, action: 'owner.setup', meta: { email: owner.email } });
    return { ...accessPayload(owner), refreshToken, session, owner };
  }

  async function login({ email, password, totpCode }, ctx = {}) {
    const owner = await store.getOwner();
    const emailOk = Boolean(owner) && String(email ?? '').trim().toLowerCase() === owner.email;
    const dummyHash = 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAA==';
    const passwordOk = await verifyPassword(String(password ?? ''), owner?.passwordHash ?? dummyHash);
    if (!owner || !emailOk || !passwordOk) {
      await audit({
        ...ctx,
        actor: owner?.id ?? 'anonymous',
        action: 'login.failed',
        meta: { email: String(email ?? '').slice(0, 120), reason: 'credentials' },
      });
      throw unauthorized('Invalid email or password');
    }
    if (owner.totpEnabled) {
      if (!totpCode) {
        throw new HttpError(401, 'totp_required', 'Two-factor code required');
      }
      const step = verifyTotp(owner.totpSecret, totpCode, { lastUsedStep: owner.totpLastStep ?? 0 });
      if (step === null) {
        await audit({ ...ctx, actor: owner.id, action: 'login.failed', meta: { reason: 'totp' } });
        throw new HttpError(401, 'invalid_totp', 'Invalid two-factor code');
      }
      await store.updateOwner(owner.id, { totpLastStep: step });
      owner.totpLastStep = step;
    }
    const { refreshToken, session } = await createSession(owner);
    await audit({ ...ctx, actor: owner.id, action: 'login.success' });
    return { ...accessPayload(owner), refreshToken, session, owner };
  }

  async function refresh(refreshToken) {
    if (!refreshToken) throw unauthorized('Missing refresh token');
    const session = await store.findSessionByRefreshHash(sha256(refreshToken));
    if (!session) throw unauthorized('Session is invalid or expired');
    if (new Date(session.expiresAt).getTime() <= Date.now()) {
      await store.deleteSession(session.id);
      throw unauthorized('Session has expired');
    }
    const owner = await store.getOwner();
    if (!owner || owner.id !== session.userId) {
      await store.deleteSession(session.id);
      throw unauthorized('Session owner no longer exists');
    }
    const nextToken = randomToken(32);
    const expiresAt = new Date(Date.now() + config.refreshTokenTtlSec * 1000);
    await store.touchSession(session.id, {
      refreshHash: sha256(nextToken),
      lastUsedAt: new Date().toISOString(),
      expiresAt,
    });
    return {
      ...accessPayload(owner),
      refreshToken: nextToken,
      session,
      owner,
    };
  }

  async function logout(ownerId, ctx = {}) {
    if (ownerId) {
      await store.deleteAllSessions(ownerId);
      await audit({ ...ctx, actor: ownerId, action: 'logout' });
    }
  }

  async function changePassword(ownerId, { currentPassword, newPassword }, ctx = {}) {
    const owner = await store.getOwner();
    if (!owner || owner.id !== ownerId) throw unauthorized();
    const ok = await verifyPassword(String(currentPassword ?? ''), owner.passwordHash);
    if (!ok) throw new HttpError(401, 'invalid_password', 'Current password is incorrect');
    validatePassword(newPassword, owner.email);
    await store.updateOwner(owner.id, {
      passwordHash: await hashPassword(newPassword),
      tokenVersion: (owner.tokenVersion ?? 1) + 1,
    });
    await store.deleteAllSessions(owner.id);
    await audit({ ...ctx, actor: owner.id, action: 'password.change' });
  }

  async function beginTotp(ownerId, ctx = {}) {
    const owner = await store.getOwner();
    if (!owner || owner.id !== ownerId) throw unauthorized();
    const secret = generateTotpSecret();
    await store.updateOwner(owner.id, { totpPendingSecret: secret });
    await audit({ ...ctx, actor: owner.id, action: '2fa.setup_started' });
    return {
      secret,
      otpauth: otpauthUri({ secret, account: owner.email }),
      alreadyEnabled: Boolean(owner.totpEnabled),
    };
  }

  async function enableTotp(ownerId, { secret, code }, ctx = {}) {
    const owner = await store.getOwner();
    if (!owner || owner.id !== ownerId) throw unauthorized();
    if (owner.totpEnabled) throw conflict('Two-factor authentication is already enabled');
    const pending = owner.totpPendingSecret;
    if (!pending || (secret && !safeEqual(secret, pending))) {
      throw badRequest('Two-factor setup was not started; request a new secret');
    }
    const step = verifyTotp(pending, code, { lastUsedStep: 0 });
    if (step === null) throw badRequest('That code is not valid. Check the time on your device.');
    await store.updateOwner(owner.id, {
      totpEnabled: true,
      totpSecret: pending,
      totpPendingSecret: null,
      totpLastStep: step,
    });
    await audit({ ...ctx, actor: owner.id, action: '2fa.enabled' });
  }

  async function disableTotp(ownerId, { password, code }, ctx = {}) {
    const owner = await store.getOwner();
    if (!owner || owner.id !== ownerId) throw unauthorized();
    if (!owner.totpEnabled) throw conflict('Two-factor authentication is not enabled');
    if (!(await verifyPassword(String(password ?? ''), owner.passwordHash))) {
      throw unauthorized('Password is incorrect');
    }
    if (verifyTotp(owner.totpSecret, code, { lastUsedStep: owner.totpLastStep ?? 0 }) === null) {
      throw badRequest('Invalid two-factor code');
    }
    await store.updateOwner(owner.id, {
      totpEnabled: false,
      totpSecret: null,
      totpPendingSecret: null,
      totpLastStep: 0,
      tokenVersion: (owner.tokenVersion ?? 1) + 1,
    });
    await store.deleteAllSessions(owner.id);
    await audit({ ...ctx, actor: owner.id, action: '2fa.disabled' });
  }

  async function ownerFromAccessToken(token) {
    const claims = verifyJwt(token, {
      secret: config.authSecret,
      audience: config.jwtAudience,
      issuer: config.jwtIssuer,
    });
    if (!claims || claims.typ !== 'access' || claims.scope !== OWNER_SCOPE) return null;
    const owner = await store.getOwner();
    if (!owner || owner.id !== claims.sub) return null;
    if ((owner.tokenVersion ?? 1) !== (claims.tv ?? 1)) return null;
    return owner;
  }

  function cookieHeader(refreshToken) {
    const maxAge = config.refreshTokenTtlSec;
    const parts = [
      `opps_rt=${encodeURIComponent(refreshToken)}`,
      `Max-Age=${maxAge}`,
      `Expires=${new Date(Date.now() + maxAge * 1000).toUTCString()}`,
      `Path=/api/auth`,
      'HttpOnly',
    ];
    if (config.cookieSecure) parts.push('Secure');
    parts.push(`SameSite=${config.cookieSameSite}`);
    return parts.join('; ');
  }

  const clearedCookie = () => {
    const parts = ['opps_rt=', 'Max-Age=0', 'Expires=Thu, 01 Jan 1970 00:00:00 GMT', 'Path=/api/auth', 'HttpOnly'];
    if (config.cookieSecure) parts.push('Secure');
    parts.push(`SameSite=${config.cookieSameSite}`);
    return parts.join('; ');
  };

  return {
    publicUser,
    setup,
    login,
    refresh,
    logout,
    changePassword,
    beginTotp,
    enableTotp,
    disableTotp,
    ownerFromAccessToken,
    cookieHeader,
    clearedCookie,
    cookieOptions,
  };
}

export function publicUser(owner) {
  if (!owner) return null;
  return {
    id: owner.id,
    email: owner.email,
    totpEnabled: Boolean(owner.totpEnabled),
    createdAt: owner.createdAt,
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
  if (!/[a-z]/i.test(value) || !/\d/.test(value)) {
    throw badRequest('Password must include letters and at least one number');
  }
  if (email && value.toLowerCase().includes(String(email).toLowerCase().split('@')[0])) {
    throw badRequest('Password must not contain your email name');
  }
  if (/^(password|123456|qwerty|admin)/i.test(value)) {
    throw badRequest('That password is too common');
  }
}

export function createGatewayGuard(config) {
  return function requireGatewayToken(req) {
    if (!config.gatewayToken) {
      throw new HttpError(503, 'gateway_disabled', 'GATEWAY_TOKEN is not configured on the backend');
    }
    const provided = req.headers['x-gateway-token'];
    if (typeof provided !== 'string' || !safeEqual(provided, config.gatewayToken)) {
      log.warn('gateway.auth_failed', { ip: req.socket?.remoteAddress });
      throw unauthorized('Invalid gateway token');
    }
  };
}
