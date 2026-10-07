import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../apps/api/src/store/memory-store.js';

const company={id:'c1',currency:'IQD',usdToIqdRate:'1300.000000'};
const user={id:'u1'};
const context={company,user};

test('manual ERP journal must balance and can be reversed without deleting history', async()=>{
  const store=new MemoryStore();
  store.companies.set(company.id,{...company,status:'active',branches:[]});
  const posted=await store.postManualJournal(context,{operationId:'op-1',entryNumber:'JV-1',currency:'IQD',occurredAt:new Date().toISOString(),description:'opening',lines:[
    {accountCode:'1000-CASH',debit:'100000',credit:'0'},
    {accountCode:'3000-EQUITY',debit:'0',credit:'100000'}
  ]});
  assert.equal(posted.status,'posted');
  const reversed=await store.reverseJournal(context,posted.id,{operationId:'op-2',entryNumber:'JV-2',occurredAt:new Date().toISOString()});
  assert.equal(reversed.lines[0].credit,'100000.000000');
  assert.equal(store.journalEntries.size,2);
});

test('manual ERP journal rejects unbalanced entries', async()=>{
  const store=new MemoryStore();
  store.companies.set(company.id,{...company,status:'active',branches:[]});
  await assert.rejects(()=>store.postManualJournal(context,{operationId:'bad',entryNumber:'BAD',currency:'IQD',occurredAt:new Date().toISOString(),lines:[
    {accountCode:'1000-CASH',debit:'10',credit:'0'},{accountCode:'3000-EQUITY',debit:'0',credit:'9'}
  ]}),/القيد غير متوازن/);
});
