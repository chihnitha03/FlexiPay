// CodeCloud — a mock developer-API SaaS integrated as an in-process JavaScript adapter
// (the "SDK" integration style). Metric: thousands of API calls, with graduated tiered pricing.
// Declares no pause/retention capabilities, so FlexPrice will not offer them.

import { makeHistory, makeCohort } from '../seed.js';

const plans = [
  { plan_id: 'cc_starter', name: 'Starter (Flat)', billing_model: 'fixed', billing_interval: 'month', base_price: 29, currency: 'USD', features: ['Unlimited API calls', 'Email support'], terms: { summary: '$29 billed monthly. Cancel anytime.' } },
  { plan_id: 'cc_annual', name: 'Starter Annual', billing_model: 'fixed', billing_interval: 'year', base_price: 290, currency: 'USD', features: ['Unlimited API calls', 'Email support', '2 months free'], terms: { summary: '$290 billed annually up-front. Renews yearly.' } },
  {
    plan_id: 'cc_metered', name: 'Metered (Tiered)', billing_model: 'tiered', billing_interval: 'month', base_price: 0, currency: 'USD', usage_metric: 'api_calls_k', unit: 'k calls',
    tier_rules: [{ up_to: 20, unit_price: 0.5 }, { up_to: 100, unit_price: 0.3 }, { up_to: null, unit_price: 0.15 }],
    minimum_charge: 5, spending_cap: 79,
    features: ['Pay per 1k calls', 'Volume discounts', 'Cap $79/month'],
    terms: { summary: '$0.50/1k calls up to 20k, $0.30/1k to 100k, then $0.15/1k. Minimum $5, capped at $79/month.' },
  },
  {
    plan_id: 'cc_hybrid', name: 'Builder (Base + Overage)', billing_model: 'hybrid', billing_interval: 'month', base_price: 15, currency: 'USD', usage_metric: 'api_calls_k', unit: 'k calls',
    included_usage: 40, unit_price: 0.2, spending_cap: 59,
    features: ['40k calls included', '$0.20 per extra 1k', 'Cap $59/month'],
    terms: { summary: '$15/month includes 40k calls; $0.20 per additional 1k, capped at $59/month.' },
  },
];

export class CodeCloudAdapter {
  constructor() {
    this.customers = new Map([
      ['acct_9001', { name: 'Nova Labs (growing startup)', plan: 'cc_starter', tenure: 7, history: makeHistory({ months: 9, base: 18, trend: 4, noise: 0.15, seed: 91 }) }],
      ['acct_9002', { name: 'Quill (steady low usage)', plan: 'cc_starter', tenure: 15, history: makeHistory({ months: 12, base: 22, noise: 0.2, seed: 92 }) }],
      ['acct_9003', { name: 'Orbit (heavy usage)', plan: 'cc_metered', tenure: 20, history: makeHistory({ months: 12, base: 150, noise: 0.1, seed: 93 }) }],
    ]);
    this.subs = new Map([...this.customers].map(([k, v]) => [k, { plan: v.plan, status: 'active' }]));
    this.applied = new Map();
  }

  async getManifest() {
    return {
      merchant_id: 'codecloud',
      name: 'CodeCloud API',
      vertical: 'saas',
      capabilities: ['plans', 'customer_context', 'usage_history', 'usage_metering', 'change_plan', 'subscription_status', 'cancel_subscription', 'cohort_usage'],
      usage: { metric: 'api_calls_k', unit: 'k calls', label: 'thousand API calls per month', default_monthly_usage: 30, slider_max: 300 },
      branding: { primary: '#2563eb', logo_text: 'CodeCloud' },
    };
  }
  async getPlans() { return plans; }
  async getCohortUsage() {
    this.cohort ??= makeCohort({
      size: 400,
      seed: 202,
      segments: [
        { share: 0.5, median: 15, spread: 0.6, plans: { cc_starter: 0.8, cc_metered: 0.2 } },
        { share: 0.35, median: 60, spread: 0.4, plans: { cc_starter: 0.6, cc_hybrid: 0.3, cc_annual: 0.1 } },
        { share: 0.15, median: 180, spread: 0.3, plans: { cc_metered: 0.5, cc_annual: 0.3, cc_starter: 0.2 } },
      ],
    });
    return this.cohort;
  }
  async getCustomerContext(ref) {
    const c = this.customers.get(ref);
    if (!c) throw Object.assign(new Error('customer not found'), { status: 404 });
    const s = this.subs.get(ref);
    return { customer_reference: ref, display_name: c.name.split(' (')[0], current_plan_id: s.status === 'cancelled' ? null : s.plan, tenure_months: c.tenure, subscription_status: s.status };
  }
  async getUsage(ref) { return this.customers.get(ref)?.history ?? []; }
  async recordUsage(event) { return { accepted: true, event_id: event.event_id }; }
  async changePlan(ref, planId, { idempotencyKey, paymentReference }) {
    if (this.applied.has(idempotencyKey)) return this.applied.get(idempotencyKey);
    const s = this.subs.get(ref);
    const prev = s.plan;
    Object.assign(s, { plan: planId, status: 'active' });
    const out = { status: 'applied', customer_reference: ref, previous_plan_id: prev, current_plan_id: planId, payment_reference: paymentReference ?? null, effective_at: new Date().toISOString() };
    this.applied.set(idempotencyKey, out);
    return out;
  }
  async getSubscriptionStatus(ref) {
    const s = this.subs.get(ref);
    return { customer_reference: ref, plan_id: s.status === 'cancelled' ? null : s.plan, status: s.status, entitlements: s.status === 'active' ? ['api_access'] : [] };
  }
  async cancelSubscription(ref, { reason }) {
    this.subs.get(ref).status = 'cancelled';
    return { status: 'cancelled', reason, effective_at: new Date().toISOString() };
  }

  demoCustomers() {
    return [...this.customers].map(([uid, c]) => ({ uid, name: c.name, plan: this.subs.get(uid).plan, status: this.subs.get(uid).status }));
  }
}
