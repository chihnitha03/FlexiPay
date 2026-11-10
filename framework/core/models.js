// Standardized FlexPrice data models (PRD §5.4) and validation helpers.
// Adapters must translate merchant-specific data into these shapes.

export const BILLING_MODELS = ['fixed', 'usage', 'hybrid', 'tiered'];
export const BILLING_INTERVALS = ['month', 'year'];

export class ValidationError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
    this.details = details;
  }
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Validate a plan definition and return a normalized copy. Throws ValidationError. */
export function normalizePlan(raw) {
  const errors = [];
  const p = { ...raw };
  if (!p.plan_id || typeof p.plan_id !== 'string') errors.push('plan_id is required');
  if (!p.name) errors.push('name is required');
  if (!BILLING_MODELS.includes(p.billing_model)) errors.push(`billing_model must be one of ${BILLING_MODELS.join(', ')}`);
  p.billing_interval ??= 'month';
  if (!BILLING_INTERVALS.includes(p.billing_interval)) errors.push('billing_interval must be month or year');
  p.currency ??= 'USD';
  p.base_price ??= 0;
  if (!isNum(p.base_price) || p.base_price < 0) errors.push('base_price must be a non-negative number');

  if (p.billing_model !== 'fixed') {
    if (!p.usage_metric) errors.push('usage_metric is required for metered plans');
    if (p.billing_interval !== 'month') errors.push('metered plans must bill monthly');
  }
  if (p.billing_model === 'usage' || p.billing_model === 'hybrid') {
    if (!isNum(p.unit_price) || p.unit_price < 0) errors.push('unit_price must be a non-negative number');
  }
  if (p.billing_model === 'tiered') {
    if (!Array.isArray(p.tier_rules) || p.tier_rules.length === 0) errors.push('tier_rules are required for tiered plans');
    else {
      let prev = 0;
      p.tier_rules.forEach((t, i) => {
        const last = i === p.tier_rules.length - 1;
        if (!isNum(t.unit_price) || t.unit_price < 0) errors.push(`tier_rules[${i}].unit_price invalid`);
        if (!last && (!isNum(t.up_to) || t.up_to <= prev)) errors.push(`tier_rules[${i}].up_to must increase`);
        if (last && t.up_to != null) errors.push('last tier must have up_to = null (unbounded)');
        if (isNum(t.up_to)) prev = t.up_to;
      });
    }
  }
  p.included_usage ??= 0;
  p.minimum_charge ??= 0;
  p.spending_cap ??= null;
  if (p.spending_cap != null && (!isNum(p.spending_cap) || p.spending_cap < p.base_price)) {
    errors.push('spending_cap must be >= base_price');
  }
  p.terms = {
    commitment_months: p.billing_interval === 'year' ? 12 : 0,
    cancel_anytime: p.billing_interval !== 'year',
    auto_renews: true,
    ...(p.terms || {}),
  };
  p.eligibility_rules ??= {};
  p.features ??= [];
  if (errors.length) throw new ValidationError(`Invalid plan ${p.plan_id || '(unknown)'}`, errors);
  return p;
}

export function normalizeUsageRecord(raw) {
  const errors = [];
  const r = { ...raw };
  if (!r.event_id) errors.push('event_id is required (used for deduplication)');
  if (!r.customer_reference) errors.push('customer_reference is required');
  if (!r.metric) errors.push('metric is required');
  if (!isNum(r.quantity) || r.quantity < 0) errors.push('quantity must be a non-negative number');
  r.unit ??= 'unit';
  r.occurred_at ??= new Date().toISOString();
  if (Number.isNaN(Date.parse(r.occurred_at))) errors.push('occurred_at must be an ISO timestamp');
  r.source ??= 'merchant';
  if (errors.length) throw new ValidationError('Invalid usage record', errors);
  return r;
}

/** Monthly usage history entries: { period: 'YYYY-MM', quantity } */
export function normalizeUsageHistory(history = []) {
  return history
    .filter((h) => h && isNum(h.quantity) && h.quantity >= 0 && /^\d{4}-\d{2}$/.test(h.period))
    .sort((a, b) => a.period.localeCompare(b.period));
}
