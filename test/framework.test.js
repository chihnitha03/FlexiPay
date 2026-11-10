// The framework must work on its own: no demo routes, no simulator, any adapter.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { startFrameworkServer } from './helpers.js';
import { createAdapterRouter, signWidgetSession, FlexPriceMerchantClient } from '../framework/sdk/index.js';
import { HttpAdapter } from '../framework/index.js';
import { CodeCloudAdapter } from '../demo/merchants/codecloud-adapter.js';
import { checkGrounding } from '../framework/ai/grounding.js';
import { redactPII } from '../framework/ai/privacy.js';

test('framework-only deployment: SDK adapter router over HTTP, no demo surface, payments disabled gracefully', async () => {
  // A "merchant backend" exposing an in-process adapter through the SDK router.
  const merchantApp = express();
  merchantApp.use('/flexprice', createAdapterRouter(new CodeCloudAdapter(), { apiKey: 'adapter-secret' }));
  const merchantServer = await new Promise((r) => { const s = merchantApp.listen(0, '127.0.0.1', () => r(s)); });
  const merchantBase = `http://127.0.0.1:${merchantServer.address().port}`;

  const t = await startFrameworkServer({
    merchants: [{ id: 'acme', name: 'Acme', adapter: new HttpAdapter({ baseUrl: merchantBase, apiKey: 'adapter-secret' }), widgetSecret: 'w-secret', adminApiKey: 'acme-key', validationCustomerRef: 'acct_9001' }],
  });
  try {
    for (const p of ['/api/v1/demo/merchants', '/mock-merchants/streamflix/site/accounts', '/paypal-sim/checkout?token=x', '/demo/site.html']) {
      assert.equal((await fetch(t.base + p)).status, 404, `${p} must not exist in the framework`);
    }
    const v = await t.call('GET', '/api/v1/merchant/validate', { key: 'acme-key' });
    assert.equal(v.body.ok, true, JSON.stringify(v.body.checks));
    assert.equal(v.body.modes.adaptive_billing, true);

    const token = signWidgetSession({ merchantId: 'acme', customerRef: 'acct_9001', secret: 'w-secret' });
    const rec = await t.call('POST', '/api/v1/widget/acme/recommend', { token, body: {} });
    assert.equal(rec.status, 200);
    const cfg = await t.call('GET', '/api/v1/widget/acme/config');
    assert.equal(cfg.body.paypal.mode, 'disabled');

    const terms = await t.call('GET', '/api/v1/widget/acme/plans/cc_annual/terms');
    const consent = await t.call('POST', '/api/v1/widget/acme/consents', { token, body: { plan_id: 'cc_annual', terms_hash: terms.body.terms_hash } });
    const co = await t.call('POST', '/api/v1/widget/acme/checkout', { token, body: { plan_id: 'cc_annual', consent_id: consent.body.consent_id } });
    assert.equal(co.status, 503);

    const client = new FlexPriceMerchantClient({ baseUrl: t.base, apiKey: 'acme-key' });
    const u = await client.recordUsage({ event_id: 'e1', customer_reference: 'acct_9001', metric: 'api_calls_k', quantity: 3 });
    assert.equal(u.accepted, true);
    assert.equal((await client.recordUsage({ event_id: 'e1', customer_reference: 'acct_9001', metric: 'api_calls_k', quantity: 3 })).duplicate, true);

    const ins = await t.call('POST', '/api/v1/merchant/insights', { key: 'acme-key', body: {} });
    assert.equal(ins.status, 201);
    assert.equal(ins.body.cohort.customers, 400);
  } finally {
    await t.close();
    await new Promise((r) => merchantServer.close(r));
  }
});

test('adapter router rejects bad keys and undeclared capabilities', async () => {
  const app = express();
  app.use('/flexprice', createAdapterRouter(new CodeCloudAdapter(), { apiKey: 'k' }));
  const s = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  const base = `http://127.0.0.1:${s.address().port}/flexprice`;
  try {
    assert.equal((await fetch(`${base}/plans`)).status, 401);
    const res = await fetch(`${base}/customers/acct_9001/pause`, { method: 'POST', headers: { Authorization: 'Bearer k', 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 501); // CodeCloud does not declare pause_subscription
  } finally {
    await new Promise((r) => s.close(r));
  }
});

test('grounding covers percentages; PII redaction', () => {
  const facts = { plans: [{ estimated_cost: 168 }, { estimated_cost: 228 }] };
  assert.equal(checkGrounding('Annual saves 26% vs monthly.', facts).grounded, true); // (228-168)/228
  assert.deepEqual(checkGrounding('Annual saves 40%!', facts).ungrounded, ['40%']);
  // amounts ≥ $1000 with and without thousands separators
  assert.equal(checkGrounding('Revenue rises $1234.50 or $1,234.50.', { x: 1234.5 }).grounded, true);
  assert.deepEqual(checkGrounding('Revenue rises $1999.00', { x: 1234.5 }).ungrounded, [1999]);
  assert.equal(redactPII('mail a.b@x.io or call 415-555-1234, card 4111 1111 1111 1111'), 'mail [email] or call [phone], card [card-or-account-number]');
});
