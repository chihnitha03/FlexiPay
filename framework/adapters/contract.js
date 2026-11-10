// FlexPrice Merchant Adapter Contract (PRD §5.3).
// An adapter is a thin translation layer between FlexPrice and a merchant backend. It must
// declare its capabilities explicitly; FlexPrice never assumes support for anything undeclared.

export const CAPABILITY_METHODS = {
  plans: 'getPlans',
  customer_context: 'getCustomerContext',
  usage_history: 'getUsage',
  usage_estimate: 'getUsageEstimate',
  usage_metering: 'recordUsage',
  change_plan: 'changePlan',
  subscription_status: 'getSubscriptionStatus',
  billing_status: 'getBillingStatus',
  pause_subscription: 'pauseSubscription',
  cancel_subscription: 'cancelSubscription',
  retention_offers: 'applyRetentionOffer',
  cohort_usage: 'getCohortUsage', // anonymized usage sample for merchant-side pricing insights
};

export const REQUIRED_CAPABILITIES = ['plans'];

/**
 * @typedef {object} MerchantAdapter
 * @property {() => Promise<Manifest>} getManifest
 * @property {() => Promise<object[]>} getPlans
 * @property {(customerRef: string) => Promise<CustomerContext>} [getCustomerContext]
 * @property {(customerRef: string, period: {from: string, to: string}) => Promise<{period: string, quantity: number}[]>} [getUsage]
 * @property {(customerRef: string, period: object) => Promise<{quantity: number}>} [getUsageEstimate]
 * @property {(event: object) => Promise<object>} [recordUsage]
 * @property {(customerRef: string, planId: string, opts: {idempotencyKey: string, consentReference: string, paymentReference?: string}) => Promise<object>} [changePlan]
 * @property {(customerRef: string) => Promise<object>} [getSubscriptionStatus]
 * @property {(referenceId: string) => Promise<object>} [getBillingStatus]
 * @property {(customerRef: string, opts: object) => Promise<object>} [pauseSubscription]
 * @property {(customerRef: string, opts: object) => Promise<object>} [cancelSubscription]
 * @property {(customerRef: string, offer: object, opts: object) => Promise<object>} [applyRetentionOffer]
 * @property {() => Promise<{current_plan_id: string|null, avg_monthly_usage: number}[]>} [getCohortUsage]
 *           anonymized sample (no customer identifiers) used by Pricing Insights
 *
 * @typedef {object} Manifest
 * @property {string} merchant_id
 * @property {string} name
 * @property {string[]} capabilities
 * @property {{metric: string, unit: string, label: string, default_monthly_usage: number, slider_max: number}} usage
 * @property {string} [checkout_url] fallback merchant checkout when FlexPrice does not run payment
 *
 * @typedef {object} CustomerContext
 * @property {string} customer_reference  stable merchant-issued reference (no PII required)
 * @property {string} [display_name]
 * @property {string|null} current_plan_id
 * @property {number} tenure_months
 * @property {string} [region]
 * @property {boolean} [has_active_discount]
 * @property {string} subscription_status  'active' | 'paused' | 'cancelled' | 'none'
 */

export class CapabilityError extends Error {
  constructor(capability) {
    super(`Merchant integration does not support '${capability}'`);
    this.status = 501;
    this.capability = capability;
  }
}
