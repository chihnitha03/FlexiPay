import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePolicy, evaluateRetention, authorizePlanChange, filterEligiblePlans, validateCatalog } from '../framework/core/policy-engine.js';
import { checkGrounding } from '../framework/ai/grounding.js';
import { parseIntent } from '../framework/ai/advisor.js';
import { normalizePlan } from '../framework/core/models.js';
import { UsageLedger } from '../framework/core/usage-ledger.js';
import { Store } from '../framework/core/store.js';

const policy = resolvePolicy({});
const plan = normalizePlan({ plan_id: 'u', name: 'PAYG', billing_model: 'usage', usage_metric: 'h', unit_price: 0.6, spending_cap: 18, terms: { summary: 'x' } });

test('discounts are never automatic: tenure, cooldown and lifetime caps apply', () => {
  const now = new Date('2026-10-01');
  assert.equal(evaluateRetention({ customer: { tenure_months: 1 }, policy, now }).discount.eligible, false);
  assert.equal(evaluateRetention({ customer: { tenure_months: 12 }, policy, now }).discount.eligible, true);
  const recent = [{ type: 'discount', granted_at: '2026-07-01' }];
  assert.match(evaluateRetention({ customer: { tenure_months: 12 }, offerHistory: recent, policy, now }).discount.reason, /already used/);
  const many = [{ type: 'discount', granted_at: '2023-01-01' }, { type: 'discount', granted_at: '2024-01-01' }];
  assert.match(evaluateRetention({ customer: { tenure_months: 40 }, offerHistory: many, policy, now }).discount.reason, /lifetime/);
});

test('AI agent can never authorize a plan change; consent must match', () => {
  const base = { customer: { customer_reference: 'c1', current_plan_id: 'm' }, targetPlan: plan, eligiblePlanIds: ['u'], policy, capabilities: { change_plan: true } };
  const consent = { plan_id: 'u', customer_reference: 'c1', accepted_at: new Date().toISOString() };
  assert.equal(authorizePlanChange({ ...base, actor: 'customer', consent }).allowed, true);
  assert.equal(authorizePlanChange({ ...base, actor: 'ai_agent', consent }).allowed, false);
  assert.equal(authorizePlanChange({ ...base, actor: 'customer', consent: null }).allowed, false);
  assert.equal(authorizePlanChange({ ...base, actor: 'customer', consent: { ...consent, plan_id: 'other' } }).allowed, false);
});

test('metered plans hidden when integration lacks metering; uncapped metered plan flagged', () => {
  const { eligible, excluded } = filterEligiblePlans([plan], {}, { usage_metering: false });
  assert.equal(eligible.length, 0);
  assert.match(excluded[0].reason, /metering/);
  const uncapped = normalizePlan({ plan_id: 'z', name: 'z', billing_model: 'usage', usage_metric: 'h', unit_price: 1 });
  assert.ok(validateCatalog([uncapped], policy).some((i) => i.issue.includes('spending_cap')));
});

test('grounding guard rejects invented prices', () => {
  const facts = { plans: [{ estimated_cost: 144, estimated_monthly_cost: 12 }, { estimated_cost: 191.88 }] };
  assert.equal(checkGrounding('PAYG costs about $12/month ($144/year).', facts).grounded, true);
  assert.equal(checkGrounding('You save $47.88 per year.', facts).grounded, true); // difference
  assert.deepEqual(checkGrounding('Special deal: just $4.99!', facts).ungrounded, [4.99]);
});

test('rule-based intent parsing', () => {
  assert.equal(parseIntent('I watch about 3 movies a week').usage, 26);
  assert.equal(parseIntent('maybe 10 hours a month, I like predictable bills').preference, 'predictable');
  assert.equal(parseIntent('I want to cancel').cancel, true);
  assert.equal(parseIntent('around 50k calls', 'k calls').usage, 50);
});

test('usage ledger deduplicates events and caps charges', () => {
  const ledger = new UsageLedger(new Store());
  const p = { ...policy, cap_reached_behavior: 'stop_billing' };
  const ev = (id, q) => ({ event_id: id, customer_reference: 'c1', metric: 'h', quantity: q, occurred_at: '2026-10-05T10:00:00Z' });
  assert.equal(ledger.record('m1', ev('e1', 20), { plan, policy: p }).accepted, true);
  assert.equal(ledger.record('m1', ev('e1', 20), { plan, policy: p }).duplicate, true);
  const r = ledger.record('m1', ev('e2', 15), { plan, policy: p });
  assert.equal(r.period_usage, 35);
  assert.equal(r.cap.reached, true);
  const inv = ledger.generateInvoice('m1', { customerRef: 'c1', plan, period: '2026-10' });
  assert.equal(inv.amount, 18);
  assert.equal(inv.cap_applied, true);
  assert.equal(ledger.generateInvoice('m1', { customerRef: 'c1', plan, period: '2026-10' }).id, inv.id); // idempotent
  // tenant isolation
  assert.equal(ledger.usageFor('m2', 'c1', 'h', '2026-10'), 0);
});
