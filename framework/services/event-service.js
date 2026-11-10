// Merchant event webhooks (outbox pattern).
//
// FlexPrice records every business event in a per-merchant outbox and delivers it to the merchant's
// endpoint as a signed POST, retrying with backoff. The merchant uses these to send emails
// ("your usage invoice of $17.99 will be charged on Nov 11"), update entitlements on past-due, or
// nudge customers when a cheaper plan fits. Events are stored before delivery, so nothing is lost
// if the merchant is down; each event has a stable id so the receiver can deduplicate.
//
// Signature header:  FlexPrice-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
// Verify with verifyEventSignature() from flexprice-ai/sdk.

import crypto from 'node:crypto';

export const EVENT_TYPES = [
  'plan.changed',
  'payment.captured',
  'payment_method.saved',
  'payment_method.removed',
  'invoice.created',
  'invoice.paid',
  'invoice.payment_failed',
  'invoice.past_due',
  'subscription.renewal_upcoming',
  'subscription.renewed',
  'subscription.past_due',
  'subscription.paused',
  'subscription.cancelled',
  'usage.cap_reached',
  'recommendation.savings_available',
  'refund.issued',
  'test.ping',
];

const BACKOFF_MS = [0, 60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000, 6 * 3600_000];

export function signEvent(secret, body, timestamp = Math.floor(Date.now() / 1000)) {
  const v1 = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${v1}`;
}

export class EventService {
  constructor({ store, registry, fetchImpl = fetch, timeoutMs = 5000 }) {
    this.store = store;
    this.registry = registry;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.timer = null;
    this.inflight = new Set();
  }

  #endpoint(merchant) {
    const ev = merchant.events;
    if (!ev?.url || !ev?.secret) return null;
    return { url: typeof ev.url === 'function' ? ev.url() : ev.url, secret: ev.secret };
  }

  /** Record an event and attempt delivery asynchronously. Never throws into business logic. */
  emit(merchantId, type, data = {}) {
    if (!EVENT_TYPES.includes(type)) throw new Error(`Unknown event type ${type}`);
    const merchant = this.registry.get(merchantId);
    const hasEndpoint = Boolean(merchant && this.#endpoint(merchant));
    const evt = this.store.insert(merchantId, 'events', {
      id: `evt_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`,
      type,
      data,
      status: hasEndpoint ? 'pending' : 'no_endpoint',
      attempts: 0,
      next_attempt_at: new Date().toISOString(),
      deliveries: [],
    });
    if (hasEndpoint) setImmediate(() => this.deliver(merchantId, evt).catch(() => {}));
    return evt;
  }

  async deliver(merchantId, evt) {
    if (this.inflight.has(evt.id) || evt.status === 'delivered') return evt;
    const merchant = this.registry.get(merchantId);
    const ep = merchant && this.#endpoint(merchant);
    if (!ep) return evt;
    this.inflight.add(evt.id);
    const body = JSON.stringify({ id: evt.id, type: evt.type, created_at: evt.created_at, merchant_id: merchantId, data: evt.data });
    const started = Date.now();
    let outcome;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetch(ep.url, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', 'FlexPrice-Signature': signEvent(ep.secret, body), 'FlexPrice-Event-Id': evt.id, 'FlexPrice-Event-Type': evt.type },
        body,
      });
      outcome = { ok: res.status >= 200 && res.status < 300, status: res.status };
    } catch (err) {
      outcome = { ok: false, error: err.name === 'AbortError' ? 'timeout' : err.message };
    } finally {
      clearTimeout(timer);
      this.inflight.delete(evt.id);
    }
    const attempts = evt.attempts + 1;
    const exhausted = !outcome.ok && attempts >= BACKOFF_MS.length;
    return this.store.update(merchantId, 'events', evt.id, {
      attempts,
      status: outcome.ok ? 'delivered' : exhausted ? 'failed' : 'pending',
      next_attempt_at: outcome.ok || exhausted ? null : new Date(Date.now() + BACKOFF_MS[attempts]).toISOString(),
      deliveries: [...evt.deliveries, { at: new Date(started).toISOString(), ms: Date.now() - started, ...outcome }].slice(-10),
    });
  }

  /** Retry due events for all merchants (called on an interval). */
  async dispatchDue(now = new Date()) {
    let n = 0;
    for (const merchantId of this.registry.keys()) {
      for (const evt of this.store.find(merchantId, 'events', (e) => e.status === 'pending' && e.next_attempt_at && new Date(e.next_attempt_at) <= now)) {
        await this.deliver(merchantId, evt);
        n += 1;
      }
    }
    return n;
  }

  async redeliver(merchantId, eventId) {
    const evt = this.store.findOne(merchantId, 'events', (e) => e.id === eventId);
    if (!evt) throw Object.assign(new Error('Event not found'), { status: 404 });
    const reset = this.store.update(merchantId, 'events', evt.id, { status: 'pending', next_attempt_at: new Date().toISOString() });
    return this.deliver(merchantId, reset);
  }

  start(intervalMs = 15_000) {
    if (this.timer) return;
    this.timer = setInterval(() => this.dispatchDue().catch(() => {}), intervalMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}
