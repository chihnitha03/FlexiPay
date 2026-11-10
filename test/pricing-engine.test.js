import test from 'node:test';
import assert from 'node:assert/strict';
import { monthlyCost, horizonCost, breakEven, usageAtCap, estimatePlans } from '../framework/core/pricing-engine.js';
import { normalizePlan } from '../framework/core/models.js';

const monthly = normalizePlan({ plan_id: 'm', name: 'Monthly', billing_model: 'fixed', base_price: 15 });
const annual = normalizePlan({ plan_id: 'y', name: 'Annual', billing_model: 'fixed', billing_interval: 'year', base_price: 150 });
const payg = normalizePlan({ plan_id: 'u', name: 'PAYG', billing_model: 'usage', usage_metric: 'h', unit_price: 0.6, minimum_charge: 3, spending_cap: 18 });
const hybrid = normalizePlan({ plan_id: 'h', name: 'Hybrid', billing_model: 'hybrid', usage_metric: 'h', base_price: 7, included_usage: 10, unit_price: 0.45, spending_cap: 19 });
const tiered = normalizePlan({ plan_id: 't', name: 'Tiered', billing_model: 'tiered', usage_metric: 'k', tier_rules: [{ up_to: 20, unit_price: 0.5 }, { up_to: 100, unit_price: 0.3 }, { up_to: null, unit_price: 0.15 }], spending_cap: 79 });

test('PRD example: 20 hours at $0.60/h = $12', () => {
  assert.equal(monthlyCost(payg, 20).cents, 1200);
  assert.equal(monthlyCost(payg, 35).cents, 1800); // 21.00 capped at 18
  assert.equal(monthlyCost(payg, 35).cap_reached, true);
});

test('minimum charge applies to low usage', () => {
  assert.equal(monthlyCost(payg, 1).cents, 300);
});

test('hybrid includes usage before overage', () => {
  assert.equal(monthlyCost(hybrid, 8).cents, 700);
  assert.equal(monthlyCost(hybrid, 20).cents, 700 + 450);
});

test('graduated tiers', () => {
  // 20*0.5 + 80*0.3 + 50*0.15 = 10 + 24 + 7.5
  assert.equal(monthlyCost(tiered, 150).cents, 4150);
  assert.equal(monthlyCost(tiered, 10).cents, 500);
});

test('annual plan charged per started 12-month term', () => {
  assert.equal(horizonCost(annual, Array(12).fill(5)).total_cents, 15000);
  assert.equal(horizonCost(annual, Array(13).fill(5)).total_cents, 30000);
  assert.equal(horizonCost(monthly, Array(12).fill(5)).total_cents, 18000);
});

test('break-even between PAYG and monthly is 25 hours', () => {
  assert.equal(breakEven(payg, monthly, 200), 25);
});

test('usage at cap', () => {
  assert.equal(usageAtCap(payg), 30);
  assert.equal(usageAtCap(monthly), null);
});

test('estimates expose low/expected/high totals', () => {
  const [e] = estimatePlans([payg], { expected: Array(12).fill(20), low: Array(12).fill(10), high: Array(12).fill(35) });
  assert.equal(e.estimated_cost, 144);
  assert.equal(e.low_cost_scenario, 72);
  assert.equal(e.high_cost_scenario, 216);
  assert.equal(e.months_at_cap, 0);
});

test('plan validation rejects bad tiers and missing caps fields', () => {
  assert.throws(() => normalizePlan({ plan_id: 'x', name: 'x', billing_model: 'tiered', usage_metric: 'k', tier_rules: [{ up_to: 10, unit_price: 1 }] }));
  assert.throws(() => normalizePlan({ plan_id: 'x', name: 'x', billing_model: 'usage', usage_metric: 'k', unit_price: 1, billing_interval: 'year' }));
});
