const SCALE = 1_000_000n;

export function decimal(value, { positive = false, nonNegative = false } = {}) {
  const text = String(value ?? '').trim();
  if (!/^-?\d+(\.\d{1,6})?$/.test(text)) throw new Error('INVALID_DECIMAL');
  const negative = text.startsWith('-');
  const [whole, fraction = ''] = text.replace('-', '').split('.');
  const scaled = BigInt(whole) * SCALE + BigInt(fraction.padEnd(6, '0'));
  const result = negative ? -scaled : scaled;
  if (positive && result <= 0n) throw new Error('DECIMAL_NOT_POSITIVE');
  if (nonNegative && result < 0n) throw new Error('DECIMAL_NEGATIVE');
  return result;
}

export function decimalString(value) {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / SCALE;
  const fraction = String(absolute % SCALE).padStart(6, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

export function multiply(left, right) {
  return (left * right + SCALE / 2n) / SCALE;
}

export function divide(left, right) {
  if (right === 0n) throw new Error('DIVIDE_BY_ZERO');
  return (left * SCALE + right / 2n) / right;
}

export const ZERO = 0n;

