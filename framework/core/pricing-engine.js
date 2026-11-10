// Deterministic pricing engine (PRD §4.4, §5.2-C).
// Computes costs, scenarios and break-even points. No AI involved: every number shown to a
// customer or sent to the LLM originates here.

import { toCents, fromCents } from './money.js';

/** Rate graduated tiers: [{ up_to, unit_price }], last tier up_to = null. Returns cents. */
function rateTiers(tiers, quantity) {
  let remaining = quantity;
  let lower = 0;
  let cents = 0;
  for (const tier of tiers) {
    if (remaining <= 0) break;
    const width = tier.up_to == null ? remaining : Math.min(remaining, tier.up_to - lower);
    cents += width * toCents(tier.unit_price);
    remaining -= width;
    lower = tier.up_to ?? lower;
  }
  return Math.round(cents);
}

/**
 * Cost of a single billing month for a plan at a given usage.
 * Annual plans return their monthly-equivalent (amortized) cost; use horizonCost for cash totals.
 */
export function monthlyCost(plan, usage) {
  const u = Math.max(0, Number(usage) || 0);
  const base = toCents(plan.base_price);
  if (plan.billing_model === 'fixed') {
    const cents = plan.billing_interval === 'year' ? Math.round(base / 12) : base;
    return { cents, base_cents: cents, usage_cents: 0, billable_usage: 0, cap_reached: false };
  }
  const billable = Math.max(0, u - (plan.included_usage || 0));
  const usageCents =
    plan.billing_model === 'tiered'
      ? rateTiers(plan.tier_rules, billable)
      : Math.round(billable * toCents(plan.unit_price));
  let cents = Math.max(base + usageCents, toCents(plan.minimum_charge));
  let capReached = false;
  if (plan.spending_cap != null && cents >= toCents(plan.spending_cap)) {
    cents = toCents(plan.spending_cap);
    capReached = true;
  }
  return { cents, base_cents: base, usage_cents: cents - base, billable_usage: billable, cap_reached: capReached };
}

/**
 * Total cost of a plan over a horizon, given a per-month usage series (length = horizon months).
 * Annual plans are charged up-front per started 12-month term, so the commitment is explicit.
 */
export function horizonCost(plan, usageSeries) {
  const months = usageSeries.length;
  if (plan.billing_model === 'fixed' && plan.billing_interval === 'year') {
    const terms = Math.ceil(months / 12);
    const total = terms * toCents(plan.base_price);
    return { total_cents: total, months, monthly: usageSeries.map(() => Math.round(total / months)), cap_months: 0, upfront_cents: toCents(plan.base_price) };
  }
  const monthly = usageSeries.map((u) => monthlyCost(plan, u));
  return {
    total_cents: monthly.reduce((s, m) => s + m.cents, 0),
    months,
    monthly: monthly.map((m) => m.cents),
    cap_months: monthly.filter((m) => m.cap_reached).length,
    upfront_cents: 0,
  };
}

/** Usage at which a metered plan hits its spending cap (null if uncapped / fixed). */
export function usageAtCap(plan) {
  if (plan.billing_model === 'fixed' || plan.spending_cap == null) return null;
  let lo = 0;
  let hi = 1;
  while (!monthlyCost(plan, hi).cap_reached) {
    hi *= 2;
    if (hi > 1e9) return null;
  }
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (monthlyCost(plan, mid).cap_reached) hi = mid;
    else lo = mid;
  }
  return Math.round(hi * 10) / 10;
}

/**
 * Smallest usage level at which plan A becomes more expensive than plan B (monthly basis).
 * Returns null when the ordering never flips within [0, maxUsage].
 */
export function breakEven(planA, planB, maxUsage = 1000) {
  const diff = (u) => monthlyCost(planA, u).cents - monthlyCost(planB, u).cents;
  const step = maxUsage / 2000;
  let prev = diff(0);
  for (let u = step; u <= maxUsage; u += step) {
    const d = diff(u);
    if (Math.sign(d) !== Math.sign(prev) && d !== 0) {
      let lo = u - step;
      let hi = u;
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        if (Math.sign(diff(mid)) === Math.sign(prev)) lo = mid;
        else hi = mid;
      }
      return Math.round(hi * 10) / 10;
    }
    if (d !== 0) prev = d;
  }
  return null;
}

/**
 * Build PRD §5.4 price estimates for each plan under low / expected / high usage scenarios.
 * scenarios: { low: number[], expected: number[], high: number[] } (per-month usage series)
 */
export function estimatePlans(plans, scenarios, { horizonMonths } = {}) {
  const horizon = horizonMonths ?? scenarios.expected.length;
  return plans.map((plan) => {
    const exp = horizonCost(plan, scenarios.expected);
    const low = horizonCost(plan, scenarios.low);
    const high = horizonCost(plan, scenarios.high);
    const assumptions = [];
    if (plan.billing_model === 'fixed') assumptions.push('Fixed price; cost does not depend on usage.');
    if (plan.billing_interval === 'year') assumptions.push(`Billed ${fromCents(toCents(plan.base_price))} ${plan.currency} up-front per 12-month term.`);
    if (plan.included_usage) assumptions.push(`${plan.included_usage} ${plan.unit || 'units'} included each month.`);
    if (plan.spending_cap != null) assumptions.push(`Monthly charges never exceed the ${plan.spending_cap} ${plan.currency} spending cap.`);
    return {
      plan_id: plan.plan_id,
      plan_name: plan.name,
      billing_model: plan.billing_model,
      billing_interval: plan.billing_interval,
      comparison_period: { months: horizon },
      expected_usage: round1(avg(scenarios.expected)),
      estimated_cost: fromCents(exp.total_cents),
      estimated_monthly_cost: fromCents(exp.total_cents / horizon),
      low_cost_scenario: fromCents(Math.min(low.total_cents, high.total_cents)),
      high_cost_scenario: fromCents(Math.max(low.total_cents, high.total_cents)),
      upfront_payment: fromCents(exp.upfront_cents),
      months_at_cap: exp.cap_months,
      usage_at_cap: usageAtCap(plan),
      cost_variability: fromCents(Math.abs(high.total_cents - low.total_cents)),
      assumptions,
      currency: plan.currency,
    };
  });
}

const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const round1 = (n) => Math.round(n * 10) / 10;
