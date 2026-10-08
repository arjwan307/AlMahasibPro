import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateDebtAgreement } from '../../apps/api/src/debt-agreements.js';

const agreement = { id:'agreement-1', originalAmount:'5000', requiredPayment:'4000', waiverAmount:'1000', deadline:'2026-12-31T23:59:59Z' };
const payment = (id, amount='500', postedAt='2026-12-01T10:00:00Z') => ({ operationId:id, agreementId:agreement.id, status:'posted', amount, postedAt });

test('waiver stays pending until all installments are posted', () => {
  const result=evaluateDebtAgreement(agreement,Array.from({length:7},(_,i)=>payment(`p${i}`)),'2026-12-20T00:00:00Z');
  assert.equal(result.eligible,false);
  assert.equal(result.waiverToPost,'0.000000');
  assert.equal(result.remainingBeforeWaiver,'1500.000000');
});

test('payments are deduplicated and unlock one stable waiver posting', () => {
  const rows=Array.from({length:8},(_,i)=>payment(`p${i}`));
  rows.push(payment('p0'));
  const result=evaluateDebtAgreement(agreement,rows,'2026-12-20T00:00:00Z');
  assert.equal(result.paid,'4000.000000');
  assert.equal(result.eligible,true);
  assert.equal(result.waiverToPost,'1000.000000');
  assert.equal(result.outstandingAfterEligibleWaiver,'0.000000');
  assert.equal(result.postingKey,'debt-waiver:agreement-1');
});

test('late installments reduce debt without activating an expired waiver', () => {
  const rows=Array.from({length:7},(_,i)=>payment(`p${i}`));
  rows.push(payment('late','500','2027-01-02T00:00:00Z'));
  const result=evaluateDebtAgreement(agreement,rows,'2027-01-03T00:00:00Z');
  assert.equal(result.paid,'4000.000000');
  assert.equal(result.paidByDeadline,'3500.000000');
  assert.equal(result.expired,true);
  assert.equal(result.waiverToPost,'0.000000');
  assert.equal(result.outstandingAfterEligibleWaiver,'1000.000000');
});

test('unposted and unrelated payments do not count', () => {
  const result=evaluateDebtAgreement(agreement,[{...payment('pending','4000'),status:'pending'},{...payment('other','4000'),agreementId:'other'}],'2027-01-01T00:00:00Z');
  assert.equal(result.paid,'0.000000');
  assert.equal(result.eligible,false);
});

test('invalid agreement totals are rejected', () => {
  assert.throws(()=>evaluateDebtAgreement({...agreement,waiverAmount:'900'},[]),/AGREEMENT_TOTAL_MISMATCH/);
});
