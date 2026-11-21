import { createMemoryStore } from './memory.mjs';
import { log } from '../log.mjs';

export async function openStore({ mongoUri, mongoDb, allowMemory }) {
  if (mongoUri) {
    const { createMongoStore } = await import('./mongo.mjs');
    const store = await createMongoStore({ uri: mongoUri, dbName: mongoDb });
    await store.init();
    log.info('store.connected', { kind: 'mongo', db: mongoDb });
    return store;
  }
  if (!allowMemory) {
    throw new Error('MONGODB_URI is not configured and in-memory fallback is disabled');
  }
  log.warn('store.memory_mode', {
    message: 'MONGODB_URI missing: using volatile in-memory store. Data is lost on restart. Do not use in production.',
  });
  const store = createMemoryStore();
  await store.init();
  return store;
}
