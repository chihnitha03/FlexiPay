import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { signSession } from '../framework/core/session-token.js';

let t;
before(async () => (t = await startTestServer()));
after(() => t.close());

const session = async (merchant, uid) => (await t.call('POST', `/api/v1/demo/${merchant}/session`, { body: { uid } })).body.token;
const W = (m) => `/api/v1/widget/${m}`;

async function selectPlan(merchant, token, planId, recommendationId) {
  const terms = await t.call('GET', `${W(merchant)}/plans/${planId}/terms`, { token });
  const consent = await t.call('POST', `${W(merchant)}/consents`, { token, body: { plan_id: planId, terms_hash: terms.body.terms_hash, recommendation_id: recommendationId } });
  assert.equal(consent.status, 201, JSON.stringify(consent.body));
  const co = await t.call('POST', `${W(merchant)}/checkout`, { token, body: { plan_id: planId, consent_id: consent.body.consent_id } });
  assert.equal(co.status, 201, JSON.stringify(co.body));
  return { terms: terms.body, consent: consent.body, checkout: co.body };
}

test('all reference adapters pass conformance validation', async () => {
  for (const key of ['sf_admin_demo_key', 'cc_admin_demo_key', 'lh_admin_demo_key']) {
    const v = await t.call('GET', '/api/v1/merchant/validate', { key });
    assert.equal(v.body.ok, true, JSON.stringify(v.body.checks));
  }
});

