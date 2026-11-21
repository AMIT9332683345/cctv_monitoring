/**
 * Create the owner account from environment variables (alternative to the
 * first-run setup screen). Reads OWNER_EMAIL, OWNER_PASSWORD from backend/.env
 * or the shell environment. Refuses to overwrite an existing owner.
 *
 * Usage: node backend/scripts/bootstrap-owner.mjs
 */
import { loadEnvFile, env, envBool } from '../src/env.mjs';
import { openStore } from '../src/store/index.mjs';
import { hashPassword, newId } from '../src/crypto.mjs';
import { log } from '../src/log.mjs';

loadEnvFile();
const email = String(env('OWNER_EMAIL', '')).trim().toLowerCase();
const password = String(env('OWNER_PASSWORD', ''));
if (!email || !password) {
  console.error('Set OWNER_EMAIL and OWNER_PASSWORD first (shell env or backend/.env).');
  process.exit(1);
}
if (password.length < 12 || !/[a-z]/i.test(password) || !/\d/.test(password)) {
  console.error('Password must be at least 12 characters and contain letters and a number.');
  process.exit(1);
}

const store = await openStore({
  mongoUri: env('MONGODB_URI', ''),
  mongoDb: env('MONGODB_DB', 'opps_cctv'),
  allowMemory: envBool('ALLOW_MEMORY_STORE', true),
});

const existing = await store.getOwner();
if (existing) {
  console.error(`An owner already exists (${existing.email}). Use the login screen or reset via Mongo.`);
  await store.close();
  process.exit(1);
}

const now = new Date().toISOString();
await store.createOwner({
  id: newId(),
  email,
  passwordHash: await hashPassword(password),
  tokenVersion: 1,
  totpEnabled: false,
  totpSecret: null,
  totpPendingSecret: null,
  totpLastStep: 0,
  createdAt: now,
  updatedAt: now,
});
await store.updateSettings({
  id: 'app',
  timezone: env('TIMEZONE', 'Asia/Kolkata'),
  defaultClipMinutes: 15,
  bufferRetentionMinutes: 60,
  createdAt: now,
});
log.info('owner.created', { email, store: store.kind });
if (store.kind === 'memory') {
  log.warn('owner.memory_store', { message: 'In-memory store: this owner disappears when the process exits.' });
}
await store.close();
