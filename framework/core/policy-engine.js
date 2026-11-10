// Policy engine (PRD §5.2-E). Deterministic merchant rules that gate every recommendation,
// retention offer, plan change and charge. The AI layer can never bypass these checks.

export const DEFAULT_POLICY = {
  require_spending_cap_for_usage: true,
  cap_reached_behavior: 'require_approval', // 'pause_service' | 'stop_billing' | 'require_approval'
  price_guardrails: { max_base_price: 1000, max_unit_price: 100 },
  retention: {
    enabled: true,
    allow_discount: true,
    discount_percent: 20,
    discount_months: 3,
    min_tenure_months: 3,
    cooldown_months: 12,
    max_discount_offers_lifetime: 2,
    allow_pause: true,
    max_pause_months: 2,
  },
  plan_change: {
    require_consent: true,
    max_changes_per_30_days: 3,
    // Anti-gaming: stops customers hopping between metered and unlimited plans month-to-month.
    min_days_between_changes: 0,
    // 'credit': unused days of a prepaid fixed period are credited against the new plan
    // (leftover becomes account credit); 'none': no credit.
    proration: 'credit',
  },
  renewals: {
    auto_renew_with_saved_paypal: true, // FlexPrice renews fixed plans by charging the saved PayPal account
    notice_days: 3, // customer is told this many days before each renewal charge
  },
  usage_billing: {
    auto_collect: true, // charge metered usage with a vaulted PayPal account (needs explicit consent)
    invoice_notice_days: 3, // customer is notified this many days before a merchant-initiated charge
    max_retry_attempts: 3,
    retry_interval_days: 3,
  },
};

export function resolvePolicy(merchantPolicy = {}) {
  return {
    ...DEFAULT_POLICY,
    ...merchantPolicy,
    price_guardrails: { ...DEFAULT_POLICY.price_guardrails, ...merchantPolicy.price_guardrails },
    retention: { ...DEFAULT_POLICY.retention, ...merchantPolicy.retention },
    plan_change: { ...DEFAULT_POLICY.plan_change, ...merchantPolicy.plan_change },
    usage_billing: { ...DEFAULT_POLICY.usage_billing, ...merchantPolicy.usage_billing },
    renewals: { ...DEFAULT_POLICY.renewals, ...merchantPolicy.renewals },
  };
}

/** Catalog-level checks run during onboarding/validation. Returns a list of issues. */
export function validateCatalog(plans, policy) {
  const issues = [];
  for (const p of plans) {
    if (p.base_price > policy.price_guardrails.max_base_price) issues.push({ plan_id: p.plan_id, severity: 'error', issue: 'base_price exceeds merchant guardrail' });
    if ((p.unit_price ?? 0) > policy.price_guardrails.max_unit_price) issues.push({ plan_id: p.plan_id, severity: 'error', issue: 'unit_price exceeds merchant guardrail' });
    if (p.billing_model !== 'fixed' && policy.require_spending_cap_for_usage && p.spending_cap == null) {
      issues.push({ plan_id: p.plan_id, severity: 'error', issue: 'metered plans must define a spending_cap' });
    }
    if (!p.terms?.summary) issues.push({ plan_id: p.plan_id, severity: 'warning', issue: 'plan has no customer-facing terms summary' });
  }
  return issues;
}

/** Which plans may be shown to this customer, and why others were excluded. */
export function filterEligiblePlans(plans, customer = {}, capabilities = {}) {
  const eligible = [];
  const excluded = [];
  for (const p of plans) {
    const r = p.eligibility_rules || {};
    let reason = null;
    if (p.billing_model !== 'fixed' && !capabilities.usage_metering) reason = 'merchant integration does not support usage metering';
    else if (r.new_customers_only && customer.current_plan_id) reason = 'available to new customers only';
    else if (r.min_tenure_months && (customer.tenure_months ?? 0) < r.min_tenure_months) reason = `requires ${r.min_tenure_months} months tenure`;
    else if (r.regions && customer.region && !r.regions.includes(customer.region)) reason = 'not available in your region';
    if (reason) excluded.push({ plan_id: p.plan_id, reason });
    else eligible.push(p);
  }
  return { eligible, excluded };
}

