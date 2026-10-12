import test from 'node:test';
import assert from 'node:assert/strict';
import { projectFinancialStatements } from '../apps/api/src/modules/accounting/financial-statements.js';

test('financial statements reconcile posted trial balance and net profit', () => {
  const rows = [
    { accountCode: 'CASH', type: 'asset', currency: 'IQD', debit: '150', credit: '0' },
    { accountCode: 'EQUITY', type: 'equity', currency: 'IQD', debit: '0', credit: '100' },
    { accountCode: 'SALES', type: 'revenue', currency: 'IQD', debit: '0', credit: '80' },
    { accountCode: 'EXPENSE', type: 'expense', currency: 'IQD', debit: '30', credit: '0' }
  ];
  const [result] = projectFinancialStatements(rows);
  assert.equal(result.profitAndLoss.netProfit, '50.000000');
  assert.equal(result.balanceSheet.difference, '0.000000');
});
test('financial statements refuse unknown accounts and unbalanced ledgers', () => {
  assert.throws(() => projectFinancialStatements([{ type: 'unknown', currency: 'IQD', debit: '1', credit: '1' }]), /UNCLASSIFIED_ACCOUNT/);
  assert.throws(() => projectFinancialStatements([{ type: 'asset', currency: 'IQD', debit: '1', credit: '0' }]), /UNBALANCED_TRIAL_BALANCE/);
});
