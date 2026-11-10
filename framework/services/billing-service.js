// Billing integration (PRD §5.2-F, §6). Coordinates customer consent, PayPal Orders checkout,
// server-side payment verification, merchant plan-change fulfilment, the FlexPrice billing
// schedule (renewals of fixed plans and month-end usage invoices, charged to a PayPal Vault saved
// account), proration on plan switches, account credits, webhooks and reconciliation.
// A browser redirect is never treated as proof of payment.
//
// Who bills what: FlexPrice runs the billing schedule for plans sold through FlexPrice. Customers
// still billed by the merchant's own system are untouched; when they switch through FlexPrice,
// the unused part of their current period is credited (proration).

import crypto from 'node:crypto';
import { authorizePlanChange, authorizeCharge } from '../core/policy-engine.js';
import { toCents, fromCents } from '../core/money.js';
import { PayPalError } from '../paypal/client.js';
import { periodOf } from '../core/usage-ledger.js';

const hash = (o) => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0, 16);
const DAY = 864e5;
const isMetered = (plan) => plan.billing_model !== 'fixed';
const unitName = (plan) => String(plan.unit ?? plan.usage_metric ?? 'unit').replace(/s$/, '');
const fmt = (n, c = 'USD') => new Intl.NumberFormat('en-US', { style: 'currency', currency: c }).format(n);
const LIVE_SUB = ['active', 'past_due', 'paused'];

/** Calendar helpers (UTC). */
export function addInterval(iso, interval) {
  const d = new Date(iso);
  const day = d.getUTCDate();
  const months = interval === 'year' ? 12 : 1;
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1, d.getUTCHours(), d.getUTCMinutes()));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, last)); // Jan 31 → Feb 28
  return target.toISOString();
}
const startOfNextMonth = (iso) => {
  const d = new Date(iso);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
};

/** What the plan itself costs today (before proration). Metered usage is billed in arrears. */
export function amountDueNow(plan) {
  if (plan.billing_model === 'fixed') return { cents: toCents(plan.base_price), description: plan.billing_interval === 'year' ? 'First year (12 months)' : 'First month' };
  if (plan.base_price > 0) return { cents: toCents(plan.base_price), description: 'First month base fee; usage billed at month end' };
  return { cents: 0, description: 'Nothing due today; usage billed at month end' };
}

/**
 * Credit for the unused part of a prepaid fixed-price period, in whole days.
 * Returns null when there is nothing to credit (metered plan, unknown period, period over).
 */
export function prorationCredit({ plan, periodStart, periodEnd, paidCents, now = new Date() }) {
  if (!plan || plan.billing_model !== 'fixed' || !periodStart || !periodEnd || !(paidCents > 0)) return null;
  const start = Date.parse(periodStart);
  const end = Date.parse(periodEnd);
  const t = now.getTime();
  if (!(end > t)) return null;
  const periodDays = Math.max(1, Math.round((end - start) / DAY));
  // A prepaid period that has not started yet (e.g. renewed early) is entirely unused.
  const unusedDays = t < start ? periodDays : Math.min(periodDays, Math.floor((end - t) / DAY));
  if (unusedDays <= 0) return null;
  return { from_plan_id: plan.plan_id, from_plan_name: plan.name, unused_days: unusedDays, period_days: periodDays, credit_cents: Math.floor((paidCents * unusedDays) / periodDays) };
}

/**
 * Everything the customer must see before accepting (PRD §6.4): net amount due today (after any
 * proration credit), and an explicit authorization for future merchant-initiated charges when the
 * plan is billed to a saved PayPal account (usage invoices and/or renewals).
 */
export function disclosure(plan, { merchantName = 'the merchant', policy, quote = null, savesAccount = false, switchingFromMetered = null } = {}) {
  const due = amountDueNow(plan);
  const net = quote ? quote.net_cents : due.cents;
  const metered = isMetered(plan);
  let future = null;
  if (savesAccount && metered) {
    future = {
      authorization: `You authorize ${merchantName} to charge your saved PayPal account after each billing month for the usage charges above${plan.spending_cap != null ? `, never more than ${fmt(plan.spending_cap, plan.currency)} per month` : ''}. You will be notified ${policy.usage_billing.invoice_notice_days} day(s) before each charge and can remove the saved account at any time.`,
      max_per_month: plan.spending_cap,
      notice_days: policy.usage_billing.invoice_notice_days,
    };
  } else if (savesAccount) {
    future = {
      authorization: `You authorize ${merchantName} to charge your saved PayPal account ${fmt(plan.base_price, plan.currency)} every ${plan.billing_interval} when your plan renews, until you cancel. You will be notified ${policy.renewals.notice_days} day(s) before each renewal and can cancel or remove the saved account at any time.`,
      amount_per_renewal: plan.base_price,
      notice_days: policy.renewals.notice_days,
    };
  }
  return {
    plan_id: plan.plan_id,
    plan_name: plan.name,
    currency: plan.currency,
    due_today: fromCents(net),
    due_today_gross: fromCents(due.cents),
    due_today_description: due.description,
    proration: quote?.credit
      ? {
          from_plan_name: quote.credit.from_plan_name,
          unused_days: quote.credit.unused_days,
          period_days: quote.credit.period_days,
          credit: fromCents(quote.credit.credit_cents),
          applied_today: fromCents(quote.applied_cents),
          carried_forward: fromCents(quote.carried_cents),
        }
      : null,
    pending_usage_note: switchingFromMetered ? `Usage so far this month on ${switchingFromMetered} is invoiced separately at that plan's rates.` : null,
    billing_frequency: plan.billing_interval === 'year' ? 'yearly' : 'monthly',
    base_price: plan.base_price,
    usage_formula:
      plan.billing_model === 'fixed'
        ? null
        : plan.billing_model === 'tiered'
          ? plan.tier_rules.map((t) => `${fmt(t.unit_price, plan.currency)} per ${unitName(plan)} ${t.up_to ? `up to ${t.up_to}` : 'thereafter'}`).join('; ')
          : `${fmt(plan.unit_price, plan.currency)} per ${unitName(plan)}${plan.included_usage ? ` after ${plan.included_usage} ${plan.unit ?? ''} included` : ''}`,
    minimum_charge: plan.minimum_charge || null,
    spending_cap: plan.spending_cap,
    commitment_months: plan.terms.commitment_months,
    auto_renews: plan.terms.auto_renews,
    cancel_anytime: plan.terms.cancel_anytime,
    terms_summary: plan.terms.summary ?? null,
    future_charges: future,
  };
}

export class BillingService {
  constructor({ pricing, store, paypal, ledger, config, events = null }) {
    this.pricing = pricing;
    this.store = store;
    this.paypal = paypal; // null when payments are not configured
    this.ledger = ledger;
    this.config = config;
    this.events = events;
  }

