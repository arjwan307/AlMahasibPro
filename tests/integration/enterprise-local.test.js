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
  await commit({documentType:'purchase',documentNumber:'P1',warehouseId:source.id,currency:'IQD',lines:[{itemId:item.id,unitId:unit.id,quantity:'10',unitPrice:'100'}],payments:[{method:'cash',amount:'1000'}]});
  await commit({documentType:'sale',documentNumber:'S1',warehouseId:source.id,partyId:customer.id,currency:'IQD',lines:[{itemId:item.id,unitId:unit.id,quantity:'2',unitPrice:'150'}],payments:[]});
  const document=[...runtime.store.commerceDocuments.values()].find(row=>row.documentNumber==='S1');
  const settlement={operationId:crypto.randomUUID(),documentId:document.id,amount:'100',receiptNumber:'PAY1',method:'cash'};
  await create('/api/v1/enterprise/settlements',settlement);await create('/api/v1/enterprise/settlements',settlement);
  assert.equal((await request('/api/v1/enterprise/settlements',{...settlement,amount:'101'})).status,409,'same settlement operation cannot change its amount');
  const overpaymentInput={...settlement,operationId:crypto.randomUUID(),receiptNumber:'PAY2',amount:'250'};
  const overpayment=await create('/api/v1/enterprise/settlements',overpaymentInput);
  assert.equal((await create('/api/v1/enterprise/settlements',overpaymentInput)).settlement.id,overpayment.settlement.id,'overpayment retry is idempotent');
  assert.equal(overpayment.settlement.amount,'200.000000');
  assert.equal(overpayment.settlement.unappliedAmount,'50.000000');
  assert.equal(overpayment.settlement.totalDocumentAmount,'250.000000');
  const overJournal=[...runtime.store.journalEntries.values()].find(x=>x.entryNumber==='PAY2');
  assert.equal(overJournal.lines.find(x=>x.accountCode==='2205-CUSTOMER-CREDITS').credit,'50.000000');
  const trial=await runtime.store.trialBalance(overJournal.companyId);
  assert.equal(trial.find(x=>x.accountCode==='2205-CUSTOMER-CREDITS'&&x.currency==='IQD').credit,'50.000000',JSON.stringify(trial.filter(x=>x.accountCode==='2205-CUSTOMER-CREDITS')));
  await create('/api/v1/commerce/commit',{operationId:crypto.randomUUID(),deviceId:'desktop',clientSequence:3,occurredAt:new Date().toISOString(),document:{documentType:'sale',documentNumber:'S2',warehouseId:source.id,partyId:customer.id,currency:'IQD',lines:[{itemId:item.id,unitId:unit.id,quantity:'1',unitPrice:'100'}],payments:[]}});
  const secondSale=[...runtime.store.commerceDocuments.values()].find(row=>row.documentNumber==='S2');
  const creditInput={operationId:crypto.randomUUID(),documentId:secondSale.id,amount:'50',receiptNumber:'CREDIT-1'};
  const applied=await create('/api/v1/enterprise/customer-credits/apply',creditInput);
  assert.equal(applied.application.amount,'50.000000');
  assert.equal((await create('/api/v1/enterprise/customer-credits/apply',creditInput)).application.id,applied.application.id,'customer credit application retry is idempotent');
  assert.equal((await request('/api/v1/enterprise/customer-credits/apply',{...creditInput,operationId:crypto.randomUUID(),receiptNumber:'CREDIT-2'})).status,409,'credit cannot be applied twice');
  const journalInput={operationId:crypto.randomUUID(),entryNumber:'MANUAL-1',occurredAt:new Date().toISOString(),description:'اختبار قيد يدوي',lines:[
   {accountCode:'1000-CASH',debit:'125',credit:'0'},
   {accountCode:'3000-EQUITY',debit:'0',credit:'125'}
  ]};
  const manualJournal=await create('/api/v1/accounting/journals',journalInput);
  assert.equal((await create('/api/v1/accounting/journals',journalInput)).journal.id,manualJournal.journal.id);
  assert.equal((await request('/api/v1/accounting/journals',{...journalInput,operationId:crypto.randomUUID(),entryNumber:'BAD-1',lines:[
   {accountCode:'1000-CASH',debit:'125',credit:'0'},
   {accountCode:'3000-EQUITY',debit:'0',credit:'124'}
  ]})).status,400);
  await create('/api/v1/enterprise/transfers',{operationId:crypto.randomUUID(),sourceWarehouseId:source.id,destinationWarehouseId:target.id,transferNumber:'T1',lines:[{itemId:item.id,quantity:'3'}]});
  const failed=await request('/api/v1/enterprise/transfers',{operationId:crypto.randomUUID(),sourceWarehouseId:source.id,destinationWarehouseId:target.id,transferNumber:'T2',lines:[{itemId:item.id,quantity:'1'},{itemId:item.id,quantity:'999'}]});assert.equal(failed.status,409);
  assert.equal(runtime.store.stockBalances.get(`local:${source.id}:${item.id}`),undefined);
  const stock=[...runtime.store.stockBalances.values()].find(row=>row.warehouseId===source.id);assert.equal(stock.quantity,'4.000000');
  const snapshot=await runtime.store.exportBackup();assert.equal(snapshot.subarray(0,15).toString(),'SQLite format 3');
  const backupFile=join(directory,'backup.sqlite');await writeFile(backupFile,snapshot);
  const restored=new SQLiteStore(backupFile);assert.equal(restored.commerceDocuments.size,3);await restored.close();
  await runtime.close();runtime=await startEnterpriseLocal({dataDirectory:directory,port:33219});
  assert.equal(runtime.store.commerceDocuments.size,3);assert.equal(runtime.store.stockTransfers.size,1);
  assert.ok([...runtime.store.journalEntries.values()].some(row=>row.entryNumber==='MANUAL-1'));
  assert.equal((await request('/api/v1/master-data')).status,200,'session survives restart');
  for(const journal of runtime.store.journalEntries.values()){const amount=value=>BigInt(value.replace('.',''));assert.equal(journal.lines.reduce((s,x)=>s+amount(x.debit)-amount(x.credit),0n),0n);}
 } finally {if(runtime)await runtime.close();await rm(directory,{recursive:true,force:true});}
});
