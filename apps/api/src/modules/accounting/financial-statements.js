/**
 * Read-only financial statement projection from a posted trial balance.
 * Keeps currencies separate and refuses unknown account classifications.
 * Values are fixed-point decimals (six fractional digits).
 */
const SCALE = 1000000n;
const parse = value => {
  const raw = String(value ?? '0').trim();
  if (!/^-?\d+(\.\d{1,6})?$/.test(raw)) throw new Error('INVALID_FINANCIAL_AMOUNT');
  const negative = raw.startsWith('-');
  const [whole, fraction = ''] = (negative ? raw.slice(1) : raw).split('.');
  const units = BigInt(whole) * SCALE + BigInt(fraction.padEnd(6, '0'));
  return negative ? -units : units;
};
const display = amount => {
  const negative = amount < 0n;
  const positive = negative ? -amount : amount;
  return (negative ? '-' : '') + String(positive / SCALE) + '.' + String(positive % SCALE).padStart(6, '0');
};
const types = new Set(['asset','liability','equity','revenue','expense','contra_revenue']);
export function projectFinancialStatements(rows, { currency } = {}) {
  if (!Array.isArray(rows)) throw new Error('TRIAL_BALANCE_REQUIRED');
  const buckets = new Map();
  let debit = 0n, credit = 0n;
  for (const row of rows) {
    const type = String(row.type || '').toLowerCase();
    if (!types.has(type)) throw new Error('UNCLASSIFIED_ACCOUNT:' + String(row.accountCode || row.code || ''));
    const rowCurrency = String(row.currency || currency || '').toUpperCase();
    if (!/^[A-Z]{3}$/.test(rowCurrency)) throw new Error('INVALID_CURRENCY');
    const dr = parse(row.debit), cr = parse(row.credit);
    if (dr < 0n || cr < 0n) throw new Error('NEGATIVE_TURNOVER');
    if (!buckets.has(rowCurrency)) buckets.set(rowCurrency, { debit: 0n, credit: 0n, asset: 0n, liability: 0n, equity: 0n, revenue: 0n, expense: 0n, contra_revenue: 0n });
    const b = buckets.get(rowCurrency);
    b.debit += dr; b.credit += cr;
    b[type] += (type === 'asset' || type === 'expense' || type === 'contra_revenue') ? dr - cr : cr - dr;
    debit += dr; credit += cr;
  }
  const result = [];
  for (const [code,b] of buckets) {
    if (b.debit !== b.credit) throw new Error('UNBALANCED_TRIAL_BALANCE:' + code);
    const netRevenue = b.revenue - b.contra_revenue;
    const profit = netRevenue - b.expense;
    const balanceDifference = b.asset - b.liability - b.equity - profit;
    if (balanceDifference !== 0n) throw new Error('BALANCE_SHEET_MISMATCH:' + code);
    result.push({ currency: code, trialBalance: { debit: display(b.debit), credit: display(b.credit) }, profitAndLoss: { revenue: display(netRevenue), expenses: display(b.expense), netProfit: display(profit) }, balanceSheet: { assets: display(b.asset), liabilities: display(b.liability), equity: display(b.equity), currentProfit: display(profit), difference: display(balanceDifference) } });
  }
  return result;
}
