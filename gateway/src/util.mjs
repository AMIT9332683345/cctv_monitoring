import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import dns from 'node:dns/promises';
import net from 'node:net';

export function nowIso() {
  return new Date().toISOString();
}

export function lanAddresses() {
  const out = { lan: [], tailnet: [], all: [] };
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      const entry = { name, address: address.address };
      out.all.push(entry);
      if (address.address.startsWith('100.')) out.tailnet.push(entry);
      else if (
        /^192\.168\./.test(address.address) ||
        /^10\./.test(address.address) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(address.address)
      ) {
        out.lan.push(entry);
      }
    }
  }
  return out;
}

export function isPrivateIp(ip) {
  if (!net.isIPv4(ip)) return false;
  const [a, b] = ip.split('.').map(Number);
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // Tailscale CGNAT
  return false;
}

/**
 * Blocks SSRF-ish use of the gateway as a proxy: the DVR host must be a
 * literal private IP, or a hostname that resolves to one (unless explicitly
 * allowed). Rejects URLs, credentials, and non-host garbage.
 */
export async function assertDvrHost(host, allowPublic) {
  const value = String(host ?? '').trim();
  if (!value) throw badRequest('DVR IP address is required');
  if (value.length > 253) throw badRequest('DVR host is too long');
  if (/[\s/@\\?#]/.test(value)) throw badRequest('DVR host must be an IP address or hostname without protocol');
  let ip = value;
  if (!net.isIP(value)) {
    try {
      const resolved = await dns.lookup(value);
      ip = resolved.address;
    } catch {
      throw badRequest(`Could not resolve host "${value}". Enter the DVR's IPv4 address instead.`);
    }
  }
  if (!allowPublic && !isPrivateIp(ip)) {
    throw badRequest(
      `Refusing to connect to public address ${ip}. The DVR must be on your home LAN. Set ALLOW_PUBLIC_DVR_HOSTS=true only if you understand the risk.`,
    );
  }
  return ip;
}

export function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  err.code = 'bad_request';
  return err;
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export async function diskInfo(dir) {
  try {
    const stats = await fs.promises.statfs(dir);
    const totalBytes = stats.blocks * stats.bsize;
    const freeBytes = stats.bavail * stats.bsize;
    return { totalBytes, freeBytes, usedBytes: totalBytes - freeBytes };
  } catch {
    return { totalBytes: 0, freeBytes: 0, usedBytes: 0 };
  }
}

export async function dirSize(dir) {
  let total = 0;
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(full);
    else {
      try {
        total += (await fs.promises.stat(full)).size;
      } catch {
        /* file removed mid-walk */
      }
    }
  }
  return total;
}

export async function newestFileAgeSec(dir) {
  try {
    const entries = await fs.promises.readdir(dir);
    if (!entries.length) return null;
    let newest = 0;
    for (const name of entries) {
      const stat = await fs.promises.stat(path.join(dir, name));
      if (stat.mtimeMs > newest) newest = stat.mtimeMs;
    }
    return Math.round((Date.now() - newest) / 1000);
  } catch {
    return null;
  }
}

export function dvrLocalTimestamp(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('year')}_${get('month')}_${get('day')}_${get('hour')}_${get('minute')}_${get('second')}`;
}

export function tcpCheck(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok, error) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve({ ok, error: error ?? null });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false, 'timeout'));
    socket.once('error', (err) => done(false, err.code ?? err.message));
  });
}

export function safeFilePath(baseDir, candidate) {
  const base = path.resolve(baseDir);
  const full = path.resolve(base, candidate);
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  return full;
}

export function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.round(n), min), max);
}
