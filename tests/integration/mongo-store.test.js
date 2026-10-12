import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MongoClient } from 'mongodb';
import { MongoStore } from '../../apps/api/src/store/mongo-store.js';
import { startBackupService } from '../../apps/api/src/lib/backup-service.js';
import { startTestMongo, randomDbName } from '../helpers/test-mongo.mjs';

let mongo = null;
let skip = 'MongoDB test service unavailable (set TEST_MONGODB_URI or provide a mongod binary)';
try {
  mongo = await startTestMongo();
  if (mongo) skip = false;
} catch (error) {
  skip = 'MongoDB test service failed to start: ' + error.message;
}

let admin = null;
if (mongo) {
  admin = new MongoClient(mongo.uri, { serverSelectionTimeoutMS: 5000 });
  await admin.connect();
}
async function openStore(dbName) {
  return MongoStore.create(mongo.uri, { dbName });
}
async function drop(database) {
  if (admin) await admin.db(database).dropDatabase();
}
async function newCompany(store, code) {
  return store.registerCompany({ code, legalName: 'شركة ' + code, currency: 'IQD', owner: { username: code + '-owner', displayName: 'مالك', passwordHash: 'hash-' + code } });
}

test.after(async () => {
  await admin?.close().catch(() => {});
  await mongo?.stop().catch(() => {});
});

test('company and retail product databases stay isolated on one cluster', { skip }, async () => {
  const companyDb = randomDbName('company');
  const retailDb = randomDbName('retail');
  const company = await openStore(companyDb);
  const retail = await openStore(retailDb);
  try {
    const created = await newCompany(company, 'acme-a');
    assert.ok(company.companies.has(created.id));
    assert.equal(retail.companies.size, 0);
    assert.equal(retail.companies.has(created.id), false);
    const reopenedRetail = await openStore(retailDb);
    try { assert.equal(reopenedRetail.companies.size, 0); } finally { await reopenedRetail.close(); }
  } finally {
    await company.close();
    await retail.close();
    await drop(companyDb);
    await drop(retailDb);
  }
});

test('state survives a store restart and is stored as verified chunks', { skip }, async () => {
  const database = randomDbName('persist');
  let store = await openStore(database);
  try {
    const created = await newCompany(store, 'persist-co');
    await store.close();
    store = await openStore(database);
    assert.ok(store.companies.has(created.id));
    assert.equal(store.companies.get(created.id).code, 'persist-co');
    const client = new MongoClient(mongo.uri);
    await client.connect();
    try {
      const document = await client.db(database).collection('_app_state').findOne({ _id: 'primary' });
      assert.equal(document.storageFormat, 'chunks-v1');
      assert.ok(document.chunkIds.length >= 1);
    } finally { await client.close(); }
  } finally {
    await store.close().catch(() => {});
    await drop(database);
  }
});

test('a rejected transaction rolls back both in-memory and persisted state', { skip }, async () => {
  const database = randomDbName('txn');
  const store = await openStore(database);
  let reopened;
  try {
    const created = await newCompany(store, 'txn-co');
    await assert.rejects(() => store.transaction(() => {
      store.companies.set('ghost', { id: 'ghost', code: 'ghost', legalName: 'شبح', currency: 'IQD' });
      throw new Error('boom');
    }), /boom/);
    assert.equal(store.companies.has('ghost'), false, 'in-memory state must be restored');
    assert.ok(store.companies.has(created.id), 'committed data must remain');
    await store.close();
    reopened = await openStore(database);
    assert.equal(reopened.companies.has('ghost'), false, 'ghost row must not be persisted');
    assert.ok(reopened.companies.has(created.id));
  } finally {
    await store.close().catch(() => {});
    await reopened?.close().catch(() => {});
    await drop(database);
  }
});

test('full backup round-trips and rejects tampered bytes', { skip }, async () => {
  const sourceDb = randomDbName('bksrc');
  const targetDb = randomDbName('bkdst');
  const source = await openStore(sourceDb);
  const target = await openStore(targetDb);
  try {
    const created = await newCompany(source, 'backup-co');
    const bytes = await source.exportBackup();
    assert.equal(await source.verifyBackup(bytes), true);

    const tampered = Buffer.from(bytes);
    tampered[tampered.length - 1] ^= 0xff;
    await assert.rejects(() => source.verifyBackup(tampered), /تالفة|سليمة/);
    await assert.rejects(() => source.verifyBackup(Buffer.from('not a backup')), /سليمة/);
    await assert.rejects(() => source.verifyBackup(Buffer.concat([bytes.subarray(0, 10), bytes.subarray(0, 10)])), /سليمة/);

    await target.importBackup(bytes);
    assert.ok(target.companies.has(created.id));
    assert.equal(target.companies.get(created.id).code, 'backup-co');
  } finally {
    await source.close();
    await target.close();
    await drop(sourceDb);
    await drop(targetDb);
  }
});

