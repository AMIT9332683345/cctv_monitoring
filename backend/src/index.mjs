import http from 'node:http';
import { loadConfig } from './config.mjs';
import { openStore } from './store/index.mjs';
import { createApp } from './app.mjs';
import { applyCors, baseSecurityHeaders } from './security.mjs';
import { log } from './log.mjs';

async function main() {
  const config = loadConfig();
  const store = await openStore({
    mongoUri: config.mongoUri,
    mongoDb: config.mongoDb,
    allowMemory: config.allowMemoryStore,
  });
  const app = createApp({ store, config });

  const server = http.createServer(async (req, res) => {
    baseSecurityHeaders(res, { production: config.production });
    try {
      const origin = applyCors(req, res, config.corsOrigins);
      if (req.method === 'OPTIONS') {
        res.writeHead(origin ? 204 : 403);
        res.end();
        return;
      }
    } catch {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'cors_rejected', message: 'Origin not allowed' } }));
      return;
    }
    await app(req, res);
  });

  server.requestTimeout = 30_000;
  server.headersTimeout = 20_000;
  server.keepAliveTimeout = 65_000;
  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });
  server.on('upgrade', (req, socket) => {
    socket.destroy();
  });

  server.listen(config.port, config.host, () => {
    log.info('backend.listening', {
      port: config.port,
      host: config.host,
      store: store.kind,
      corsOrigins: config.corsOrigins,
      production: config.production,
    });
    if (!config.gatewayToken) {
      log.warn('gateway.token_missing', { message: 'GATEWAY_TOKEN is empty; gateway endpoints will return 503.' });
    }
    if (!config.setupToken) {
      log.warn('setup.token_missing', { message: 'SETUP_TOKEN is empty; owner setup endpoint is disabled.' });
    }
  });

  const shutdown = async (signal) => {
    log.info('backend.shutdown', { signal });
    server.close();
    try {
      await store.close();
    } catch (err) {
      log.error('backend.store_close_failed', { err });
    }
    setTimeout(() => process.exit(0), 300).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => log.error('unhandled_rejection', { err }));
  process.on('uncaughtException', (err) => {
    log.error('uncaught_exception', { err });
    setTimeout(() => process.exit(1), 200);
  });
}

main().catch((err) => {
  log.error('backend.startup_failed', { err });
  process.exit(1);
});
