import test from 'node:test';
import assert from 'node:assert/strict';
import { PayPalClient, PayPalError } from '../framework/paypal/client.js';

function mockPayPal() {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, ...init, json: init.body && init.body.startsWith('{') ? JSON.parse(init.body) : init.body });
    const path = new URL(url).pathname;
    const ok = (b) => new Response(JSON.stringify(b), { status: 200 });
    if (path === '/v1/oauth2/token') return ok({ access_token: 'A21', expires_in: 3600 });
    if (path === '/v2/checkout/orders') return ok({ id: 'ORDER1', status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER1' }] });
    if (path.endsWith('/capture')) return new Response(JSON.stringify({ name: 'UNPROCESSABLE_ENTITY', message: 'The requested action could not be performed', details: [{ issue: 'ORDER_NOT_APPROVED' }], debug_id: 'dbg1' }), { status: 422 });
    if (path === '/v1/notifications/verify-webhook-signature') return ok({ verification_status: 'SUCCESS' });
    return new Response('{}', { status: 404 });
  };
  return { impl, calls };
}

test('PayPal client: OAuth once, idempotent order creation, typed errors, webhook verification', async () => {
  const pp = mockPayPal();
  const c = new PayPalClient({ clientId: 'id', clientSecret: 'secret', apiBase: 'https://api-m.sandbox.paypal.com', webhookId: 'WH1', fetchImpl: pp.impl });
  const order = await c.createOrder({ amount: 159.99, currency: 'USD', description: 'Annual', referenceId: 'SF-STD-Y', customId: 'streamflix|che_1', brandName: 'StreamFlix', returnUrl: 'https://x/r', cancelUrl: 'https://x/c', idempotencyKey: 'order-che_1' });
  assert.equal(order.id, 'ORDER1');
  const [auth, create] = pp.calls;
  assert.equal(auth.headers.Authorization, `Basic ${Buffer.from('id:secret').toString('base64')}`);
  assert.equal(create.headers['PayPal-Request-Id'], 'order-che_1');
  assert.equal(create.headers.Authorization, 'Bearer A21');
  assert.equal(create.json.intent, 'CAPTURE');
  assert.deepEqual(create.json.purchase_units[0].amount, { currency_code: 'USD', value: '159.99' });
  assert.equal(create.json.purchase_units[0].custom_id, 'streamflix|che_1');
  assert.equal(create.json.payment_source.paypal.experience_context.shipping_preference, 'NO_SHIPPING');

  await assert.rejects(c.captureOrder('ORDER1', { idempotencyKey: 'cap-1' }), (e) => e instanceof PayPalError && e.status === 422 && e.details[0].issue === 'ORDER_NOT_APPROVED' && e.debugId === 'dbg1');
  assert.equal(pp.calls.filter((x) => x.url.endsWith('/oauth2/token')).length, 1, 'token cached');

  const ok = await c.verifyWebhook({ 'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'u', 'paypal-transmission-id': 't', 'paypal-transmission-sig': 's', 'paypal-transmission-time': 'now' }, { id: 'WH-1' });
  assert.equal(ok, true);
  assert.equal(pp.calls.at(-1).json.webhook_id, 'WH1');
});
