// Recurring billing, proration and merchant event webhooks.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { startFrameworkServer } from './helpers.js';
import { verifyEventSignature, signWidgetSession } from '../framework/sdk/index.js';
import { prorationCredit, addInterval } from '../framework/services/billing-service.js';
import { normalizePlan } from '../framework/core/models.js';
import { CodeCloudAdapter } from '../demo/merchants/codecloud-adapter.js';
import { PayPalSimulator } from '../demo/paypal-simulator/simulator.js';

const DAY = 864e5;

test('proration credit: whole unused days of a prepaid fixed period', () => {
  const plan = normalizePlan({ plan_id: 'm', name: 'Monthly', billing_model: 'fixed', base_price: 30 });
  const start = '2026-11-01T00:00:00Z';
  const end = '2026-12-01T00:00:00Z';
  const c = prorationCredit({ plan, periodStart: start, periodEnd: end, paidCents: 3000, now: new Date('2026-11-11T12:00:00Z') });
  assert.equal(c.period_days, 30);
  assert.equal(c.unused_days, 19);
  assert.equal(c.credit_cents, 1900);
  assert.equal(prorationCredit({ plan: { ...plan, billing_model: 'usage' }, periodStart: start, periodEnd: end, paidCents: 3000 }), null);
  assert.equal(prorationCredit({ plan, periodStart: start, periodEnd: end, paidCents: 3000, now: new Date('2026-10-20T00:00:00Z') }).credit_cents, 3000); // not started yet
  assert.equal(prorationCredit({ plan, periodStart: start, periodEnd: end, paidCents: 3000, now: new Date('2026-12-02T00:00:00Z') }), null); // over
  assert.equal(addInterval('2026-01-31T00:00:00.000Z', 'month'), '2026-02-28T00:00:00.000Z');
  assert.equal(addInterval('2026-03-15T00:00:00.000Z', 'year'), '2027-03-15T00:00:00.000Z');
});