test('pricing insights: quantifies advisor impact and returns validated, simulated proposals (heuristic fallback)', async () => {
  const r = await t.call('POST', '/api/v1/merchant/insights', { key: 'sf_admin_demo_key', body: { goal: 'balanced' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.source, 'heuristic');
  assert.equal(r.body.cohort.source, 'merchant_adapter');
  assert.equal(r.body.cohort.customers, 600);
  const impact = r.body.advisor_impact_on_current_catalog;
  assert.ok(impact.overpaying_customers > 100);
  assert.ok(impact.customer_savings_12m > 0);
  assert.ok(impact.churned_customers_avoided > 0);
  assert.ok(r.body.proposals.length >= 1);
  for (const p of r.body.proposals) assert.equal(p.result.valid, true);
  assert.ok(r.body.proposals.some((p) => /minimum on metered plans/.test(p.title)));
  const solver = r.body.revenue_neutral_pricing;
  assert.equal(solver.metrics.customers_worse_off, 0);
  assert.ok(solver.metrics.revenue_change_vs_today_12m > impact.revenue_impact_12m); // solver narrows the gap
  assert.ok(solver.break_even_new_customers.count > 0);
});

test('occasional viewer: history-based recommendation of pay-as-you-watch; PayPal vaulted with no charge; plan switched', async () => {
  const token = await session('streamflix', 'sf-1001');
  const rec = await t.call('POST', `${W('streamflix')}/recommend`, { token, body: {} });
  assert.equal(rec.status, 200);
  assert.equal(rec.body.forecast.source, 'history');
  assert.equal(rec.body.recommendation.recommended_plan_id, 'SF-PAYG');
  assert.ok(rec.body.recommendation.estimated_savings > 50);
  assert.equal(rec.body.explanation.source, 'template');

  const { checkout, terms } = await selectPlan('streamflix', token, 'SF-PAYG', rec.body.recommendation.recommendation_id);
  assert.match(terms.disclosure.future_charges.authorization, /never more than \$17\.99 per month/);
  assert.equal(checkout.amount, 0);
  assert.equal(checkout.status, 'awaiting_payment_method');
  assert.match(checkout.approve_url, /setup_token=/);
  // completing before the buyer approves the setup token fails
  assert.equal((await t.call('POST', `${W('streamflix')}/checkout/${checkout.checkout_id}/payment-method`, { token })).status, 422);
  await t.call('POST', '/paypal-sim/approve-setup', { body: { token: checkout.setup_token_id } });
  const done = await t.call('POST', `${W('streamflix')}/checkout/${checkout.checkout_id}/payment-method`, { token });
  assert.equal(done.body.status, 'completed', JSON.stringify(done.body));
  assert.equal(done.body.subscription.plan_id, 'SF-PAYG');
  const pm = await t.call('GET', `${W('streamflix')}/payment-method`, { token });
  assert.equal(pm.body.payment_method.status, 'active');
});

test('binge watcher: annual plan paid through PayPal, verified server-side, webhook deduplicated', async () => {
  const token = await session('streamflix', 'sf-1002');
  const rec = await t.call('POST', `${W('streamflix')}/recommend`, { token, body: {} });
  assert.equal(rec.body.recommendation.recommended_plan_id, 'SF-STD-Y');
  const { checkout, terms } = await selectPlan('streamflix', token, 'SF-STD-Y', rec.body.recommendation.recommendation_id);
  assert.equal(checkout.status, 'created');
  // unused days of Ben's StreamFlix-billed monthly period are credited against the annual price
  const credit = terms.disclosure.proration?.applied_today ?? 0;
  assert.equal(terms.disclosure.due_today_gross, 159.99);
  assert.equal(checkout.amount, Math.round((159.99 - credit) * 100) / 100);
  if (terms.disclosure.proration) assert.equal(terms.disclosure.proration.from_plan_name, 'Standard Monthly');
  assert.match(checkout.approve_url, /paypal-sim\/checkout/);

  // capture before buyer approval must fail — redirect is not proof of payment
  const early = await t.call('POST', `${W('streamflix')}/checkout/${checkout.paypal_order_id}/capture`, { token });
  assert.equal(early.status, 422);

  await t.call('POST', '/paypal-sim/approve', { body: { token: checkout.paypal_order_id } });
  const [a, b] = await Promise.all([
    t.call('POST', `${W('streamflix')}/checkout/${checkout.paypal_order_id}/capture`, { token }),
    t.call('POST', `${W('streamflix')}/checkout/${checkout.paypal_order_id}/capture`, { token }),
  ]);
  assert.equal(a.body.status, 'completed', JSON.stringify(a.body));
  assert.equal(b.body.capture_id, a.body.capture_id); // idempotent
  assert.equal(a.body.subscription.plan_id, 'SF-STD-Y');

  await new Promise((r) => setTimeout(r, 800)); // simulator delivers the webhook twice
  const audit = (await t.call('GET', '/api/v1/merchant/audit', { key: 'sf_admin_demo_key' })).body;
  assert.equal(audit.filter((e) => e.type === 'webhook:PAYMENT.CAPTURE.COMPLETED').length, 1);
  const recon = await t.call('POST', '/api/v1/merchant/reconcile', { key: 'sf_admin_demo_key' });
  assert.deepEqual(recon.body.unconfirmed_by_webhook, []);

  const ov = await t.call('GET', '/api/v1/merchant/overview', { key: 'sf_admin_demo_key' });
  assert.equal(ov.body.metrics.revenue_captured, checkout.amount);
});

test('declined payment leaves checkout retryable and plan unchanged', async () => {
  const token = await session('streamflix', 'sf-1003');
  const { checkout } = await selectPlan('streamflix', token, 'SF-STD-Y');
  await t.call('POST', '/paypal-sim/approve', { body: { token: checkout.paypal_order_id, decline: true } });
  const cap = await t.call('POST', `${W('streamflix')}/checkout/${checkout.paypal_order_id}/capture`, { token });
  assert.equal(cap.status, 422);
  const rec = await t.call('POST', `${W('streamflix')}/recommend`, { token, body: {} });
  assert.equal(rec.body.customer.current_plan_id, 'SF-STD-M');
});

test('security: forged sessions, stale terms and cross-tenant keys are rejected', async () => {
  const forged = signSession({ merchantId: 'streamflix', customerRef: 'sf-1002' }, 'wrong-secret');
  assert.equal((await t.call('POST', `${W('streamflix')}/recommend`, { token: forged, body: {} })).status, 401);
  const ccToken = await session('codecloud', 'acct_9001');
  assert.equal((await t.call('POST', `${W('streamflix')}/recommend`, { token: ccToken, body: {} })).status, 401);
  const token = await session('streamflix', 'sf-1003');
  const bad = await t.call('POST', `${W('streamflix')}/consents`, { token, body: { plan_id: 'SF-PAYG', terms_hash: 'tampered' } });
  assert.equal(bad.status, 409);
  const noConsent = await t.call('POST', `${W('streamflix')}/checkout`, { token, body: { plan_id: 'SF-PAYG', consent_id: 'nope' } });
  assert.equal(noConsent.status, 403);
  assert.equal((await t.call('GET', '/api/v1/merchant/overview', { key: 'cc_admin_demo_key' })).body.merchant.id, 'codecloud');
  assert.equal((await t.call('GET', '/api/v1/merchant/overview', { key: 'nope' })).status, 401);
});

test('retention: recent offer blocks discount; pause allowed; cheaper alternatives listed', async () => {
  const token = await session('streamflix', 'sf-1004');
  const opts = await t.call('POST', `${W('streamflix')}/retention/options`, { token });
  assert.equal(opts.body.discount.eligible, false);
  assert.match(opts.body.discount.reason, /already used/);
  assert.equal(opts.body.pause.eligible, true);
  assert.ok(opts.body.alternatives.length >= 1);
  assert.equal((await t.call('POST', `${W('streamflix')}/retention/accept`, { token, body: { action: 'discount' } })).status, 403);
  const pause = await t.call('POST', `${W('streamflix')}/retention/accept`, { token, body: { action: 'pause', months: 1 } });
  assert.equal(pause.body.status, 'paused');
});

test('retention: eligible customer can accept a discount exactly once', async () => {
  const token = await session('streamflix', 'sf-1003');
  const opts = await t.call('POST', `${W('streamflix')}/retention/options`, { token });
  assert.equal(opts.body.discount.eligible, true);
  assert.equal((await t.call('POST', `${W('streamflix')}/retention/accept`, { token, body: { action: 'discount' } })).status, 200);
  const again = await t.call('POST', `${W('streamflix')}/retention/options`, { token });
  assert.equal(again.body.discount.eligible, false);
});

test('adaptive billing: usage dedupe, cap-respecting invoice, notice period, merchant-initiated PayPal charge', async () => {
  // sf-1001 switched to SF-PAYG with a vaulted PayPal account earlier in this file
  const key = 'sf_admin_demo_key';
  const now = new Date().toISOString();
  const ev = (id, q) => ({ event_id: id, customer_reference: 'sf-1001', metric: 'watch_hours', quantity: q, occurred_at: now });
  const batch = await t.call('POST', '/api/v1/merchant/usage', { key, body: { events: [ev('w1', 10), ev('w2', 5), ev('w1', 10)] } });
  assert.deepEqual(batch.body.results.map((r) => r.accepted), [true, true, false]);
  const token = await session('streamflix', 'sf-1001');
  const cur = await t.call('GET', `${W('streamflix')}/usage/current`, { token });
  assert.equal(cur.body.usage, 15);
  assert.equal(cur.body.charge_so_far, 9);
  await t.call('POST', '/api/v1/merchant/usage', { key, body: ev('w3', 40) });
  const inv = await t.call('POST', '/api/v1/merchant/customers/sf-1001/close-period', { key });
  assert.equal(inv.body.gross_cents, 1799); // capped
  // Asha's unused StreamFlix-billed days became account credit, applied to this invoice
  assert.equal(inv.body.amount_cents, 1799 - (inv.body.credit_applied_cents ?? 0));
  assert.equal(inv.body.cap_applied, true);
  assert.equal(inv.body.collection, 'automatic');

  // notice period not elapsed → nothing charged
  const early = await t.call('POST', '/api/v1/merchant/billing/run', { key });
  assert.deepEqual(early.body.charged, []);
  assert.deepEqual(early.body.skipped_not_due, [inv.body.id]);
  // after the notice period → charged with the vaulted account, no buyer interaction
  const later = await t.call('POST', '/api/v1/merchant/billing/run', { key, body: { as_of: new Date(Date.now() + 4 * 864e5).toISOString() } });
  assert.deepEqual(later.body.charged, [{ invoice_id: inv.body.id, amount: inv.body.amount, kind: 'usage' }]);
  const invoices = (await t.call('GET', '/api/v1/merchant/invoices', { key })).body;
  assert.equal(invoices.find((i) => i.id === inv.body.id).status, 'paid');
  const ov = (await t.call('GET', '/api/v1/merchant/overview', { key })).body;
  assert.equal(ov.metrics.auto_collected_payments, 1);
});

test('adaptive billing: failed automatic charges retry, then fall back to manual PayPal payment', async () => {
  const key = 'cc_admin_demo_key';
  const token = await session('codecloud', 'acct_9002');
  const { checkout } = await selectPlan('codecloud', token, 'cc_metered');
  await t.call('POST', '/paypal-sim/approve-setup', { body: { token: checkout.setup_token_id } });
  await t.call('POST', `${W('codecloud')}/checkout/${checkout.checkout_id}/payment-method`, { token });
  await t.call('POST', '/api/v1/merchant/usage', { key, body: { event_id: 'cc1', customer_reference: 'acct_9002', metric: 'api_calls_k', quantity: 30, occurred_at: new Date().toISOString() } });
  const inv = (await t.call('POST', '/api/v1/merchant/customers/acct_9002/close-period', { key })).body;
  assert.equal(inv.amount, 13); // 20k × $0.50 + 10k × $0.30
  const pm = t.services.store.findOne('codecloud', 'payment_methods', (p) => p.customer_reference === 'acct_9002' && p.status === 'active');
  t.services.simulator.declineVaultIds.add(pm.vault_id);
  let day = 4;
  for (let i = 0; i < 3; i++, day += 4) await t.call('POST', '/api/v1/merchant/billing/run', { key, body: { as_of: new Date(Date.now() + day * 864e5).toISOString() } });
  const after = (await t.call('GET', '/api/v1/merchant/invoices', { key })).body.find((i) => i.id === inv.id);
  assert.equal(after.status, 'past_due');
  assert.equal(after.collection, 'manual');
  assert.equal(after.attempts, 3);
  // customer pays manually via PayPal checkout
  const pay = await t.call('POST', `${W('codecloud')}/invoices/${inv.id}/pay`, { token });
  await t.call('POST', '/paypal-sim/approve', { body: { token: pay.body.paypal_order_id } });
  const cap = await t.call('POST', `${W('codecloud')}/checkout/${pay.body.paypal_order_id}/capture`, { token });
  assert.equal(cap.body.status, 'completed');
  // removing the saved account is honoured
  assert.equal((await t.call('DELETE', `${W('codecloud')}/payment-method`, { token })).body.removed, true);
});

test('anti-gaming: a second plan change inside the merchant cooldown is refused', async () => {
  const token = await session('streamflix', 'sf-1001'); // changed plan earlier in this file; StreamFlix cooldown = 14 days
  const terms = await t.call('GET', `${W('streamflix')}/plans/SF-STD-M/terms`, { token });
  const consent = await t.call('POST', `${W('streamflix')}/consents`, { token, body: { plan_id: 'SF-STD-M', terms_hash: terms.body.terms_hash } });
  const co = await t.call('POST', `${W('streamflix')}/checkout`, { token, body: { plan_id: 'SF-STD-M', consent_id: consent.body.consent_id } });
  assert.equal(co.status, 403);
  assert.match(co.body.error, /once every 14 days/);
});

test('plug-and-play: SaaS tiered merchant and zero-code catalog merchant', async () => {
  const token = await session('codecloud', 'acct_9001');
  const rec = await t.call('POST', `${W('codecloud')}/recommend`, { token, body: {} });
  assert.equal(rec.status, 200);
  assert.equal(rec.body.forecast.history_forecast.trend, 'increasing');
  const lh = await t.call('POST', `${W('learnhub')}/recommend`, { body: { monthly_usage: 4 } });
  assert.equal(lh.status, 200);
  assert.ok(lh.body.excluded_plans.some((p) => p.plan_id === 'lh_per_lesson' && /metering/.test(p.reason)));
  assert.equal(lh.body.forecast.source, 'customer_estimate');
  const cfg = await t.call('GET', `${W('learnhub')}/config`);
  assert.equal(cfg.body.capabilities.change_plan, false);
});

test('chat without Claude falls back to rule-based intent parsing', async () => {
  const token = await session('streamflix', 'sf-1005');
  const r = await t.call('POST', `${W('streamflix')}/chat`, { token, body: { message: 'I watch maybe 2 movies a week' } });
  assert.equal(r.body.source, 'rules');
  assert.ok(r.body.actions.some((a) => a.type === 'set_usage' && a.value === 17.3));
  assert.match(r.body.reply, /\$/);
});
