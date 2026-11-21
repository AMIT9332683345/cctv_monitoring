import { MongoClient } from 'mongodb';
import { assertStoreShape } from './contract.mjs';

const clone = (v) => (v === undefined ? undefined : structuredClone(v));
const strip = (doc) => {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return rest;
};

export async function createMongoStore({ uri, dbName, appName = 'opps-cctv-backend' }) {
  const client = new MongoClient(uri, {
    appName,
    serverSelectionTimeoutMS: 12_000,
    retryWrites: true,
    tls: true,
  });
  await client.connect();
  const db = client.db(dbName);
  const users = db.collection('users');
  const sessions = db.collection('sessions');
  const settingsCol = db.collection('settings');
  const gateways = db.collection('gateways');
  const cameras = db.collection('cameras');
  const jobs = db.collection('jobs');
  const tasks = db.collection('tasks');
  const audit = db.collection('audit');

  const store = {
    kind: 'mongo',
    async init() {
      await Promise.all([
        users.createIndex({ email: 1 }, { unique: true }),
        sessions.createIndex({ refreshHash: 1 }, { unique: true }),
        sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
        gateways.createIndex({ id: 1 }, { unique: true }),
        cameras.createIndex({ gatewayId: 1, channel: 1 }),
        jobs.createIndex({ createdAt: -1 }),
        jobs.createIndex({ status: 1 }),
        tasks.createIndex({ gatewayId: 1, status: 1, createdAt: 1 }),
        audit.createIndex({ ts: -1 }),
      ]);
    },
    async close() {
      await client.close();
    },

    async getOwner() {
      return clone(strip(await users.findOne({}, { sort: { createdAt: 1 } })));
    },
    async createOwner(doc) {
      await users.insertOne({ ...doc });
      return clone(doc);
    },
    async updateOwner(id, patch) {
      const result = await users.findOneAndUpdate(
        { id },
        { $set: { ...patch, updatedAt: new Date().toISOString() } },
        { returnDocument: 'after' },
      );
      return clone(strip(result));
    },

    async createSession(doc) {
      await sessions.insertOne({ ...doc });
      return clone(doc);
    },
    async findSessionByRefreshHash(hash) {
      return clone(strip(await sessions.findOne({ refreshHash: hash })));
    },
    async touchSession(id, patch = {}) {
      const result = await sessions.findOneAndUpdate(
        { id },
        { $set: { ...patch } },
        { returnDocument: 'after' },
      );
      return clone(strip(result));
    },
    async deleteSession(id) {
      await sessions.deleteOne({ id });
    },
    async deleteAllSessions(userId) {
      await sessions.deleteMany({ userId });
    },

    async getSettings() {
      return clone(strip(await settingsCol.findOne({ id: 'app' })));
    },
    async updateSettings(patch) {
      const result = await settingsCol.findOneAndUpdate(
        { id: 'app' },
        { $set: { ...patch, id: 'app', updatedAt: new Date().toISOString() } },
        { upsert: true, returnDocument: 'after' },
      );
      return clone(strip(result));
    },

    async upsertGateway(doc) {
      const result = await gateways.findOneAndUpdate(
        { id: doc.id },
        { $set: { ...doc } },
        { upsert: true, returnDocument: 'after' },
      );
      return clone(strip(result));
    },
    async getGateway(id) {
      return clone(strip(await gateways.findOne({ id })));
    },
    async listGateways() {
      return (await gateways.find({}).toArray()).map((d) => clone(strip(d)));
    },

    async replaceCameras(gatewayId, list) {
      await cameras.deleteMany({ gatewayId });
      if (list.length) {
        await cameras.insertMany(list.map((cam) => ({ ...cam, gatewayId })));
      }
    },
    async listCameras() {
      return (await cameras.find({}).sort({ channel: 1 }).toArray()).map((d) => clone(strip(d)));
    },
    async getCamera(id) {
      return clone(strip(await cameras.findOne({ id })));
    },
    async deleteCamera(id) {
      await cameras.deleteOne({ id });
    },

    async createJob(doc) {
      await jobs.insertOne({ ...doc });
      return clone(doc);
    },
    async updateJob(id, patch) {
      const result = await jobs.findOneAndUpdate(
        { id },
        { $set: { ...patch, updatedAt: new Date().toISOString() } },
        { returnDocument: 'after' },
      );
      return clone(strip(result));
    },
    async getJob(id) {
      return clone(strip(await jobs.findOne({ id })));
    },
    async listJobs(limit = 50) {
      return (await jobs.find({}).sort({ createdAt: -1 }).limit(limit).toArray()).map((d) =>
        clone(strip(d)),
      );
    },
    async deleteJob(id) {
      await jobs.deleteOne({ id });
    },

    async createTask(doc) {
      await tasks.insertOne({ ...doc });
      return clone(doc);
    },
    async claimNextTask(gatewayId, staleMs = 15 * 60 * 1000) {
      await tasks.updateMany(
        {
          gatewayId,
          status: 'running',
          updatedAt: { $lt: new Date(Date.now() - staleMs).toISOString() },
        },
        { $set: { status: 'failed', error: 'Gateway stopped before finishing task', updatedAt: new Date().toISOString() } },
      );
      const result = await tasks.findOneAndUpdate(
        { gatewayId, status: 'pending' },
        { $set: { status: 'running', updatedAt: new Date().toISOString() } },
        { sort: { createdAt: 1 }, returnDocument: 'after' },
      );
      return clone(strip(result));
    },
    async completeTask(id, { status, result, error }) {
      const doc = await tasks.findOneAndUpdate(
        { id },
        { $set: { status, result: result ?? null, error: error ?? null, updatedAt: new Date().toISOString() } },
        { returnDocument: 'after' },
      );
      return clone(strip(doc));
    },
    async getTask(id) {
      return clone(strip(await tasks.findOne({ id })));
    },
    async listTasks(limit = 50) {
      return (await tasks.find({}).sort({ createdAt: -1 }).limit(limit).toArray()).map((d) =>
        clone(strip(d)),
      );
    },

    async appendAudit(doc) {
      await audit.insertOne({ ...doc });
    },
    async listAudit(limit = 200) {
      return (await audit.find({}).sort({ ts: -1 }).limit(limit).toArray()).map((d) =>
        clone(strip(d)),
      );
    },
  };

  return assertStoreShape(store);
}
