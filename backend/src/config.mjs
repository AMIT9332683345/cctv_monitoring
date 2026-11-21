import { loadEnvFile, env, envBool, envInt, envList, requireEnv } from './env.mjs';

export function loadConfig() {
  loadEnvFile();
  const production = env('NODE_ENV') === 'production';
  const authSecret = requireEnv('AUTH_SECRET');
  if (authSecret.length < 32) {
    throw new Error('AUTH_SECRET must be at least 32 characters. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"');
  }
  const setupToken = env('SETUP_TOKEN', '');
  if (setupToken && setupToken.length < 16) {
    throw new Error('SETUP_TOKEN must be at least 16 characters');
  }
  const gatewayToken = env('GATEWAY_TOKEN', '');
  if (gatewayToken && gatewayToken.length < 16) {
    throw new Error('GATEWAY_TOKEN must be at least 16 characters');
  }
  const cookieSameSite = env('COOKIE_SAMESITE', production ? 'none' : 'lax');
  const cookieSecure = envBool('COOKIE_SECURE', production);
  if (cookieSameSite === 'none' && !cookieSecure) {
    throw new Error('SameSite=None cookies require COOKIE_SECURE=true');
  }
  return {
    production,
    port: envInt('PORT', 8787),
    host: env('HOST', '0.0.0.0'),
    mongoUri: env('MONGODB_URI', ''),
    mongoDb: env('MONGODB_DB', 'opps_cctv'),
    allowMemoryStore: envBool('ALLOW_MEMORY_STORE', !production),
    authSecret,
    setupToken,
    gatewayToken,
    accessTokenTtlSec: envInt('ACCESS_TOKEN_TTL_SEC', 900),
    refreshTokenTtlSec: envInt('REFRESH_TOKEN_TTL_SEC', 30 * 24 * 60 * 60),
    cookieSameSite,
    cookieSecure,
    corsOrigins: envList('CORS_ORIGINS', ['http://localhost:5173']),
    trustProxy: envBool('TRUST_PROXY', production),
    jwtIssuer: 'opps-cloud',
    jwtAudience: 'opps-cctv',
    gatewayOnlineWindowSec: envInt('GATEWAY_ONLINE_WINDOW_SEC', 45),
    version: '1.0.0',
  };
}
