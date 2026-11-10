// StreamFlix — a mock streaming merchant with its OWN backend and data model.
// The `/flexprice/*` routes below are StreamFlix's thin adapter: they translate StreamFlix's
// native records (prices in cents, "tiers", watch-minute logs) into the FlexPrice contract.
// FlexPrice talks to it only over HTTP via HttpAdapter, exactly like a real external merchant.

import express from 'express';
import crypto from 'node:crypto';
import { makeHistory, makeCohort } from '../seed.js';
import { signSession } from '../../framework/core/session-token.js';
import { verifyEventSignature } from '../../framework/sdk/index.js';

export const STREAMFLIX = {
  id: 'streamflix',
  adapterApiKey: process.env.STREAMFLIX_ADAPTER_KEY || 'sf_adapter_demo_key',
  flexpriceApiKey: process.env.STREAMFLIX_FLEXPRICE_KEY || 'sf_admin_demo_key',
  eventsSecret: process.env.STREAMFLIX_EVENTS_SECRET || 'sf_events_demo_secret',
  widgetSecret: process.env.STREAMFLIX_WIDGET_SECRET || 'sf_widget_demo_secret',
};

// ---- StreamFlix's native data model (deliberately different from FlexPrice's) ----
const tiers = [
  { sku: 'SF-STD-M', title: 'Standard Monthly', kind: 'flat', cents: 1599, cycle: 'monthly', perks: ['HD streaming', '2 screens', 'Unlimited watching'] },
  { sku: 'SF-STD-Y', title: 'Standard Annual', kind: 'flat', cents: 15999, cycle: 'yearly', perks: ['HD streaming', '2 screens', 'Unlimited watching', '2 months free vs monthly'] },
  { sku: 'SF-PAYG', title: 'Pay-As-You-Watch', kind: 'metered', cents: 0, centsPerHour: 60, minCents: 299, capCents: 1799, perks: ['HD streaming', '1 screen', 'Pay only for hours watched', 'Spending cap $17.99'] },
  { sku: 'SF-LITE', title: 'Lite + Hours', kind: 'base_plus', cents: 699, includedHours: 10, centsPerHour: 45, capCents: 1899, perks: ['HD streaming', '1 screen', '10 hours included', 'Spending cap $18.99'] },
];

const SEASON = [1.25, 1.1, 0.95, 0.85, 0.8, 0.75, 0.8, 0.85, 0.95, 1.05, 1.2, 1.45];
const accounts = new Map(
  [
    { uid: 'sf-1001', name: 'Asha (occasional viewer)', sku: 'SF-STD-M', since: '2025-08-02', region: 'US', history: makeHistory({ months: 12, base: 6, noise: 0.35, seed: 11 }) },
    { uid: 'sf-1002', name: 'Ben (binge watcher)', sku: 'SF-STD-M', since: '2024-01-15', region: 'US', history: makeHistory({ months: 12, base: 38, trend: 1.2, noise: 0.15, seed: 22 }) },
    { uid: 'sf-1003', name: 'Chen (seasonal viewer)', sku: 'SF-STD-M', since: '2024-06-10', region: 'US', history: makeHistory({ months: 18, base: 18, noise: 0.12, seasonal: SEASON, seed: 33 }) },
    { uid: 'sf-1004', name: 'Dana (used a retention offer recently)', sku: 'SF-STD-M', since: '2025-01-20', region: 'US', discountUsedAt: '2026-07-01', history: makeHistory({ months: 10, base: 9, noise: 0.25, seed: 44 }) },
    { uid: 'sf-1005', name: 'Eli (new visitor, no history)', sku: null, since: null, region: 'US', history: [] },
  ].map((a) => [a.uid, { ...a, status: a.sku ? 'active' : 'none', discount: null, pausedUntil: null, ledger: [] }]),
);

