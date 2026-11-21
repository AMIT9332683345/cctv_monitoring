import { loadEnvFile, env, envBool, envInt, envList, requireEnv } from './env.mjs';
import path from 'node:path';
import { ROOT_DIR } from './env.mjs';

export function loadGatewayConfig() {
  loadEnvFile();
  const authSecret = requireEnv('AUTH_SECRET');
  if (authSecret.length < 32) {
    throw new Error('AUTH_SECRET must be at least 32 characters and must match the backend value');
  }
  const dataDir = path.resolve(ROOT_DIR, env('GATEWAY_DATA_DIR', 'data'));
  const staticDir = path.resolve(ROOT_DIR, env('STATIC_DIR', '../frontend/dist'));
  const port = envInt('GATEWAY_PORT', 8089);
  return {
    version: '1.0.0',
    port,
    host: env('GATEWAY_HOST', '0.0.0.0'),
    dataDir,
    staticDir,
    hlsDir: path.join(dataDir, 'hls'),
    bufferDir: path.join(dataDir, 'buffer'),
    mediaDir: path.join(dataDir, 'media'),
    tmpDir: path.join(dataDir, 'tmp'),
    authSecret,
    setupToken: env('GATEWAY_SETUP_TOKEN', ''),
    backendUrl: env('BACKEND_URL', '').replace(/\/+$/, ''),
    gatewayToken: env('GATEWAY_TOKEN', ''),
    gatewayId: env('GATEWAY_ID', 'gw-primary'),
    gatewayName: env('GATEWAY_NAME', 'Home CCTV Gateway'),
    publicBaseUrl: env('GATEWAY_PUBLIC_URL', '').replace(/\/+$/, ''),
    allowedOrigins: envList('GATEWAY_ALLOWED_ORIGINS', []),
    ffmpegPath: env('FFMPEG_PATH', 'ffmpeg'),
    ffprobePath: env('FFPROBE_PATH', 'ffprobe'),
    maxStreams: envInt('MAX_STREAMS', 2),
    hlsEncoder: env('HLS_ENCODER', 'copy'),
    allowPublicDvrHosts: envBool('ALLOW_PUBLIC_DVR_HOSTS', false),
    cookieSecure: envBool('COOKIE_SECURE', false),
    tlsCert: env('TLS_CERT', ''),
    tlsKey: env('TLS_KEY', ''),
    logLevel: env('LOG_LEVEL', 'info'),
    dvrCommandTimeoutMs: envInt('DVR_COMMAND_TIMEOUT_MS', 20_000),
    exportTimeoutMs: envInt('EXPORT_TIMEOUT_MS', 45 * 60_000),
    maxConcurrentExports: envInt('MAX_CONCURRENT_EXPORTS', 1),
    bufferSegmentSec: envInt('BUFFER_SEGMENT_SEC', 60),
    bufferDiskCapBytes: envInt('BUFFER_DISK_CAP_BYTES', 20 * 1024 ** 3),
  };
}
