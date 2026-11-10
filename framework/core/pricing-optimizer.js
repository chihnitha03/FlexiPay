// Revenue-neutral pricing solver for metered plans.
//
// Goal: find usage-plan parameters (unit price, minimum charge, base fee, included usage, cap,
// tier scale) that MAXIMIZE customer savings subject to hard constraints:
//   1. merchant 12-month revenue with the advisor ≥ today's revenue × (1 + min_revenue_change_pct)
//   2. no customer's cheapest option costs more than what they pay today (with grandfathering,
//      existing subscribers of a changed plan keep their old terms)
//   3. merchant guardrails (±max_price_change_pct per price field, caps required, price limits)
//
// Why it is possible at all: customers only ever move to cheaper options, so revenue from the
// existing base can only fall per customer. Neutrality has to come from lower churn (customers
// who would leave stay on a fitting plan), and from minimums / base fees that keep a fair floor.
// The solver searches that trade-off; it is deterministic and every result is a full simulation.

import { simulateCatalog, applyCatalogChanges } from './catalog-simulator.js';

const r2 = (n) => Math.round(n * 100) / 100;
const price99 = (n) => Math.max(0, Math.round(n) - 0.01); // 10.4 → 9.99, 11.6 → 11.99

function candidates(plan, flatPrice, maxPct) {
  const lim = maxPct / 100;
  const mults = [-lim, -lim / 2, -lim / 4, 0, lim / 4, lim / 2, lim].map((x) => 1 + x);
  const out = {};
  if (plan.billing_model === 'usage' || plan.billing_model === 'hybrid') {
    out.unit_price = [...new Set(mults.map((m) => r2(plan.unit_price * m)))];
  }
  if (plan.billing_model === 'hybrid' && plan.base_price > 0) {
    out.base_price = [...new Set(mults.map((m) => price99(plan.base_price * m)).filter((v) => v > 0 && Math.abs(v - plan.base_price) / plan.base_price <= lim + 1e-9))];
    out.included_usage = [...new Set([0.5, 0.75, 1, 1.25, 1.5].map((m) => Math.max(1, Math.round(plan.included_usage * m))))];
  }
  if (plan.billing_model === 'usage' || plan.billing_model === 'tiered') {
    // A minimum is a floor, not a price increase per unit; bounded well below the flat plan.
    out.minimum_charge = [...new Set([plan.minimum_charge, ...[0.2, 0.3, 0.4, 0.5, 0.6, 0.7].map((f) => price99(flatPrice * f))].filter((v) => v >= 0 && v < flatPrice))];
  }
  if (plan.spending_cap != null && flatPrice) {
    out.spending_cap = [...new Set([plan.spending_cap, flatPrice, price99(flatPrice * 1.1)].filter((v) => v >= plan.base_price))];
  }
  if (plan.billing_model === 'tiered') out.tier_scale = mults.map(r2);
  return out;
}

function toChange(plan, field, value) {
  if (field === 'tier_scale') return { tier_rules: plan.tier_rules.map((t) => ({ ...t, unit_price: r2(t.unit_price * value) })) };
  return { [field]: value };
}

/**
 * @returns {{ feasible, changes, metrics, baseline, evaluations, constraints, notes }}
 */
/**
 * @param {number} [newCustomersPct] merchant's estimate of extra customers (as % of the current base)
 *   who subscribe only because flexible plans exist. Default 0: neutrality must then come from the
 *   existing base alone. Validate any non-zero value with an experiment.
 */
