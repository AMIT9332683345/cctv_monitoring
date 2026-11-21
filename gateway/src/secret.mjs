import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PREFIX = 'enc:v1:';

export function loadOrCreateMasterKey(dataDir, envKey) {
  if (envKey) {
    const buf = Buffer.from(envKey, 'base64');
    if (buf.length !== 32) {
      throw new Error('GATEWAY_KEY must be 32 bytes, base64 encoded');
    }
    return buf;
  }
  const keyPath = path.join(dataDir, 'master.key');
  if (fs.existsSync(keyPath)) {
    const buf = Buffer.from(fs.readFileSync(keyPath, 'utf8').trim(), 'base64');
    if (buf.length !== 32) throw new Error(`Master key at ${keyPath} is invalid (expected 32 bytes)`);
    return buf;
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const key = randomBytes(32);
  fs.writeFileSync(keyPath, key.toString('base64'), { mode: 0o600 });
  try {
    fs.chmodSync(keyPath, 0o600);
  } catch {
    /* Windows: ACLs are inherited; documented in the security guide. */
  }
  return key;
}

export function encryptSecret(plaintext, key) {
  if (!plaintext) return '';
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64')}.${tag.toString('base64')}.${ciphertext.toString('base64')}`;
}

export function decryptSecret(value, key) {
  if (!value) return '';
  if (!String(value).startsWith(PREFIX)) {
    throw new Error('Encrypted value has an unknown format');
  }
  const payload = String(value).slice(PREFIX.length).split('.');
  if (payload.length !== 3) throw new Error('Encrypted value is malformed');
  const [ivB64, tagB64, dataB64] = payload;
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}

export function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

export function sameSecret(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
