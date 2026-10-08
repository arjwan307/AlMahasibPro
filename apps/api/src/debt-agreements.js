import { decimal, decimalString } from './lib/decimal.js';

/**
 * Pure, deterministic conditional-debt settlement evaluator.
 * Payment posting remains the responsibility of the accounting ledger.
 * Never post a waiver unless eligible === true, and post it once using
 * the agreement id as an idempotency key in the ledger.
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
    if (!payment || typeof payment.operationId !== 'string' || !payment.operationId.trim()) throw new Error('PAYMENT_ID_REQUIRED');
    if (seen.has(payment.operationId)) continue;
    seen.add(payment.operationId);
    if (payment.status !== 'posted' || payment.agreementId !== agreement.id) continue;
    const amount = decimal(payment.amount, { positive: true });
    const date = Date.parse(payment.postedAt);
    if (!Number.isFinite(date)) throw new Error('INVALID_PAYMENT_DATE');
    if (date > now) continue;
    paid += amount;
    if (date <= deadline) paidByDeadline += amount;
  }
  const eligible = paidByDeadline >= required && now >= 0;
  const expired = now > deadline && !eligible;
  return {
    agreementId: agreement.id,
    eligible,
    expired,
    waiverToPost: decimalString(eligible ? waiver : 0n),
    paid: decimalString(paid),
    paidByDeadline: decimalString(paidByDeadline),
    remainingBeforeWaiver: decimalString(original > paid ? original - paid : 0n),
    outstandingAfterEligibleWaiver: decimalString(original > paid + (eligible ? waiver : 0n) ? original - paid - (eligible ? waiver : 0n) : 0n),
    postingKey: eligible ? 'debt-waiver:' + agreement.id : null,
  };
}
