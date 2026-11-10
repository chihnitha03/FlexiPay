// Usage metering and rating for Adaptive Billing mode (PRD §6.2).
// Deduplicates trusted usage events, aggregates per billing period, rates with the plan's
// formula, enforces spending caps and produces auditable invoices.

import { normalizeUsageRecord } from './models.js';
import { monthlyCost, usageAtCap } from './pricing-engine.js';
import { fromCents } from './money.js';

export const periodOf = (iso) => iso.slice(0, 7); // 'YYYY-MM'

export class UsageLedger {
  constructor(store) {
    this.store = store;
  }

  /**
   * Usage for a customer/metric/period. With planId, only usage recorded while the customer was on
   * that plan counts: after a mid-month switch each plan bills only its own usage.
   */
  usageFor(merchantId, customerRef, metric, period, planId = undefined) {
    return this.store
      .find(merchantId, 'usage_events', (e) => e.customer_reference === customerRef && e.metric === metric && periodOf(e.occurred_at) === period && (planId === undefined || e.plan_id == null || e.plan_id === planId))
      .reduce((s, e) => s + e.quantity, 0);
  }

  /**
   * Record one trusted usage event. Returns { accepted, duplicate, period_usage, cap }.
   * When the plan's spending cap is reached the configured policy decides what happens; the
   * system never silently bills beyond the cap.
   */
  record(merchantId, rawEvent, { plan, policy }) {
    const event = normalizeUsageRecord(rawEvent);
    const dup = this.store.findOne(merchantId, 'usage_events', (e) => e.event_id === event.event_id);
    if (dup) return { accepted: false, duplicate: true, event_id: event.event_id };

    const period = periodOf(event.occurred_at);
    const before = this.usageFor(merchantId, event.customer_reference, event.metric, period, plan?.plan_id ?? null);
    const after = before + event.quantity;
    const cap = this.capStatus(plan, after, policy);

    if (cap.reached && policy.cap_reached_behavior === 'pause_service' && this.capStatus(plan, before, policy).reached) {
      return { accepted: false, duplicate: false, rejected_reason: 'spending cap reached — service paused for this period', cap };
    }
    // Usage past the cap is still recorded for analytics; rating clamps the charge at the cap.
    this.store.insert(merchantId, 'usage_events', { ...event, period, plan_id: plan?.plan_id ?? null, beyond_cap: cap.reached });
    let capJustReached = false;
    if (cap.reached && !this.store.findOne(merchantId, 'audit', (a) => a.type === 'cap_reached' && a.customer_reference === event.customer_reference && a.period === period)) {
      this.store.audit(merchantId, 'cap_reached', { customer_reference: event.customer_reference, period, behavior: policy.cap_reached_behavior });
      capJustReached = true;
    }
    return { accepted: true, duplicate: false, event_id: event.event_id, period, period_usage: round1(after), cap, cap_just_reached: capJustReached };
  }

  capStatus(plan, usage, policy) {
    if (!plan || plan.billing_model === 'fixed' || plan.spending_cap == null) return { applies: false, reached: false };
    const capUsage = usageAtCap(plan);
    const reached = monthlyCost(plan, usage).cap_reached;
    return {
      applies: true,
      reached,
      spending_cap: plan.spending_cap,
      usage_at_cap: capUsage,
      remaining_usage_before_cap: capUsage == null ? null : round1(Math.max(0, capUsage - usage)),
      behavior: policy.cap_reached_behavior,
      message: reached
        ? {
            pause_service: 'Spending cap reached: service is paused until the next billing period.',
            stop_billing: 'Spending cap reached: further usage this period is free of charge.',
            require_approval: 'Spending cap reached: charges are capped. You will be asked before any additional usage is billed.',
          }[policy.cap_reached_behavior]
        : null,
    };
  }

  /** Current rated charge (cents) for a customer's period. */
  rate(merchantId, { customerRef, plan, period }) {
    const usage = plan.billing_model === 'fixed' ? 0 : this.usageFor(merchantId, customerRef, plan.usage_metric, period, plan.plan_id);
    return monthlyCost(plan, usage).cents;
  }

  /**
   * Rate a closed billing period into an invoice. Idempotent per customer + period + plan.
   * prepaidCents: base fee already collected for this period (e.g. at signup) — shown as a credit
   * line so it is never charged twice. partial: invoice for usage up to a mid-period plan switch.
   */
  generateInvoice(merchantId, { customerRef, plan, period, prepaidCents = 0, partial = false }) {
    const existing = this.store.findOne(merchantId, 'invoices', (i) => i.customer_reference === customerRef && i.period === period && i.plan_id === plan.plan_id && (i.kind ?? 'usage') === 'usage');
    if (existing) return existing;
    const usage = plan.billing_model === 'fixed' ? 0 : this.usageFor(merchantId, customerRef, plan.usage_metric, period, plan.plan_id);
    const cost = monthlyCost(plan, usage);
    const lines = [];
    if (cost.base_cents) lines.push({ description: `${plan.name} base fee`, amount: fromCents(cost.base_cents) });
    if (cost.billable_usage > 0 || plan.billing_model !== 'fixed') {
      lines.push({
        description: `${round1(usage)} ${plan.unit || plan.usage_metric}${plan.included_usage ? ` (${plan.included_usage} included)` : ''}`,
        amount: fromCents(cost.cents - cost.base_cents),
      });
    }
    const prepaid = Math.min(prepaidCents, cost.cents);
    if (prepaid > 0) lines.push({ description: 'Base fee prepaid at signup', amount: -fromCents(prepaid) });
    const invoice = this.store.insert(merchantId, 'invoices', {
      kind: 'usage',
      customer_reference: customerRef,
      plan_id: plan.plan_id,
      period,
      partial,
      usage: round1(usage),
      lines,
      gross_cents: cost.cents,
      amount: fromCents(cost.cents - prepaid),
      amount_cents: cost.cents - prepaid,
      currency: plan.currency,
      cap_applied: cost.cap_reached,
      status: 'open',
    });
    this.store.audit(merchantId, 'invoice_generated', { invoice_id: invoice.id, customer_reference: customerRef, amount: invoice.amount, period });
    return invoice;
  }
}

const round1 = (n) => Math.round(n * 10) / 10;
