import { decimal, decimalString } from './lib/decimal.js';

/**
 * Evaluate a conditional debt agreement without mutating the ledger.
 * Payments are deduplicated by operationId. The returned postingKey must be
 * used by the ledger as its idempotency key when the waiver is posted.
 */
export function evaluateDebtAgreement(agreement, payments, asOf = new Date().toISOString()) {
  if (!agreement || !Array.isArray(payments)) throw new TypeError('INVALID_AGREEMENT');
  const original = decimal(agreement.originalAmount, { positive: true });
  const required = decimal(agreement.requiredPayment, { positive: true });
  const waiver = decimal(agreement.waiverAmount, { nonNegative: true });
  if (required + waiver !== original) throw new Error('AGREEMENT_TOTAL_MISMATCH');
  const deadline = Date.parse(agreement.deadline);
  const now = Date.parse(asOf);
  if (!Number.isFinite(deadline) || !Number.isFinite(now)) throw new Error('INVALID_DATE');

  const seen = new Set();
  let paid = 0n;
  let paidByDeadline = 0n;
  for (const payment of payments) {
    if (!payment || typeof payment.operationId !== 'string' || !payment.operationId.trim()) {
      throw new Error('PAYMENT_ID_REQUIRED');
    }
    if (seen.has(payment.operationId)) continue;
    seen.add(payment.operationId);
    if (payment.status !== 'posted' || payment.agreementId !== agreement.id) continue;
    const amount = decimal(payment.amount, { positive: true });
    const postedAt = Date.parse(payment.postedAt);
    if (!Number.isFinite(postedAt)) throw new Error('INVALID_PAYMENT_DATE');
    if (postedAt > now) continue;
    paid += amount;
    if (postedAt <= deadline) paidByDeadline += amount;
  }

  const eligible = paidByDeadline >= required;
  const expired = now > deadline && !eligible;
  const appliedWaiver = eligible ? waiver : 0n;
  return {
    agreementId: agreement.id,
    eligible,
    expired,
    waiverToPost: decimalString(appliedWaiver),
    paid: decimalString(paid),
    paidByDeadline: decimalString(paidByDeadline),
    remainingBeforeWaiver: decimalString(original > paid ? original - paid : 0n),
    outstandingAfterEligibleWaiver: decimalString(original > paid + appliedWaiver ? original - paid - appliedWaiver : 0n),
    postingKey: eligible ? `debt-waiver:${agreement.id}` : null,
  };
}
