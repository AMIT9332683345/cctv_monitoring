import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(here, '..');

export function loadEnvFile(file = path.join(ROOT_DIR, '.env')) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(match[1] in process.env)) process.env[match[1]] = value;
  }
}

export function env(name, fallback = undefined) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

export function envInt(name, fallback) {
  const n = Number(env(name));
  return Number.isFinite(n) ? n : fallback;
}

export function envBool(name, fallback = false) {
  const v = env(name);
  if (v === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

export function envList(name, fallback = []) {
  const v = env(name);
  if (!v) return fallback;
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

export function requireEnv(name) {
  const v = env(name);
  if (!v) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}
