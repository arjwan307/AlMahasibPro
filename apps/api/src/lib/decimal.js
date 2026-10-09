const SCALE = 1_000_000n;

export function normalizeDecimalInput(value) {
  let text = String(value ?? '').trim()
    .replace(/[٠-٩]/g, digit => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, digit => String(digit.charCodeAt(0) - 0x06f0))
    .replace(/[−﹣－]/g, '-')
    .replace(/\u066c/g, '')
    .replace(/\u066b/g, '.')
    .replace(/[\s\u00a0\u202f]/g, '');

  const commas = (text.match(/,/g) || []).length;
  const dots = (text.match(/\./g) || []).length;
  if (commas && dots) {
    const decimalSeparator = text.lastIndexOf(',') > text.lastIndexOf('.') ? ',' : '.';
    const decimalIndex = text.lastIndexOf(decimalSeparator);
    const whole = text.slice(0, decimalIndex).replace(/[.,]/g, '');
    const fraction = text.slice(decimalIndex + 1).replace(/[.,]/g, '');
    text = `${whole || '0'}.${fraction || '0'}`;
  } else if (commas) {
    if (/^-?\d{1,3}(?:,\d{3})+$/.test(text)) text = text.replace(/,/g, '');
    else if (commas === 1) text = text.replace(',', '.');
    else {
      const decimalIndex = text.lastIndexOf(',');
      text = `${text.slice(0, decimalIndex).replace(/,/g, '')}.${text.slice(decimalIndex + 1)}`;
    }
  } else if (dots > 1) {
    if (/^-?\d{1,3}(?:\.\d{3})+$/.test(text)) text = text.replace(/\./g, '');
    else {
      const decimalIndex = text.lastIndexOf('.');
      text = `${text.slice(0, decimalIndex).replace(/\./g, '')}.${text.slice(decimalIndex + 1)}`;
    }
  }

  if (text.startsWith('.')) text = `0${text}`;
  if (text.startsWith('-.')) text = text.replace('-.', '-0.');
  if (text.endsWith('.')) text += '0';
  return text;
}

export function decimal(value, { positive = false, nonNegative = false } = {}) {
  const text = normalizeDecimalInput(value);
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