test('recurring billing + proration + signed merchant webhooks, end to end on the framework', async () => {
  // Merchant backend receiving FlexPrice events, verifying signatures with the SDK.
  const received = [];
  const hookApp = express();
  hookApp.post('/hooks', express.text({ type: '*/*' }), (req, res) => {
    try {
      received.push(verifyEventSignature({ payload: req.body, header: req.get('flexprice-signature'), secret: 'hook-secret' }));
      res.sendStatus(204);
    } catch {
      res.sendStatus(400);
    }
  });
  const hookSrv = await new Promise((r) => { const s = hookApp.listen(0, '127.0.0.1', () => r(s)); });
  const hookUrl = `http://127.0.0.1:${hookSrv.address().port}/hooks`;

  let sim;
  const adapter = new CodeCloudAdapter();
  const t = await startFrameworkServer({
    merchants: [{ id: 'cc', name: 'CodeCloud', adapter, widgetSecret: 'w', adminApiKey: 'k', events: { url: hookUrl, secret: 'hook-secret' } }],
    paypal: ({ deliverWebhook }) => (sim = new PayPalSimulator({ publicBaseUrl: 'http://x', webhookSink: deliverWebhook })),
  });
  const token = signWidgetSession({ merchantId: 'cc', customerRef: 'acct_9002', secret: 'w' });
  const W = '/api/v1/widget/cc';
  const buy = async (planId) => {
    const terms = (await t.call('GET', `${W}/plans/${planId}/terms`, { token })).body;
    const consent = (await t.call('POST', `${W}/consents`, { token, body: { plan_id: planId, terms_hash: terms.terms_hash } })).body;
    const co = (await t.call('POST', `${W}/checkout`, { token, body: { plan_id: planId, consent_id: consent.consent_id } })).body;
    return { terms, co };
  };
  try {
    // 1. Annual flat plan, paid now, PayPal saved for renewals.
    const { terms, co } = await buy('cc_annual');
    assert.match(terms.disclosure.future_charges.authorization, /\$290\.00 every year when your plan renews/);
    sim.approve(co.paypal_order_id);
    const cap = (await t.call('POST', `${W}/checkout/${co.paypal_order_id}/capture`, { token })).body;
    assert.equal(cap.status, 'completed');
    const sub = t.services.billing.liveSubscription('cc', 'acct_9002');
    assert.equal(sub.plan_id, 'cc_annual');
    assert.equal(sub.paid_cents, 29000);
    assert.ok(t.services.billing.activePaymentMethod('cc', 'acct_9002'), 'PayPal saved with the purchase');

    // 2. Renewal: notice 3 days before, then charged to the saved PayPal account at period end.
    const end = new Date(sub.current_period_end).getTime();
    const notice = (await t.call('POST', '/api/v1/merchant/billing/run', { key: 'k', body: { as_of: new Date(end - 2 * DAY).toISOString() } })).body;
    assert.equal(notice.renewal_notices, 1);
    assert.equal(notice.renewals_invoiced, 0);
    const renew = (await t.call('POST', '/api/v1/merchant/billing/run', { key: 'k', body: { as_of: new Date(end + 3600_000).toISOString() } })).body;
    assert.equal(renew.renewals_invoiced, 1);
    assert.deepEqual(renew.charged.map((c) => [c.amount, c.kind]), [[290, 'renewal']]);
    const renewed = t.services.billing.liveSubscription('cc', 'acct_9002');
    assert.equal(renewed.paid_cents, 29000);
    assert.ok(new Date(renewed.current_period_end) > new Date(end + 300 * DAY));
    // running again is a no-op (idempotent schedule)
    const again = (await t.call('POST', '/api/v1/merchant/billing/run', { key: 'k', body: { as_of: new Date(end + 3600_000).toISOString() } })).body;
    assert.equal(again.renewals_invoiced + again.charged.length, 0);

    // 3. Switch mid-period to the monthly plan: unused annual days are credited.
    //    (Use the cooldown-free default policy; plan change limit is 3 per 30 days.)
    const sw = await buy('cc_starter');
    const pr = sw.terms.disclosure.proration;
    assert.equal(pr.from_plan_name, 'Starter Annual');
    assert.ok(pr.credit > 200, `credit ${pr.credit}`); // ~all of the year is unused
    assert.equal(sw.terms.disclosure.due_today, 0); // $29 fully covered by credit
    assert.ok(pr.carried_forward > 0);
    // nothing due today → but renewals use the saved PayPal already on file → plan switches immediately
    assert.equal(sw.co.status, 'completed');
    const bal = t.services.billing.creditBalanceCents('cc', 'acct_9002');
    assert.equal(bal, Math.round(pr.carried_forward * 100));
    // the next monthly renewal is paid from account credit, not PayPal
    const msub = t.services.billing.liveSubscription('cc', 'acct_9002');
    const r2 = (await t.call('POST', '/api/v1/merchant/billing/run', { key: 'k', body: { as_of: new Date(new Date(msub.current_period_end).getTime() + 3600_000).toISOString() } })).body;
    assert.equal(r2.renewals_invoiced, 1);
    assert.equal(r2.charged.length, 0);
    const renewalInv = t.services.store.find('cc', 'invoices', (i) => i.kind === 'renewal').at(-1);
    assert.equal(renewalInv.status, 'paid');
    assert.equal(renewalInv.collection, 'none');
    assert.ok(renewalInv.lines.some((l) => l.description === 'Account credit'));

    // 4. Webhooks: signed, delivered, verifiable by the merchant.
    await new Promise((r) => setTimeout(r, 200));
    const types = received.map((e) => e.type);
    for (const ty of ['payment.captured', 'payment_method.saved', 'plan.changed', 'subscription.renewal_upcoming', 'invoice.created', 'invoice.paid', 'subscription.renewed']) assert.ok(types.includes(ty), `missing ${ty} in ${types}`);
    const evs = (await t.call('GET', '/api/v1/merchant/events', { key: 'k' })).body;
    assert.ok(evs.every((e) => e.status === 'delivered'), JSON.stringify(evs.map((e) => [e.type, e.status])));
  } finally {
    await t.close();
    await new Promise((r) => hookSrv.close(r));
  }
});

