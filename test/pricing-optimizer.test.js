import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateCatalog, applyCatalogChanges } from '../framework/core/catalog-simulator.js';
import { optimizeMeteredPricing } from '../framework/core/pricing-optimizer.js';
import { normalizePlan } from '../framework/core/models.js';
import { resolvePolicy } from '../framework/core/policy-engine.js';
import { makeCohort } from '../demo/seed.js';

const plans = [
  { plan_id: 'm', name: 'Monthly', billing_model: 'fixed', base_price: 15.99, terms: { summary: 'x' } },
  { plan_id: 'y', name: 'Annual', billing_model: 'fixed', billing_interval: 'year', base_price: 159.99, terms: { summary: 'x' } },
  { plan_id: 'u', name: 'PAYG', billing_model: 'usage', usage_metric: 'h', unit: 'hours', unit_price: 0.6, minimum_charge: 2.99, spending_cap: 17.99, terms: { summary: 'x' } },
].map(normalizePlan);
const cohort = makeCohort({
  size: 400,
  seed: 5,
  segments: [
    { share: 0.5, median: 6, spread: 0.5, plans: { m: 0.85, u: 0.15 } },
    { share: 0.5, median: 30, spread: 0.3, plans: { m: 0.7, y: 0.3 } },
  ],
});
const policy = resolvePolicy({});

test('churn reference is fixed: making the cheap plan worse does not "reduce churn"', () => {
  const base = simulateCatalog(plans, cohort);
  const { plans: worse } = applyCatalogChanges(plans, [{ op: 'update', plan_id: 'u', set: { minimum_charge: 12.99 } }], policy);
  const sim = simulateCatalog(worse, cohort, {}, { previousPlans: plans, grandfather: true });
  assert.ok(sim.status_quo.expected_churned >= base.status_quo.expected_churned - 1e-6);
});

test('without grandfathering, raising a floor leaves existing usage-plan customers worse off', () => {
  const { plans: next } = applyCatalogChanges(plans, [{ op: 'update', plan_id: 'u', set: { minimum_charge: 9.99 } }], policy);
  assert.ok(simulateCatalog(next, cohort, {}, { previousPlans: plans, grandfather: false }).customers_worse_off > 0);
  assert.equal(simulateCatalog(next, cohort, {}, { previousPlans: plans, grandfather: true }).customers_worse_off, 0);
});

test('solver: nobody worse off, guardrails respected, revenue gap reduced, break-even acquisition reported', () => {
  const r = optimizeMeteredPricing({ plans, cohort, policy });
  assert.equal(r.metrics.customers_worse_off, 0);
  assert.ok(r.metrics.revenue_change_vs_today_12m > r.baseline_without_changes.revenue_change_vs_today_12m);
  assert.ok(r.metrics.customer_savings_12m > 0);
  for (const ch of r.changes) {
    const before = plans.find((p) => p.plan_id === ch.plan_id);
    if (ch.set.unit_price != null) assert.ok(Math.abs(ch.set.unit_price - before.unit_price) / before.unit_price <= 0.3 + 1e-9);
    if (ch.set.minimum_charge != null) assert.ok(ch.set.minimum_charge < 15.99);
  }
  if (!r.feasible) assert.ok(r.break_even_new_customers.count > 0);
});

test('existing base alone cannot be revenue-neutral while customers save (every saved dollar is uncollected revenue)', () => {
  for (const sens of [0.6, 1.5]) assert.equal(optimizeMeteredPricing({ plans, cohort, policy, assumptions: { overpay_churn_sensitivity: sens } }).feasible, false);
});

test('solver reaches revenue neutrality once the reported break-even acquisition is assumed', () => {
  const gap = optimizeMeteredPricing({ plans, cohort, policy });
  const r = optimizeMeteredPricing({ plans, cohort, policy, newCustomersPct: Math.ceil(gap.break_even_new_customers.pct_of_base) + 1 });
  assert.equal(r.feasible, true, JSON.stringify(r.metrics));
  assert.ok(r.metrics.revenue_change_vs_today_12m >= 0);
  assert.ok(r.metrics.customer_savings_12m > 0);
  assert.equal(r.metrics.customers_worse_off, 0);
});
