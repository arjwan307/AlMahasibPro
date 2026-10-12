/**
 * Pure, read-only general ledger projection. Does not create or alter postings.
 * Date filters are inclusive, account codes are exact, and running balances
 * remain separated by currency to prevent accidental cross-currency netting.
 */
export function projectGeneralLedger(journals, { accountCode, from, to, currency } = {}) {
  if (!accountCode || typeof accountCode !== 'string') throw new Error('ACCOUNT_REQUIRED');
  const code = accountCode.trim().toUpperCase();
  if (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) throw new Error('INVALID_FROM_DATE');
  if (to && !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new Error('INVALID_TO_DATE');
  if (from && to && from > to) throw new Error('INVALID_DATE_RANGE');
  const scale = 1000000n;
  const parse = value => {
    const raw = String(value ?? '0');
    if (!/^\d+(\.\d{1,6})?$/.test(raw)) throw new Error('INVALID_AMOUNT');
    const [whole, fraction = ''] = raw.split('.');
    return BigInt(whole) * scale + BigInt(fraction.padEnd(6, '0'));
  };
  const format = units => (units < 0n ? '-' : '') + String((units < 0n ? -units : units) / scale) + '.' + String((units < 0n ? -units : units) % scale).padStart(6, '0');
  const selected = (journals || []).filter(j => j.status === 'posted').flatMap(j =>
    (j.lines || []).filter(line => String(line.accountCode || line.account || '').trim().toUpperCase() === code).map((line, index) => ({
      journalId: j.id, entryNumber: j.entryNumber, occurredAt: j.occurredAt,
      currency: String(j.currency || '').toUpperCase(), description: j.description || '',
      index, debit: parse(line.debit), credit: parse(line.credit)
    }))
  ).filter(row => !currency || row.currency === currency.toUpperCase())
    .sort((a,b) => a.occurredAt.localeCompare(b.occurredAt) || String(a.journalId).localeCompare(String(b.journalId)) || a.index - b.index);
  const balances = new Map();
  const opening = new Map();
  const entries = [];
  for (const row of selected) {
    const current = (balances.get(row.currency) || 0n) + row.debit - row.credit;
    balances.set(row.currency, current);
    if (from && row.occurredAt.slice(0,10) < from) {
      opening.set(row.currency, current);
      continue;
    }
    if (to && row.occurredAt.slice(0,10) > to) continue;
    entries.push({ journalId: row.journalId, entryNumber: row.entryNumber, occurredAt: row.occurredAt, currency: row.currency, description: row.description, debit: format(row.debit), credit: format(row.credit), balance: format(current) });
  }
  return { accountCode: code, openingBalances: [...opening].map(([currency, amount]) => ({ currency, balance: format(amount) })), entries };
}
