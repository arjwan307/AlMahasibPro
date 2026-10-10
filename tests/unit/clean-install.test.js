import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteStore } from '../../apps/api/src/store/sqlite-store.js';
import { clearCompanyData, resetInstallationOnce } from '../../apps/api/src/lib/clean-install.js';

test('clean installation removes tenant data and sessions, preserving only platform administrators after reopening', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'erp-clean-'));
  const filename = join(directory, 'enterprise.sqlite');
  let store = new SQLiteStore(filename);
  try {
    await store.transaction(() => {
      store.users.set('developer', { id: 'developer', platformAdmin: true, passwordHash: 'preserved-hash' });
      store.users.set('owner', { id: 'owner', companyId: 'tenant', platformAdmin: false });
      store.companies.set('tenant', { id: 'tenant', code: 'COMPANY2020' });
      store.sessions.set('session', { userId: 'owner' });
      store.salesSettings.set('tenant:settings', { companyId: 'tenant', secret: 'old-data' });
    });
    assert.deepEqual(await clearCompanyData(store), { companies: 0, users: 1, administrators: 1 });
    await store.close();
    store = new SQLiteStore(filename);
    for (const [field, value] of Object.entries(store)) {
      if (value instanceof Map && field !== 'users') assert.equal(value.size, 0, field);
      if (Array.isArray(value)) assert.equal(value.length, 0, field);
    }
    assert.equal(store.users.get('developer').passwordHash, 'preserved-hash');
    assert.equal(store.users.has('owner'), false);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test('reset runs once, removes old backups and leaves newly created customers intact on restart',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'erp-reset-once-')),store=new SQLiteStore(join(directory,'enterprise.sqlite'));
 try {
  await mkdir(join(directory,'backups'));await writeFile(join(directory,'backups','old.sqlite'),'old customer data');
  await writeFile(join(directory,'cloud-connection.json'),'old cloud identity');
  assert.equal(await resetInstallationOnce(store,directory,'clean_test_125'),true);
  await assert.rejects(()=>access(join(directory,'backups')));
  await assert.rejects(()=>access(join(directory,'cloud-connection.json')));
  await store.transaction(()=>store.companies.set('new-customer',{id:'new-customer',code:'co2020'}));
  assert.equal(await resetInstallationOnce(store,directory,'clean_test_125'),false);
  assert.equal(store.companies.size,1);
 } finally {await store.close();await rm(directory,{recursive:true,force:true});}
});
