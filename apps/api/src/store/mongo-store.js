import { MongoClient } from 'mongodb';
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
  'seedPlatformAdmin','createPlatformAdmin','registerCompany','approveCompany','createSession','revokeSession','createUser','createUnit',
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
    for (const field of MAP_FIELDS) this[field] = new Map(document[field] || []);
    for (const field of ARRAY_FIELDS) this[field] = document[field] || [];
    this.changeSequence = Number(document.changeSequence || 0);
  }

  #snapshot() {
    const document = { changeSequence: this.changeSequence, updatedAt: new Date() };
    for (const field of MAP_FIELDS) document[field] = [...this[field].entries()];
    for (const field of ARRAY_FIELDS) document[field] = structuredClone(this[field]);
    return document;
  }

  async #persist() {
    const snapshot = this.#snapshot();
    this.persistQueue = this.persistQueue.then(() =>
      this.state.replaceOne({ _id: 'primary' }, { _id: 'primary', ...snapshot }, { upsert: true })
    );
    await this.persistQueue;
  }

  async close() {
    await this.persistQueue;
    await this.client.close();
  }
}
