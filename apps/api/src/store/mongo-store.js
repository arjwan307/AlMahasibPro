import { MongoClient } from 'mongodb';
import { serialize, deserialize } from 'node:v8';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFile } from 'node:fs/promises';
import { MemoryStore } from './memory-store.js';

const MAP_FIELDS = [
  'companies','financialPeriods','users','roles','sessions','customerNotifications','desktopCommands','desktopIdMappings',
  'operations','financialRecords','units','items','itemUnits','prices','customers','suppliers','warehouses','stockBalances',
  'stocktakes','stockReceipts','stockIssues','stockWriteoffs','deliveryLoads','commerceDocuments','journalEntries','chartAccounts',
  'itemBarcodes','posDevices','posShifts','offlineAllocations','posReceipts','posDiscountPolicies','representatives',
  'representativeCustomers','representativeRoutes','stockTransfers','representativeOrders','debtMovements',
  'representativeCollections','custodyMovements','representativeHandovers','syncConflicts','departments',
  'employees','employeeContracts','employeeComponents','employeeAdvances','workShifts','employeeShiftAssignments',
  'attendanceEvents','overtimeRequests','leaveRequests','payrollSettings','payrollCycles','payrollPayments',
  'payrollAdjustments','cashboxes','cashboxSessions','cashboxMovements','importShipments','importCostPostings',
  'dataImportBatches','salesSettings','salesApprovals','salesReviews','deletedCompanies','deletedAccounts','ownershipTransfers'
];
const ARRAY_FIELDS = ['changes','audit','serverOutbox'];
const WRITE_METHODS = [
  'transferEnterpriseStock','settleEnterpriseDocument','seedPlatformAdmin','createPlatformAdmin','setCompanyStatus','updatePlatformCompany','deletePlatformCompany','registerCompany','approveCompany','createSession','revokeSession','touchSession','createUser','updateUser','createUnit',
  'createItem','addItemUnit','setPrice','createParty','createWarehouse','createDepartment','createEmployee',
  'createEmployeeContract','addEmployeeComponent','createEmployeeAdvance','createWorkShift','assignEmployeeShift',
  'createOvertimeRequest','decideOvertime','createLeaveRequest','decideLeave','setPayrollSettings',
  'createPayrollCycle','reviewPayrollCycle','approvePayrollCycle','payPayrollCycle','adjustPayrollCycle',
  'setBarcode','createPosDevice','setPosAllocation','createRepresentative','assignRepresentativeCustomer',
  'createRepresentativeRoute','pushOperations'
];

// Portable, self-describing backup envelope for MongoDB deployments. The magic
// prefix identifies the format, the version byte allows future evolution and the
// trailing SHA-256 digest makes every backup verifiable before it is trusted.
const BACKUP_MAGIC = Buffer.from('AlMahasibProMongoBackup\n');
const BACKUP_VERSION = 1;
const BACKUP_HEADER = BACKUP_MAGIC.length + 1 + 32;

export class MongoStore extends MemoryStore {
  constructor(client, db) {
    super();
    this.client = client;
    this.db = db;
    this.state = db.collection('_app_state');
    this.stateChunks = db.collection('_app_state_chunks');
    this.persistQueue = Promise.resolve();
    this.backupExtension = 'mongo';
    // Serialize explicit transactions the same way the SQLite store does, and
    // persist the resulting snapshot once the callback settles. Re-entrant calls
    // (already inside a transaction) run inline to avoid deadlocking the queue.
    this.txScope = new AsyncLocalStorage();
    this.txQueue = Promise.resolve();

    for (const name of WRITE_METHODS) {
      const domainMethod = this[name].bind(this);
      // Inside an explicit transaction defer persistence to the caller; standalone
      // calls run in their own transaction so a failed mutation never half-writes.
      this[name] = (...args) => this.txScope.getStore() ? domainMethod(...args) : this.transaction(() => domainMethod(...args));
    }
  }