test('switching away from a metered plan bills usage so far at the old rates; hybrid base fee never double-charged', async () => {
  let sim;
  const t = await startFrameworkServer({
    merchants: [{ id: 'cc', name: 'CodeCloud', adapter: new CodeCloudAdapter(), widgetSecret: 'w', adminApiKey: 'k' }],
    paypal: ({ deliverWebhook }) => (sim = new PayPalSimulator({ publicBaseUrl: 'http://x', webhookSink: deliverWebhook })),
  });
  const token = signWidgetSession({ merchantId: 'cc', customerRef: 'acct_9001', secret: 'w' });
  const W = '/api/v1/widget/cc';
  try {
    // hybrid plan: $15 base paid at signup, 40k included, $0.20 per extra 1k
    const terms = (await t.call('GET', `${W}/plans/cc_hybrid/terms`, { token })).body;
    const consent = (await t.call('POST', `${W}/consents`, { token, body: { plan_id: 'cc_hybrid', terms_hash: terms.terms_hash } })).body;
    const co = (await t.call('POST', `${W}/checkout`, { token, body: { plan_id: 'cc_hybrid', consent_id: consent.consent_id } })).body;
    sim.approve(co.paypal_order_id);
    await t.call('POST', `${W}/checkout/${co.paypal_order_id}/capture`, { token });
    await t.call('POST', '/api/v1/merchant/usage', { key: 'k', body: { event_id: 'u1', customer_reference: 'acct_9001', metric: 'api_calls_k', quantity: 50 } });
    // switch to the flat plan mid-month
    const t2 = (await t.call('GET', `${W}/plans/cc_starter/terms`, { token })).body;
    assert.match(t2.disclosure.pending_usage_note, /invoiced separately/);
    const c2 = (await t.call('POST', `${W}/consents`, { token, body: { plan_id: 'cc_starter', terms_hash: t2.terms_hash } })).body;
    const co2 = (await t.call('POST', `${W}/checkout`, { token, body: { plan_id: 'cc_starter', consent_id: c2.consent_id } })).body;
    sim.approve(co2.paypal_order_id);
    await t.call('POST', `${W}/checkout/${co2.paypal_order_id}/capture`, { token });
    const inv = t.services.store.find('cc', 'invoices', (i) => i.plan_id === 'cc_hybrid').at(-1);
    assert.ok(inv, 'final hybrid invoice created at switch');
    assert.equal(inv.partial, true);
    assert.equal(inv.gross_cents, 1500 + 10 * 20); // base + 10k overage
    assert.equal(inv.amount_cents, 200); // base prepaid at signup is credited
    // usage after the switch is not billed to the old plan
    await t.call('POST', '/api/v1/merchant/usage', { key: 'k', body: { event_id: 'u2', customer_reference: 'acct_9001', metric: 'api_calls_k', quantity: 999 } });
    assert.equal(t.services.ledger.rate('cc', { customerRef: 'acct_9001', plan: await t.services.registry.get('cc').gateway.getPlan('cc_hybrid'), period: inv.period }), 1700);
  } finally {
    await t.close();
  }
});

test('merchant webhook receivers mounted behind the framework JSON parser still verify signatures (raw body kept)', async () => {
  const { startTestServer } = await import('./helpers.js');
  const t = await startTestServer();
  try {
    const evt = t.services.events.emit('streamflix', 'test.ping', { customer_reference: 'sf-1001' });
    await new Promise((r) => setTimeout(r, 300));
    const after = t.services.store.findOne('streamflix', 'events', (e) => e.id === evt.id);
    assert.equal(after.status, 'delivered', JSON.stringify(after.deliveries));
  } finally {
    await t.close();
  }
});

test('reaching the spending cap emits usage.cap_reached once and the event is still accepted', async () => {
  const { startTestServer } = await import('./helpers.js');
  const t = await startTestServer();
  try {
    const key = 'sf_admin_demo_key';
    // sf-1001 needs a metered plan for the cap to apply; put the plan in the ledger record directly via a PAYG switch
    const token = (await t.call('POST', '/api/v1/demo/streamflix/session', { body: { uid: 'sf-1001' } })).body.token;
    const W = '/api/v1/widget/streamflix';
    const terms = (await t.call('GET', `${W}/plans/SF-PAYG/terms`, { token })).body;
    const c = (await t.call('POST', `${W}/consents`, { token, body: { plan_id: 'SF-PAYG', terms_hash: terms.terms_hash } })).body;
    const co = (await t.call('POST', `${W}/checkout`, { token, body: { plan_id: 'SF-PAYG', consent_id: c.consent_id } })).body;
    await t.call('POST', '/paypal-sim/approve-setup', { body: { token: co.setup_token_id } });
    await t.call('POST', `${W}/checkout/${co.checkout_id}/payment-method`, { token });
    const ev = (id, q) => ({ event_id: id, customer_reference: 'sf-1001', metric: 'watch_hours', quantity: q });
    const a = await t.call('POST', '/api/v1/merchant/usage', { key, body: ev('c1', 20) });
    const b = await t.call('POST', '/api/v1/merchant/usage', { key, body: ev('c2', 20) }); // crosses the 30 h cap
    const c3 = await t.call('POST', '/api/v1/merchant/usage', { key, body: ev('c3', 20) });
    assert.deepEqual([a.status, b.status, c3.status], [200, 200, 200], JSON.stringify(b.body));
    assert.equal(b.body.cap_just_reached, true);
    assert.equal(t.services.store.find('streamflix', 'events', (e) => e.type === 'usage.cap_reached').length, 1);
  } finally {
    await t.close();
  }
});
