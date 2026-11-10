// Deterministic plan recommendation (PRD §4.4). Ranks eligible plans on risk-adjusted cost over a
// common comparison horizon, honouring the customer's stated preference. Produces structured
// decision factors that the AI layer may explain but never alter.

import { estimatePlans, breakEven } from './pricing-engine.js';
import { round2 } from './money.js';

export const PREFERENCES = {
  balanced: { risk: 0.35, commitment: 0.04, label: 'a balance of low cost and predictability' },
  lowest_cost: { risk: 0, commitment: 0, label: 'the lowest expected cost' },
  predictable: { risk: 1.0, commitment: 0, label: 'predictable bills' },
  flexible: { risk: 0.2, commitment: 0.15, label: 'flexibility with no long-term commitment' },
};

/**
 * @param {object} args
 * @param {object[]} args.plans  eligible, normalized plans
 * @param {object} args.forecast output of forecastUsage()
 * @param {string} [args.preference]
 * @param {string} [args.currentPlanId]
 */
export function recommendPlan({ plans, forecast, preference = 'balanced', currentPlanId = null }) {
  if (!plans.length) throw Object.assign(new Error('No eligible plans to compare'), { status: 422 });
  const pref = PREFERENCES[preference] ?? PREFERENCES.balanced;
  const horizon = forecast.horizon_months;
  const estimates = estimatePlans(plans, forecast, { horizonMonths: horizon });

  const scored = estimates.map((e) => {
    const plan = plans.find((p) => p.plan_id === e.plan_id);
    const riskPenalty = pref.risk * Math.max(0, e.high_cost_scenario - e.estimated_cost);
    const commitmentPenalty = plan.terms.commitment_months > 0 ? pref.commitment * e.estimated_cost : 0;
    return { ...e, score: round2(e.estimated_cost + riskPenalty + commitmentPenalty), risk_penalty: round2(riskPenalty), commitment_penalty: round2(commitmentPenalty) };
  });
  scored.sort((a, b) => a.score - b.score || a.estimated_cost - b.estimated_cost);

  const best = scored[0];
  const bestPlan = plans.find((p) => p.plan_id === best.plan_id);
  const cheapest = [...scored].sort((a, b) => a.estimated_cost - b.estimated_cost)[0];
  const current = currentPlanId ? scored.find((s) => s.plan_id === currentPlanId) : null;
  const runnerUp = scored[1] ?? null;

  const baseline = current ?? scored.find((s) => s.billing_model === 'fixed' && s.billing_interval === 'month') ?? runnerUp;
  const savings = baseline && baseline.plan_id !== best.plan_id ? round2(baseline.estimated_cost - best.estimated_cost) : 0;

  const factors = [];
  factors.push({ factor: 'expected_usage', detail: `Expected usage ≈ ${forecast.summary.expected_monthly} per month (range ${forecast.summary.low_monthly}–${forecast.summary.high_monthly}).` });
  factors.push({ factor: 'expected_cost', detail: `${best.plan_name} is expected to cost ${best.estimated_cost} ${best.currency} over ${horizon} months.` });
  if (cheapest.plan_id !== best.plan_id) {
    factors.push({ factor: 'preference_tradeoff', detail: `${cheapest.plan_name} is cheaper on average (${cheapest.estimated_cost}) but ${best.plan_name} better matches your preference for ${pref.label}.` });
  }
  if (best.cost_variability > 0) factors.push({ factor: 'variability', detail: `Your cost could range from ${best.low_cost_scenario} to ${best.high_cost_scenario} depending on usage.` });
  if (best.usage_at_cap != null) factors.push({ factor: 'spending_cap', detail: `Charges stop increasing at the spending cap once usage reaches ~${best.usage_at_cap} per month.` });
  if (bestPlan.terms.commitment_months > 0) factors.push({ factor: 'commitment', detail: `Requires a ${bestPlan.terms.commitment_months}-month commitment paid up-front (${best.upfront_payment}).` });

  const breakEvens = [];
  for (const alt of scored.slice(1)) {
    const altPlan = plans.find((p) => p.plan_id === alt.plan_id);
    const be = breakEven(bestPlan, altPlan, Math.max(200, forecast.summary.high_monthly * 4));
    if (be != null) breakEvens.push({ versus_plan_id: alt.plan_id, versus_plan_name: alt.plan_name, usage_per_month: be });
  }
  breakEvens.forEach((b) => factors.push({ factor: 'break_even', detail: `${best.plan_name} and ${b.versus_plan_name} cost the same at ~${b.usage_per_month} per month.` }));

  return {
    recommended_plan_id: best.plan_id,
    recommended_plan_name: best.plan_name,
    preference,
    estimated_savings: savings,
    savings_baseline_plan_id: baseline?.plan_id ?? null,
    comparison_period: { months: horizon },
    confidence_or_uncertainty: {
      forecast_confidence: forecast.confidence,
      forecast_source: forecast.source,
      note: best.cost_variability > 0 ? 'Usage-based costs are estimates; actual charges depend on real usage.' : 'This plan has a fixed price.',
    },
    decision_factors: factors,
    break_even_points: breakEvens,
    ranked_plans: scored,
    current_plan_id: currentPlanId,
  };
}
