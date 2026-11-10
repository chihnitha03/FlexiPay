// DEMO ONLY — deterministic synthetic usage data for the mock merchants.

import { lastMonths } from '../framework/core/periods.js';

export function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export { lastMonths };

/** Generate a usage history: base level, linear trend per month, noise ratio, optional seasonality. */
export function makeHistory({ months, base, trend = 0, noise = 0.15, seasonal = null, seed = 1 }) {
  const rand = mulberry32(seed);
  return lastMonths(months).map((period, i) => {
    const m = Number(period.slice(5, 7));
    const s = seasonal ? seasonal[m - 1] : 1;
    const q = Math.max(0, (base + trend * i) * s * (1 + (rand() * 2 - 1) * noise));
    return { period, quantity: Math.round(q * 10) / 10 };
  });
}

/**
 * Synthetic anonymized cohort: a mixture of usage segments, each with a plan distribution.
 * segments: [{ share, median, spread, plans: { planId: weight } }]
 */
export function makeCohort({ size, segments, seed = 7 }) {
  const rand = mulberry32(seed);
  const pick = (weights) => {
    const total = Object.values(weights).reduce((a, b) => a + b, 0);
    let x = rand() * total;
    for (const [k, w] of Object.entries(weights)) if ((x -= w) <= 0) return k;
    return Object.keys(weights)[0];
  };
  const rows = [];
  for (const seg of segments) {
    const n = Math.round(size * seg.share);
    for (let i = 0; i < n; i++) {
      // log-normal-ish spread around the segment median
      const z = (rand() + rand() + rand() - 1.5) * 2;
      rows.push({ current_plan_id: pick(seg.plans), avg_monthly_usage: Math.round(seg.median * Math.exp(seg.spread * z) * 10) / 10 });
    }
  }
  return rows;
}
