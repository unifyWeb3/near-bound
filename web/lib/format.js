/**
 * How the console prints numbers and dates.
 */

const UNIT = 1000000000000000000000000n;

/**
 * Format yoctoNEAR as NEAR. Keeps small amounts readable.
 *
 * @param {string|number|bigint} yocto
 */
export function formatNear(yocto) {
  const value = BigInt(yocto ?? 0);
  const whole = value / UNIT;
  const frac = value % UNIT;
  if (frac === 0n) return `${whole} NEAR`;
  const digits = frac.toString().padStart(24, '0').replace(/0+$/, '');
  // Whole NEAR balances clamp to 6 fraction digits so the figure fits a small
  // screen. Sub-NEAR amounts keep 8, which is all they need.
  const cap = whole === 0n ? 8 : 6;
  return `${whole}.${digits.slice(0, cap)} NEAR`;
}

/**
 * Format a count for display.
 *
 * @param {number|string|bigint} value
 */
export function formatCount(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString('en-US') : String(value);
}

/**
 * Seconds since the epoch for a timestamp the contract wrote.
 *
 * Receipts written before the block timestamp fix carry nanoseconds. Values
 * above 10^15 are nanoseconds, values above 10^12 milliseconds, otherwise
 * seconds.
 *
 * @param {string|number|bigint} value
 */
export function timestampSeconds(value) {
  const raw = BigInt(value ?? 0);
  if (raw > 1000000000000000n) return Number(raw / 1000000000n);
  if (raw > 1000000000000n) return Number(raw / 1000n);
  return Number(raw);
}

/**
 * A date and time for a contract timestamp.
 *
 * @param {string|number|bigint} value
 */
export function formatTimestamp(value) {
  return new Date(timestampSeconds(value) * 1000).toLocaleString();
}

/**
 * A day label for a contract timestamp, in the reader's own timezone.
 *
 * @param {string|number|bigint} value
 */
export function dayLabel(value) {
  const date = new Date(timestampSeconds(value) * 1000);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
