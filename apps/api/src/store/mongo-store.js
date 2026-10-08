import { MongoClient } from 'mongodb';
import { serialize, deserialize } from 'node:v8';
import { createHash } from 'node:crypto';
import { MemoryStore } from './memory-store.js';

const MAP_FIELDS = [
  'companies','users','roles','sessions','operations','financialRecords','units','items','itemUnits','prices',
  'customers','suppliers','warehouses','stockBalances','commerceDocuments','journalEntries','itemBarcodes',
  'posDevices','posShifts','offlineAllocations','posReceipts','posDiscountPolicies','representatives',
  'representativeCustomers','representativeRoutes','stockTransfers','representativeOrders','debtMovements',
  'representativeCollections','custodyMovements','representativeHandovers','syncConflicts','departments',
  'employees','employeeContracts','employeeComponents','employeeAdvances','workShifts','employeeShiftAssignments',
  'attendanceEvents','overtimeRequests','leaveRequests','payrollSettings','payrollCycles','payrollPayments',
  'payrollAdjustments'
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

export class MongoStore extends MemoryStore {
  constructor(client, db) {
    super();
    this.client = client;
    this.db = db;
    this.state = db.collection('_app_state');
    this.stateChunks = db.collection('_app_state_chunks');
    this.persistQueue = Promise.resolve();

    for (const name of WRITE_METHODS) {
      const domainMethod = this[name].bind(this);
      this[name] = async (...args) => {
        const result = await domainMethod(...args);
        await this.#persist();
        return result;
      };
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
    for (const field of MAP_FIELDS) this[field] = new Map(restored[field] || []);
    for (const field of ARRAY_FIELDS) this[field] = restored[field] || [];
    this.changeSequence = Number(restored.changeSequence || 0);
  }

  #snapshot() {
    const document = { changeSequence: this.changeSequence, updatedAt: new Date() };
    for (const field of MAP_FIELDS) document[field] = [...this[field].entries()];
    for (const field of ARRAY_FIELDS) document[field] = structuredClone(this[field]);
    return document;
  }

  async #persist() {
    const snapshot = this.#snapshot();
    delete snapshot.updatedAt;
    const bytes = serialize(snapshot);
    this.persistQueue = this.persistQueue.catch(() => {}).then(async () => {
      const chunkIds = [];
      for (let offset = 0; offset < bytes.length; offset += 2 * 1024 * 1024) {
        const data = bytes.subarray(offset, offset + 2 * 1024 * 1024);
        const id = createHash('sha256').update(data).digest('hex');
        chunkIds.push(id);
        await this.stateChunks.updateOne({ _id: id }, { $setOnInsert: { data: Buffer.from(data), createdAt: new Date() } }, { upsert: true });
      }
      // Publish only after every chunk is durable. Legacy primary remains intact until then.
      await this.state.replaceOne({ _id: 'primary' }, { _id: 'primary', storageFormat: 'chunks-v1', chunkIds, changeSequence: snapshot.changeSequence, updatedAt: new Date() }, { upsert: true });
    });
    await this.persistQueue;
  }

  async close() {
    await this.persistQueue;
    await this.client.close();
  }
}

