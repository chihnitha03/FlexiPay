// All pricing math is done in integer minor units (cents) to avoid floating point drift.

export const toCents = (amount) => Math.round(Number(amount || 0) * 100);
export const fromCents = (cents) => Math.round(cents) / 100;
export const round2 = (n) => Math.round(n * 100) / 100;

export function formatMoney(amount, currency = 'USD') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
}