function toFlexPlan(t) {
  const common = { plan_id: t.sku, name: t.title, currency: 'USD', features: t.perks, usage_metric: 'watch_hours', unit: 'hours' };
  if (t.kind === 'flat') {
    return {
      ...common,
      billing_model: 'fixed',
      billing_interval: t.cycle === 'yearly' ? 'year' : 'month',
      base_price: t.cents / 100,
      usage_metric: null,
      terms: { summary: t.cycle === 'yearly' ? 'Billed $159.99 once per year. Renews automatically; cancel before renewal.' : 'Billed monthly. Cancel anytime.' },
    };
  }
  if (t.kind === 'metered') {
    return {
      ...common,
      billing_model: 'usage',
      billing_interval: 'month',
      base_price: 0,
      unit_price: t.centsPerHour / 100,
      minimum_charge: t.minCents / 100,
      spending_cap: t.capCents / 100,
      terms: { summary: `$${(t.centsPerHour / 100).toFixed(2)} per hour watched, minimum $${(t.minCents / 100).toFixed(2)}, never more than $${(t.capCents / 100).toFixed(2)} per month. Billed at month end. Cancel anytime.` },
    };
  }
  return {
    ...common,
    billing_model: 'hybrid',
    billing_interval: 'month',
    base_price: t.cents / 100,
    included_usage: t.includedHours,
    unit_price: t.centsPerHour / 100,
    spending_cap: t.capCents / 100,
    terms: { summary: `$${(t.cents / 100).toFixed(2)}/month includes ${t.includedHours} hours; extra hours $${(t.centsPerHour / 100).toFixed(2)} each, capped at $${(t.capCents / 100).toFixed(2)}/month. Cancel anytime.` },
  };
}

/** StreamFlix bills monthly on the signup day; FlexPrice uses this to prorate switches. */
function currentPeriod(since, now = new Date()) {
  if (!since) return { start: null, end: null };
  const day = new Date(since).getUTCDate();
  const at = (y, m) => new Date(Date.UTC(y, m, Math.min(day, new Date(Date.UTC(y, m + 1, 0)).getUTCDate())));
  let start = at(now.getUTCFullYear(), now.getUTCMonth());
  if (start > now) start = at(now.getUTCFullYear(), now.getUTCMonth() - 1);
  return { start: start.toISOString(), end: at(start.getUTCFullYear(), start.getUTCMonth() + 1).toISOString() };
}

// Emails StreamFlix "sent" in response to FlexPrice events (demo inbox).
const notifications = [];
const EMAIL = {
  'invoice.created': (d) => d.collection === 'automatic' ? `Your ${d.period} usage bill is ${money(d.amount)}. We'll charge your saved PayPal account on ${day(d.charge_scheduled_at)}.` : `Your ${d.period} bill of ${money(d.amount)} is ready to pay.`,
  'invoice.paid': (d) => `Payment received: ${money(d.amount)} (${d.kind}). Thank you!`,
  'invoice.payment_failed': (d) => `We couldn't charge ${money(d.amount)}. We'll retry on ${day(d.next_retry_at)}.`,
  'invoice.past_due': (d) => `Your payment of ${money(d.amount)} is past due. Please update your payment method.`,
  'subscription.renewal_upcoming': (d) => `Your plan renews on ${day(d.renews_at)} for ${money(d.amount)}.`,
  'subscription.renewed': (d) => `Your plan renewed for ${money(d.amount)}. Next renewal ${day(d.current_period_end)}.`,
  'plan.changed': (d) => `You're now on ${d.to_plan_id}.${d.proration_credit ? ` ${money(d.proration_credit)} credited for unused time on your old plan.` : ''}`,
  'usage.cap_reached': (d) => `You've reached your ${money(d.spending_cap)} monthly cap — you won't be charged more this month.`,
  'recommendation.savings_available': (d) => `Heads up: based on how much you watch this month, ${d.recommended_plan_name} could save you about ${money(d.estimated_savings_12m)} a year.`,
};
const money = (n) => `$${Number(n).toFixed(2)}`;
const day = (iso) => (iso ? new Date(iso).toDateString() : '—');

const tenureMonths = (since) => (since ? Math.max(0, Math.floor((Date.now() - Date.parse(since)) / (30.44 * 864e5))) : 0);

