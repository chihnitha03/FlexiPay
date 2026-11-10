// Public API used by the embeddable widget. Customer identity comes only from a merchant-signed
// session token (X-FlexPrice-Session); the browser can never pick an arbitrary customer.

import express from 'express';
import { verifySession } from '../core/session-token.js';
import { periodOf } from '../core/usage-ledger.js';

export function widgetApi({ pricing, billing, store, ledger, advisor, config }) {
  const r = express.Router({ mergeParams: true });

  r.use((req, res, next) => {
    const m = pricing.merchant(req.params.merchantId);
    req.merchant = m;
    const token = req.get('x-flexprice-session');
    req.customerRef = token ? verifySession(token, m.widgetSecret, m.id)?.customerRef ?? null : null;
    if (token && !req.customerRef) return res.status(401).json({ error: 'invalid or expired session' });
    next();
  });
  const requireCustomer = (req, res, next) => (req.customerRef ? next() : res.status(401).json({ error: 'customer session required' }));

  r.get('/config', async (req, res) => {
    const gw = req.merchant.gateway;
    const manifest = await gw.getManifest();
    res.json({
      merchant_id: req.merchant.id,
      name: manifest.name,
      vertical: manifest.vertical,
      usage: manifest.usage,
      branding: manifest.branding,
      checkout_url: manifest.checkout_url ?? null,
      capabilities: await gw.capabilities(),
      integration: req.merchant.integration,
      paypal: { mode: billing.paymentsMode, client_id: ['sandbox', 'live'].includes(billing.paymentsMode) ? config.paypal.clientId : null, vault: billing.vaultSupported },
      ai: { enabled: advisor.enabled, model: advisor.enabled ? config.ai.model : null },
      customer_authenticated: Boolean(req.customerRef),
    });
  });

  const parseInputs = (body = {}) => {
    const usage = body.monthly_usage == null || body.monthly_usage === '' ? undefined : Number(body.monthly_usage);
    if (usage != null && (!Number.isFinite(usage) || usage < 0 || usage > 1e6)) throw Object.assign(new Error('monthly_usage must be a non-negative number'), { status: 400 });
    return { monthlyUsage: usage, preference: body.preference, horizonMonths: Math.min(36, Math.max(1, Number(body.horizon_months) || 12)) };
  };

  // Fast, deterministic: prices never wait on the LLM. Pass explain:false and call /explain separately.
  r.post('/recommend', async (req, res) => {
    const inputs = parseInputs(req.body);
    const explain = req.body?.explain === 'template' ? 'template' : req.body?.explain !== false;
    const { ctx, forecast, recommendation, explanation, served } = await pricing.recommend(req.merchant.id, req.customerRef, { ...inputs, explain, record: req.body?.record !== false });
    res.json({
      customer: req.customerRef ? { display_name: ctx.customer.display_name, current_plan_id: ctx.customer.current_plan_id, subscription_status: ctx.customer.subscription_status, tenure_months: ctx.customer.tenure_months } : null,
      plans: ctx.eligible,
      excluded_plans: ctx.excluded,
      history: ctx.history,
      forecast,
      recommendation,
      explanation,
      served,
      warnings: ctx.warnings,
    });
  });

  r.post('/explain', async (req, res) => {
    const { explanation, recommendation } = await pricing.recommend(req.merchant.id, req.customerRef, { ...parseInputs(req.body), record: false });
    res.json({ recommended_plan_id: recommendation.recommended_plan_id, ...explanation });
  });

  r.post('/chat', async (req, res) => {
    const { message, history = [] } = req.body ?? {};
    if (!message || typeof message !== 'string') return res.status(400).json({ error: 'message is required' });
    const m = req.merchant;
    const manifest = await m.gateway.getManifest();
    const out = await advisor.chat({
      message: message.slice(0, 1000),
      history: Array.isArray(history) ? history : [],
      merchantName: manifest.name,
      usageLabel: manifest.usage?.label ?? 'units per month',
      usageUnit: manifest.usage?.unit ?? 'units',
      tools: {
        compare_plans: (args) => pricing.compareForAI(m.id, req.customerRef, args),
        usage_summary: () => pricing.usageSummary(m.id, req.customerRef),
        retention_options: () => (req.customerRef ? pricing.retentionOptions(m.id, req.customerRef) : { note: 'customer is not signed in' }),
      },
    });
    store.metric(m.id, 'ai_chat', { source: out.source });
    res.json(out);
  });

  r.get('/plans/:planId/terms', async (req, res) => {
    const plan = await req.merchant.gateway.getPlan(req.params.planId);
    if (!plan) return res.status(404).json({ error: 'plan not found' });
    // Signed-in customers get a personal quote (proration of their current period).
    const ctx = req.customerRef ? await pricing.context(req.merchant.id, req.customerRef, { includeHistory: false }) : null;
    const { disclosure, terms_hash } = billing.termsFor(req.merchant, plan, ctx);
    res.json({ disclosure, terms_hash });
  });

  r.post('/consents', requireCustomer, async (req, res) => {
    const { plan_id, terms_hash, recommendation_id } = req.body ?? {};
    const consent = await billing.recordConsent(req.merchant.id, req.customerRef, plan_id, { termsHash: terms_hash, recommendationId: recommendation_id });
    res.status(201).json({ consent_id: consent.id, accepted_at: consent.accepted_at });
  });

  r.post('/checkout', requireCustomer, async (req, res) => {
    const { plan_id, consent_id, context } = req.body ?? {};
    const out = await billing.startCheckout(req.merchant.id, req.customerRef, plan_id, { consentId: consent_id });
    if (context === 'retention') store.update(req.merchant.id, 'checkouts', out.checkout_id, { retention: true });
    res.status(201).json(out);
  });

  r.post('/checkout/:orderId/capture', requireCustomer, async (req, res) => {
    res.json(await billing.captureCheckout(req.merchant.id, req.customerRef, req.params.orderId));
  });

  // $0-due metered plan: buyer approved saving PayPal for usage billing (Vault setup token).
  r.post('/checkout/:checkoutId/payment-method', requireCustomer, async (req, res) => {
    res.json(await billing.completePaymentMethodSetup(req.merchant.id, req.customerRef, req.params.checkoutId));
  });

  r.get('/payment-method', requireCustomer, (req, res) => res.json({ payment_method: billing.paymentMethodView(req.merchant.id, req.customerRef) }));
  r.delete('/payment-method', requireCustomer, async (req, res) => res.json(await billing.removePaymentMethod(req.merchant.id, req.customerRef)));

  r.post('/retention/options', requireCustomer, async (req, res) => {
    store.metric(req.merchant.id, 'cancel_intent', { customer_reference: req.customerRef });
    res.json(await pricing.retentionOptions(req.merchant.id, req.customerRef));
  });

  r.post('/retention/accept', requireCustomer, async (req, res) => {
    const { action, months, reason } = req.body ?? {};
    const m = req.merchant;
    const gw = m.gateway;
    const key = `ret-${req.customerRef}-${action}-${new Date().toISOString().slice(0, 10)}`;
    res.on('finish', () => pricing.invalidate(m.id, req.customerRef)); // subscription state changed
    if (action === 'cancel') {
      const out = await store.idempotent(m.id, key, () => gw.cancelSubscription(req.customerRef, { reason: String(reason ?? '').slice(0, 200), idempotencyKey: key }));
      store.metric(m.id, 'cancellation', { customer_reference: req.customerRef, reason });
      billing.onRetentionAction(m.id, req.customerRef, 'cancel');
      store.audit(m.id, 'subscription_cancelled', { customer_reference: req.customerRef, reason });
      return res.json(out);
    }
    // Re-check policy server-side: the client can't grant itself an offer.
    const options = await pricing.retentionOptions(m.id, req.customerRef);
    if (action === 'pause') {
      if (!options.pause.eligible) return res.status(403).json({ error: options.pause.reason });
      const n = Math.min(options.pause.max_months, Math.max(1, Number(months) || 1));
      const out = await store.idempotent(m.id, key, () => gw.pauseSubscription(req.customerRef, { months: n, idempotencyKey: key }));
      const monthly = options.current_estimated_monthly_cost ?? 0;
      store.metric(m.id, 'retention_save', { type: 'pause', customer_reference: req.customerRef, retained_revenue_12m: Math.round(monthly * (12 - n) * 100) / 100 });
      store.audit(m.id, 'subscription_paused', { customer_reference: req.customerRef, months: n });
      billing.onRetentionAction(m.id, req.customerRef, 'pause', { months: n });
      return res.json(out);
    }
    if (action === 'discount') {
      if (!options.discount.eligible || !options.discount.offer) return res.status(403).json({ error: options.discount.reason ?? 'not eligible' });
      const offer = { percent: options.discount.offer.percent, months: options.discount.offer.months };
      const out = await store.idempotent(m.id, key, () => gw.applyRetentionOffer(req.customerRef, offer, { idempotencyKey: key }));
      store.insert(m.id, 'offers', { type: 'discount', customer_reference: req.customerRef, ...offer, granted_at: new Date().toISOString() });
      const monthly = options.current_estimated_monthly_cost ?? 0;
      store.metric(m.id, 'retention_save', { type: 'discount', customer_reference: req.customerRef, retained_revenue_12m: Math.round(monthly * (12 - (offer.percent / 100) * offer.months) * 100) / 100 });
      store.audit(m.id, 'retention_offer_applied', { customer_reference: req.customerRef, ...offer });
      return res.json(out);
    }
    res.status(400).json({ error: 'action must be cancel, pause or discount (plan switches go through checkout)' });
  });

  r.get('/usage/current', requireCustomer, async (req, res) => {
    const ctx = await pricing.context(req.merchant.id, req.customerRef, { includeHistory: false });
    const plan = ctx.plans.find((p) => p.plan_id === ctx.customer.current_plan_id);
    const period = periodOf(new Date().toISOString());
    const usage = plan?.usage_metric ? ledger.usageFor(req.merchant.id, req.customerRef, plan.usage_metric, period, plan.plan_id) : 0;
    res.json({
      period,
      plan_id: plan?.plan_id ?? null,
      metered: Boolean(plan && plan.billing_model !== 'fixed'),
      usage: Math.round(usage * 100) / 100,
      charge_so_far: plan ? ledger.rate(req.merchant.id, { customerRef: req.customerRef, plan, period }) / 100 : 0,
      cap: plan ? ledger.capStatus(plan, usage, req.merchant.policy) : null,
      invoices: store.find(req.merchant.id, 'invoices', (i) => i.customer_reference === req.customerRef),
      payment_method: billing.paymentMethodView(req.merchant.id, req.customerRef),
      subscription: billing.subscriptionView(req.merchant.id, req.customerRef),
    });
  });

  r.post('/invoices/:invoiceId/pay', requireCustomer, async (req, res) => {
    res.status(201).json(await billing.payInvoice(req.merchant.id, req.customerRef, req.params.invoiceId));
  });

  return r;
}