test('company backup restores through a cloud snapshot without leaking other companies', { skip }, async () => {
  const sourceDb = randomDbName('cbsrc');
  const targetDb = randomDbName('cbdst');
  const source = await openStore(sourceDb);
  const target = await openStore(targetDb);
  try {
    const first = await newCompany(source, 'keep-co');
    const second = await newCompany(source, 'drop-co');
    const bytes = await source.exportCompanyBackup(first.id);
    await assert.rejects(() => source.exportCompanyBackup('missing-company'), /غير موجودة/);

    assert.equal(await target.importCloudSnapshot(bytes, first.id, { initial: true }), true);
    assert.ok(target.companies.has(first.id));
    assert.equal(target.companies.has(second.id), false);
    await assert.rejects(() => target.importCloudSnapshot(bytes, second.id), /لا تخص الشركة المحددة/);
    await assert.rejects(() => target.importCloudSnapshot(Buffer.from('broken'), first.id), /سليمة/);
  } finally {
    await source.close();
    await target.close();
    await drop(sourceDb);
    await drop(targetDb);
  }
});

test('cloud restore imports historical postings and closed periods without disabling posting validation', { skip }, async () => {
  const sourceDb = randomDbName('history-src');
  const targetDb = randomDbName('history-dst');
  const source = await openStore(sourceDb);
  const target = await openStore(targetDb);
  try {
    const company = await newCompany(source, 'history-co');
    // Historical postings (one without occurredAt) and a closed period, injected the
    // same way a previous cloud release stored them. The flag mirrors the SQLite
    // store: restored history must not be re-validated against periods closed later.
    source.importingCloudSnapshot = true;
    await source.transaction(() => {
      source.financialPeriods.set('p', { id: 'p', companyId: company.id, startDate: '2025-01-01', endDate: '2025-01-31', status: 'closed' });
      source.journalEntries.set('legacy', { id: 'legacy', companyId: company.id, createdAt: '2025-01-01T00:00:00Z', lines: [] });
      source.journalEntries.set('closed', { id: 'closed', companyId: company.id, occurredAt: '2025-01-01T00:00:00Z', lines: [] });
    });
    const bytes = await source.exportBackup();

    assert.equal(await target.importCloudSnapshot(bytes, company.id, { initial: true }), true);
    assert.equal(target.journalEntries.size, 2);
    assert.equal(target.financialPeriods.get('p').status, 'closed');

    await assert.rejects(() => target.transaction(() => target.journalEntries.set('bad', { id: 'bad', companyId: company.id, lines: [] })), /تاريخ الترحيل غير صالح/);
    await assert.rejects(() => target.transaction(() => target.journalEntries.set('late', { id: 'late', companyId: company.id, occurredAt: '2025-01-05T00:00:00Z', lines: [] })), /الفترة المالية مقفلة/);
    assert.equal(target.journalEntries.size, 2);
  } finally {
    await source.close();
    await target.close();
    await drop(sourceDb);
    await drop(targetDb);
  }
});

test('automatic backups verify before publishing and record failures', { skip }, async () => {
  const database = randomDbName('svc');
  const directory = await mkdtemp(join(tmpdir(), 'almahasib-backups-'));
  const store = await openStore(database);
  try {
    await newCompany(store, 'svc-co');
    const service = startBackupService({ store, directory, onError: () => {} });
    try {
      const file = await service.run();
      assert.ok(file && file.endsWith('.mongo'));
      assert.equal(service.status().lastError, null);
      assert.equal(await store.verifyBackup(await readFile(file)), true);
    } finally { await service.close(); }

    const badDb = randomDbName('svcbad');
    const badStore = await openStore(badDb);
    try {
      await newCompany(badStore, 'bad-co');
      badStore.exportBackup = async () => Buffer.from('not a backup');
      const failing = startBackupService({ store: badStore, directory, onError: () => {} });
      try {
        await assert.rejects(() => failing.run());
        assert.ok(failing.status().lastError, 'failure must be recorded');
        const published = (await readdir(directory)).filter(name => /^AlMahasibPro-auto-.*\.mongo$/.test(name));
        assert.equal(published.length, 1, 'corrupt snapshot must never be published');
      } finally { await failing.close(); }
    } finally {
      await badStore.close();
      await drop(badDb);
    }
  } finally {
    await store.close();
    await drop(database);
    await rm(directory, { recursive: true, force: true });
  }
});

test('logistics records and shipment revisions persist before acknowledging writes', {skip}, async()=>{
 const dbName=randomDbName('logistics');let store=await openStore(dbName);
 try{
  const company=await newCompany(store,'logistics-mongo'),context={company,user:store.users.get(company.ownerUserId)};
  const supplier=await store.createParty(company.id,'supplier',{code:'SUP',name:'المورد'},context.user.id);
  const shipment=await store.createImportShipment(context,{operationId:crypto.randomUUID(),shipmentNumber:'MONGO-SHIP',containerNumber:'CONT-1',supplierId:supplier.id,currency:'IQD',logistics:{mode:'multimodal',driverPhone:'123'}});
  const partner=await store.saveLogisticsRecord(context,{id:crypto.randomUUID(),kind:'partner',code:'SEA',name:'شركة النقل',role:'sea_carrier',createdBy:context.user.id});
  await store.updateImportLogistics(context,shipment.id,{mode:'multimodal',seaCarrierId:partner.id,driverPhone:'456'},0,{billOfLading:'BL-MONGO'});
  const auditLength=store.audit.length;await store.close();store=await openStore(dbName);
  assert.equal(store.logisticsRecords.get(partner.id).name,'شركة النقل');assert.equal(store.importShipments.get(shipment.id).logistics.driverPhone,'456');assert.equal(store.importShipments.get(shipment.id).logisticsRevision,1);assert.equal(store.importShipments.get(shipment.id).billOfLading,'BL-MONGO');assert.equal(store.audit.length,auditLength);
 }finally{await store.close();await drop(dbName);}
});
