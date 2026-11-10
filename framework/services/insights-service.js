// Merchant Pricing Insights: quantifies the advisor's effect on revenue/churn and proposes catalog
// experiments (Claude copilot, or deterministic heuristics as fallback). All metrics come from the
// deterministic catalog simulator.

import { simulateCatalog, applyCatalogChanges, summarizeCohort, DEFAULT_ASSUMPTIONS } from '../core/catalog-simulator.js';
import { optimizeMeteredPricing } from '../core/pricing-optimizer.js';
import { runPricingCopilot } from '../ai/pricing-copilot.js';

const MAX_PRICE_CHANGE_PCT = 30;
const r2 = (n) => Math.round(n * 100) / 100;

export class InsightsService {
  constructor({ pricing, advisor, store }) {
    this.pricing = pricing;
    this.advisor = advisor;
    this.store = store;
  }

  /** Adapter-provided anonymized cohort, else customers FlexPrice has advised (latest per customer). */
  async cohort(merchantId) {
    const m = this.pricing.merchant(merchantId);
    const fromAdapter = await m.gateway.getCohortUsage().catch(() => null);
    if (fromAdapter?.length) return { source: 'merchant_adapter', rows: fromAdapter };
    const latest = new Map();
    for (const r of this.store.find(merchantId, 'recommendations', (x) => x.customer_reference !== 'anonymous' && x.expected_monthly_usage != null)) latest.set(r.customer_reference, r);
    return { source: 'observed_customers', rows: [...latest.values()].map((r) => ({ current_plan_id: r.current_plan_id, avg_monthly_usage: r.expected_monthly_usage })) };
  }

  compare(base, sim) {
    return {
      revenue_change_12m: r2(sim.with_advisor.revenue_12m - base.with_advisor.revenue_12m),
      churned_customers_change: r2(sim.with_advisor.expected_churned - base.with_advisor.expected_churned),
      customer_spend_change_12m: r2(sim.with_advisor.customer_spend_12m - base.with_advisor.customer_spend_12m),
      overpaying_customers_change: sim.overpaying_customers - base.overpaying_customers,
    };
  }

  async generate(merchantId, { goal = 'balanced', assumptions = {}, grandfather = true, newCustomersPct = 0 } = {}) {
    const m = this.pricing.merchant(merchantId);
    const plans = await m.gateway.getPlans();
    const { source: cohortSource, rows } = await this.cohort(merchantId);
    if (rows.length < 5) throw Object.assign(new Error('Not enough usage data for insights (need at least 5 customers)'), { status: 422 });
    const a = { ...DEFAULT_ASSUMPTIONS, ...assumptions };
    const baseline = simulateCatalog(plans, rows, a);

    const simulate = (changes) => {
      const { plans: next, errors } = applyCatalogChanges(plans, changes, m.policy, { maxPriceChangePct: MAX_PRICE_CHANGE_PCT });
      if (errors.length) return { valid: false, errors };
      const sim = simulateCatalog(next, rows, a, { previousPlans: plans, grandfather });
      return { valid: true, vs_current_catalog: this.compare(baseline, sim), customers_worse_off: sim.customers_worse_off, revenue_12m: sim.with_advisor.revenue_12m, expected_churned: sim.with_advisor.expected_churned, overpaying_customers: sim.overpaying_customers, plan_mix_after: sim.plan_mix_after };
    };

    // Deterministic solver: the fairest metered pricing that keeps revenue ≥ today and nobody worse off.
    const revenueNeutral = optimizeMeteredPricing({ plans, cohort: rows, policy: m.policy, assumptions: a, grandfather, maxPriceChangePct: MAX_PRICE_CHANGE_PCT, newCustomersPct });

    let raw;
    let source = 'heuristic';
    let aiError = null;
    if (this.advisor.enabled) {
      try {
        const facts = {
          goal,
          catalog: plans.map(({ plan_id, name, billing_model, billing_interval, base_price, unit_price, included_usage, tier_rules, minimum_charge, spending_cap, unit }) => ({ plan_id, name, billing_model, billing_interval, base_price, unit_price, included_usage, tier_rules, minimum_charge, spending_cap, unit })),
          usage: summarizeCohort(rows),
          current_catalog_simulation: { revenue_12m: baseline.with_advisor.revenue_12m, expected_churned: baseline.with_advisor.expected_churned, overpaying_customers: baseline.overpaying_customers, plan_mix_after: baseline.plan_mix_after },
          guardrails: { max_price_change_pct: MAX_PRICE_CHANGE_PCT, require_spending_cap_for_usage: m.policy.require_spending_cap_for_usage, max_base_price: m.policy.price_guardrails.max_base_price, max_unit_price: m.policy.price_guardrails.max_unit_price },
          assumptions: a,
          revenue_neutral_solver_result: { feasible: revenueNeutral.feasible, changes: revenueNeutral.changes, metrics: revenueNeutral.metrics, break_even_new_customers: revenueNeutral.break_even_new_customers },
        };
        const out = await runPricingCopilot({ config: this.advisor.config, fetchImpl: this.advisor.fetch, facts, simulate, goal });
        raw = out.proposals;
        source = 'claude';
      } catch (err) {
        aiError = err.message;
      }
    }
    if (!raw) raw = this.#heuristics(plans, rows);

    // Re-simulate every proposal deterministically; drop invalid ones.
    const proposals = raw
      .map((p) => ({ ...p, result: simulate(p.changes) }))
      .filter((p) => p.result.valid)
      .filter((p) => Object.values(p.result.vs_current_catalog).some((v) => Math.abs(v) > 0.005)) // drop no-effect ideas
      .map((p) => ({ ...p, rationale: p.rationale_grounded === false ? `${autoRationale(p.result)} (AI rationale replaced: it cited unverified numbers.)` : p.rationale ?? autoRationale(p.result) }));
    rank(proposals, goal);

    const report = this.store.insert(merchantId, 'insights', {
      goal,
      source,
      ai_error: aiError,
      cohort: { source: cohortSource, customers: rows.length, summary: summarizeCohort(rows) },
      advisor_impact_on_current_catalog: {
        revenue_status_quo_12m: baseline.status_quo.revenue_12m,
        revenue_with_advisor_12m: baseline.with_advisor.revenue_12m,
        revenue_impact_12m: baseline.advisor_revenue_impact_12m,
        churned_customers_avoided: baseline.advisor_churn_reduction,
        customer_savings_12m: baseline.customer_savings_from_advisor_12m,
        overpaying_customers: baseline.overpaying_customers,
      },
      proposals,
      revenue_neutral_pricing: revenueNeutral,
      assumptions: a,
      disclaimer: 'Estimates from a simple behavioural model with the assumptions shown. Proposals are not applied automatically; validate them with an experiment in your own billing system.',
    });
    return report;
  }