  get paymentsMode() {
    return this.paypal?.mode ?? 'disabled';
  }

  get vaultSupported() {
    return Boolean(this.paypal?.createSetupToken);
  }

  #emit(merchantId, type, data) {
    try {
      this.events?.emit(merchantId, type, data);
    } catch {
      /* events must never break billing */
    }
  }

  #requirePayPal() {
    if (!this.paypal) throw Object.assign(new Error('Payments are not configured for this deployment'), { status: 503 });
    return this.paypal;
  }

  #returnUrls(checkoutId) {
    return {
      returnUrl: `${this.config.publicBaseUrl}/checkout/return.html?checkout=${checkoutId}`,
      cancelUrl: `${this.config.publicBaseUrl}/checkout/return.html?cancelled=1`,
    };
  }

  /** Is this plan billed to a saved PayPal account (usage invoices or renewals)? */
  savesAccount(merchant, plan) {
    if (!this.vaultSupported) return false;
    if (isMetered(plan)) return merchant.policy.usage_billing.auto_collect;
    return plan.terms.auto_renews && merchant.policy.renewals.auto_renew_with_saved_paypal;
  }

  liveSubscription(merchantId, customerRef) {
    return this.store.find(merchantId, 'subscriptions', (s) => s.customer_reference === customerRef && LIVE_SUB.includes(s.status)).at(-1) ?? null;
  }

  creditBalanceCents(merchantId, customerRef) {
    return this.store.find(merchantId, 'credits', (c) => c.customer_reference === customerRef).reduce((s, c) => s + c.remaining_cents, 0);
  }

  #consumeCredit(merchantId, customerRef, maxCents) {
    let applied = 0;
    for (const c of this.store.find(merchantId, 'credits', (x) => x.customer_reference === customerRef && x.remaining_cents > 0)) {
      if (applied >= maxCents) break;
      const take = Math.min(c.remaining_cents, maxCents - applied);
      this.store.update(merchantId, 'credits', c.id, { remaining_cents: c.remaining_cents - take });
      applied += take;
    }
    return applied;
  }

  /** What the customer currently has and has paid for (FlexPrice-billed or merchant-billed). */
  #currentBilling(merchantId, ctx) {
    const currentPlan = ctx.plans.find((p) => p.plan_id === ctx.customer.current_plan_id) ?? null;
    const sub = this.liveSubscription(merchantId, ctx.customer.customer_reference);
    if (sub && sub.plan_id === currentPlan?.plan_id) {
      return { currentPlan, sub, periodStart: sub.current_period_start, periodEnd: sub.current_period_end, paidCents: sub.paid_cents, billedBy: 'flexprice' };
    }
    // Merchant-billed customer: the adapter may report the current period; assume it was paid.
    const c = ctx.customer;
    return { currentPlan, sub: null, periodStart: c.current_period_start ?? null, periodEnd: c.current_period_end ?? null, paidCents: currentPlan ? toCents(currentPlan.base_price) : 0, billedBy: 'merchant' };
  }

  /** Price today for switching to `plan`, including proration of the current period. */
  quote(merchantId, ctx, plan, now = new Date()) {
    const gross = amountDueNow(plan).cents;
    const cur = this.#currentBilling(merchantId, ctx);
    const credit = ctx.merchant.policy.plan_change.proration === 'credit' && cur.currentPlan?.plan_id !== plan.plan_id
      ? prorationCredit({ plan: cur.currentPlan, periodStart: cur.periodStart, periodEnd: cur.periodEnd, paidCents: cur.paidCents, now })
      : null;
    const applied = credit ? Math.min(credit.credit_cents, gross) : 0;
    return { gross_cents: gross, credit, applied_cents: applied, carried_cents: credit ? credit.credit_cents - applied : 0, net_cents: gross - applied, current: cur };
  }

  termsFor(merchant, plan, ctx = null) {
    const quote = ctx ? this.quote(merchant.id, ctx, plan) : null;
    const fromMetered = quote?.current.currentPlan && isMetered(quote.current.currentPlan) && quote.current.currentPlan.plan_id !== plan.plan_id ? quote.current.currentPlan.name : null;
    const d = disclosure(plan, { merchantName: merchant.name, policy: merchant.policy, quote, savesAccount: this.savesAccount(merchant, plan), switchingFromMetered: fromMetered });
    return { disclosure: d, terms_hash: hash(d), quote };
  }

  /** Step 1: customer reviews the disclosure and accepts. Consent is bound to the exact terms. */
  async recordConsent(merchantId, customerRef, planId, { termsHash, recommendationId }) {
    const ctx = await this.pricing.context(merchantId, customerRef, { includeHistory: false });
    const plan = ctx.eligible.find((p) => p.plan_id === planId);
    if (!plan) throw Object.assign(new Error('Plan is not available for this customer'), { status: 422 });
    const { disclosure: disc, terms_hash: expected } = this.termsFor(ctx.merchant, plan, ctx);
    if (termsHash !== expected) throw Object.assign(new Error('Terms changed since they were displayed; please review again'), { status: 409, terms_hash: expected });
    const consent = this.store.insert(merchantId, 'consents', {
      type: 'plan_terms',
      customer_reference: customerRef,
      plan_id: planId,
      terms_hash: expected,
      disclosure: disc,
      authorizes_future_charges: Boolean(disc.future_charges),
      recommendation_id: recommendationId ?? null,
      accepted_at: new Date().toISOString(),
    });
    this.store.audit(merchantId, 'consent_recorded', { customer_reference: customerRef, plan_id: planId, consent_id: consent.id, authorizes_future_charges: consent.authorizes_future_charges });
    return consent;
  }

  async #authorize(merchantId, customerRef, planId, consentId) {
    const ctx = await this.pricing.context(merchantId, customerRef, { includeHistory: false });
    const plan = ctx.eligible.find((p) => p.plan_id === planId) ?? ctx.plans.find((p) => p.plan_id === planId);
    const consent = this.store.findOne(merchantId, 'consents', (c) => c.id === consentId);
    const decision = authorizePlanChange({
      actor: 'customer',
      customer: ctx.customer,
      targetPlan: plan,
      eligiblePlanIds: ctx.eligible.map((p) => p.plan_id),
      consent,
      recentChanges: this.store.find(merchantId, 'plan_changes', (c) => c.customer_reference === customerRef).map((c) => ({ at: c.created_at })),
      policy: ctx.merchant.policy,
      capabilities: ctx.capabilities,
    });
    if (!decision.allowed) throw Object.assign(new Error(`Not permitted: ${decision.reasons.join('; ')}`), { status: 403, reasons: decision.reasons });
    return { ctx, plan, consent };
  }

  activePaymentMethod(merchantId, customerRef) {
    return this.store.findOne(merchantId, 'payment_methods', (p) => p.customer_reference === customerRef && p.status === 'active');
  }

  /**
   * Step 2: create a PayPal order for the server-computed net amount. If the plan is billed to a
   * saved PayPal account, the account is vaulted with the purchase, or through a Vault setup token
   * when nothing is due today.
   */
  async startCheckout(merchantId, customerRef, planId, { consentId }) {
    const { ctx, plan, consent } = await this.#authorize(merchantId, customerRef, planId, consentId);
    const existing = this.store.findOne(merchantId, 'checkouts', (c) => c.consent_id === consentId && ['created', 'awaiting_payment_method', 'completed', 'paid_pending_fulfillment'].includes(c.status));
    if (existing) return this.#checkoutView(existing);

    const q = this.quote(merchantId, ctx, plan);
    // The consented terms are authoritative: if the quote moved (e.g. a day passed), re-consent.
    if (toCents(consent.disclosure.due_today) !== q.net_cents) throw Object.assign(new Error('The amount due changed since you accepted the terms; please review again'), { status: 409 });
    const due = amountDueNow(plan);
    const vault = this.savesAccount(ctx.merchant, plan) && consent.authorizes_future_charges && !this.activePaymentMethod(merchantId, customerRef);
    const checkout = this.store.insert(merchantId, 'checkouts', {
      customer_reference: customerRef,
      plan_id: plan.plan_id,
      previous_plan_id: ctx.customer.current_plan_id,
      previous_subscription_id: q.current.sub?.id ?? null,
      consent_id: consent.id,
      recommendation_id: consent.recommendation_id,
      gross_cents: q.gross_cents,
      amount_cents: q.net_cents,
      proration: q.credit ? { ...q.credit, applied_cents: q.applied_cents, carried_cents: q.carried_cents, billed_by: q.current.billedBy } : null,
      currency: plan.currency,
      status: 'created',
      kind: 'plan_change',
      vault_requested: vault,
    });

    if (q.net_cents === 0 && !vault) return this.#checkoutView(await this.#fulfil(merchantId, checkout, { paymentReference: null }));

    const paypal = this.#requirePayPal();
    if (q.net_cents === 0) {
      const st = await paypal.createSetupToken({
        description: `${ctx.manifest.name} — ${plan.name} ${isMetered(plan) ? 'usage billing' : 'renewals'}`,
        brandName: ctx.merchant.paypal.brand_name,
        ...this.#returnUrls(checkout.id),
        idempotencyKey: `setup-${checkout.id}`,
      });
      this.store.update(merchantId, 'checkouts', checkout.id, { status: 'awaiting_payment_method', setup_token_id: st.id });
      this.store.audit(merchantId, 'vault_setup_started', { checkout_id: checkout.id, setup_token_id: st.id });
      return { ...this.#checkoutView(checkout), approve_url: approveLink(st) };
    }

    const order = await paypal.createOrder({
      amount: fromCents(q.net_cents),
      currency: plan.currency,
      description: `${ctx.manifest.name} — ${plan.name} (${due.description}${q.applied_cents ? `, ${fmt(fromCents(q.applied_cents))} credit applied` : ''})`,
      referenceId: plan.plan_id,
      customId: `${merchantId}|${checkout.id}`,
      invoiceId: `${merchantId}-${checkout.id}`,
      brandName: ctx.merchant.paypal.brand_name,
      vault,
      ...this.#returnUrls(checkout.id),
      idempotencyKey: `order-${checkout.id}`,
    });
    this.store.update(merchantId, 'checkouts', checkout.id, { paypal_order_id: order.id });
    this.store.audit(merchantId, 'paypal_order_created', { checkout_id: checkout.id, order_id: order.id, amount: fromCents(q.net_cents), vault });
    return { ...this.#checkoutView(checkout), approve_url: approveLink(order) };
  }

  /** Step 2b (nothing due today): buyer approved the setup token → create payment token → fulfil. */
  async completePaymentMethodSetup(merchantId, customerRef, checkoutId) {
    const checkout = this.store.findOne(merchantId, 'checkouts', (c) => c.id === checkoutId && c.customer_reference === customerRef);
    if (!checkout?.setup_token_id) throw Object.assign(new Error('Checkout not found'), { status: 404 });
    return this.store.idempotent(merchantId, `vault:${checkoutId}`, async () => {
      if (checkout.status === 'completed') return this.#checkoutView(checkout);
      const token = await this.#requirePayPal().createPaymentToken(checkout.setup_token_id, { idempotencyKey: `ptoken-${checkout.id}` });
      this.#savePaymentMethod(merchantId, customerRef, { vault_id: token.id, paypal_customer_id: token.customer?.id ?? null, source_checkout_id: checkout.id, consent_id: checkout.consent_id });
      return this.#checkoutView(await this.#fulfil(merchantId, checkout, { paymentReference: null }));
    });
  }

  #savePaymentMethod(merchantId, customerRef, pm) {
    for (const old of this.store.find(merchantId, 'payment_methods', (p) => p.customer_reference === customerRef && p.status === 'active')) {
      this.store.update(merchantId, 'payment_methods', old.id, { status: 'replaced' });
    }
    const row = this.store.insert(merchantId, 'payment_methods', { customer_reference: customerRef, provider: 'paypal', status: 'active', ...pm });
    this.store.audit(merchantId, 'payment_method_vaulted', { customer_reference: customerRef, payment_method_id: row.id });
    this.#emit(merchantId, 'payment_method.saved', { customer_reference: customerRef, provider: 'paypal' });
    return row;
  }

  async removePaymentMethod(merchantId, customerRef) {
    const pm = this.activePaymentMethod(merchantId, customerRef);
    if (!pm) throw Object.assign(new Error('No saved payment method'), { status: 404 });
    await this.#requirePayPal().deletePaymentToken(pm.vault_id).catch((err) => {
      if (err.status !== 404) throw err;
    });
    this.store.update(merchantId, 'payment_methods', pm.id, { status: 'removed', removed_at: new Date().toISOString() });
    // Pending automatic invoices fall back to manual payment.
    for (const inv of this.store.find(merchantId, 'invoices', (i) => i.customer_reference === customerRef && i.status === 'open' && i.collection === 'automatic')) {
      this.store.update(merchantId, 'invoices', inv.id, { collection: 'manual' });
    }
    this.store.audit(merchantId, 'payment_method_removed', { customer_reference: customerRef });
    this.#emit(merchantId, 'payment_method.removed', { customer_reference: customerRef });
    return { removed: true };
  }

  paymentMethodView(merchantId, customerRef) {
    const pm = this.activePaymentMethod(merchantId, customerRef);
    return pm ? { provider: pm.provider, status: pm.status, saved_at: pm.created_at, payer_email: pm.payer_email ?? null } : null;
  }

  subscriptionView(merchantId, customerRef) {
    const s = this.liveSubscription(merchantId, customerRef);
    return s
      ? { plan_id: s.plan_id, status: s.status, current_period_start: s.current_period_start, current_period_end: s.current_period_end, auto_renew: s.auto_renew, billing_model: s.billing_model, renewal_amount: s.billing_model === 'fixed' && s.auto_renew ? fromCents(s.renewal_cents) : null, credit_balance: fromCents(this.creditBalanceCents(merchantId, customerRef)) }
      : null;
  }

  /** Step 3: buyer approved in PayPal → capture server-side, verify, then fulfil with the merchant. */
  async captureCheckout(merchantId, customerRef, orderId) {
    const checkout = this.store.findOne(merchantId, 'checkouts', (c) => c.paypal_order_id === orderId);
    if (!checkout || (customerRef && checkout.customer_reference !== customerRef)) throw Object.assign(new Error('Checkout not found'), { status: 404 });
    return this.store.idempotent(merchantId, `capture:${orderId}`, () => this.#captureAndFulfil(merchantId, checkout));
  }

  async #captureAndFulfil(merchantId, checkout) {
    if (checkout.status === 'completed') return this.#checkoutView(checkout);
    let order;
    if (checkout.status !== 'paid_pending_fulfillment') {
      const paypal = this.#requirePayPal();
      try {
        order = await paypal.captureOrder(checkout.paypal_order_id, { idempotencyKey: `capture-${checkout.id}` });
      } catch (err) {
        if (err instanceof PayPalError && err.details?.some?.((d) => d.issue === 'ORDER_ALREADY_CAPTURED')) order = await paypal.getOrder(checkout.paypal_order_id);
        else {
          this.store.update(merchantId, 'checkouts', checkout.id, { status: err.details?.some?.((d) => d.issue === 'INSTRUMENT_DECLINED') ? 'payment_declined' : 'created', last_error: err.message });
          throw err;
        }
      }
      const verification = this.#recordCapture(merchantId, checkout, order);
      if (checkout.vault_requested) {
        const v = order.payment_source?.paypal?.attributes?.vault;
        if (v?.id) this.#savePaymentMethod(merchantId, checkout.customer_reference, { vault_id: v.id, paypal_customer_id: v.customer?.id ?? null, payer_email: order.payer?.email_address ?? null, source_checkout_id: checkout.id, consent_id: checkout.consent_id });
        else this.store.audit(merchantId, 'vault_not_returned', { checkout_id: checkout.id, vault_status: v?.status ?? null });
      }
      if (checkout.kind === 'invoice') {
        this.#markInvoicePaid(merchantId, checkout.invoice_id, verification.capture_id);
        return this.#checkoutView(this.store.update(merchantId, 'checkouts', checkout.id, { status: 'completed' }));
      }
    }
    return this.#checkoutView(await this.#fulfil(merchantId, checkout, { paymentReference: checkout.capture_id }));
  }

  /** Verify a completed PayPal order and record it; throws on mismatch. */
  #recordCapture(merchantId, checkout, order) {
    const verification = this.verifyCapturedOrder(order, checkout, merchantId);
    if (!verification.ok) {
      this.store.update(merchantId, 'checkouts', checkout.id, { status: 'payment_mismatch', verification });
      this.store.audit(merchantId, 'payment_verification_failed', { checkout_id: checkout.id, ...verification });
      throw Object.assign(new Error(`Payment verification failed: ${verification.reasons.join('; ')}`), { status: 409 });
    }
    this.store.update(merchantId, 'checkouts', checkout.id, { status: 'paid_pending_fulfillment', capture_id: verification.capture_id, payer_email: order.payer?.email_address ?? null, paid_at: new Date().toISOString() });
    this.store.audit(merchantId, 'payment_captured', { checkout_id: checkout.id, capture_id: verification.capture_id, amount: fromCents(checkout.amount_cents), merchant_initiated: Boolean(checkout.merchant_initiated) });
    this.store.metric(merchantId, 'payment_captured', { amount: fromCents(checkout.amount_cents), plan_id: checkout.plan_id, merchant_initiated: Boolean(checkout.merchant_initiated) });
    this.#emit(merchantId, 'payment.captured', { customer_reference: checkout.customer_reference, checkout_id: checkout.id, capture_id: verification.capture_id, amount: fromCents(checkout.amount_cents), currency: checkout.currency, kind: checkout.kind, merchant_initiated: Boolean(checkout.merchant_initiated) });
    return verification;
  }

  /** Independently verify the order PayPal returned matches what we expected to charge. */
  verifyCapturedOrder(order, checkout, merchantId) {
    const reasons = [];
    const pu = order?.purchase_units?.[0];
    const cap = pu?.payments?.captures?.[0];
    if (order?.status !== 'COMPLETED') reasons.push(`order status ${order?.status}`);
    if (!cap || !['COMPLETED', 'PENDING'].includes(cap.status)) reasons.push(`capture status ${cap?.status}`);
    const amount = cap?.amount ?? pu?.amount;
    if (amount && toCents(amount.value) !== checkout.amount_cents) reasons.push(`amount ${amount.value} != expected ${fromCents(checkout.amount_cents)}`);
    if (amount && amount.currency_code !== checkout.currency) reasons.push('currency mismatch');
    const customId = cap?.custom_id ?? pu?.custom_id;
    if (customId && customId !== `${merchantId}|${checkout.id}`) reasons.push('custom_id mismatch');
    return { ok: reasons.length === 0, reasons, capture_id: cap?.id, capture_status: cap?.status };
  }

  async #fulfil(merchantId, checkout, { paymentReference }) {
    const m = this.pricing.merchant(merchantId);
    const gw = m.gateway;
    try {
      const change = await gw.changePlan(checkout.customer_reference, checkout.plan_id, {
        idempotencyKey: `chg-${checkout.id}`,
        consentReference: checkout.consent_id,
        paymentReference,
      });
      const sub = await gw.getSubscriptionStatus(checkout.customer_reference);
      if (sub.plan_id !== checkout.plan_id) throw new Error(`merchant reports plan ${sub.plan_id}, expected ${checkout.plan_id}`);
      await this.#startSubscription(merchantId, checkout);
      this.store.insert(merchantId, 'plan_changes', { customer_reference: checkout.customer_reference, from: checkout.previous_plan_id, to: checkout.plan_id, checkout_id: checkout.id, merchant_result: change });
      this.pricing.invalidate(merchantId, checkout.customer_reference);
      const rec = checkout.recommendation_id && this.store.findOne(merchantId, 'recommendations', (r) => r.id === checkout.recommendation_id);
      const est = rec?.plan_estimates ?? {};
      const next = est[checkout.plan_id];
      const prev = checkout.previous_plan_id ? est[checkout.previous_plan_id] : null;
      this.store.metric(merchantId, 'plan_selected', {
        plan_id: checkout.plan_id,
        followed_recommendation: rec ? rec.recommended_plan_id === checkout.plan_id : null,
        estimated_savings: rec && rec.recommended_plan_id === checkout.plan_id ? rec.estimated_savings : 0,
        retention_save: checkout.retention ?? false,
        // Merchant view (12-month estimates): a save keeps revenue that would otherwise churn;
        // a regular switch shifts revenue between plans.
        revenue_delta_12m: next == null ? null : checkout.retention ? next : prev == null ? next : Math.round((next - prev) * 100) / 100,
      });
      this.store.audit(merchantId, 'plan_changed', { checkout_id: checkout.id, customer_reference: checkout.customer_reference, to: checkout.plan_id, verified_subscription: sub.status });
      this.#emit(merchantId, 'plan.changed', {
        customer_reference: checkout.customer_reference,
        from_plan_id: checkout.previous_plan_id,
        to_plan_id: checkout.plan_id,
        amount_paid: fromCents(checkout.amount_cents),
        proration_credit: checkout.proration ? fromCents(checkout.proration.credit_cents) : 0,
        // Merchant-billed customers: the merchant should stop billing the old plan in its own system.
        previous_plan_billed_by: checkout.proration?.billed_by ?? (checkout.previous_subscription_id ? 'flexprice' : 'merchant'),
      });
      return this.store.update(merchantId, 'checkouts', checkout.id, { status: 'completed', subscription: sub, completed_at: new Date().toISOString() });
    } catch (err) {
      // Payment captured (or $0) but merchant fulfilment failed: never charge again; retry via reconciliation.
      const status = paymentReference ? 'paid_pending_fulfillment' : 'fulfillment_failed';
      this.store.audit(merchantId, 'fulfillment_failed', { checkout_id: checkout.id, error: err.message });
      return this.store.update(merchantId, 'checkouts', checkout.id, { status, last_error: err.message });
    }
  }

  /**
   * Start the FlexPrice billing schedule for the new plan (idempotent per checkout): close out the
   * previous plan (final usage invoice if it was metered), carry forward unused credit, and set
   * the first period.
   */
  async #startSubscription(merchantId, checkout) {
    if (this.store.findOne(merchantId, 'subscriptions', (s) => s.source_checkout_id === checkout.id)) return;
    const m = this.pricing.merchant(merchantId);
    const plans = await m.gateway.getPlans();
    const plan = plans.find((p) => p.plan_id === checkout.plan_id);
    const prevPlan = plans.find((p) => p.plan_id === checkout.previous_plan_id);
    const now = new Date().toISOString();
    const prevSub = checkout.previous_subscription_id && this.store.findOne(merchantId, 'subscriptions', (s) => s.id === checkout.previous_subscription_id);

    // Usage on the old metered plan up to now is billed at the old plan's rates.
    if (prevPlan && isMetered(prevPlan)) {
      await this.#closeUsage(merchantId, checkout.customer_reference, prevPlan, periodOf(now), { partial: true, sub: prevSub });
    }
    if (prevSub) this.store.update(merchantId, 'subscriptions', prevSub.id, { status: 'replaced', ended_at: now });
    if (checkout.proration?.carried_cents > 0) {
      this.store.insert(merchantId, 'credits', { customer_reference: checkout.customer_reference, remaining_cents: checkout.proration.carried_cents, original_cents: checkout.proration.carried_cents, source: `proration of ${checkout.proration.from_plan_name}` });
    }
    const metered = isMetered(plan);
    this.store.insert(merchantId, 'subscriptions', {
      customer_reference: checkout.customer_reference,
      plan_id: plan.plan_id,
      billing_model: plan.billing_model,
      interval: plan.billing_interval,
      status: 'active',
      current_period_start: now,
      // Metered plans follow calendar months (matches the usage ledger); fixed plans anchor on the start date.
      current_period_end: metered ? startOfNextMonth(now) : addInterval(now, plan.billing_interval),
      paid_cents: metered ? 0 : checkout.gross_cents, // value of the current prepaid period (for proration)
      prepaid_cents: metered ? checkout.gross_cents : 0, // base fee collected at signup for this month
      prepaid_period: metered ? periodOf(now) : null,
      renewal_cents: metered ? 0 : toCents(plan.base_price),
      auto_renew: metered ? true : plan.terms.auto_renews,
      source_checkout_id: checkout.id,
    });
  }

  #checkoutView(c) {
    return {
      checkout_id: c.id,
      status: c.status,
      plan_id: c.plan_id,
      amount: fromCents(c.amount_cents),
      currency: c.currency,
      proration_credit: c.proration ? fromCents(c.proration.credit_cents) : 0,
      paypal_order_id: c.paypal_order_id ?? null,
      setup_token_id: c.setup_token_id ?? null,
      capture_id: c.capture_id ?? null,
      subscription: c.subscription ?? null,
      error: c.last_error ?? null,
    };
  }

  // ---- Invoices & the billing schedule ----

  /** Rate a metered period into an invoice (idempotent) and schedule collection. */
  async #closeUsage(merchantId, customerRef, plan, period, { partial = false, sub = null } = {}) {
    const prepaid = sub && sub.prepaid_period === period ? sub.prepaid_cents : 0;
    const inv = this.ledger.generateInvoice(merchantId, { customerRef, plan, period, prepaidCents: prepaid, partial });
    this.pricing.invalidate(merchantId, customerRef); // a closed month is new history
    if (!inv.collection) this.#schedule(merchantId, inv, plan);
    return this.store.findOne(merchantId, 'invoices', (i) => i.id === inv.id);
  }

  /** Apply account credit, then decide automatic vs manual collection and notify the customer. */
  #schedule(merchantId, inv, plan, { chargeNow = false } = {}) {
    const m = this.pricing.merchant(merchantId);
    const credit = inv.amount_cents > 0 ? this.#consumeCredit(merchantId, inv.customer_reference, inv.amount_cents) : 0;
    const patch = {};
    if (credit > 0) {
      patch.lines = [...inv.lines, { description: 'Account credit', amount: -fromCents(credit) }];
      patch.amount_cents = inv.amount_cents - credit;
      patch.amount = fromCents(patch.amount_cents);
      patch.credit_applied_cents = credit;
    }
    const amount = patch.amount_cents ?? inv.amount_cents;
    const auto = amount > 0 && Boolean(this.activePaymentMethod(merchantId, inv.customer_reference)) && this.savesAccount(m, plan);
    const notice = inv.kind === 'renewal' ? 0 : m.policy.usage_billing.invoice_notice_days; // renewals were announced before period end
    Object.assign(patch, amount === 0
      ? { status: 'paid', collection: 'none', paid_at: new Date().toISOString() }
      : auto
        ? { collection: 'automatic', charge_scheduled_at: new Date(Date.now() + (chargeNow ? 0 : notice) * DAY).toISOString(), attempts: 0 }
        : { collection: 'manual' });
    const updated = this.store.update(merchantId, 'invoices', inv.id, patch);
    // The customer is told what will be charged and when, before any money moves (PRD §6.2).
    this.store.audit(merchantId, 'invoice_notice', { customer_reference: inv.customer_reference, invoice_id: inv.id, amount: updated.amount, collection: updated.collection, charge_scheduled_at: updated.charge_scheduled_at ?? null });
    this.#emit(merchantId, 'invoice.created', { customer_reference: inv.customer_reference, invoice_id: inv.id, kind: inv.kind, period: inv.period, amount: updated.amount, currency: inv.currency, collection: updated.collection, charge_scheduled_at: updated.charge_scheduled_at ?? null, lines: updated.lines });
    return updated;
  }

  /** Merchant/admin: close the current (or given) period for a metered customer now. */
  async closePeriod(merchantId, customerRef, period = periodOf(new Date().toISOString())) {
    const ctx = await this.pricing.context(merchantId, customerRef, { includeHistory: false });
    const plan = ctx.plans.find((p) => p.plan_id === ctx.customer.current_plan_id);
    if (!plan) throw Object.assign(new Error('Customer has no active plan'), { status: 422 });
    if (plan.billing_model === 'fixed') throw Object.assign(new Error('Fixed plans are billed by renewal, not usage invoices'), { status: 422 });
    const sub = this.liveSubscription(merchantId, customerRef);
    return this.#closeUsage(merchantId, customerRef, plan, period, { sub: sub?.plan_id === plan.plan_id ? sub : null });
  }

  /**
   * The billing schedule. Safe to run repeatedly (e.g. every few minutes from a scheduler):
   *  1. announce upcoming renewals (notice period),
   *  2. roll over ended periods — renewal invoices for fixed plans, usage invoices for metered,
   *  3. charge automatic invoices whose notice has elapsed, with retries and manual fallback.
   */
  async runBilling(merchantId, { asOf = new Date() } = {}) {
    const now = new Date(asOf);
    const m = this.pricing.merchant(merchantId);
    const plans = await m.gateway.getPlans();
    const report = { renewal_notices: 0, renewals_invoiced: 0, usage_periods_closed: 0, charged: [], failed: [], moved_to_manual: [], skipped_not_due: [] };

    for (const sub of this.store.find(merchantId, 'subscriptions', (s) => LIVE_SUB.includes(s.status))) {
      const plan = plans.find((p) => p.plan_id === sub.plan_id);
      if (!plan) continue;
      if (sub.status === 'paused' && sub.paused_until && new Date(sub.paused_until) <= now) this.store.update(merchantId, 'subscriptions', sub.id, { status: 'active' });
      // 1. renewal notice
      if (sub.billing_model === 'fixed' && sub.auto_renew && sub.status === 'active' && sub.notice_sent_for !== sub.current_period_end) {
        const noticeAt = new Date(new Date(sub.current_period_end).getTime() - m.policy.renewals.notice_days * DAY);
        if (noticeAt <= now) {
          this.store.update(merchantId, 'subscriptions', sub.id, { notice_sent_for: sub.current_period_end });
          this.#emit(merchantId, 'subscription.renewal_upcoming', { customer_reference: sub.customer_reference, plan_id: sub.plan_id, amount: fromCents(sub.renewal_cents), renews_at: sub.current_period_end, payment: this.activePaymentMethod(merchantId, sub.customer_reference) ? 'saved_paypal' : 'manual' });
          report.renewal_notices += 1;
        }
      }
      // 2. period rollover (catch up at most 12 periods per run)
      for (let i = 0; i < 12 && sub.status !== 'paused' && new Date(sub.current_period_end) <= now; i++) {
        if (sub.billing_model === 'fixed') {
          if (!sub.auto_renew) {
            this.store.update(merchantId, 'subscriptions', sub.id, { status: 'ended', ended_at: sub.current_period_end });
            break;
          }
          const start = sub.current_period_end;
          const end = addInterval(start, sub.interval);
          const inv = this.store.insert(merchantId, 'invoices', {
            kind: 'renewal',
            customer_reference: sub.customer_reference,
            plan_id: sub.plan_id,
            subscription_id: sub.id,
            period: `${start.slice(0, 10)}→${end.slice(0, 10)}`,
            lines: [{ description: `${plan.name} renewal (${start.slice(0, 10)} – ${end.slice(0, 10)})`, amount: fromCents(sub.renewal_cents) }],
            gross_cents: sub.renewal_cents,
            amount_cents: sub.renewal_cents,
            amount: fromCents(sub.renewal_cents),
            currency: plan.currency,
            status: 'open',
          });
          // Access continues during retries (grace period); paid_cents tracks what was actually paid.
          this.store.update(merchantId, 'subscriptions', sub.id, { current_period_start: start, current_period_end: end, paid_cents: 0, pending_invoice_id: inv.id });
          this.#schedule(merchantId, inv, plan, { chargeNow: true });
          report.renewals_invoiced += 1;
        } else {
          await this.#closeUsage(merchantId, sub.customer_reference, plan, periodOf(sub.current_period_start), { sub });
          const start = sub.current_period_end;
          this.store.update(merchantId, 'subscriptions', sub.id, { current_period_start: start, current_period_end: startOfNextMonth(start), prepaid_cents: 0, prepaid_period: null });
          report.usage_periods_closed += 1;
        }
        Object.assign(sub, this.store.findOne(merchantId, 'subscriptions', (s) => s.id === sub.id));
      }
    }

    // 3. charge
    const policy = m.policy.usage_billing;
    for (const inv of this.store.find(merchantId, 'invoices', (i) => i.status === 'open' && i.collection === 'automatic')) {
      const at = new Date(inv.next_retry_at ?? inv.charge_scheduled_at);
      if (at > now) {
        report.skipped_not_due.push(inv.id);
        continue;
      }
      try {
        await this.#chargeInvoice(merchantId, inv);
        report.charged.push({ invoice_id: inv.id, amount: inv.amount, kind: inv.kind ?? 'usage' });
      } catch (err) {
        const attempts = (inv.attempts ?? 0) + 1;
        const exhausted = attempts >= policy.max_retry_attempts;
        this.store.update(merchantId, 'invoices', inv.id, {
          attempts,
          last_error: err.message,
          next_retry_at: exhausted ? null : new Date(now.getTime() + policy.retry_interval_days * DAY).toISOString(),
          ...(exhausted ? { collection: 'manual', status: 'past_due' } : {}),
        });
        this.store.audit(merchantId, exhausted ? 'invoice_moved_to_manual' : 'invoice_charge_failed', { invoice_id: inv.id, attempts, error: err.message });
        this.#emit(merchantId, exhausted ? 'invoice.past_due' : 'invoice.payment_failed', { customer_reference: inv.customer_reference, invoice_id: inv.id, amount: inv.amount, attempts, next_retry_at: exhausted ? null : new Date(now.getTime() + policy.retry_interval_days * DAY).toISOString() });
        if (exhausted && inv.subscription_id) {
          this.store.update(merchantId, 'subscriptions', inv.subscription_id, { status: 'past_due' });
          this.#emit(merchantId, 'subscription.past_due', { customer_reference: inv.customer_reference, plan_id: inv.plan_id, invoice_id: inv.id });
        }
        (exhausted ? report.moved_to_manual : report.failed).push({ invoice_id: inv.id, error: err.message });
      }
    }
    this.store.audit(merchantId, 'billing_run', { as_of: now.toISOString(), ...Object.fromEntries(Object.entries(report).map(([k, v]) => [k, Array.isArray(v) ? v.length : v])) });
    return report;
  }

  async #chargeInvoice(merchantId, inv) {
    const paypal = this.#requirePayPal();
    const m = this.pricing.merchant(merchantId);
    const plan = await m.gateway.getPlan(inv.plan_id);
    this.#authorizeInvoice(merchantId, inv, plan);
    const pm = this.activePaymentMethod(merchantId, inv.customer_reference);
    if (!pm) throw new Error('no saved payment method');
    const attempt = (inv.attempts ?? 0) + 1;
    const checkout = this.store.insert(merchantId, 'checkouts', { customer_reference: inv.customer_reference, plan_id: inv.plan_id, invoice_id: inv.id, amount_cents: inv.amount_cents, currency: inv.currency, status: 'created', kind: 'invoice', merchant_initiated: true });
    let order = await paypal.createOrder({
      amount: inv.amount,
      currency: inv.currency,
      description: `${m.name} ${inv.kind === 'renewal' ? 'renewal' : 'usage'} ${inv.period}`,
      referenceId: inv.id,
      customId: `${merchantId}|${checkout.id}`,
      invoiceId: `${merchantId}-${inv.id}-${attempt}`,
      brandName: m.paypal.brand_name,
      vaultId: pm.vault_id,
      idempotencyKey: `invcharge-${inv.id}-${attempt}`,
    });
    this.store.update(merchantId, 'checkouts', checkout.id, { paypal_order_id: order.id });
    if (order.status !== 'COMPLETED') order = await paypal.captureOrder(order.id, { idempotencyKey: `capture-${checkout.id}` });
    try {
      const v = this.#recordCapture(merchantId, checkout, order);
      this.#markInvoicePaid(merchantId, inv.id, v.capture_id, { attempts: attempt });
      this.store.update(merchantId, 'checkouts', checkout.id, { status: 'completed' });
    } catch (err) {
      this.store.update(merchantId, 'checkouts', checkout.id, { status: 'payment_mismatch', last_error: err.message });
      throw err;
    }
  }

  #markInvoicePaid(merchantId, invoiceId, captureId, extra = {}) {
    const inv = this.store.update(merchantId, 'invoices', invoiceId, { status: 'paid', capture_id: captureId, paid_at: new Date().toISOString(), next_retry_at: null, ...extra });
    this.#emit(merchantId, 'invoice.paid', { customer_reference: inv.customer_reference, invoice_id: inv.id, kind: inv.kind, amount: inv.amount, capture_id: captureId });
    if (inv.kind === 'renewal' && inv.subscription_id) {
      const sub = this.store.update(merchantId, 'subscriptions', inv.subscription_id, { paid_cents: inv.gross_cents, status: 'active', pending_invoice_id: null });
      this.#emit(merchantId, 'subscription.renewed', { customer_reference: inv.customer_reference, plan_id: inv.plan_id, current_period_end: sub.current_period_end, amount: inv.amount });
    }
    return inv;
  }

  /** Re-rate and confirm the amount never exceeds what the plan allows (cap for usage, price for renewals). */
  #authorizeInvoice(merchantId, inv, plan) {
    const kind = inv.kind ?? 'usage';
    const gross = inv.gross_cents ?? inv.amount_cents;
    const computed = kind === 'renewal' ? toCents(plan.base_price) : this.ledger.rate(merchantId, { customerRef: inv.customer_reference, plan, period: inv.period });
    const authz = authorizeCharge({ requestedCents: gross, computedCents: computed, plan, capCents: kind === 'usage' && plan.spending_cap != null ? toCents(plan.spending_cap) : null });
    if (!authz.allowed || inv.amount_cents > gross) throw Object.assign(new Error(`Charge blocked: ${[...authz.reasons, ...(inv.amount_cents > gross ? ['amount exceeds invoice total'] : [])].join('; ')}`), { status: 422 });
  }

  /** Customer-present invoice payment (manual collection, or paying early). */
  async payInvoice(merchantId, customerRef, invoiceId) {
    const inv = this.store.findOne(merchantId, 'invoices', (i) => i.id === invoiceId && i.customer_reference === customerRef);
    if (!inv) throw Object.assign(new Error('Invoice not found'), { status: 404 });
    if (inv.status === 'paid') throw Object.assign(new Error('Invoice already paid'), { status: 409 });
    const existing = this.store.findOne(merchantId, 'checkouts', (c) => c.invoice_id === inv.id && c.status === 'created' && !c.merchant_initiated);
    if (existing) return { ...this.#checkoutView(existing) };
    const paypal = this.#requirePayPal();
    const m = this.pricing.merchant(merchantId);
    const plan = await m.gateway.getPlan(inv.plan_id);
    this.#authorizeInvoice(merchantId, inv, plan);
    const checkout = this.store.insert(merchantId, 'checkouts', { customer_reference: customerRef, plan_id: inv.plan_id, invoice_id: inv.id, amount_cents: inv.amount_cents, currency: inv.currency, status: 'created', kind: 'invoice' });
    const order = await paypal.createOrder({
      amount: inv.amount,
      currency: inv.currency,
      description: `${m.name} ${inv.kind === 'renewal' ? 'renewal' : 'usage'} ${inv.period}`,
      referenceId: inv.id,
      customId: `${merchantId}|${checkout.id}`,
      invoiceId: `${merchantId}-${inv.id}-manual`,
      brandName: m.paypal.brand_name,
      ...this.#returnUrls(checkout.id),
      idempotencyKey: `order-${checkout.id}`,
    });
    this.store.update(merchantId, 'checkouts', checkout.id, { paypal_order_id: order.id });
    return { ...this.#checkoutView({ ...checkout, paypal_order_id: order.id }), approve_url: approveLink(order) };
  }

  /** Retention actions also update the FlexPrice billing schedule. */
  onRetentionAction(merchantId, customerRef, action, { months = 1 } = {}) {
    const sub = this.liveSubscription(merchantId, customerRef);
    if (action === 'cancel') {
      if (sub) this.store.update(merchantId, 'subscriptions', sub.id, { status: 'cancelled', auto_renew: false, ended_at: new Date().toISOString() });
      this.#emit(merchantId, 'subscription.cancelled', { customer_reference: customerRef, plan_id: sub?.plan_id ?? null });
    } else if (action === 'pause') {
      if (sub) {
        const until = new Date(Date.now() + months * 30 * DAY).toISOString();
        // Not charged while paused: the renewal date moves out by the pause length.
        this.store.update(merchantId, 'subscriptions', sub.id, { status: 'paused', paused_until: until, current_period_end: new Date(new Date(sub.current_period_end).getTime() + months * 30 * DAY).toISOString() });
      }
      this.#emit(merchantId, 'subscription.paused', { customer_reference: customerRef, months });
    }
  }

  // ---- Webhooks ----
  async handleWebhook(headers, event) {
    if (!this.paypal) return { status: 503, body: { error: 'payments not configured' } };
    const verified = await this.paypal.verifyWebhook(headers, event);
    if (!verified) return { status: 401, body: { error: 'invalid webhook signature' } };
    if (!this.store.markWebhookProcessed(event.id)) return { status: 200, body: { duplicate: true } };
    const r = event.resource || {};
    const customId = r.custom_id ?? r.purchase_units?.[0]?.custom_id;
    const [merchantId, checkoutId] = String(customId || '').split('|');
    if (!merchantId || !this.pricing.registry.has(merchantId)) return { status: 200, body: { ignored: true } };
    const checkout = this.store.findOne(merchantId, 'checkouts', (c) => c.id === checkoutId);
    this.store.audit(merchantId, `webhook:${event.event_type}`, { event_id: event.id, checkout_id: checkoutId ?? null });
    if (!checkout) return { status: 200, body: { ignored: true } };
    switch (event.event_type) {
      case 'CHECKOUT.ORDER.APPROVED':
        // Buyer approved but our capture call never arrived (closed tab, network drop): recover server-side.
        if (checkout.status === 'created' && !checkout.merchant_initiated) await this.captureCheckout(merchantId, null, checkout.paypal_order_id).catch(() => {});
        break;
      case 'PAYMENT.CAPTURE.COMPLETED':
        this.store.update(merchantId, 'checkouts', checkout.id, { webhook_confirmed_at: new Date().toISOString() });
        break;
      case 'PAYMENT.CAPTURE.DENIED':
      case 'PAYMENT.CAPTURE.REVERSED':
      case 'PAYMENT.CAPTURE.REFUNDED':
        this.store.update(merchantId, 'checkouts', checkout.id, { payment_state: event.event_type.split('.').pop().toLowerCase() });
        break;
      default:
        break;
    }
    return { status: 200, body: { ok: true } };
  }

  /** Retry fulfilment for paid-but-unfulfilled checkouts and flag mismatches (PRD §6.3). */
  async reconcile(merchantId) {
    const report = { retried: [], still_failing: [], mismatches: [], unconfirmed_by_webhook: [] };
    for (const c of this.store.find(merchantId, 'checkouts')) {
      if (c.kind === 'plan_change' && (c.status === 'paid_pending_fulfillment' || c.status === 'fulfillment_failed')) {
        const out = await this.#fulfil(merchantId, c, { paymentReference: c.capture_id ?? null });
        (out.status === 'completed' ? report.retried : report.still_failing).push(c.id);
      }
      if (c.status === 'payment_mismatch') report.mismatches.push(c.id);
      if (c.status === 'completed' && c.capture_id && !c.webhook_confirmed_at) report.unconfirmed_by_webhook.push(c.id);
    }
    this.store.audit(merchantId, 'reconciliation_run', report);
    return report;
  }

  async refund(merchantId, checkoutId) {
    const c = this.store.findOne(merchantId, 'checkouts', (x) => x.id === checkoutId);
    if (!c?.capture_id) throw Object.assign(new Error('Nothing to refund'), { status: 422 });
    const refund = await this.store.idempotent(merchantId, `refund:${checkoutId}`, () => this.#requirePayPal().refundCapture(c.capture_id, { idempotencyKey: `refund-${checkoutId}` }));
    this.store.update(merchantId, 'checkouts', checkoutId, { payment_state: 'refunded', refund_id: refund.id });
    this.store.audit(merchantId, 'refund_issued', { checkout_id: checkoutId, refund_id: refund.id });
    this.#emit(merchantId, 'refund.issued', { customer_reference: c.customer_reference, checkout_id: checkoutId, refund_id: refund.id, amount: fromCents(c.amount_cents) });
    return refund;
  }

  /** Mirror fixed plans into PayPal Subscriptions catalog (Products + Billing Plans). */
  async syncCatalog(merchantId) {
    const paypal = this.#requirePayPal();
    const m = this.pricing.merchant(merchantId);
    const plans = (await m.gateway.getPlans()).filter((p) => p.billing_model === 'fixed');
    const product = await paypal.createProduct({ name: `${m.name} subscriptions`, description: `FlexPrice-managed plans for ${m.name}`, idempotencyKey: `prod-${merchantId}` });
    const mapped = [];
    for (const p of plans) {
      const bp = await paypal.createBillingPlan({ productId: product.id, name: p.name, description: p.terms.summary, price: p.base_price, currency: p.currency, interval: p.billing_interval, idempotencyKey: `plan-${merchantId}-${p.plan_id}-${toCents(p.base_price)}` });
      mapped.push({ plan_id: p.plan_id, paypal_plan_id: bp.id });
    }
    this.store.audit(merchantId, 'paypal_catalog_synced', { product_id: product.id, plans: mapped });
    return { product_id: product.id, plans: mapped };
  }
}

function approveLink(resource) {
  return resource.links?.find((l) => l.rel === 'payer-action' || l.rel === 'approve')?.href;
}
