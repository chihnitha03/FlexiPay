import test from 'node:test';
import assert from 'node:assert/strict';
import { forecastUsage } from '../framework/core/forecaster.js';
import { recommendPlan } from '../framework/core/recommender.js';
import { normalizePlan } from '../framework/core/models.js';
import { makeHistory } from '../demo/seed.js';

const plans = [
  { plan_id: 'm', name: 'Monthly', billing_model: 'fixed', base_price: 15.99 },
  { plan_id: 'y', name: 'Annual', billing_model: 'fixed', billing_interval: 'year', base_price: 159.99 },
  { plan_id: 'u', name: 'PAYG', billing_model: 'usage', usage_metric: 'h', unit_price: 0.6, minimum_charge: 2.99, spending_cap: 17.99 },
].map(normalizePlan);

test('forecast source priority: history > customer estimate > default', () => {
  const h = makeHistory({ months: 12, base: 10, seed: 1 });
  assert.equal(forecastUsage({ history: h }).source, 'history');
  assert.equal(forecastUsage({ history: h, customerEstimate: 30 }).source, 'customer_estimate');
  assert.equal(forecastUsage({}).source, 'merchant_default');
});

test('forecast range brackets expected and is non-negative', () => {
  const f = forecastUsage({ history: makeHistory({ months: 12, base: 6, noise: 0.4, seed: 2 }) });
  f.expected.forEach((e, i) => {
    assert.ok(f.low[i] <= e && e <= f.high[i]);
    assert.ok(f.low[i] >= 0);
  });
});

test('increasing history produces increasing trend', () => {
  const f = forecastUsage({ history: makeHistory({ months: 12, base: 10, trend: 3, noise: 0.02, seed: 3 }) });
  assert.equal(f.history_forecast.trend, 'increasing');
  assert.ok(f.summary.expected_monthly > 40);
});

test('light user is recommended pay-as-you-go with savings vs current plan', () => {
  const forecast = forecastUsage({ customerEstimate: 6 });
  const r = recommendPlan({ plans, forecast, currentPlanId: 'm' });
  assert.equal(r.recommended_plan_id, 'u');
  assert.ok(r.estimated_savings > 100);
});

test('heavy user is recommended the annual plan', () => {
  const r = recommendPlan({ plans, forecast: forecastUsage({ customerEstimate: 45 }), currentPlanId: 'm' });
  assert.equal(r.recommended_plan_id, 'y');
});

test('flexible preference avoids annual commitment when the saving is marginal', () => {
  const closePlans = [plans[0], normalizePlan({ plan_id: 'y2', name: 'Annual', billing_model: 'fixed', billing_interval: 'year', base_price: 180 })];
  const forecast = forecastUsage({ customerEstimate: 45 });
  assert.equal(recommendPlan({ plans: closePlans, forecast, preference: 'balanced' }).recommended_plan_id, 'y2');
  assert.equal(recommendPlan({ plans: closePlans, forecast, preference: 'flexible' }).recommended_plan_id, 'm');
});

test('predictable preference penalizes usage variability', () => {
  const forecast = forecastUsage({ customerEstimate: 22 });
  const cheap = recommendPlan({ plans, forecast, preference: 'lowest_cost' });
  const pred = recommendPlan({ plans, forecast, preference: 'predictable' });
  assert.equal(cheap.recommended_plan_id, 'u');
  assert.notEqual(pred.recommended_plan_id, 'u');
  assert.ok(pred.decision_factors.some((f) => f.factor === 'preference_tradeoff'));
});
