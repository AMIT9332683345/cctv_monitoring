const SECRET_KEY = /^(password|passphrase|secret|token|authorization|cookie|apikey|api_key|credential|privatekey|key)$/i;
const MAX_STRING = 400;

export function redact(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > 5) return '[depth-limit]';
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) {
    return { name: value.name, message: redact(value.message), code: value.code };
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY.test(k) || /pass(word)?$/i.test(k)) {
        out[k] = '[redacted]';
      } else if (k === 'url' && typeof v === 'string') {
        out[k] = redactUrl(v);
      } else {
        out[k] = redact(v, depth + 1);
      }
    }
    return out;
  }
  return '[unserializable]';
}

export function redactUrl(url) {
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = u.username ? '[redacted]' : '';
      u.password = u.password ? '[redacted]' : '';
    }
    for (const key of [...u.searchParams.keys()]) {
      if (/token|key|secret|password/i.test(key)) u.searchParams.set(key, '[redacted]');
    }
    return u.toString();
  } catch {
    return '[invalid-url]';
  }
}

function emit(level, msg, fields) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(fields && typeof fields === 'object' ? redact(fields) : {}),
  };
  const line = JSON.stringify(entry);
  if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export const log = {
  info: (msg, fields) => emit('info', msg, fields),
  warn: (msg, fields) => emit('warn', msg, fields),
  error: (msg, fields) => emit('error', msg, fields),
  debug: (msg, fields) => {
    if (process.env.LOG_LEVEL === 'debug') emit('debug', msg, fields);
  },
};
