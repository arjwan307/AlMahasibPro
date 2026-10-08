import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../apps/api/src/store/memory-store.js';

function fixture() {
  const store = new MemoryStore();
  const company = { id:'company-a', currency:'IQD' };
  const user = { id:'accountant-a' };
  const context = { company, user };
  return {store,context};
}
function journal(overrides={}) {
  return {operationId:'op-1',entryNumber:'JV-001',occurredAt:'2026-10-08T09:00:00.000Z',currency:'IQD',description:'Test',
    lines:[{accountCode:'1000-CASH',debit:'150000',credit:'0'},{accountCode:'6100-PAYROLL-EXPENSE',debit:'0',credit:'150000'}],...overrides};
}

test('balanced manual journal posts and affects trial balance',async()=>{
  const {store,context}=fixture();
  const posted=await store.postManualJournal(context,journal());
  assert.equal(posted.status,'posted');
  const rows=store.trialBalance(context.company.id);
  assert.equal(rows.find(x=>x.accountCode==='1000-CASH').debit,'150000.000000');
  assert.equal(rows.find(x=>x.accountCode==='6100-PAYROLL-EXPENSE').credit,'150000.000000');
  assert.equal(rows.reduce((n,x)=>n+Number(x.debit),0),rows.reduce((n,x)=>n+Number(x.credit),0));
});
test('unbalanced journal rejected without persistence',async()=>{
  const {store,context}=fixture();
  await assert.rejects(store.postManualJournal(context,journal({lines:[{accountCode:'1000-CASH',debit:'150',credit:'0'},{accountCode:'1010-BANK',debit:'0',credit:'149'}]})),{code:'UNBALANCED_JOURNAL'});
  assert.equal(store.journalEntries.size,0);
});
test('duplicate operation id is idempotent',async()=>{
  const {store,context}=fixture();
  const first=await store.postManualJournal(context,journal());
  const second=await store.postManualJournal(context,journal());
  assert.equal(first.id,second.id);
  assert.equal(store.journalEntries.size,1);
});
test('reusing a journal operation id with different lines is rejected',async()=>{
  const {store,context}=fixture();
  await store.postManualJournal(context,journal());
  await assert.rejects(store.postManualJournal(context,journal({lines:[
    {accountCode:'1000-CASH',debit:'100',credit:'0'},
    {accountCode:'6100-PAYROLL-EXPENSE',debit:'0',credit:'100'}
  ]})),{code:'OPERATION_ID_REUSED'});
  assert.equal(store.journalEntries.size,1);
});
test('duplicate entry number with different operation is rejected',async()=>{
  const {store,context}=fixture();
  await store.postManualJournal(context,journal());
  await assert.rejects(store.postManualJournal(context,journal({operationId:'op-2'})),{code:'ENTRY_NUMBER_EXISTS'});
});
test('cross-company reversal is rejected',async()=>{
  const {store,context}=fixture();
  const original=await store.postManualJournal(context,journal());
  await assert.rejects(store.reverseJournal({company:{id:'company-b',currency:'IQD'},user:{id:'other'}},original.id,{operationId:'reverse-1',entryNumber:'REV-001',occurredAt:'2026-10-08T10:00:00.000Z'}),{code:'JOURNAL_NOT_FOUND'});
});
test('reversal balances the original and cannot be repeated',async()=>{
  const {store,context}=fixture();
  const original=await store.postManualJournal(context,journal());
  const reversed=await store.reverseJournal(context,original.id,{operationId:'reverse-1',entryNumber:'REV-001',occurredAt:'2026-10-08T10:00:00.000Z'});
  const replay=await store.reverseJournal(context,original.id,{operationId:'reverse-1',entryNumber:'REV-001',occurredAt:'2026-10-08T10:00:00.000Z'});
  assert.equal(replay.id,reversed.id);
  assert.equal(reversed.lines[0].credit,'150000.000000');
  assert.equal(store.trialBalance(context.company.id).find(x=>x.accountCode==='1000-CASH').balance,'0.000000');
  await assert.rejects(store.reverseJournal(context,original.id,{operationId:'reverse-2',entryNumber:'REV-002',occurredAt:'2026-10-08T11:00:00.000Z'}),{code:'JOURNAL_ALREADY_REVERSED'});
});
test('compound journal with three lines posts',async()=>{
  const {store,context}=fixture();
  const input=journal({lines:[{accountCode:'1000-CASH',debit:'100',credit:'0'},{accountCode:'1010-BANK',debit:'50',credit:'0'},{accountCode:'4100-SALES',debit:'0',credit:'150'}]});
  const posted=await store.postManualJournal(context,input);
  assert.equal(posted.lines.length,3);
});
