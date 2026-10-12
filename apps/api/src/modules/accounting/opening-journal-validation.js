/**
 * Opening journal preflight. Pure and read-only: posting must still pass the
 * existing accounting authorization, period lock and transaction checks.
 * Amounts are integer minor units (six decimal places), never binary floats.
 */
export function validateOpeningJournal(input, { accountCodes = [], existingOpeningPeriods = [] } = {}) {
  const errors = [];
  const period = String(input?.period || '').trim();
  if (!/^\d{4}$/.test(period)) errors.push('INVALID_OPENING_PERIOD');
  if (existingOpeningPeriods.includes(period)) errors.push('OPENING_PERIOD_EXISTS');
  const currency = String(input?.currency || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) errors.push('INVALID_CURRENCY');
  const accounts = new Set(accountCodes.map(code => String(code).trim().toUpperCase()));
  const lines = Array.isArray(input?.lines) ? input.lines : [];
  if (lines.length < 2 || lines.length > 500) errors.push('INVALID_LINE_COUNT');
  const amount = value => {
    const raw = String(value ?? '0').trim();
    if (!/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(raw)) return null;
    const [whole, fraction = ''] = raw.split('.');
    return BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'));
  };
  let debit = 0n, credit = 0n;
  for (const [index, line] of lines.entries()) {
    const code = String(line?.accountCode || '').trim().toUpperCase();
    if (!code || !accounts.has(code)) errors.push(`UNKNOWN_ACCOUNT:${index}`);
    const dr = amount(line?.debit), cr = amount(line?.credit);
    if (dr === null || cr === null || (dr > 0n) === (cr > 0n)) {
      errors.push(`INVALID_LINE:${index}`);
      continue;
    }
    debit += dr;
    credit += cr;
  }
  if (debit !== credit || debit === 0n) errors.push('UNBALANCED_OPENING_JOURNAL');
  const format = units => `${units / 1000000n}.${String(units % 1000000n).padStart(6, '0')}`;
  return { valid: errors.length === 0, errors, debit: format(debit), credit: format(credit), difference: (debit - credit).toString() };
}
