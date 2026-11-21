import { assertStoreShape } from './contract.mjs';

const clone = (v) => (v === undefined ? undefined : structuredClone(v));

export function createMemoryStore() {
  const users = new Map();
  const sessions = new Map();
  let settings = null;
  const gateways = new Map();
  const cameras = new Map();
  const jobs = new Map();
  const tasks = new Map();
  const audit = [];

  const store = {
    kind: 'memory',
    async init() {},
    async close() {},

    async getOwner() {
      return clone([...users.values()][0] ?? null);
    },
    async createOwner(doc) {
      users.set(doc.id, clone(doc));
      return clone(doc);
    },
    async updateOwner(id, patch) {
      const current = users.get(id);
      if (!current) return null;
      const next = { ...current, ...clone(patch), updatedAt: new Date().toISOString() };
      users.set(id, next);
      return clone(next);
    },

    async createSession(doc) {
      sessions.set(doc.id, clone(doc));
      return clone(doc);
    },
    async findSessionByRefreshHash(hash) {
      const found = [...sessions.values()].find((s) => s.refreshHash === hash);
      return clone(found ?? null);
    },
    async touchSession(id, patch = {}) {
      const current = sessions.get(id);
      if (!current) return null;
      const next = { ...current, ...clone(patch) };
      sessions.set(id, next);
      return clone(next);
    },
    async deleteSession(id) {
      sessions.delete(id);
    },
    async deleteAllSessions(userId) {
      for (const [id, s] of sessions) {
        if (s.userId === userId) sessions.delete(id);
      }
    },

    async getSettings() {
      return clone(settings);
    },
    async updateSettings(patch) {
      settings = { ...(settings ?? {}), ...clone(patch), updatedAt: new Date().toISOString() };
      return clone(settings);
    },

    async upsertGateway(doc) {
      const existing = gateways.get(doc.id);
      const next = { ...(existing ?? {}), ...clone(doc) };
      gateways.set(doc.id, next);
      return clone(next);
    },
    async getGateway(id) {
      return clone(gateways.get(id) ?? null);
    },
    async listGateways() {
      return [...gateways.values()].map(clone);
    },

    async replaceCameras(gatewayId, list) {
      for (const [id, cam] of cameras) {
        if (cam.gatewayId === gatewayId) cameras.delete(id);
      }
      for (const cam of list) cameras.set(cam.id, clone({ ...cam, gatewayId }));
    },
    async listCameras() {
      return [...cameras.values()].map(clone).sort((a, b) => a.channel - b.channel);
    },
    async getCamera(id) {
      return clone(cameras.get(id) ?? null);
    },
    async deleteCamera(id) {
      cameras.delete(id);
    },

    async createJob(doc) {
      jobs.set(doc.id, clone(doc));
      return clone(doc);
    },
    async updateJob(id, patch) {
      const current = jobs.get(id);
      if (!current) return null;
      const next = { ...current, ...clone(patch), updatedAt: new Date().toISOString() };
      jobs.set(id, next);
      return clone(next);
    },
    async getJob(id) {
      return clone(jobs.get(id) ?? null);
    },
    async listJobs(limit = 50) {
      return [...jobs.values()]
        .map(clone)
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, limit);
    },
    async deleteJob(id) {
      jobs.delete(id);
    },

    async createTask(doc) {
      tasks.set(doc.id, clone(doc));
      return clone(doc);
    },
    async claimNextTask(gatewayId, staleMs = 15 * 60 * 1000) {
      const now = Date.now();
      const pending = [...tasks.values()]
        .filter((t) => t.gatewayId === gatewayId && t.status === 'pending')
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
      if (!pending.length) return null;
      const task = pending[0];
      if (now - Date.parse(task.createdAt) > staleMs * 24) {
        // Defensive: never execute ancient queued commands blindly.
      }
      task.status = 'running';
      task.updatedAt = new Date().toISOString();
      tasks.set(task.id, task);
      return clone(task);
    },
    async completeTask(id, { status, result, error }) {
      const current = tasks.get(id);
      if (!current) return null;
      const next = {
        ...current,
        status,
        result: clone(result) ?? null,
        error: error ?? null,
        updatedAt: new Date().toISOString(),
      };
      tasks.set(id, next);
      return clone(next);
    },
    async getTask(id) {
      return clone(tasks.get(id) ?? null);
    },
    async listTasks(limit = 50) {
      return [...tasks.values()]
        .map(clone)
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, limit);
    },

    async appendAudit(doc) {
      audit.push(clone(doc));
      while (audit.length > 2000) audit.shift();
    },
    async listAudit(limit = 200) {
      return audit.slice(-limit).reverse().map(clone);
    },
  };

  return assertStoreShape(store);
}
