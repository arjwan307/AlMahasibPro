import test from 'node:test';
import assert from 'node:assert/strict';
import { projectGeneralLedger } from '../apps/api/src/modules/accounting/general-ledger.js';
test('general ledger keeps opening and running balances in account currency', () => {
 const journals = [
  { id:'1',status:'posted',currency:'IQD',entryNumber:'1',occurredAt:'2026-01-01T00:00:00Z',lines:[{accountCode:'CASH',debit:'100',credit:'0'}] },
  { id:'2',status:'posted',currency:'IQD',entryNumber:'2',occurredAt:'2026-02-01T00:00:00Z',lines:[{accountCode:'CASH',debit:'0',credit:'25'}] },
  { id:'3',status:'draft',currency:'IQD',entryNumber:'3',occurredAt:'2026-02-02T00:00:00Z',lines:[{accountCode:'CASH',debit:'999',credit:'0'}] }
 ];
 const result=projectGeneralLedger(journals,{accountCode:'CASH',from:'2026-02-01',to:'2026-02-28'});
 assert.equal(result.openingBalances[0].balance,'100.000000');
 assert.equal(result.entries.length,1);
 assert.equal(result.entries[0].balance,'75.000000');
});
