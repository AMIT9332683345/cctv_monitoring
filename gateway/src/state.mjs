import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { log } from './log.mjs';

const STATE_VERSION = 1;
const MAX_JOBS = 250;
const MAX_AUDIT = 1000;

export function defaultState() {
  return {
    version: STATE_VERSION,
    createdAt: new Date().toISOString(),
    owner: null,
    settings: {
      timezone: 'Asia/Kolkata',
      defaultClipMinutes: 15,
      bufferRetentionMinutes: 60,
      bufferEnabled: false,
      bufferDiskCapGb: 20,
      clipRetentionDays: 7,
      hlsEncoder: 'copy',
      maxStreams: 2,
      publicBaseUrl: '',
    },
    dvr: {
      host: '',
      rtspPort: 554,
      httpPort: 80,
      username: '',
      passwordEnc: '',
      channels: 4,
      rtspTemplate: '/cam/realmonitor?channel={ch}&subtype={sub}',
      playbackTemplate: '/cam/playback?channel={ch}&subtype=0&starttime={start}&endtime={end}',
      onvif: true,
      model: '',
      firmware: '',
      lastTest: null,
    },
    cameras: [],
    jobs: [],
    sessions: [],
    audit: [],
  };
}

export async function openState({ dataDir }) {
  const statePath = path.join(dataDir, 'state.json');
  fs.mkdirSync(dataDir, { recursive: true });
  let state = defaultState();
  if (fs.existsSync(statePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      state = { ...state, ...parsed, settings: { ...state.settings, ...parsed.settings }, dvr: { ...state.dvr, ...parsed.dvr } };
    } catch (err) {
      const backup = `${statePath}.corrupt-${Date.now()}`;
      fs.copyFileSync(statePath, backup);
      log.error('state.corrupt', { err, backup });
      throw new Error(`Gateway state file is corrupt. A backup was saved to ${backup}`);
    }
  }
  state.version = STATE_VERSION;
  state.sessions = (state.sessions ?? []).filter((s) => new Date(s.expiresAt).getTime() > Date.now());
  state.jobs = (state.jobs ?? []).slice(0, MAX_JOBS);

  let writeChain = Promise.resolve();
  function save() {
    writeChain = writeChain.then(async () => {
      prune(state);
      const tmp = `${statePath}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
      try {
        await fs.promises.rename(tmp, statePath);
      } catch {
        await fs.promises.rm(statePath, { force: true });
        await fs.promises.rename(tmp, statePath);
      }
    });
    return writeChain;
  }

  async function audit({ actor, action, ip, ua, meta }) {
    state.audit.unshift({
      id: randomUUID(),
      ts: new Date().toISOString(),
      actor: actor ?? 'system',
      action,
      ip: ip ?? null,
      ua: ua ? String(ua).slice(0, 200) : null,
      meta: meta ?? null,
    });
    if (state.audit.length > MAX_AUDIT) state.audit.length = MAX_AUDIT;
    await save();
  }

  await save();
  return { state, save, audit, statePath };
}

function prune(state) {
  if (state.jobs.length > MAX_JOBS) {
    const removable = state.jobs
      .filter((j) => ['completed', 'failed', 'deleted'].includes(j.status))
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    while (state.jobs.length > MAX_JOBS && removable.length) {
      const victim = removable.shift();
      state.jobs = state.jobs.filter((j) => j.id !== victim.id);
    }
    if (state.jobs.length > MAX_JOBS) state.jobs.length = MAX_JOBS;
  }
  if (state.audit.length > MAX_AUDIT) state.audit.length = MAX_AUDIT;
  const now = Date.now();
  state.sessions = state.sessions.filter((s) => new Date(s.expiresAt).getTime() > now);
}
