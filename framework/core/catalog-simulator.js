// Deterministic catalog simulator for merchant Pricing Insights.
// Answers: "If customers were shown best-fit recommendations under this catalog, what happens to
// 12-month revenue, churn and customer spend?" Every number in AI-generated pricing proposals is
// produced here. The behavioural model is deliberately simple and every assumption is explicit
// and overridable, because these are estimates, not predictions.

import { horizonCost } from './pricing-engine.js';
import { normalizePlan } from './models.js';
import { validateCatalog } from './policy-engine.js';

export const DEFAULT_ASSUMPTIONS = {
  horizon_months: 12,
  adoption_rate: 0.35, // share of mismatched customers who switch when shown their best fit
  base_annual_churn: 0.25, // churn of customers whose plan fits their usage
  overpay_churn_sensitivity: 0.6, // extra churn per 100% overpayment vs. best fit
  max_annual_churn: 0.9,
};

const r2 = (n) => Math.round(n * 100) / 100;

/** 12-month cost of every plan for a flat monthly usage (cents). */
function costTable(plans, usage, months) {
  const series = Array(months).fill(usage);
  return plans.map((p) => ({ plan_id: p.plan_id, cents: horizonCost(p, series).total_cents }));
}

function churnProb(overpayRatio, a) {
  return Math.min(a.max_annual_churn, a.base_annual_churn + a.overpay_churn_sensitivity * Math.max(0, overpayRatio));
}

/**
 * @param {object[]} plans normalized plans (the catalog to evaluate)
 * @param {{current_plan_id: string|null, avg_monthly_usage: number}[]} cohort
 * @param {object} [assumptions]
 * @param {object} [opts]
 * @param {object[]} [opts.previousPlans] today's catalog; enables the "worse off" check
 * @param {boolean} [opts.grandfather] existing subscribers of a changed plan keep their old terms
 */
export function simulateCatalog(plans, cohort, assumptions = {}, { previousPlans = null, grandfather = false } = {}) {
  const a = { ...DEFAULT_ASSUMPTIONS, ...assumptions };
  const months = a.horizon_months;
  const byId = new Map(plans.map((p) => [p.plan_id, p]));
  const out = {
    customers: 0,
    // revenue_12m is churn-adjusted; customer_spend_12m is what customers' chosen plans cost over
    // the horizon if they stay (the customer-side view).
    status_quo: { revenue_12m: 0, expected_churned: 0, customer_spend_12m: 0 },
    with_advisor: { revenue_12m: 0, expected_churned: 0, customer_spend_12m: 0, switches: 0 },
    overpaying_customers: 0,
    // Customers whose cheapest available option now costs more than what they pay today.
    customers_worse_off: 0,
    // Average 12-month revenue of a customer whose best fit is a metered plan — a proxy for the
    // value of a NEW customer who would only subscribe because flexible pricing exists.
    avg_metered_customer_revenue_12m: 0,
    plan_mix_before: {},
    plan_mix_after: {},
  };
  const prevById = previousPlans ? new Map(previousPlans.map((p) => [p.plan_id, p])) : null;
  const series = (u) => Array(months).fill(u);
  const meteredFit = { n: 0, sum: 0 };
  for (const c of cohort) {
    const table = costTable(plans, c.avg_monthly_usage, months);
    const prevPlan = prevById?.get(c.current_plan_id);
    const todayCents = prevPlan ? horizonCost(prevPlan, series(c.avg_monthly_usage)).total_cents : null;
    let currentEntry = table.find((x) => x.plan_id === c.current_plan_id);
    if (grandfather && prevPlan) currentEntry = { plan_id: c.current_plan_id, cents: todayCents }; // keeps old terms
    const best = [...table, ...(currentEntry ? [currentEntry] : [])].reduce((m, x) => (x.cents < m.cents ? x : m));
    // Customers on a plan that no longer exists (or none) are treated as choosing the best fit.
    const current = currentEntry ?? best;
    if (todayCents != null && Math.min(current.cents, best.cents) > todayCents + 1) out.customers_worse_off += 1;
    // Churn depends on perceived value against a FIXED reference: the best-fit cost in today's
    // catalog. Making alternatives worse must never "reduce churn" (a solver would exploit that).
    const refCents = prevById ? Math.min(...previousPlans.map((p) => horizonCost(p, series(c.avg_monthly_usage)).total_cents)) : best.cents;
    const overpayVsRef = (cents) => (cents > 0 ? Math.max(0, cents - refCents) / cents : 0);
    const churnStay = churnProb(overpayVsRef(current.cents), a);
    const churnFit = churnProb(overpayVsRef(best.cents), a);
    // Revenue exposure: a churned customer pays on average for half the horizon.
    const stayRevenue = (current.cents / 100) * (1 - churnStay / 2);
    const fitRevenue = (best.cents / 100) * (1 - churnFit / 2);
    out.customers += 1;
    if (byId.get(best.plan_id)?.billing_model !== 'fixed' && byId.has(best.plan_id)) {
      meteredFit.n += 1;
      meteredFit.sum += fitRevenue;
    }
    out.status_quo.revenue_12m += stayRevenue;
    out.status_quo.expected_churned += churnStay;
    out.status_quo.customer_spend_12m += current.cents / 100;
    out.plan_mix_before[current.plan_id] = (out.plan_mix_before[current.plan_id] ?? 0) + 1;
    if (best.plan_id !== current.plan_id) {
      out.overpaying_customers += 1;
      const adopt = a.adoption_rate;
      out.with_advisor.revenue_12m += adopt * fitRevenue + (1 - adopt) * stayRevenue;
      out.with_advisor.expected_churned += adopt * churnFit + (1 - adopt) * churnStay;
      out.with_advisor.switches += adopt;
      out.with_advisor.customer_spend_12m += (adopt * best.cents + (1 - adopt) * current.cents) / 100;
      out.plan_mix_after[best.plan_id] = (out.plan_mix_after[best.plan_id] ?? 0) + adopt;
      out.plan_mix_after[current.plan_id] = (out.plan_mix_after[current.plan_id] ?? 0) + (1 - adopt);
    } else {
      out.with_advisor.revenue_12m += stayRevenue;
      out.with_advisor.expected_churned += churnStay;
      out.with_advisor.customer_spend_12m += current.cents / 100;
      out.plan_mix_after[current.plan_id] = (out.plan_mix_after[current.plan_id] ?? 0) + 1;
    }
  }
  const round = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? r2(v) : v]));
  out.status_quo = round(out.status_quo);
  out.with_advisor = round(out.with_advisor);
  out.customer_savings_from_advisor_12m = r2(out.status_quo.customer_spend_12m - out.with_advisor.customer_spend_12m);
  out.plan_mix_before = round(out.plan_mix_before);
  out.plan_mix_after = round(out.plan_mix_after);
  out.avg_metered_customer_revenue_12m = meteredFit.n ? r2(meteredFit.sum / meteredFit.n) : 0;
  out.advisor_revenue_impact_12m = r2(out.with_advisor.revenue_12m - out.status_quo.revenue_12m);
  out.advisor_churn_reduction = r2(out.status_quo.expected_churned - out.with_advisor.expected_churned);
  out.assumptions = a;
  out.plans = [...byId.keys()];
  return out;
}

