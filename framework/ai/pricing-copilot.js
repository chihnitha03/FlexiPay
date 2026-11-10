// Merchant-side AI: Pricing Insights copilot.
// Claude reads an aggregated view of the merchant's catalog and customer usage (no individual
// customer data), proposes catalog experiments, and must test each one with the deterministic
// `simulate_catalog` tool before submitting. Proposals are suggestions only: FlexPrice never
// changes merchant prices (PRD non-goal: no dynamic/individualized pricing without approval).

import { callClaude } from './claude.js';
import { checkGrounding } from './grounding.js';

const SYSTEM = `You are FlexPrice Pricing Copilot, an analyst helping a subscription merchant improve its plan catalog.
You see aggregated usage (histograms and quantiles), never individual customers.

Process:
1. Form up to 3 hypotheses for catalog changes that better match how customers actually use the product.
2. Test EVERY hypothesis with simulate_catalog before proposing it. Iterate if a result is poor.
3. Finish by calling submit_proposals exactly once.

Rules:
- Only use fields and operations the tool accepts. Respect the guardrails in FACTS (price changes are limited to ±max_price_change_pct; metered plans must keep a spending cap).
- Never propose individualized or per-customer prices, and never raise prices specifically on customers who already overpay.
- Prefer changes that reduce customer overpayment and churn without large revenue loss; state the trade-off honestly.
- FACTS include revenue_neutral_solver_result from a deterministic optimizer; build on it or explain why an alternative is better. Existing subscribers are grandfathered; proposals must not leave any customer worse off (customers_worse_off must stay 0).
- In rationales, only cite numbers that appear in simulate_catalog results or FACTS. Max 60 words per rationale.`;

const CHANGE_SCHEMA = {
  type: 'object',
  properties: {
    op: { type: 'string', enum: ['update', 'add', 'remove'] },
    plan_id: { type: 'string', description: 'for update/remove' },
    set: { type: 'object', description: 'for update: fields among base_price, unit_price, included_usage, spending_cap, minimum_charge, tier_rules, name, features' },
    plan: { type: 'object', description: 'for add: a full plan definition (plan_id, name, billing_model, base_price, unit_price, included_usage, usage_metric, unit, spending_cap, terms.summary)' },
  },
  required: ['op'],
};

export async function runPricingCopilot({ config, fetchImpl, facts, simulate, goal, maxSteps = 8 }) {
  const tools = [
    {
      name: 'simulate_catalog',
      description: 'Apply catalog changes and simulate 12-month revenue, churn and customer spend across the cohort, compared with the current catalog. Returns validation errors if the changes are not allowed.',
      input_schema: { type: 'object', properties: { changes: { type: 'array', items: CHANGE_SCHEMA } }, required: ['changes'] },
    },
    {
      name: 'submit_proposals',
      description: 'Submit the final proposals (max 3). Each must have been simulated.',
      input_schema: {
        type: 'object',
        properties: {
          proposals: {
            type: 'array',
            maxItems: 3,
            items: { type: 'object', properties: { title: { type: 'string' }, rationale: { type: 'string' }, changes: { type: 'array', items: CHANGE_SCHEMA } }, required: ['title', 'rationale', 'changes'] },
          },
        },
        required: ['proposals'],
      },
    },
  ];
  const messages = [{ role: 'user', content: `Merchant goal: ${goal}.\nFACTS:\n${JSON.stringify(facts)}\n\nPropose catalog experiments.` }];
  const toolResults = [facts];
  for (let step = 0; step < maxSteps; step++) {
    const res = await callClaude({ apiKey: config.ai.apiKey, model: config.ai.model, timeoutMs: Math.max(config.ai.timeoutMs, 30000), fetchImpl, system: SYSTEM, messages, tools, maxTokens: 1500 });
    messages.push({ role: 'assistant', content: res.content });
    const calls = res.content.filter((b) => b.type === 'tool_use');
    if (!calls.length) break;
    const results = [];
    for (const call of calls) {
      if (call.name === 'submit_proposals') {
        const proposals = (call.input.proposals ?? []).slice(0, 3).map((p) => {
          const g = checkGrounding(String(p.rationale ?? ''), toolResults);
          return { title: String(p.title ?? '').slice(0, 120), rationale: String(p.rationale ?? '').slice(0, 600), rationale_grounded: g.grounded, changes: p.changes ?? [] };
        });
        return { proposals, source: 'claude', model: config.ai.model, steps: step + 1 };
      }
      const out = call.name === 'simulate_catalog' ? simulate(call.input.changes) : { error: 'unknown tool' };
      toolResults.push(out);
      results.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(out) });
    }
    messages.push({ role: 'user', content: results });
  }
  throw new Error('Pricing copilot did not submit proposals');
}
