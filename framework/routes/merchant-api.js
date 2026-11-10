// Merchant (server-to-server + dashboard) API. Authenticated by a per-merchant API key; the key
// alone determines the tenant, enforcing isolation between merchants.

import express from 'express';
import crypto from 'node:crypto';
import { validateCatalog } from '../core/policy-engine.js';
import { monthlyCost, breakEven } from '../core/pricing-engine.js';
import { CAPABILITY_METHODS } from '../adapters/contract.js';
import { ValidationError } from '../core/models.js';
import { periodOf } from '../core/usage-ledger.js';

export function merchantApi({ pricing, billing, store, ledger, insights, events }) {
  const r = express.Router();

  r.use((req, res, next) => {
    const key = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const m = [...pricing.registry.values()].find((x) => x.adminApiKey.length === key.length && crypto.timingSafeEqual(Buffer.from(x.adminApiKey), Buffer.from(key)));
    if (!m) return res.status(401).json({ error: 'invalid merchant API key' });
    req.merchant = m;
    next();
  });

  /** Trusted usage ingestion: single event or { events: [...] }. Deduplicated by event_id. */
  r.post('/usage', async (req, res) => {
    const m = req.merchant;
    const batch = Array.isArray(req.body?.events) ? req.body.events : [req.body];
    if (batch.length > 500) return res.status(413).json({ error: 'max 500 events per batch' });
    const results = [];
    for (const ev of batch) {
      try {
        const ctx = await pricing.context(m.id, ev.customer_reference, { includeHistory: false });
        const plan = ctx.plans.find((p) => p.plan_id === ctx.customer.current_plan_id);
        const out = ledger.record(m.id, ev, { plan, policy: m.policy });
        if (out.accepted && ctx.capabilities.usage_metering) await m.gateway.recordUsage(ev).catch(() => {});
        // O(1)-ish check: only flags the precomputed recommendation if a break-even point was crossed.
        if (out.accepted && out.period === periodOf(new Date().toISOString())) out.recommendation = pricing.onUsage(m.id, ev.customer_reference, { periodUsage: out.period_usage });
        if (out.cap_just_reached) events.emit(m.id, 'usage.cap_reached', { customer_reference: ev.customer_reference, period: out.period, spending_cap: out.cap.spending_cap, behavior: out.cap.behavior });
        results.push(out);
      } catch (err) {
        results.push({ accepted: false, event_id: ev?.event_id, error: err.message, details: err.details });
      }
    }
    res.status(results.every((x) => x.accepted || x.duplicate) ? 200 : 207).json(batch.length === 1 ? results[0] : { results });
  });

  r.get('/overview', async (req, res) => {
    const m = req.merchant;
    const metrics = store.find(m.id, 'metrics');
    const count = (n) => metrics.filter((x) => x.name === n).length;
    const selections = metrics.filter((x) => x.name === 'plan_selected');
    const payments = metrics.filter((x) => x.name === 'payment_captured');
    const cancelIntents = count('cancel_intent');
    const saves = count('retention_save') + selections.filter((s) => s.retention_save).length;
    const chats = metrics.filter((x) => x.name === 'ai_chat');
    // Merchant revenue view (12-month estimates). Recommending cheaper plans shifts revenue down;
    // saves keep revenue that would otherwise churn. Both are shown so the trade-off is explicit.
    const shifted = selections.filter((s) => !s.retention_save && s.revenue_delta_12m != null).reduce((a, s) => a + s.revenue_delta_12m, 0);
    const retained =
      selections.filter((s) => s.retention_save && s.revenue_delta_12m != null).reduce((a, s) => a + s.revenue_delta_12m, 0) +
      metrics.filter((x) => x.name === 'retention_save').reduce((a, s) => a + (s.retained_revenue_12m ?? 0), 0);
    const byPlan = {};
    selections.forEach((s) => (byPlan[s.plan_id] = (byPlan[s.plan_id] || 0) + 1));
    res.json({
      merchant: { id: m.id, name: m.name, integration: m.integration },
      metrics: {
        recommendations_shown: count('recommendation_shown'),
        plans_selected: selections.length,
        followed_recommendation_rate: selections.length ? round(selections.filter((s) => s.followed_recommendation).length / selections.length) : null,
        estimated_customer_savings: round(selections.reduce((s, x) => s + (x.estimated_savings > 0 ? x.estimated_savings : 0), 0)),
        payments_captured: payments.length,
        revenue_captured: round(payments.reduce((s, p) => s + p.amount, 0)),
        cancel_intents: cancelIntents,
        retention_saves: saves,
        cancellations: count('cancellation'),
        retention_save_rate: cancelIntents ? round(saves / cancelIntents) : null,
        revenue_shifted_by_switches_12m: round(shifted),
        revenue_retained_by_saves_12m: round(retained),
        net_revenue_impact_12m: round(shifted + retained),
        auto_collected_payments: payments.filter((p) => p.merchant_initiated).length,
        ai_chats: chats.length,
        ai_chats_by_source: chats.reduce((a, c) => ({ ...a, [c.source]: (a[c.source] || 0) + 1 }), {}),
        selections_by_plan: byPlan,
      },
      integration_health: m.gateway.health,
      snapshot_cache: pricing.cache.info(),
      policy: m.policy,
      paypal_mode: billing.paymentsMode,
    });
  });

  /** Adapter conformance check used during onboarding (PRD §5.6 step 5). */
  r.get('/validate', async (req, res) => {
    const m = req.merchant;
    const checks = [];
    const check = async (name, fn) => {
      const t = Date.now();
      try {
        const detail = await fn();
        checks.push({ name, ok: true, ms: Date.now() - t, detail });
      } catch (err) {
        checks.push({ name, ok: false, ms: Date.now() - t, error: err.message, details: err instanceof ValidationError ? err.details : undefined });
      }
    };
    await check('manifest', async () => {
      const mf = await m.gateway.getManifest({ refresh: true });
      return { capabilities: mf.capabilities, usage_metric: mf.usage?.metric };
    });
    await check('plans schema', async () => `${(await m.gateway.getPlans({ refresh: true })).length} plans valid`);
    await check('policy guardrails', async () => {
      const issues = validateCatalog(await m.gateway.getPlans(), m.policy);
      if (issues.some((i) => i.severity === 'error')) throw new ValidationError('Catalog violates policy', issues.map((i) => `${i.plan_id}: ${i.issue}`));
      return issues.length ? issues.map((i) => `${i.plan_id}: ${i.issue}`) : 'ok';
    });
    const caps = await m.gateway.capabilities().catch(() => ({}));
    // Customer-level checks need a known sample customer (query param or registration setting).
    const sample = req.query.customer || m.validationCustomerRef;
    if (sample) {
      if (caps.customer_context) await check('customer context', async () => { const c = await m.gateway.getCustomerContext(sample); return { current_plan_id: c.current_plan_id }; });
      if (caps.usage_history) await check('usage history', async () => `${(await m.gateway.getUsage(sample, {})).length} months`);
      if (caps.subscription_status) await check('subscription status', async () => (await m.gateway.getSubscriptionStatus(sample)).status);
    } else if (caps.customer_context) {
      checks.push({ name: 'customer-level checks', ok: true, ms: 0, detail: 'skipped — pass ?customer=<ref> to include them' });
    }
    res.json({
      merchant_id: m.id,
      ok: checks.every((c) => c.ok),
      checks,
      capabilities: Object.keys(CAPABILITY_METHODS).map((c) => ({ capability: c, method: CAPABILITY_METHODS[c], supported: Boolean(caps[c]) })),
      modes: { pricing_advisor: Boolean(caps.plans), adaptive_billing: Boolean(caps.usage_metering && caps.change_plan && caps.subscription_status) },
    });
  });

  /** Cost curves for the dashboard's break-even chart. */
  r.get('/cost-curves', async (req, res) => {
    const plans = await req.merchant.gateway.getPlans();
    const manifest = await req.merchant.gateway.getManifest();
    const max = Number(req.query.max) || manifest.usage?.slider_max || 100;
    const steps = 40;
    const xs = Array.from({ length: steps + 1 }, (_, i) => Math.round((i * max * 10) / steps) / 10);
    res.json({
      unit: manifest.usage?.unit,
      x: xs,
      series: plans.map((p) => ({ plan_id: p.plan_id, name: p.name, y: xs.map((x) => monthlyCost(p, x).cents / 100) })),
      break_even: plans.flatMap((a, i) => plans.slice(i + 1).map((b) => ({ a: a.plan_id, b: b.plan_id, usage: breakEven(a, b, max) })).filter((x) => x.usage != null)),
    });
  });

  r.get('/plans', async (req, res) => res.json({ plans: await req.merchant.gateway.getPlans({ refresh: true }), issues: validateCatalog(await req.merchant.gateway.getPlans(), req.merchant.policy) }));
  r.get('/audit', (req, res) => res.json(store.find(req.merchant.id, 'audit').slice(-200).reverse()));
  r.get('/checkouts', (req, res) => res.json(store.find(req.merchant.id, 'checkouts').slice(-100).reverse()));
  r.get('/subscriptions', (req, res) => res.json(store.find(req.merchant.id, 'subscriptions').slice(-200).reverse()));
  // Outbound event webhooks: delivery log, manual redelivery, and a test ping.
  r.get('/events', (req, res) => res.json(store.find(req.merchant.id, 'events', (e) => (!req.query.type || e.type === req.query.type) && (!req.query.status || e.status === req.query.status)).slice(-200).reverse()));
  r.post('/events/:id/redeliver', async (req, res) => res.json(await events.redeliver(req.merchant.id, req.params.id)));
  r.post('/events/test', (req, res) => res.status(201).json(events.emit(req.merchant.id, 'test.ping', { message: 'Hello from FlexPrice' })));
  r.get('/invoices', (req, res) => res.json(store.find(req.merchant.id, 'invoices').slice(-100).reverse()));
  r.post('/reconcile', async (req, res) => res.json(await billing.reconcile(req.merchant.id)));
  r.post('/checkouts/:id/refund', async (req, res) => res.json(await billing.refund(req.merchant.id, req.params.id)));
  r.post('/customers/:ref/close-period', async (req, res) => res.status(201).json(await billing.closePeriod(req.merchant.id, req.params.ref, req.body?.period)));
  /** Pricing Insights: advisor revenue/churn impact + AI (or heuristic) catalog experiments. */
  r.post('/insights', async (req, res) => {
    const goal = ['balanced', 'retention', 'revenue'].includes(req.body?.goal) ? req.body.goal : 'balanced';
    res.status(201).json(await insights.generate(req.merchant.id, { goal, assumptions: sanitizeAssumptions(req.body?.assumptions), grandfather: req.body?.grandfather !== false, newCustomersPct: Math.min(100, Math.max(0, Number(req.body?.new_customers_pct) || 0)) }));
  });
  r.get('/insights/latest', (req, res) => res.json(insights.latest(req.merchant.id)));

  /** Merchant tells FlexPrice a customer changed outside FlexPrice (plan, entitlement, data fix). */
  r.post('/customers/:ref/invalidate', (req, res) => {
    pricing.invalidate(req.merchant.id, req.params.ref);
    res.json({ invalidated: req.params.ref });
  });

  /** Bulk precompute default recommendations (e.g. nightly or after month close). Max 1000 per call. */
  r.post('/precompute', async (req, res) => {
    const refs = Array.isArray(req.body?.customer_refs) ? req.body.customer_refs.map(String).slice(0, 1000) : [];
    if (!refs.length) return res.status(400).json({ error: 'customer_refs (array, max 1000) is required' });
    res.json(await pricing.precompute(req.merchant.id, refs, { withExplanations: req.body?.with_explanations === true }));
  });

  /** Charge automatic usage invoices whose notice period has elapsed (call from a scheduler). */
  r.post('/billing/run', async (req, res) => res.json(await billing.runBilling(req.merchant.id, { asOf: req.body?.as_of ? new Date(req.body.as_of) : new Date() })));
  r.post('/paypal/sync-catalog', async (req, res) => res.json(await billing.syncCatalog(req.merchant.id)));

  return r;
}

const round = (n) => Math.round(n * 100) / 100;

function sanitizeAssumptions(a = {}) {
  const out = {};
  for (const k of ['adoption_rate', 'base_annual_churn', 'overpay_churn_sensitivity']) {
    const v = Number(a?.[k]);
    if (Number.isFinite(v) && v >= 0 && v <= 1) out[k] = v;
  }
  return out;
}
