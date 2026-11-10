// PayPal REST client (Orders v2, Payments v2, Vault v3, Subscriptions v1, Webhooks v1).
// Any object implementing the same methods can be injected instead (the demo injects an offline
// simulator; see demo/paypal-simulator).

import crypto from 'node:crypto';

export class PayPalError extends Error {
  constructor(message, { status = 502, details = null, debugId = null } = {}) {
    super(message);
    this.name = 'PayPalError';
    this.status = status;
    this.details = details;
    this.debugId = debugId;
  }
}

export class PayPalClient {
  constructor({ clientId, clientSecret, apiBase, webhookId, fetchImpl = fetch }) {
    this.mode = apiBase.includes('sandbox') ? 'sandbox' : 'live';
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.apiBase = apiBase;
    this.webhookId = webhookId;
    this.fetch = fetchImpl;
    this.token = null;
  }

  async accessToken() {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const res = await this.fetch(`${this.apiBase}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) throw new PayPalError('PayPal authentication failed', { status: 502, details: await res.text() });
    const json = await res.json();
    this.token = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
    return this.token.value;
  }

  async request(method, path, { body, idempotencyKey, headers = {} } = {}) {
    const res = await this.fetch(`${this.apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await this.accessToken()}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
        ...(idempotencyKey ? { 'PayPal-Request-Id': idempotencyKey } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      throw new PayPalError(json.message || `PayPal ${method} ${path} failed`, {
        status: res.status >= 500 ? 502 : res.status,
        details: json.details,
        debugId: json.debug_id || res.headers.get('paypal-debug-id'),
      });
    }
    return json;
  }

  /**
   * Orders v2. Options:
   *  - vault: true   → save the buyer's PayPal account on successful capture (Vault "save with purchase")
   *  - vaultId       → merchant-initiated charge against a previously vaulted account (no buyer present)
   */
  createOrder({ amount, currency, description, referenceId, customId, invoiceId, brandName, returnUrl, cancelUrl, idempotencyKey, vault = false, vaultId = null }) {
    const paymentSource = vaultId
      ? { paypal: { vault_id: vaultId } }
      : {
          paypal: {
            ...(vault ? { attributes: { vault: { store_in_vault: 'ON_SUCCESS', usage_type: 'MERCHANT', customer_type: 'CONSUMER' } } } : {}),
            experience_context: {
              brand_name: brandName?.slice(0, 127),
              user_action: 'PAY_NOW',
              shipping_preference: 'NO_SHIPPING',
              return_url: returnUrl,
              cancel_url: cancelUrl,
            },
          },
        };
    return this.request('POST', '/v2/checkout/orders', {
      idempotencyKey,
      body: {
        intent: 'CAPTURE',
        purchase_units: [
          {
            reference_id: referenceId,
            custom_id: customId,
            invoice_id: invoiceId,
            description: description?.slice(0, 127),
            amount: { currency_code: currency, value: amount.toFixed(2) },
          },
        ],
        payment_source: paymentSource,
      },
    });
  }

  // ---- Vault v3 (save PayPal without a purchase, for $0-due metered plans) ----
  createSetupToken({ description, brandName, returnUrl, cancelUrl, idempotencyKey }) {
    return this.request('POST', '/v3/vault/setup-tokens', {
      idempotencyKey,
      body: {
        payment_source: {
          paypal: {
            description: description?.slice(0, 127),
            usage_type: 'MERCHANT',
            customer_type: 'CONSUMER',
            permit_multiple_payment_tokens: false,
            experience_context: { brand_name: brandName?.slice(0, 127), shipping_preference: 'NO_SHIPPING', vault_instruction: 'ON_PAYER_APPROVAL', return_url: returnUrl, cancel_url: cancelUrl },
          },
        },
      },
    });
  }

  createPaymentToken(setupTokenId, { idempotencyKey } = {}) {
    return this.request('POST', '/v3/vault/payment-tokens', { idempotencyKey, body: { payment_source: { token: { id: setupTokenId, type: 'SETUP_TOKEN' } } } });
  }

  deletePaymentToken(paymentTokenId) {
    return this.request('DELETE', `/v3/vault/payment-tokens/${encodeURIComponent(paymentTokenId)}`);
  }

  getOrder(orderId) {
    return this.request('GET', `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
  }

  captureOrder(orderId, { idempotencyKey } = {}) {
    return this.request('POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, { idempotencyKey, body: {} });
  }

  refundCapture(captureId, { amount, currency, idempotencyKey } = {}) {
    return this.request('POST', `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {
      idempotencyKey,
      body: amount ? { amount: { value: amount.toFixed(2), currency_code: currency } } : {},
    });
  }

  // ---- Subscriptions (fixed recurring plans) ----
  createProduct({ name, description, idempotencyKey }) {
    return this.request('POST', '/v1/catalogs/products', {
      idempotencyKey,
      body: { name, description, type: 'DIGITAL', category: 'SOFTWARE' },
    });
  }

  createBillingPlan({ productId, name, description, price, currency, interval, idempotencyKey }) {
    return this.request('POST', '/v1/billing/plans', {
      idempotencyKey,
      body: {
        product_id: productId,
        name,
        description: description?.slice(0, 127),
        status: 'ACTIVE',
        billing_cycles: [
          {
            frequency: { interval_unit: interval === 'year' ? 'YEAR' : 'MONTH', interval_count: 1 },
            tenure_type: 'REGULAR',
            sequence: 1,
            total_cycles: 0,
            pricing_scheme: { fixed_price: { value: price.toFixed(2), currency_code: currency } },
          },
        ],
        payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 2 },
      },
    });
  }

  getSubscription(subscriptionId) {
    return this.request('GET', `/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}`);
  }

  cancelSubscription(subscriptionId, reason) {
    return this.request('POST', `/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, { body: { reason } });
  }

  /** Verify a webhook using PayPal's verification API (PRD §7). */
  async verifyWebhook(headers, event) {
    if (!this.webhookId) return false;
    const res = await this.request('POST', '/v1/notifications/verify-webhook-signature', {
      body: {
        auth_algo: headers['paypal-auth-algo'],
        cert_url: headers['paypal-cert-url'],
        transmission_id: headers['paypal-transmission-id'],
        transmission_sig: headers['paypal-transmission-sig'],
        transmission_time: headers['paypal-transmission-time'],
        webhook_id: this.webhookId,
        webhook_event: event,
      },
    });
    return res.verification_status === 'SUCCESS';
  }
}
