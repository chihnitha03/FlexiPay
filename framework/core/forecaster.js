// Usage forecasting component (PRD §4.3).
// Input priority: (1) authorized historical usage, (2) customer-provided estimate,
// (3) merchant-configured default scenario. Always returns a low/expected/high range.

import { normalizeUsageHistory } from './models.js';

const Z80 = 1.2816; // two-sided 80% interval
const DEFAULT_CV = 0.35; // assumed variability when there is not enough history

/** Holt's linear trend with damping. Returns { level, trend, residualStd }. */
function holtDamped(values, alpha = 0.5, beta = 0.2, phi = 0.85) {
  let level = values[0];
  let trend = values.length > 1 ? (values[1] - values[0]) / 2 : 0;
  const errors = [];
  for (let i = 1; i < values.length; i++) {
    const predicted = level + phi * trend;
    errors.push(values[i] - predicted);
    const prevLevel = level;
    level = alpha * values[i] + (1 - alpha) * predicted;
    trend = beta * (level - prevLevel) + (1 - beta) * phi * trend;
  }
  const residualStd = errors.length >= 2 ? Math.sqrt(errors.reduce((s, e) => s + e * e, 0) / (errors.length - 1)) : null;
  return { level, trend, phi, residualStd };
}

/** Multiplicative calendar-month seasonal indices (requires >= 12 months). Damped toward 1. */
function seasonalIndices(history) {
  if (history.length < 12) return null;
  const mean = history.reduce((s, h) => s + h.quantity, 0) / history.length;
  if (mean <= 0) return null;
  const buckets = Array.from({ length: 12 }, () => []);
  history.forEach((h) => buckets[Number(h.period.slice(5, 7)) - 1].push(h.quantity / mean));
  return buckets.map((b) => (b.length ? 1 + 0.5 * (b.reduce((s, x) => s + x, 0) / b.length - 1) : 1));
}

function nextPeriods(lastPeriod, n) {
  let [y, m] = lastPeriod ? lastPeriod.split('-').map(Number) : [new Date().getUTCFullYear(), new Date().getUTCMonth()];
  const out = [];
  for (let i = 0; i < n; i++) {
    m += 1;
    if (m > 12) { m = 1; y += 1; }
    out.push(`${y}-${String(m).padStart(2, '0')}`);
  }
  return out;
}

const r1 = (n) => Math.round(Math.max(0, n) * 10) / 10;
const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);

/**
 * @param {object} input
 * @param {{period:string, quantity:number}[]} [input.history]
 * @param {number} [input.customerEstimate] monthly usage the customer expects
 * @param {number} [input.defaultUsage] merchant default scenario
 * @param {number} [input.horizonMonths=12]
 */
export function forecastUsage({ history = [], customerEstimate, defaultUsage = 10, horizonMonths = 12 } = {}) {
  const hist = normalizeUsageHistory(history);
  const values = hist.map((h) => h.quantity);
  const periods = nextPeriods(hist.at(-1)?.period, horizonMonths);
  const notes = [];
  let historyForecast = null;

  if (values.length >= 2) {
    const { level, trend, phi, residualStd } = holtDamped(values);
    const seasonal = seasonalIndices(hist);
    const cv = mean(values) > 0 ? stdDev(values) / mean(values) : DEFAULT_CV;
    const sigma = residualStd ?? Math.max(1, mean(values) * DEFAULT_CV);
    const expected = [];
    const low = [];
    const high = [];
    let dampSum = 0;
    for (let h = 1; h <= horizonMonths; h++) {
      dampSum += phi ** h;
      const s = seasonal ? seasonal[Number(periods[h - 1].slice(5, 7)) - 1] : 1;
      const point = Math.max(0, (level + dampSum * trend) * s);
      const spread = Z80 * sigma * Math.sqrt(1 + 0.15 * (h - 1));
      expected.push(r1(point));
      low.push(r1(point - spread));
      high.push(r1(point + spread));
    }
    const recentTrend = trend / Math.max(1, mean(values));
    historyForecast = {
      expected, low, high,
      months_of_history: values.length,
      historical_average: r1(mean(values)),
      historical_min: r1(Math.min(...values)),
      historical_max: r1(Math.max(...values)),
      coefficient_of_variation: Math.round(cv * 100) / 100,
      trend: Math.abs(recentTrend) < 0.03 ? 'stable' : recentTrend > 0 ? 'increasing' : 'decreasing',
      seasonality_applied: Boolean(seasonal),
      confidence: values.length >= 6 && cv < 0.3 ? 'high' : values.length >= 4 && cv < 0.6 ? 'medium' : 'low',
    };
  } else if (values.length === 1) {
    notes.push('Only one month of history is available; treated as a single data point.');
  }

  let source;
  let series;
  let confidence;
  if (customerEstimate != null && Number.isFinite(Number(customerEstimate))) {
    source = 'customer_estimate';
    const est = Math.max(0, Number(customerEstimate));
    const cv = historyForecast ? Math.max(0.15, historyForecast.coefficient_of_variation) : DEFAULT_CV;
    series = flatScenario(est, cv, horizonMonths);
    confidence = historyForecast ? 'medium' : 'low';
    notes.push('Based on the usage you entered' + (historyForecast ? '; the range reflects how much your past usage varied.' : '.'));
  } else if (historyForecast) {
    source = 'history';
    series = { expected: historyForecast.expected, low: historyForecast.low, high: historyForecast.high };
    confidence = historyForecast.confidence;
    notes.push(`Forecast from ${historyForecast.months_of_history} months of your usage history (trend: ${historyForecast.trend}).`);
  } else {
    source = 'merchant_default';
    const est = values[0] ?? defaultUsage;
    series = flatScenario(est, DEFAULT_CV, horizonMonths);
    confidence = 'low';
    notes.push('No usage history available — showing a typical-customer scenario. Enter your own estimate for a better comparison.');
  }

  return {
    source,
    periods,
    horizon_months: horizonMonths,
    expected: series.expected,
    low: series.low,
    high: series.high,
    summary: {
      expected_monthly: r1(mean(series.expected)),
      low_monthly: r1(mean(series.low)),
      high_monthly: r1(mean(series.high)),
    },
    confidence,
    history_forecast: historyForecast,
    notes,
  };
}

function flatScenario(est, cv, n) {
  const spread = Z80 * cv * est;
  return {
    expected: Array(n).fill(r1(est)),
    low: Array(n).fill(r1(est - spread)),
    high: Array(n).fill(r1(est + spread)),
  };
}

function stdDev(a) {
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1));
}