export function optimizeMeteredPricing({ plans, cohort, policy, assumptions = {}, grandfather = true, minRevenueChangePct = 0, maxPriceChangePct = 30, passes = 8, newCustomersPct = 0 }) {
  const flat = plans.filter((p) => p.billing_model === 'fixed' && p.billing_interval === 'month').sort((a, b) => a.base_price - b.base_price)[0];
  const metered = plans.filter((p) => p.billing_model !== 'fixed');
  const today = simulateCatalog(plans, cohort, assumptions); // status_quo = today without FlexPrice
  const revenueFloor = today.status_quo.revenue_12m * (1 + minRevenueChangePct / 100);
  const notes = [];
  if (!flat) notes.push('No flat monthly plan: minimum/cap candidates are limited.');
  if (!metered.length) return { feasible: false, changes: [], notes: ['No metered plans to optimize.'] };

  let evaluations = 0;
  const evaluate = (changes) => {
    evaluations += 1;
    const { plans: next, errors } = applyCatalogChanges(plans, changes, policy, { maxPriceChangePct });
    if (errors.length) return null;
    const sim = simulateCatalog(next, cohort, assumptions, { previousPlans: plans, grandfather });
    sim.new_customer_revenue_12m = r2(((newCustomersPct / 100) * cohort.length) * sim.avg_metered_customer_revenue_12m);
    sim.total_revenue_12m = sim.with_advisor.revenue_12m + sim.new_customer_revenue_12m;
    const shortfall = Math.max(0, revenueFloor - sim.total_revenue_12m);
    const feasible = shortfall < 0.005 && sim.customers_worse_off === 0;
    // Lexicographic: first reach feasibility (no shortfall, nobody worse off), then maximize savings.
    const score = feasible ? sim.customer_savings_from_advisor_12m : -(shortfall + sim.customers_worse_off * 1000) - 1e9;
    return { sim, feasible, score, shortfall };
  };

  // State: per-plan field overrides.
  const state = Object.fromEntries(metered.map((p) => [p.plan_id, {}]));
  const changesOf = (st) => Object.entries(st).filter(([, set]) => Object.keys(set).length).map(([plan_id, set]) => ({ op: 'update', plan_id, set }));
  let best = evaluate([]);
  for (let pass = 0; pass < passes; pass++) {
    let improved = false;
    for (const plan of metered) {
      for (const [field, values] of Object.entries(candidates(plan, flat?.base_price ?? plan.spending_cap ?? 0, maxPriceChangePct))) {
        for (const v of values) {
          const trial = structuredClone(state);
          trial[plan.plan_id] = { ...trial[plan.plan_id], ...toChange(plan, field, v) };
          const res = evaluate(changesOf(trial));
          if (res && res.score > best.score + 0.01) {
            best = res;
            Object.assign(state, trial);
            improved = true;
          }
        }
      }
    }
    if (!improved) break;
  }

  const s = best.sim;
  return {
    feasible: best.feasible,
    changes: changesOf(state),
    constraints: {
      revenue_floor_12m: r2(revenueFloor),
      revenue_shortfall_12m: r2(best.shortfall),
      customers_worse_off: s.customers_worse_off,
      grandfather_existing_subscribers: grandfather,
      max_price_change_pct: maxPriceChangePct,
    },
    metrics: {
      revenue_today_12m: today.status_quo.revenue_12m,
      revenue_with_advisor_12m: s.with_advisor.revenue_12m,
      assumed_new_customers_pct: newCustomersPct,
      new_customer_revenue_12m: s.new_customer_revenue_12m,
      revenue_change_vs_today_12m: r2(s.total_revenue_12m - today.status_quo.revenue_12m),
      customer_savings_12m: s.customer_savings_from_advisor_12m,
      churned_customers_avoided: r2(today.status_quo.expected_churned - s.with_advisor.expected_churned),
      customers_worse_off: s.customers_worse_off,
    },
    // What it would take to close any remaining gap: new customers attracted by flexible plans.
    break_even_new_customers: best.shortfall > 0 && s.avg_metered_customer_revenue_12m > 0
      ? { count: Math.ceil(best.shortfall / s.avg_metered_customer_revenue_12m), pct_of_base: r2((100 * Math.ceil(best.shortfall / s.avg_metered_customer_revenue_12m)) / cohort.length), avg_revenue_per_new_customer_12m: s.avg_metered_customer_revenue_12m }
      : null,
    baseline_without_changes: {
      revenue_change_vs_today_12m: today.advisor_revenue_impact_12m,
      customer_savings_12m: today.customer_savings_from_advisor_12m,
    },
    evaluations,
    notes: best.feasible
      ? notes
      : [...notes, grandfather
          ? 'Not revenue-neutral from the existing base alone: when customers can always pick a cheaper option, existing-customer revenue can only fall. The remaining gap must come from new customers attracted by flexible plans (see break_even_new_customers) or from showing the advisor only at signup and cancellation.'
          : 'Without grandfathering, any price floor raises bills for existing usage-plan customers, which the "nobody pays more" constraint forbids. Enable grandfathering.'],
  };
}
