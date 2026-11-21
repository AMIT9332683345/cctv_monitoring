export type Mode = 'gateway' | 'cloud';

export type User = {
  id: string;
  email: string;
  totpEnabled?: boolean;
  local?: boolean;
};

export type Meta = {
  mode: Mode;
  version: string;
  setupRequired: boolean;
  registrationEnabled?: boolean;
  gatewayName?: string;
  cloud?: {
    configured: boolean;
    connected: boolean;
    backendUrl?: string | null;
    lastHeartbeatAt?: string | null;
    lastError?: string | null;
    dvrOnline?: boolean;
    dvrError?: string | null;
  };
  auth?: { totpEnabled: boolean };
  limits?: { maxClipHours: number };
};

export type Probe = {
  online: boolean;
  at: string;
  codec?: string | null;
  resolution?: string | null;
  error?: string | null;
};

export type Camera = {
  id: string;
  name: string;
  channel: number;
  subtype?: number;
  enabled: boolean;
  buffer?: boolean;
  dvrPlayback?: boolean | null;
  audio?: boolean;
  online?: boolean;
  state?: 'disabled' | 'live' | 'offline' | 'ready' | 'unknown' | string;
  live?: boolean;
  buffering?: boolean;
  resolution?: string | null;
  codec?: string | null;
  lastSeen?: string | null;
  error?: string | null;
  lastProbe?: Probe | null;
  createdAt?: string;
  updatedAt?: string;
};

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'deleting' | 'deleted' | string;
export type JobSource = 'auto' | 'dvr' | 'buffer';

export type Job = {
  id: string;
  gatewayId?: string;
  cameraId: string;
  cameraName: string;
  channel: number;
  start: string;
  end: string;
  durationSec: number;
  source: JobSource;
  status: JobStatus;
  progress: number;
  error?: string | null;
  message?: string | null;
  errorCode?: string | null;
  requestedBy?: string | null;
  file?: {
    sizeBytes?: number;
    durationSec?: number;
    resolution?: string | null;
    codec?: string | null;
    source?: string | null;
    createdAt?: string;
    fileName?: string;
  } | null;
  createdAt: string;
  updatedAt: string;
  mediaUrl?: string | null;
  downloadUrl?: string | null;
};

export type StorageInfo = {
  disk?: { totalBytes: number; freeBytes: number; usedBytes: number };
  bufferBytes?: number;
  clipsBytes?: number;
  freeBytes?: number;
  totalBytes?: number;
  exportsDirConfigured?: boolean;
  stateBytes?: number;
};

export type GatewayStatus = {
  version: string;
  uptimeSec: number;
  gateway: {
    id: string;
    name: string;
    publicBaseUrl: string;
    lanUrls: { name: string; address: string; url: string }[];
    tailnetUrls: { name: string; address: string; url: string }[];
    dataDirConfigured?: boolean;
  };
  cloud: Meta['cloud'] & { configured: boolean; connected: boolean };
  dvr: {
    configured: boolean;
    online: boolean;
    host: string;
    port: number;
    channels: number;
    model: string;
    firmware: string;
    onvif: boolean;
    error?: string | null;
    lastTest?: { at: string; ok: boolean; message: string } | null;
  };
  cameras: { total: number; enabled: number; online: number };
  streams: { cameraId: string; state: string; encoder?: string; startedAt?: string; resolution?: string | null }[];
  buffer: {
    enabled: boolean;
    retentionMinutes: number;
    bytesUsed: number;
    cameras: {
      cameraId: string;
      name: string;
      running: boolean;
      restarts: number;
      error?: string | null;
      segments: number;
      bytes: number;
      oldest?: string | null;
      newest?: string | null;
    }[];
  };
  storage: StorageInfo;
  jobs: { total: number; active: number; latest: { id: string; name: string; status: string; progress: number; createdAt: string }[] };
  ffmpeg: { ok?: boolean; available?: boolean; version: string | null; error?: string | null };
  setupRequired?: boolean;
};

export type GatewaySettings = {
  timezone: string;
  defaultClipMinutes: number;
  bufferRetentionMinutes: number;
  bufferEnabled: boolean;
  bufferDiskCapGb: number;
  clipRetentionDays: number;
  hlsEncoder: 'copy' | 'x264' | 'nvenc' | string;
  maxStreams: number;
  publicBaseUrl: string;
  encoderOptions?: string[];
  setupRequired?: boolean;
  cloud?: GatewayStatus['cloud'];
};

export type DvrConfig = {
  host: string;
  rtspPort: number;
  httpPort: number;
  username: string;
  channels: number;
  rtspTemplate: string;
  playbackTemplate: string;
  onvif: boolean;
  model: string;
  firmware: string;
  lastTest?: { at: string; ok: boolean; message: string } | null;
  hasPassword: boolean;
  templates?: { name: string; template: string }[];
  playbackExample?: string;
  capabilities?: { rtspLive: boolean; dvrPlayback: boolean; onvif: boolean };
};

export type DvrTestResult = {
  ok: boolean;
  ip?: string;
  message: string;
  testedAt?: string;
  checks?: Record<string, { ok?: boolean; error?: string | null } | boolean | null>;
  stream?: { ok: boolean; video?: { codec?: string; width?: number; height?: number } | null; audio?: { codec?: string } | null; error?: string | null; note?: string } | null;
  onvif?: {
    ok: boolean;
    device?: { manufacturer?: string; model?: string; firmware?: string; serial?: string } | null;
    channels?: number | null;
    profiles?: string[];
    error?: string | null;
  } | null;
};

export type ScanState = {
  id: string;
  status: 'running' | 'done' | 'failed' | string;
  startedAt?: string;
  total: number;
  done: number;
  found: number;
  currentChannel?: number | null;
  results?: {
    channel: number;
    online: boolean;
    template?: string | null;
    video?: { codec?: string; width?: number; height?: number } | null;
  }[];
  applied?: { created?: Camera[]; updated?: Camera[]; foundChannels?: number[] } | null;
  error?: string | null;
};

export type CloudGateway = {
  gateway: {
    id: string;
    name: string;
    version?: string;
    platform?: string;
    publicBaseUrl?: string | null;
    lastHeartbeat?: string;
    online: boolean;
    dvr?: {
      configured?: boolean;
      online?: boolean;
      model?: string;
      firmware?: string;
      host?: string;
      port?: number;
      channels?: number;
      rtspPlayback?: boolean;
      onvif?: boolean;
      error?: string | null;
    } | null;
    storage?: { freeBytes?: number; totalBytes?: number; clipsBytes?: number; bufferBytes?: number } | null;
    buffer?: { enabled?: boolean; retentionMinutes?: number; cameraIds?: string[]; diskUsedBytes?: number } | null;
    connectionMode?: string;
  } | null;
  cameras: { total: number; online: number };
};

export type CommandResult = {
  id: string;
  type: string;
  status: 'pending' | 'running' | 'done' | 'failed' | string;
  result?: unknown;
  error?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AuditEntry = {
  id: string;
  ts: string;
  actor?: string | null;
  action: string;
  ip?: string | null;
  ua?: string | null;
  meta?: Record<string, unknown> | null;
};

export type Snapshot = { url: string; camera: { id: string; name: string } };
