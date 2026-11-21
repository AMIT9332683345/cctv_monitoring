/**
 * Storage contract shared by the Mongo and in-memory adapters.
 * IDs are application-generated UUIDs; timestamps are ISO strings except
 * session.expiresAt, which is a Date so MongoDB's TTL monitor can expire it.
 */

export const STORE_METHODS = [
  'init',
  'close',
  'getOwner',
  'createOwner',
  'updateOwner',
  'createSession',
  'findSessionByRefreshHash',
  'touchSession',
  'deleteSession',
  'deleteAllSessions',
  'getSettings',
  'updateSettings',
  'upsertGateway',
  'getGateway',
  'listGateways',
  'replaceCameras',
  'listCameras',
  'getCamera',
  'deleteCamera',
  'createJob',
  'updateJob',
  'getJob',
  'listJobs',
  'deleteJob',
  'createTask',
  'claimNextTask',
  'completeTask',
  'getTask',
  'listTasks',
  'appendAudit',
  'listAudit',
];

export function assertStoreShape(store) {
  for (const method of STORE_METHODS) {
    if (typeof store[method] !== 'function') {
      throw new Error(`Store adapter is missing method: ${method}`);
    }
  }
  return store;
}