  static async create(uri, { dbName = process.env.MONGODB_DB || 'AlMahasibPro' } = {}) {
    if (!uri) throw new Error('MONGODB_URI is required');
    const client = new MongoClient(uri, { maxPoolSize: 10 });
    await client.connect();
    const store = new MongoStore(client, client.db(dbName));
    await store.#load();
    return store;
  }

  async #load() {
    const document = await this.state.findOne({ _id: 'primary' });
    if (!document) return;
    let restored = document;
    if (document.storageFormat === 'chunks-v1') {
      const buffers = [];
      for (const id of document.chunkIds || []) {
        const chunk = await this.stateChunks.findOne({ _id: id });
        if (!chunk) throw new Error('Missing database state chunk: ' + id);
        const bytes = Buffer.isBuffer(chunk.data) ? chunk.data : Buffer.from(chunk.data.buffer);
        if (createHash('sha256').update(bytes).digest('hex') !== id) throw new Error('Invalid database state chunk');
        buffers.push(bytes);
      }
      restored = deserialize(Buffer.concat(buffers));
    }
    this.#applyState(restored);
  }

  #applyState(restored) {
    for (const field of MAP_FIELDS) this[field] = new Map(restored[field] || []);
    for (const field of ARRAY_FIELDS) this[field] = restored[field] || [];
    this.changeSequence = Number(restored.changeSequence || 0);
  }

  #stateDocument() {
    const document = { changeSequence: this.changeSequence };
    for (const field of MAP_FIELDS) document[field] = [...this[field].entries()];
    for (const field of ARRAY_FIELDS) document[field] = structuredClone(this[field]);
    return document;
  }

  async #persist() {
    const state = this.#stateDocument();
    const bytes = serialize(state);
    this.persistQueue = this.persistQueue.catch(() => {}).then(async () => {
      const chunkIds = [];
      for (let offset = 0; offset < bytes.length; offset += 2 * 1024 * 1024) {
        const data = bytes.subarray(offset, offset + 2 * 1024 * 1024);
        const id = createHash('sha256').update(data).digest('hex');
        chunkIds.push(id);
        await this.stateChunks.updateOne({ _id: id }, { $setOnInsert: { data: Buffer.from(data), createdAt: new Date() } }, { upsert: true });
      }
      // Publish only after every chunk is durable. Legacy primary remains intact until then.
      await this.state.replaceOne({ _id: 'primary' }, { _id: 'primary', storageFormat: 'chunks-v1', chunkIds, changeSequence: state.changeSequence, updatedAt: new Date() }, { upsert: true });
    });
    await this.persistQueue;
  }

  async transaction(callback) {
    if (this.txScope.getStore()) return callback();
    const task = this.txQueue.then(() => this.txScope.run(true, async () => {
      const fields = Object.keys(this).filter(key => this[key] instanceof Map || Array.isArray(this[key]) || key === 'changeSequence');
      const before = new Map(fields.map(key => [key, serialize(this[key])]));
      const previous = new Map(fields.map(key => [key, deserialize(before.get(key))]));
      this.auditStateBefore = previous;
      try {
        const result = await callback();
        // Enforce closed financial periods on every new posting, as the SQLite store does.
        if (!this.importingCloudSnapshot) for (const [id, row] of this.journalEntries) if (!previous.get('journalEntries').has(id)) this.assertFinancialPeriod(row.companyId, row.occurredAt);
        await this.#persist();
        return result;
      } catch (error) {
        // Roll the in-process state back so a rejected transaction is not half-applied.
        for (const [key, bytes] of before) this[key] = deserialize(bytes);
        throw error;
      } finally { this.auditStateBefore = null; this.importingCloudSnapshot = false; }
    }));
    this.txQueue = task.catch(() => {});
    return task;
  }

  #encodeBackup(state) {
    const payload = serialize(state);
    const digest = createHash('sha256').update(payload).digest();
    return Buffer.concat([BACKUP_MAGIC, Buffer.from([BACKUP_VERSION]), digest, payload]);
  }

  #decodeBackup(target) {
    const bytes = Buffer.isBuffer(target) ? target : Buffer.from(target);
    if (bytes.length <= BACKUP_HEADER || !bytes.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC)) throw new Error('النسخة الاحتياطية غير سليمة');
    if (bytes[BACKUP_MAGIC.length] !== BACKUP_VERSION) throw new Error('إصدار النسخة الاحتياطية غير مدعوم');
    const digest = bytes.subarray(BACKUP_MAGIC.length + 1, BACKUP_HEADER);
    const payload = bytes.subarray(BACKUP_HEADER);
    if (!createHash('sha256').update(payload).digest().equals(digest)) throw new Error('النسخة الاحتياطية تالفة');
    let state;
    try { state = deserialize(payload); } catch { throw new Error('النسخة الاحتياطية غير سليمة'); }
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('النسخة الاحتياطية غير سليمة');
    return state;
  }

  async verifyBackup(target) {
    const bytes = typeof target === 'string' ? await readFile(target) : target;
    this.#decodeBackup(bytes);
    return true;
  }

  // Full-fidelity snapshot of one product database, used by the automatic backup
  // service. The bytes are portable and self-verifying.
  async exportBackup() {
    return this.#encodeBackup(this.#stateDocument());
  }

  // Company-scoped backup mirroring the SQLite store so the cloud backup download
  // route works against MongoDB too. Photos are stored inline, so no file reads.
  async exportCompanyBackup(companyId) {
    if (!this.companies.has(companyId)) throw new Error('الشركة غير موجودة');
    const state = this.#stateDocument();
    const knownIds = new Set();
    for (const field of MAP_FIELDS) for (const [id, row] of this[field]) if (row?.companyId === companyId) knownIds.add(String(id));
    const filtered = { changeSequence: state.changeSequence };
    for (const field of MAP_FIELDS) {
      filtered[field] = [...this[field]]
        .filter(([id, row]) => field === 'sessions' ? false : field === 'companies' ? id === companyId : row?.companyId === companyId || (field === 'salesSettings' && !row?.companyId && knownIds.has(String(id).split(':').at(-1))))
        .map(([id, row]) => [id, structuredClone(row)]);
    }
    for (const field of ARRAY_FIELDS) filtered[field] = structuredClone(this[field].filter(row => row?.companyId === companyId));
    return this.#encodeBackup(filtered);
  }

  // Replace this store's data with a full snapshot (used to restore a backup).
  async importBackup(bytes) {
    const state = this.#decodeBackup(bytes);
    await this.transaction(() => { this.#applyState(state); });
    return true;
  }

  // Import a company-scoped cloud snapshot, matching the SQLite store contract:
  // only fields present in the snapshot are applied and local sessions/desktop
  // commands are cleared when this is the initial cloud connection.
  async importCloudSnapshot(bytes, companyId, { initial = false } = {}) {
    if (this.deletedCompanies?.has(companyId)) throw new Error('تم حذف الشركة نهائيًا؛ لا يمكن استيراد نسخة سحابية قديمة');
    const state = this.#decodeBackup(bytes);
    const companies = new Map(state.companies || []);
    if (companies.size !== 1 || !companies.has(companyId)) throw new Error('النسخة لا تخص الشركة المحددة');
    return this.transaction(() => {
      if (!initial && this.desktopCommands && [...this.desktopCommands.values()].some(x => x.local && x.status !== 'acknowledged')) return false;
      // Historical postings restored from a verified backup must not be re-validated
      // against periods closed after the snapshot; the transaction clears this flag.
      this.importingCloudSnapshot = true;
      for (const field of MAP_FIELDS) {
        if (['sessions', 'desktopCommands', 'desktopIdMappings'].includes(field)) continue;
        if (state[field] !== undefined) this[field] = new Map(state[field]);
      }
      for (const field of ARRAY_FIELDS) if (state[field] !== undefined) this[field] = structuredClone(state[field]);
      this.changeSequence = Number(state.changeSequence || 0);
      if (initial) { this.sessions.clear(); this.desktopCommands?.clear(); this.desktopIdMappings?.clear(); }
      return true;
    });
  }

  async close() {
    await this.persistQueue;
    await this.client.close();
  }
}
