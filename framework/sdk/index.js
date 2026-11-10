// FlexPrice merchant-side SDK — helpers a merchant uses inside ITS OWN backend:
//   • signWidgetSession: sign the customer session token the widget needs
//   • FlexPriceMerchantClient: push trusted usage events, close periods, run billing
//   • createAdapterRouter: expose any object implementing the adapter contract as the HTTP
//     endpoints FlexPrice's HttpAdapter expects (so merchants only write the translation logic)

import express from 'express';
import crypto from 'node:crypto';
import { signSession } from '../core/session-token.js';
import { CAPABILITY_METHODS } from '../adapters/contract.js';

/**
 * Verify a FlexPrice event webhook. Pass the RAW request body string (not re-serialized JSON).
 * Returns the parsed event, or throws if the signature is invalid or older than toleranceSec.
 */
export function verifyEventSignature({ payload, header, secret, toleranceSec = 300, now = Date.now() }) {
  const parts = Object.fromEntries(String(header ?? '').split(',').map((kv) => kv.split('=')));
  const t = Number(parts.t);
  if (!t || !parts.v1) throw new Error('missing FlexPrice-Signature');
  if (Math.abs(now / 1000 - t) > toleranceSec) throw new Error('signature timestamp outside tolerance');
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  if (expected.length !== parts.v1.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1))) throw new Error('invalid signature');
  return JSON.parse(payload);
}

export function signWidgetSession({ merchantId, customerRef, secret, ttlSeconds = 3600 }) {
  return signSession({ merchantId, customerRef, ttlSeconds }, secret);
}

export class FlexPriceMerchantClient {
  constructor({ baseUrl, apiKey, fetchImpl = fetch }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
  }

  async #req(method, path, body) {
    const res = await this.fetch(`${this.baseUrl}/api/v1/merchant${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 207) throw Object.assign(new Error(json.error || `FlexPrice ${method} ${path} failed (${res.status})`), { status: res.status, body: json });
    return json;
  }

  /** Events need a stable event_id; resending the same event is safe (deduplicated). */
  recordUsage(events) {
    return this.#req('POST', '/usage', Array.isArray(events) ? { events } : events);
  }
  closePeriod(customerRef, period) {
    return this.#req('POST', `/customers/${encodeURIComponent(customerRef)}/close-period`, { period });
  }
  runBilling(asOf) {
    return this.#req('POST', '/billing/run', asOf ? { as_of: new Date(asOf).toISOString() } : {});
  }
  overview() {
    return this.#req('GET', '/overview');
  }
}

/**
 * Turn an adapter object (same methods as an in-process adapter) into the FlexPrice HTTP contract.
 *   app.use('/flexprice', createAdapterRouter(myAdapter, { apiKey: process.env.FLEXPRICE_ADAPTER_KEY }))
 * Handles bearer auth, Idempotency-Key replay and only exposes declared capabilities.
 */
export function createAdapterRouter(adapter, { apiKey }) {
  if (!apiKey) throw new Error('createAdapterRouter requires an apiKey');
  const r = express.Router();
  const replay = new Map();
  r.use(express.json());
  r.use((req, res, next) => {
    const got = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const ok = got.length === apiKey.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(apiKey));
    if (!ok) return res.status(401).json({ error: 'unauthorized' });
    next();
  });
  const wrap = (capability, fn) => async (req, res) => {
    try {
      const manifest = await adapter.getManifest();
      if (capability && !manifest.capabilities.includes(capability)) return res.status(501).json({ error: `capability '${capability}' not supported` });
      const key = req.get('idempotency-key');
      if (key && replay.has(key)) return res.json(replay.get(key));
      const out = await fn(req);
      if (key) replay.set(key, out);
      res.json(out);
    } catch (err) {
      res.status(err.status && err.status < 500 ? err.status : 502).json({ error: err.message });
    }
  };
  const ref = (req) => req.params.ref;
  r.get('/manifest', wrap(null, () => adapter.getManifest()));
  r.get('/plans', wrap('plans', async () => ({ plans: await adapter.getPlans() })));
  r.get('/customers/:ref', wrap('customer_context', (req) => adapter.getCustomerContext(ref(req))));
  r.get('/customers/:ref/usage', wrap('usage_history', async (req) => ({ usage: await adapter.getUsage(ref(req), { from: req.query.from, to: req.query.to }) })));
  r.post('/usage', wrap('usage_metering', (req) => adapter.recordUsage(req.body)));
  r.post('/customers/:ref/plan-change', wrap('change_plan', (req) =>
    adapter.changePlan(ref(req), req.body.target_plan_id, { idempotencyKey: req.get('idempotency-key'), consentReference: req.body.consent_reference, paymentReference: req.body.payment_reference })));
  r.get('/customers/:ref/subscription', wrap('subscription_status', (req) => adapter.getSubscriptionStatus(ref(req))));
  r.post('/customers/:ref/pause', wrap('pause_subscription', (req) => adapter.pauseSubscription(ref(req), { months: req.body.months, idempotencyKey: req.get('idempotency-key') })));
  r.post('/customers/:ref/cancel', wrap('cancel_subscription', (req) => adapter.cancelSubscription(ref(req), { reason: req.body.reason, idempotencyKey: req.get('idempotency-key') })));
  r.post('/customers/:ref/retention-offer', wrap('retention_offers', (req) => adapter.applyRetentionOffer(ref(req), req.body, { idempotencyKey: req.get('idempotency-key') })));
  r.get('/cohort-usage', wrap('cohort_usage', async () => ({ cohort: await adapter.getCohortUsage() })));
  return r;
}

export { CAPABILITY_METHODS };