  latest(merchantId) {
    return this.store.find(merchantId, 'insights').at(-1) ?? null;
  }

  /** Deterministic fallback proposals targeting common catalog mismatches. */
  #heuristics(plans, rows) {
    const out = [];
    const fixedMonthly = plans.filter((p) => p.billing_model === 'fixed' && p.billing_interval === 'month').sort((a, b) => a.base_price - b.base_price)[0];
    const metered = plans.filter((p) => p.billing_model !== 'fixed');
    if (fixedMonthly) {
      const over = metered.filter((p) => p.spending_cap != null && p.spending_cap > fixedMonthly.base_price);
      if (over.length) {
        out.push({
          title: `Cap metered plans at the ${fixedMonthly.name} price`,
          rationale: null,
          changes: over.map((p) => ({ op: 'update', plan_id: p.plan_id, set: { spending_cap: fixedMonthly.base_price } })),
        });
      }
      // Fair revenue floor: metered plans keep a modest minimum (~30% of the flat plan), so light
      // users still pay far less than the flat price but the merchant keeps a baseline.
      const floor = Math.round(fixedMonthly.base_price * 0.3 * 100) / 100;
      const low = metered.filter((p) => (p.minimum_charge ?? 0) < floor && p.base_price < floor);
      if (low.length) {
        out.push({
          title: `Set a $${floor.toFixed(2)} monthly minimum on metered plans`,
          rationale: null,
          changes: low.map((p) => ({ op: 'update', plan_id: p.plan_id, set: { minimum_charge: floor } })),
        });
      }
    }
    const annual = plans.find((p) => p.billing_model === 'fixed' && p.billing_interval === 'year');
    if (annual && fixedMonthly && annual.base_price > fixedMonthly.base_price * 10.5) {
      out.push({ title: 'Make the annual plan "2 months free"', rationale: null, changes: [{ op: 'update', plan_id: annual.plan_id, set: { base_price: Math.round(fixedMonthly.base_price * 10 * 100) / 100 } }] });
    }
    return out;
  }
}

function autoRationale(res) {
  const d = res.vs_current_catalog;
  const fmt = (n) => `${n >= 0 ? '+' : '−'}$${Math.abs(n).toFixed(2)}`;
  return `Simulated 12-month revenue ${fmt(d.revenue_change_12m)}, expected churned customers ${d.churned_customers_change >= 0 ? '+' : ''}${d.churned_customers_change}, customer spend ${fmt(d.customer_spend_change_12m)} vs. the current catalog.`;
}

function rank(proposals, goal) {
  const score = (p) => {
    const d = p.result.vs_current_catalog;
    if (goal === 'revenue') return d.revenue_change_12m;
    if (goal === 'retention') return -d.churned_customers_change * 1000 + d.revenue_change_12m * 0.01;
    return d.revenue_change_12m - d.churned_customers_change * 50;
  };
  proposals.sort((a, b) => score(b) - score(a));
}
