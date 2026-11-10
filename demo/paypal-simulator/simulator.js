// DEMO ONLY — offline stand-in for the PayPal REST API, implementing the same interface as
// framework/paypal/client.js so the full flow is demoable without sandbox credentials.

import crypto from 'node:crypto';
import { PayPalError } from '../../framework/paypal/client.js';

/**
 * In-process stand-in for PayPal that follows the same state machine:
 * CREATED → (buyer approves on the simulated checkout page) APPROVED → capture → COMPLETED.
 * Emits signed webhooks to the app, just like PayPal would.
 */
export class PayPalSimulator {
  constructor({ publicBaseUrl, webhookSink = null }) {
    this.mode = 'simulator';
    this.publicBaseUrl = publicBaseUrl;
    this.orders = new Map();
    this.subscriptions = new Map();
    this.setupTokens = new Map();
    this.paymentTokens = new Map();
    this.declineVaultIds = new Set(); // demo/test hook: force merchant-initiated charges to fail
    this.requests = new Map();
    this.secret = crypto.randomBytes(32).toString('hex');
    this.webhookSink = webhookSink; // async (headers, event) => void
    this.clientId = 'simulator';
  }

  #idem(key, fn) {
    if (key && this.requests.has(key)) return structuredClone(this.requests.get(key));
    const out = fn();
    if (key) this.requests.set(key, structuredClone(out));
    return out;
  }

  async createOrder({ amount, currency, description, referenceId, customId, invoiceId, idempotencyKey, vault = false, vaultId = null }) {
    if (vaultId) return this.#idem(idempotencyKey, () => this.#chargeVault({ amount, currency, description, referenceId, customId, invoiceId, vaultId }));
    return this.#idem(idempotencyKey, () => {
      const id = `SIM-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
      const order = {
        id,
        intent: 'CAPTURE',
        status: 'CREATED',
        purchase_units: [{ reference_id: referenceId, custom_id: customId, invoice_id: invoiceId, description, amount: { currency_code: currency, value: amount.toFixed(2) } }],
        create_time: new Date().toISOString(),
        vaultRequested: vault,
        links: [{ rel: 'payer-action', href: `${this.publicBaseUrl}/paypal-sim/checkout?token=${id}`, method: 'GET' }],
      };
      this.orders.set(id, order);
      return structuredClone(order);
    });
  }

  async getOrder(orderId) {
    const o = this.orders.get(orderId);
    if (!o) throw new PayPalError('The specified resource does not exist.', { status: 404 });
    return structuredClone(o);
  }

  /** Called by the simulated buyer-approval page. */
  approve(orderId, payer = {}) {
    const o = this.orders.get(orderId);
    if (!o) throw new PayPalError('Order not found', { status: 404 });
    if (o.status === 'CREATED') {
      o.status = 'APPROVED';
      o.simulateDecline = Boolean(payer.decline);
      o.payer = { email_address: payer.email || 'buyer@example.com', payer_id: 'SIMPAYER' + crypto.randomBytes(3).toString('hex').toUpperCase(), name: { given_name: 'Sandbox', surname: 'Buyer' } };
    }
    return structuredClone(o);
  }

  async captureOrder(orderId, { idempotencyKey } = {}) {
    if (idempotencyKey && this.requests.has(idempotencyKey)) return structuredClone(this.requests.get(idempotencyKey));
    const o = this.orders.get(orderId);
    if (!o) throw new PayPalError('Order not found', { status: 404 });
    if (o.status === 'COMPLETED') throw new PayPalError('ORDER_ALREADY_CAPTURED', { status: 422, details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] });
    if (o.status !== 'APPROVED') throw new PayPalError('ORDER_NOT_APPROVED', { status: 422, details: [{ issue: 'ORDER_NOT_APPROVED' }] });
    if (o.simulateDecline) {
      o.status = 'CREATED';
      throw new PayPalError('The instrument presented was either declined by the processor or bank.', { status: 422, details: [{ issue: 'INSTRUMENT_DECLINED' }] });
    }
    o.status = 'COMPLETED';
    const pu = o.purchase_units[0];
    if (o.vaultRequested) {
      const token = this.#newPaymentToken();
      o.payment_source = { paypal: { email_address: o.payer.email_address, attributes: { vault: { id: token.id, status: 'VAULTED', customer: token.customer } } } };
    }
    pu.payments = { captures: [{ id: `SIMCAP-${crypto.randomBytes(6).toString('hex').toUpperCase()}`, status: 'COMPLETED', amount: pu.amount, custom_id: pu.custom_id, invoice_id: pu.invoice_id, create_time: new Date().toISOString() }] };
    const out = structuredClone(o);
    if (idempotencyKey) this.requests.set(idempotencyKey, structuredClone(out));
    this.#emit('PAYMENT.CAPTURE.COMPLETED', { ...pu.payments.captures[0], supplementary_data: { related_ids: { order_id: o.id } } });
    return out;
  }

  // ---- Vault ----
  #newPaymentToken() {
    const token = { id: `SIMVAULT-${crypto.randomBytes(6).toString('hex').toUpperCase()}`, customer: { id: `SIMCUST-${crypto.randomBytes(4).toString('hex').toUpperCase()}` }, status: 'ACTIVE' };
    this.paymentTokens.set(token.id, token);
    return token;
  }

  async createSetupToken({ idempotencyKey } = {}) {
    return this.#idem(idempotencyKey, () => {
      const id = `SIMSETUP-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
      const st = { id, status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'approve', href: `${this.publicBaseUrl}/paypal-sim/checkout?setup_token=${id}`, method: 'GET' }] };
      this.setupTokens.set(id, st);
      return structuredClone(st);
    });
  }

  getSetupToken(id) {
    return this.setupTokens.get(id) ?? null;
  }

  approveSetupToken(id) {
    const st = this.setupTokens.get(id);
    if (!st) throw new PayPalError('Setup token not found', { status: 404 });
    st.status = 'APPROVED';
    return structuredClone(st);
  }

  async createPaymentToken(setupTokenId, { idempotencyKey } = {}) {
    if (idempotencyKey && this.requests.has(idempotencyKey)) return structuredClone(this.requests.get(idempotencyKey));
    const st = this.setupTokens.get(setupTokenId);
    if (!st) throw new PayPalError('Setup token not found', { status: 404 });
    if (st.status !== 'APPROVED') throw new PayPalError('Setup token has not been approved by the payer', { status: 422, details: [{ issue: 'SETUP_TOKEN_NOT_APPROVED' }] });
    const token = this.#newPaymentToken();
    st.status = 'VAULTED';
    if (idempotencyKey) this.requests.set(idempotencyKey, structuredClone(token));
    return structuredClone(token);
  }

  async deletePaymentToken(id) {
    const t = this.paymentTokens.get(id);
    if (!t) throw new PayPalError('Payment token not found', { status: 404 });
    t.status = 'DELETED';
    return {};
  }

  /** Merchant-initiated charge against a vaulted account: completes immediately, like PayPal. */
  #chargeVault({ amount, currency, description, referenceId, customId, invoiceId, vaultId }) {
    const t = this.paymentTokens.get(vaultId);
    if (!t || t.status !== 'ACTIVE') throw new PayPalError('The payment token is invalid or was deleted.', { status: 422, details: [{ issue: 'PAYMENT_SOURCE_INFO_CANNOT_BE_VERIFIED' }] });
    if (this.declineVaultIds.has(vaultId)) throw new PayPalError('The instrument presented was either declined by the processor or bank.', { status: 422, details: [{ issue: 'INSTRUMENT_DECLINED' }] });
    const id = `SIM-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
    const capture = { id: `SIMCAP-${crypto.randomBytes(6).toString('hex').toUpperCase()}`, status: 'COMPLETED', amount: { currency_code: currency, value: amount.toFixed(2) }, custom_id: customId, invoice_id: invoiceId, create_time: new Date().toISOString() };
    const order = { id, intent: 'CAPTURE', status: 'COMPLETED', payment_source: { paypal: { attributes: { vault: { id: vaultId, status: 'VAULTED' } } } }, purchase_units: [{ reference_id: referenceId, custom_id: customId, invoice_id: invoiceId, description, amount: capture.amount, payments: { captures: [capture] } }] };
    this.orders.set(id, order);
    this.#emit('PAYMENT.CAPTURE.COMPLETED', { ...capture, supplementary_data: { related_ids: { order_id: id } } });
    return structuredClone(order);
  }

  async refundCapture(captureId, { amount, currency } = {}) {
    const order = [...this.orders.values()].find((o) => o.purchase_units[0].payments?.captures?.[0]?.id === captureId);
    if (!order) throw new PayPalError('Capture not found', { status: 404 });
    const cap = order.purchase_units[0].payments.captures[0];
    const refund = { id: `SIMREF-${crypto.randomBytes(6).toString('hex').toUpperCase()}`, status: 'COMPLETED', amount: amount ? { value: amount.toFixed(2), currency_code: currency } : cap.amount };
    cap.status = amount && amount < Number(cap.amount.value) ? 'PARTIALLY_REFUNDED' : 'REFUNDED';
    this.#emit('PAYMENT.CAPTURE.REFUNDED', { ...refund, custom_id: cap.custom_id, links: [{ rel: 'up', href: `/v2/payments/captures/${captureId}` }] });
    return refund;
  }

  async createProduct({ name }) {
    return { id: `PROD-SIM-${crypto.createHash('sha1').update(name).digest('hex').slice(0, 10).toUpperCase()}`, name };
  }

  async createBillingPlan({ productId, name, price, currency, interval }) {
    return { id: `P-SIM-${crypto.createHash('sha1').update(productId + name + price).digest('hex').slice(0, 16).toUpperCase()}`, status: 'ACTIVE', name, price, currency, interval };
  }

  createSubscription({ planId, customId }) {
    const id = `I-SIM${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
    const sub = { id, plan_id: planId, custom_id: customId, status: 'ACTIVE', start_time: new Date().toISOString() };
    this.subscriptions.set(id, sub);
    return structuredClone(sub);
  }

  async getSubscription(id) {
    const s = this.subscriptions.get(id);
    if (!s) throw new PayPalError('Subscription not found', { status: 404 });
    return structuredClone(s);
  }

  async cancelSubscription(id) {
    const s = this.subscriptions.get(id);
    if (s) s.status = 'CANCELLED';
  }

  async verifyWebhook(headers, event) {
    const expected = crypto.createHmac('sha256', this.secret).update(`${headers['paypal-transmission-id']}|${JSON.stringify(event)}`).digest('hex');
    const got = headers['paypal-transmission-sig'] || '';
    return got.length === expected.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
  }

  #emit(eventType, resource) {
    if (!this.webhookSink) return;
    const event = { id: `WH-SIM-${crypto.randomUUID()}`, event_type: eventType, resource_type: eventType.split('.')[1]?.toLowerCase(), resource, create_time: new Date().toISOString() };
    const transmissionId = crypto.randomUUID();
    const headers = {
      'paypal-transmission-id': transmissionId,
      'paypal-transmission-sig': crypto.createHmac('sha256', this.secret).update(`${transmissionId}|${JSON.stringify(event)}`).digest('hex'),
      'paypal-auth-algo': 'SIM-HMAC-SHA256',
    };
    // Deliver asynchronously, like a real webhook; deliver twice to exercise duplicate handling.
    setTimeout(() => this.webhookSink(headers, event).catch(() => {}), 150);
    setTimeout(() => this.webhookSink(headers, event).catch(() => {}), 600);
  }
}
