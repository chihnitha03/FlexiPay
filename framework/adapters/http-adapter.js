// Generic HTTP adapter: lets any merchant integrate by exposing the FlexPrice contract as REST
// endpoints on their own backend, in any language. FlexPrice authenticates with a per-merchant
// bearer token and sends Idempotency-Key headers on mutations.

export class HttpAdapter {
  constructor({ baseUrl, apiKey, fetchImpl = fetch }) {
    this.resolveBase = typeof baseUrl === 'function' ? baseUrl : () => baseUrl;
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
  }

  async #req(method, path, { body, idempotencyKey } = {}) {
    const res = await this.fetch(`${this.resolveBase().replace(/\/$/, '')}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(json.error || `Merchant ${method} ${path} failed (${res.status})`), { status: res.status === 404 ? 404 : 502 });
    return json;
  }

  getManifest() { return this.#req('GET', '/flexprice/manifest'); }
  getPlans() { return this.#req('GET', '/flexprice/plans').then((r) => r.plans); }
  getCustomerContext(ref) { return this.#req('GET', `/flexprice/customers/${encodeURIComponent(ref)}`); }
  getUsage(ref, { from, to } = {}) {
    const q = new URLSearchParams({ ...(from && { from }), ...(to && { to }) });
    return this.#req('GET', `/flexprice/customers/${encodeURIComponent(ref)}/usage?${q}`).then((r) => r.usage);
  }
  recordUsage(event) { return this.#req('POST', '/flexprice/usage', { body: event, idempotencyKey: event.event_id }); }
  changePlan(ref, planId, opts) {
    return this.#req('POST', `/flexprice/customers/${encodeURIComponent(ref)}/plan-change`, {
      body: { target_plan_id: planId, consent_reference: opts.consentReference, payment_reference: opts.paymentReference, retention_offer: opts.retentionOffer },
      idempotencyKey: opts.idempotencyKey,
    });
  }
  getSubscriptionStatus(ref) { return this.#req('GET', `/flexprice/customers/${encodeURIComponent(ref)}/subscription`); }
  pauseSubscription(ref, opts) { return this.#req('POST', `/flexprice/customers/${encodeURIComponent(ref)}/pause`, { body: { months: opts.months }, idempotencyKey: opts.idempotencyKey }); }
  cancelSubscription(ref, opts) { return this.#req('POST', `/flexprice/customers/${encodeURIComponent(ref)}/cancel`, { body: { reason: opts.reason }, idempotencyKey: opts.idempotencyKey }); }
  getCohortUsage() { return this.#req('GET', '/flexprice/cohort-usage').then((r) => r.cohort); }
  applyRetentionOffer(ref, offer, opts) { return this.#req('POST', `/flexprice/customers/${encodeURIComponent(ref)}/retention-offer`, { body: offer, idempotencyKey: opts.idempotencyKey }); }
}
