import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEnterpriseLocal } from '../../apps/local/enterprise-server.js';
import { SQLiteStore } from '../../apps/api/src/store/sqlite-store.js';

test('company-owned SQLite installation persists accounting, stock, users and backups after restart', async () => {
 const directory=await mkdtemp(join(tmpdir(),'enterprise-test-'));
 let runtime;
 let cookie='';
 try {
  runtime=await startEnterpriseLocal({dataDirectory:directory,port:33219});
  async function request(path,body){const response=await fetch(runtime.url+path,{headers:{...(body?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{})},...(body?{method:'POST',body:JSON.stringify(body)}:{})});if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];const data=await response.json();return {status:response.status,data};}
  async function create(path,body){const result=await request(path,body);assert.equal(result.status,201,JSON.stringify(result.data));return result.data;}
  const owner={legalName:'شركة الأثاث',ownerName:'المدير',username:'company_admin',password:'Strong-Offline-123'};
  await create('/api/local/setup',owner);
  assert.equal(runtime.store.users.size,1,'no developer or hidden platform account');
  assert.equal((await request('/api/local/setup',owner)).status,409);
  assert.equal((await request('/api/v1/auth/login',{companyCode:'local',username:owner.username,password:owner.password})).status,200);
  const unit=(await create('/api/v1/catalog/units',{code:'PC',name:'قطعة'})).unit;
  const source=(await create('/api/v1/warehouses',{code:'MAIN',name:'الرئيسي'})).warehouse;
  const target=(await create('/api/v1/warehouses',{code:'BRANCH',name:'الفرع'})).warehouse;
  const item=(await create('/api/v1/catalog/items',{sku:'ITEM-001',name:'كرسي',baseUnitId:unit.id})).item;
  const customer=(await create('/api/v1/customers',{code:'C001',name:'عميل',creditLimit:'100000'})).customer;
  const commit=async document=>create('/api/v1/commerce/commit',{operationId:crypto.randomUUID(),deviceId:'desktop',clientSequence:Date.now(),occurredAt:new Date().toISOString(),document});
  await commit({documentType:'purchase',documentNumber:'P1',warehouseId:source.id,currency:'IQD',lines:[{itemId:item.id,unitId:unit.id,quantity:'10',unitPrice:'100'}],payments:[]});
  await commit({documentType:'sale',documentNumber:'S1',warehouseId:source.id,partyId:customer.id,currency:'IQD',lines:[{itemId:item.id,unitId:unit.id,quantity:'2',unitPrice:'150'}],payments:[]});
  const document=[...runtime.store.commerceDocuments.values()].find(row=>row.documentNumber==='S1');
  const settlement={operationId:crypto.randomUUID(),documentId:document.id,amount:'100',receiptNumber:'PAY1',method:'cash'};
  await create('/api/v1/enterprise/settlements',settlement);await create('/api/v1/enterprise/settlements',settlement);
  assert.equal((await request('/api/v1/enterprise/settlements',{...settlement,operationId:crypto.randomUUID(),amount:'250'})).status,409);
  await create('/api/v1/enterprise/transfers',{operationId:crypto.randomUUID(),sourceWarehouseId:source.id,destinationWarehouseId:target.id,transferNumber:'T1',lines:[{itemId:item.id,quantity:'3'}]});
  const failed=await request('/api/v1/enterprise/transfers',{operationId:crypto.randomUUID(),sourceWarehouseId:source.id,destinationWarehouseId:target.id,transferNumber:'T2',lines:[{itemId:item.id,quantity:'1'},{itemId:item.id,quantity:'999'}]});assert.equal(failed.status,409);
  assert.equal(runtime.store.stockBalances.get(`local:${source.id}:${item.id}`),undefined);
  const stock=[...runtime.store.stockBalances.values()].find(row=>row.warehouseId===source.id);assert.equal(stock.quantity,'5.000000');
  const snapshot=await runtime.store.exportBackup();assert.equal(snapshot.subarray(0,15).toString(),'SQLite format 3');
  const backupFile=join(directory,'backup.sqlite');await writeFile(backupFile,snapshot);
  const restored=new SQLiteStore(backupFile);assert.equal(restored.commerceDocuments.size,2);await restored.close();
  await runtime.close();runtime=await startEnterpriseLocal({dataDirectory:directory,port:33219});
  assert.equal(runtime.store.commerceDocuments.size,2);assert.equal(runtime.store.stockTransfers.size,1);
  assert.equal((await request('/api/v1/master-data')).status,200,'session survives restart');
  for(const journal of runtime.store.journalEntries.values()){const amount=value=>BigInt(value.replace('.',''));assert.equal(journal.lines.reduce((s,x)=>s+amount(x.debit)-amount(x.credit),0n),0n);}
 } finally {if(runtime)await runtime.close();await rm(directory,{recursive:true,force:true});}
});
