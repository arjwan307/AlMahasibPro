import test from 'node:test';
import assert from 'node:assert/strict';
import { validateOpeningJournal } from '../apps/api/src/modules/accounting/opening-journal-validation.js';

const opts = { accountCodes: ['CASH', 'EQUITY'], existingOpeningPeriods: [] };
const balanced = { period: '2026', currency: 'IQD', lines: [
  { accountCode: 'CASH', debit: '25000000.000', credit: '0' },
  { accountCode: 'EQUITY', debit: '0', credit: '25000000.000' }
] };
test('opening journal validates balanced double entry without floating point', () => {
  const result = validateOpeningJournal(balanced, opts);
  assert.equal(result.valid, true);
  assert.equal(result.debit, '25000000.000');
});
test('opening journal rejects imbalance, unknown accounts and duplicate period', () => {
  const input = structuredClone(balanced);
  input.lines[1].credit = '24999999.999';
  input.lines[1].accountCode = 'UNKNOWN';
  const result = validateOpeningJournal(input, { ...opts, existingOpeningPeriods: ['2026'] });
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes('UNBALANCED_OPENING_JOURNAL'));
  assert.ok(result.errors.includes('OPENING_PERIOD_EXISTS'));
  assert.ok(result.errors.includes('UNKNOWN_ACCOUNT:1'));
});
test('opening journal rejects invalid decimal precision and zero-only entries', () => {
  const input = structuredClone(balanced);
  input.lines[0].debit = '0.0001';
  assert.equal(validateOpeningJournal(input, opts).valid, false);
});