export function streamflixRouter() {
  const r = express.Router();
  r.use((req, res, next) => (req.path.startsWith('/hooks/') ? next() : express.json()(req, res, next))); // hooks need the raw body
  const idem = new Map();

  // --- StreamFlix's own website endpoints (not part of the FlexPrice contract) ---
  // FlexPrice → StreamFlix event webhooks. Verified with the FlexPrice SDK using the RAW body.
  r.post('/hooks/flexprice', express.text({ type: '*/*' }), (req, res) => {
    let evt;
    try {
      // req.rawBody is set when an upstream JSON parser already consumed the stream.
      evt = verifyEventSignature({ payload: req.rawBody ?? req.body, header: req.get('flexprice-signature'), secret: STREAMFLIX.eventsSecret });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    if (!notifications.some((n) => n.event_id === evt.id)) {
      const text = EMAIL[evt.type]?.(evt.data);
      if (text) notifications.push({ event_id: evt.id, type: evt.type, uid: evt.data.customer_reference, text, at: new Date().toISOString() });
    }
    res.sendStatus(204);
  });
  r.get('/site/notifications', (req, res) => res.json(notifications.filter((n) => !req.query.uid || n.uid === req.query.uid).slice(-30).reverse()));

  r.get('/site/accounts', (_req, res) => {
    res.json([...accounts.values()].map((a) => ({ uid: a.uid, name: a.name, plan: a.sku, status: a.status })));
  });
  // StreamFlix's login system would normally do this after authenticating the user.
  r.post('/site/session', (req, res) => {
    const acct = accounts.get(req.body?.uid);
    if (!acct) return res.status(404).json({ error: 'unknown account' });
    res.json({ token: signSession({ merchantId: STREAMFLIX.id, customerRef: acct.uid }, STREAMFLIX.widgetSecret), customer: acct.uid });
  });
  // Simulates StreamFlix's player reporting watch time. In production this is StreamFlix's
  // trusted backend pushing usage to FlexPrice; here the player calls its own backend which forwards.
  r.post('/site/watch', async (req, res) => {
    const acct = accounts.get(req.body?.uid);
    if (!acct) return res.status(404).json({ error: 'unknown account' });
    const minutes = Math.max(1, Math.min(1440, Number(req.body.minutes) || 60));
    const eventId = req.body.event_id || `sfwatch-${acct.uid}-${crypto.randomUUID()}`;
    const at = new Date().toISOString();
    acct.ledger.push({ eventId, minutes, at });
    // StreamFlix backend → FlexPrice usage ingestion (trusted, server-to-server, deduplicated by event_id)
    const fp = await fetch(`${req.protocol}://${req.get('host')}/api/v1/merchant/usage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${STREAMFLIX.flexpriceApiKey}` },
      body: JSON.stringify({ event_id: eventId, customer_reference: acct.uid, metric: 'watch_hours', quantity: Math.round((minutes / 60) * 100) / 100, unit: 'hours', occurred_at: at, source: 'streamflix-player' }),
    });
    res.status(fp.status).json({ event_id: eventId, minutes, flexprice: await fp.json() });
  });

  // --- FlexPrice adapter contract (authenticated) ---
  const a = express.Router();
  a.use((req, res, next) => {
    if (req.get('authorization') !== `Bearer ${STREAMFLIX.adapterApiKey}`) return res.status(401).json({ error: 'unauthorized' });
    next();
  });
  const acct = (req, res) => {
    const x = accounts.get(req.params.ref);
    if (!x) res.status(404).json({ error: 'customer not found' });
    return x;
  };

  a.get('/manifest', (_req, res) =>
    res.json({
      merchant_id: STREAMFLIX.id,
      name: 'StreamFlix',
      vertical: 'streaming',
      capabilities: ['plans', 'customer_context', 'usage_history', 'usage_metering', 'change_plan', 'subscription_status', 'pause_subscription', 'cancel_subscription', 'retention_offers', 'cohort_usage'],
      usage: { metric: 'watch_hours', unit: 'hours', label: 'hours watched per month', default_monthly_usage: 15, slider_max: 80 },
      branding: { primary: '#e50914', logo_text: 'StreamFlix' },
    }),
  );
  a.get('/plans', (_req, res) => res.json({ plans: tiers.map(toFlexPlan) }));
  // Anonymized usage sample (no account IDs) for FlexPrice Pricing Insights.
  const cohort = makeCohort({
    size: 600,
    seed: 101,
    segments: [
      { share: 0.45, median: 6, spread: 0.5, plans: { 'SF-STD-M': 0.85, 'SF-PAYG': 0.1, 'SF-LITE': 0.05 } },
      { share: 0.35, median: 18, spread: 0.35, plans: { 'SF-STD-M': 0.8, 'SF-STD-Y': 0.1, 'SF-LITE': 0.1 } },
      { share: 0.2, median: 45, spread: 0.3, plans: { 'SF-STD-M': 0.6, 'SF-STD-Y': 0.35, 'SF-PAYG': 0.05 } },
    ],
  });
  a.get('/cohort-usage', (_req, res) => res.json({ cohort }));
  a.get('/customers/:ref', (req, res) => {
    const x = acct(req, res);
    if (!x) return;
    res.json({
      customer_reference: x.uid,
      display_name: x.name.split(' ')[0],
      current_plan_id: x.status === 'cancelled' ? null : x.sku,
      tenure_months: tenureMonths(x.since),
      region: x.region,
      has_active_discount: Boolean(x.discount && Date.parse(x.discount.until) > Date.now()),
      last_retention_offer_at: x.discountUsedAt ?? null,
      subscription_status: x.status,
      // Only meaningful while StreamFlix itself bills the plan (before a FlexPrice switch).
      current_period_start: x.flexBilled ? null : currentPeriod(x.since).start,
      current_period_end: x.flexBilled ? null : currentPeriod(x.since).end,
    });
  });
  a.get('/customers/:ref/usage', (req, res) => {
    const x = acct(req, res);
    if (!x) return;
    const live = {};
    x.ledger.forEach((l) => (live[l.at.slice(0, 7)] = (live[l.at.slice(0, 7)] || 0) + l.minutes / 60));
    const usage = x.history.map((h) => ({ ...h })).filter((h) => (!req.query.from || h.period >= req.query.from) && (!req.query.to || h.period <= req.query.to));
    for (const [period, hours] of Object.entries(live)) {
      const row = usage.find((u) => u.period === period);
      if (row) row.quantity = Math.round((row.quantity + hours) * 10) / 10;
    }
    res.json({ metric: 'watch_hours', usage });
  });
  a.post('/usage', (req, res) => res.json({ accepted: true, event_id: req.body.event_id }));
  a.post('/customers/:ref/plan-change', (req, res) => {
    const x = acct(req, res);
    if (!x) return;
    const key = req.get('idempotency-key');
    if (!key) return res.status(400).json({ error: 'Idempotency-Key header required' });
    if (idem.has(key)) return res.json(idem.get(key));
    const target = tiers.find((t) => t.sku === req.body.target_plan_id);
    if (!target) return res.status(400).json({ error: 'unknown plan' });
    const previous = x.sku;
    x.sku = target.sku;
    x.status = 'active';
    x.since ??= new Date().toISOString();
    x.pausedUntil = null;
    x.flexBilled = true; // FlexPrice now runs this customer's billing schedule
    const out = { status: 'applied', customer_reference: x.uid, previous_plan_id: previous, current_plan_id: x.sku, payment_reference: req.body.payment_reference ?? null, effective_at: new Date().toISOString() };
    idem.set(key, out);
    res.json(out);
  });
  a.get('/customers/:ref/subscription', (req, res) => {
    const x = acct(req, res);
    if (!x) return;
    res.json({ customer_reference: x.uid, plan_id: x.status === 'cancelled' ? null : x.sku, status: x.status, paused_until: x.pausedUntil, entitlements: x.status === 'active' ? ['catalog_access'] : [], discount: x.discount });
  });
  a.post('/customers/:ref/pause', (req, res) => {
    const x = acct(req, res);
    if (!x) return;
    const months = Math.min(3, Math.max(1, Number(req.body.months) || 1));
    x.status = 'paused';
    x.pausedUntil = new Date(Date.now() + months * 30.44 * 864e5).toISOString().slice(0, 10);
    res.json({ status: 'paused', paused_until: x.pausedUntil });
  });
  a.post('/customers/:ref/cancel', (req, res) => {
    const x = acct(req, res);
    if (!x) return;
    x.status = 'cancelled';
    res.json({ status: 'cancelled', effective_at: new Date().toISOString(), reason: req.body.reason ?? null });
  });
  a.post('/customers/:ref/retention-offer', (req, res) => {
    const x = acct(req, res);
    if (!x) return;
    const { percent, months } = req.body;
    x.discount = { percent, until: new Date(Date.now() + months * 30.44 * 864e5).toISOString().slice(0, 10) };
    x.discountUsedAt = new Date().toISOString();
    res.json({ status: 'applied', discount: x.discount });
  });

  r.use('/flexprice', a);
  return r;
}
