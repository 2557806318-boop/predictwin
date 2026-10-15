/** Exact 18-decimal arithmetic. Monetary inputs must be strings or scaled bigint. */
export const SCALE = 10n ** 18n;
export function units(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value !== 'string' || !/^-?\d+(\.\d{1,18})?$/.test(value)) {
    throw new TypeError('Expected a decimal string with at most 18 fractional digits');
  }
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = value.replace('-', '').split('.');
  const result = BigInt(whole) * SCALE + BigInt(fraction.padEnd(18, '0'));
  return negative ? -result : result;
}
export function decimal(value) {
  const n = BigInt(value);
  const abs = n < 0n ? -n : n;
  const fraction = (abs % SCALE).toString().padStart(18, '0').replace(/0+$/, '');
  return `${n < 0n ? '-' : ''}${abs / SCALE}${fraction ? `.${fraction}` : ''}`;
}
export const ceilDiv = (a, b) => {
  if (a < 0n || b <= 0n) throw new RangeError('Nonnegative numerator and positive denominator required');
  return (a + b - 1n) / b;
};
// Number is used ONLY for dimensionless features/metrics, not monetary settlement.
export const ratio = (a, b) => b === 0n ? 0 : Number(a * 1_000_000n / b) / 1_000_000;
export const json = (value) => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v);