const EDITABLE = ['base_price', 'unit_price', 'included_usage', 'spending_cap', 'minimum_charge', 'tier_rules', 'name', 'features', 'terms'];

/**
 * Apply proposed changes to a catalog with validation and guardrails.
 * changes: [{ op: 'update', plan_id, set: {...} } | { op: 'add', plan: {...} } | { op: 'remove', plan_id }]
 * Returns { plans, errors }.
 */
export function applyCatalogChanges(plans, changes, policy, { maxPriceChangePct = 30 } = {}) {
  const errors = [];
  let next = plans.map((p) => structuredClone(p));
  for (const [i, ch] of (Array.isArray(changes) ? changes : []).entries()) {
    try {
      if (ch.op === 'update') {
        const idx = next.findIndex((p) => p.plan_id === ch.plan_id);
        if (idx < 0) throw new Error(`unknown plan ${ch.plan_id}`);
        const set = ch.set ?? {};
        const bad = Object.keys(set).filter((k) => !EDITABLE.includes(k));
        if (bad.length) throw new Error(`fields not editable: ${bad.join(', ')}`);
        const before = next[idx];
        for (const k of ['base_price', 'unit_price']) {
          if (set[k] != null && before[k] > 0 && Math.abs(set[k] - before[k]) / before[k] > maxPriceChangePct / 100) {
            throw new Error(`${k} change for ${ch.plan_id} exceeds the ±${maxPriceChangePct}% guardrail`);
          }
        }
        next[idx] = normalizePlan({ ...before, ...set });
      } else if (ch.op === 'add') {
        if (next.some((p) => p.plan_id === ch.plan?.plan_id)) throw new Error(`plan ${ch.plan?.plan_id} already exists`);
        next.push(normalizePlan({ currency: plans[0]?.currency ?? 'USD', ...ch.plan }));
      } else if (ch.op === 'remove') {
        if (!next.some((p) => p.plan_id === ch.plan_id)) throw new Error(`unknown plan ${ch.plan_id}`);
        next = next.filter((p) => p.plan_id !== ch.plan_id);
      } else throw new Error(`unknown op '${ch.op}'`);
    } catch (err) {
      errors.push(`change[${i}]: ${err.details ? `${err.message}: ${err.details.join('; ')}` : err.message}`);
    }
  }
  if (!next.length) errors.push('catalog would be empty');
  for (const issue of validateCatalog(next, policy).filter((x) => x.severity === 'error')) errors.push(`${issue.plan_id}: ${issue.issue}`);
  return { plans: next, errors };
}

/** Aggregate a cohort into a usage histogram per current plan — what the AI is allowed to see. */
export function summarizeCohort(cohort, buckets) {
  const edges = buckets ?? quantileEdges(cohort.map((c) => c.avg_monthly_usage));
  const rows = {};
  for (const c of cohort) {
    const key = c.current_plan_id ?? 'none';
    rows[key] ??= Array(edges.length).fill(0);
    const b = edges.findIndex((e) => c.avg_monthly_usage <= e);
    rows[key][b < 0 ? edges.length - 1 : b] += 1;
  }
  const sorted = cohort.map((c) => c.avg_monthly_usage).sort((x, y) => x - y);
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
  return {
    customers: cohort.length,
    usage_quantiles: { p10: r2(q(0.1)), p25: r2(q(0.25)), median: r2(q(0.5)), p75: r2(q(0.75)), p90: r2(q(0.9)) },
    bucket_upper_edges: edges,
    histogram_by_current_plan: rows,
  };
}

function quantileEdges(values) {
  const s = [...values].sort((a, b) => a - b);
  if (!s.length) return [0];
  const edges = [0.2, 0.4, 0.6, 0.8].map((p) => Math.round(s[Math.floor(p * (s.length - 1))] * 10) / 10);
  edges.push(Math.ceil(s.at(-1)));
  return [...new Set(edges)];
}