const monthsBetween = (a, b) => (new Date(b) - new Date(a)) / (1000 * 60 * 60 * 24 * 30.44);

/**
 * Decide which retention options are permitted. Discounts are never automatic: they require
 * tenure, a cooldown since the last offer, and a lifetime cap to prevent discount-seeking loops.
 */
export function evaluateRetention({ customer, offerHistory = [], policy, capabilities = {}, now = new Date() }) {
  const r = policy.retention;
  const result = { enabled: r.enabled, discount: { eligible: false, reason: null }, pause: { eligible: false, reason: null } };
  if (!r.enabled) {
    result.discount.reason = result.pause.reason = 'retention offers disabled by merchant';
    return result;
  }
  const discounts = offerHistory.filter((o) => o.type === 'discount');
  const last = discounts.map((o) => o.granted_at).sort().at(-1);
  if (!r.allow_discount) result.discount.reason = 'merchant does not offer retention discounts';
  else if ((customer.tenure_months ?? 0) < r.min_tenure_months) result.discount.reason = `requires at least ${r.min_tenure_months} months as a customer`;
  else if (discounts.length >= r.max_discount_offers_lifetime) result.discount.reason = 'lifetime retention-offer limit reached';
  else if (last && monthsBetween(last, now) < r.cooldown_months) result.discount.reason = `a retention offer was already used in the last ${r.cooldown_months} months`;
  else if (customer.has_active_discount) result.discount.reason = 'a discount is already active';
  else result.discount = { eligible: true, percent: r.discount_percent, months: r.discount_months, reason: null };

  if (!r.allow_pause) result.pause.reason = 'merchant does not support pausing';
  else if (!capabilities.pause_subscription) result.pause.reason = 'merchant integration does not support pausing';
  else result.pause = { eligible: true, max_months: r.max_pause_months, reason: null };
  return result;
}

/**
 * Gate for any subscription mutation. `actor` identifies who initiated it; the AI agent is
 * never an authorized actor for mutations (PRD §7).
 */
export function authorizePlanChange({ actor, customer, targetPlan, eligiblePlanIds, consent, recentChanges = [], policy, capabilities, now = new Date() }) {
  const reasons = [];
  if (actor === 'ai_agent') reasons.push('AI agent is not permitted to execute subscription changes');
  if (!capabilities.change_plan) reasons.push('merchant integration does not support plan changes');
  if (!targetPlan) reasons.push('target plan does not exist');
  else if (!eligiblePlanIds.includes(targetPlan.plan_id)) reasons.push('target plan is not eligible for this customer');
  if (targetPlan && customer.current_plan_id === targetPlan.plan_id) reasons.push('customer is already on this plan');
  if (policy.plan_change.require_consent) {
    if (!consent) reasons.push('customer consent is required');
    else if (consent.plan_id !== targetPlan?.plan_id || consent.customer_reference !== customer.customer_reference) reasons.push('consent does not match this plan change');
    else if (monthsBetween(consent.accepted_at, now) * 30.44 * 24 > 1) reasons.push('consent has expired; please review the terms again');
  }
  const recent = recentChanges.filter((c) => monthsBetween(c.at, now) < 1).length;
  if (recent >= policy.plan_change.max_changes_per_30_days) reasons.push('too many plan changes in the last 30 days');
  const last = recentChanges.map((c) => c.at).sort().at(-1);
  const minDays = policy.plan_change.min_days_between_changes;
  if (last && minDays > 0 && (now - new Date(last)) / 864e5 < minDays) reasons.push(`plans can be changed once every ${minDays} days`);
  return { allowed: reasons.length === 0, reasons };
}

/** The charged amount must exactly match the server-side computed amount. */
export function authorizeCharge({ requestedCents, computedCents, plan, capCents }) {
  const reasons = [];
  if (requestedCents !== computedCents) reasons.push('amount does not match server-computed price');
  if (computedCents <= 0) reasons.push('amount must be positive');
  if (capCents != null && computedCents > capCents) reasons.push(`amount exceeds the ${plan?.name ?? ''} spending cap`);
  return { allowed: reasons.length === 0, reasons };
}
