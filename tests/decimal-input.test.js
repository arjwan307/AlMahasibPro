import assert from 'node:assert/strict';
import test from 'node:test';
import { decimal, decimalString, normalizeDecimalInput } from '../apps/api/src/lib/decimal.js';

test('accepts English decimal points and Arabic-Indic digits', () => {
  assert.equal(normalizeDecimalInput('500.00'), '500.00');
  assert.equal(decimalString(decimal('٥٠٠.٠٠')), '500.000000');
  assert.equal(decimalString(decimal('۵۰۰٫۰۰')), '500.000000');
});

test('accepts comma decimals and common grouped number formats', () => {
  assert.equal(decimalString(decimal('500,00')), '500.000000');
  assert.equal(decimalString(decimal('1,234.50')), '1234.500000');
  assert.equal(decimalString(decimal('1.234,50')), '1234.500000');
  assert.equal(decimalString(decimal('١٬٢٣٤٫٥٠')), '1234.500000');
});

test('keeps decimal validation and range checks after normalization', () => {
  assert.throws(() => decimal('12,3456789'), /INVALID_DECIMAL/);
  assert.throws(() => decimal('-٥', { nonNegative: true }), /DECIMAL_NEGATIVE/);
  assert.throws(() => decimal('٠', { positive: true }), /DECIMAL_NOT_POSITIVE/);
});
