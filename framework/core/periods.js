/** Last `n` complete calendar months as 'YYYY-MM', oldest first. */
export function lastMonths(n, now = new Date()) {
  const out = [];
  for (let i = n; i >= 1; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}
