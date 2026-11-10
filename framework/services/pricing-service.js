// Orchestrates adapter data → forecaster → policy → pricing engine → recommender → AI explanation.
//
// Serving model ("compute cheap things on read, cache expensive inputs, invalidate on events"):
//  • Merchant data (customer context, usage history) is cached per customer in a SnapshotCache, so
//    slider moves and repeat views make no calls to the merchant backend.
//  • The default recommendation (history-based, balanced preference) is precomputed — lazily on the
//    first view or in bulk via precompute() — and served as-is until something that can change it
//    happens: plan change, month close, catalog change, or live usage crossing a break-even point.
//  • What-if requests (customer moves the slider) are recomputed on the fly: the engine costs
//    ~0.05 ms, so caching them would cost more than it saves.
//  • LLM explanations are generated at most once per snapshot; what-ifs get the template unless
//    the customer explicitly asks for an AI explanation.

import crypto from 'node:crypto';
import { forecastUsage } from '../core/forecaster.js';
import { recommendPlan, PREFERENCES } from '../core/recommender.js';
import { filterEligiblePlans, evaluateRetention, validateCatalog } from '../core/policy-engine.js';
import { estimatePlans, breakEven } from '../core/pricing-engine.js';
import { lastMonths } from '../core/periods.js';
import { periodOf } from '../core/usage-ledger.js';
import { SnapshotCache } from '../core/snapshot-cache.js';

const MIN_DAYS_FOR_PROJECTION = 7;
const planVersions = new WeakMap();

/** Stable hash of a plan catalog: snapshots computed against an older catalog are recomputed. */
function catalogVersion(plans) {
  if (!planVersions.has(plans)) planVersions.set(plans, crypto.createHash('sha1').update(JSON.stringify(plans)).digest('hex').slice(0, 12));
  return planVersions.get(plans);
}

/** Month-to-date usage scaled to a full month (null until enough of the month has passed). */
export function projectMonth(usageSoFar, now = new Date()) {
  const day = now.getUTCDate();
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  if (day < MIN_DAYS_FOR_PROJECTION || !(usageSoFar > 0)) return null;
  return Math.round((usageSoFar / (day / daysInMonth)) * 10) / 10;
}

/** Usage levels at which some pair of plans swaps order — the only places the answer can change. */
function breakEvenThresholds(plans, maxUsage) {
  const out = new Set();
  for (let i = 0; i < plans.length; i++) {
    for (let j = i + 1; j < plans.length; j++) {
      const be = breakEven(plans[i], plans[j], maxUsage);
      if (be != null) out.add(be);
    }
  }
  return [...out].sort((a, b) => a - b);
}

const band = (thresholds, x) => thresholds.filter((t) => t < x).length;

export class PricingService {
  constructor({ registry, store, advisor, ledger = null, cache = new SnapshotCache() }) {
    this.registry = registry;
    this.store = store;
    this.advisor = advisor;
    this.ledger = ledger;
    this.cache = cache;
  }

  merchant(merchantId) {
    const m = this.registry.get(merchantId);
    if (!m) throw Object.assign(new Error(`Unknown merchant '${merchantId}'`), { status: 404 });
    return m;
  }

  /** Drop everything cached for a customer (their data changed). */
  invalidate(merchantId, customerRef) {
    this.cache.invalidate(merchantId, customerRef);
  }

  /**
   * Gather everything known about a customer. Merchant data is served from the snapshot cache when
   * present (fresh: true forces a refetch). Degrades gracefully when the adapter lacks data.
   */
  async context(merchantId, customerRef, { includeHistory = true, fresh = false } = {}) {
    const m = this.merchant(merchantId);
    const gw = m.gateway;
    const [manifest, caps, plans] = await Promise.all([gw.getManifest(), gw.capabilities(), gw.getPlans()]);
    let customer = { customer_reference: customerRef ?? null, current_plan_id: null, tenure_months: 0, subscription_status: 'none' };
    let history = [];
    const warnings = [];
    let cacheStatus = 'none';
    if (customerRef) {
      const snap = fresh ? null : this.cache.get(merchantId, customerRef);
      if (snap?.customer && (!includeHistory || snap.history)) {
        ({ customer } = snap);
        history = snap.history ?? [];
        cacheStatus = 'hit';
      } else {
        cacheStatus = 'miss';
        let ok = true;
        try {
          customer = await gw.getCustomerContext(customerRef);
        } catch (err) {
          ok = false;
          warnings.push(`Customer context unavailable: ${err.message}`);
        }
        let fetchedHistory = null;
        if (includeHistory) {
          try {
            const months = lastMonths(24);
            fetchedHistory = await gw.getUsage(customerRef, { from: months[0], to: months.at(-1) });
            history = fetchedHistory;
          } catch (err) {
            ok = false;
            warnings.push(`Usage history unavailable (${err.message}); using estimates instead.`);
          }
        }
        // Only cache complete, successful reads; failures are retried on the next request.
        if (ok) this.cache.set(merchantId, customerRef, { customer, ...(fetchedHistory ? { history: fetchedHistory } : {}), fetched_at: new Date().toISOString() });
      }
    }
    const { eligible, excluded } = filterEligiblePlans(plans, customer, caps);
    const catalogIssues = validateCatalog(eligible, m.policy).filter((i) => i.severity === 'error');
    const blocked = new Set(catalogIssues.map((i) => i.plan_id));
    return {
      merchant: m,
      manifest,
      capabilities: caps,
      plans,
      catalog_version: catalogVersion(plans),
      eligible: eligible.filter((p) => !blocked.has(p.plan_id)),
      excluded: [...excluded, ...catalogIssues.map((i) => ({ plan_id: i.plan_id, reason: `policy: ${i.issue}` }))].map((x) => ({ ...x, plan_name: plans.find((p) => p.plan_id === x.plan_id)?.name ?? x.plan_id })),
      customer,
      history,
      cache_status: cacheStatus,
      warnings,
    };
  }

  /** Current month's live usage from the ledger, projected to a full month. */
  liveProjection(ctx, merchantId, customerRef, now = new Date()) {
    const metric = ctx.manifest.usage?.metric;
    if (!this.ledger || !customerRef || !metric) return null;
    const period = periodOf(now.toISOString());
    if (ctx.history.some((h) => h.period === period)) return null; // merchant already reports it
    const soFar = this.ledger.usageFor(merchantId, customerRef, metric, period);
    const projected = projectMonth(soFar, now);
    return projected == null ? null : { period, quantity: projected, so_far: Math.round(soFar * 10) / 10 };
  }

  forecast(ctx, { monthlyUsage, horizonMonths = 12, live = null } = {}) {
    const f = forecastUsage({
      history: live ? [...ctx.history, { period: live.period, quantity: live.quantity }] : ctx.history,
      customerEstimate: monthlyUsage,
      defaultUsage: ctx.manifest.usage?.default_monthly_usage ?? 10,
      horizonMonths,
    });
    if (live && monthlyUsage == null) f.notes.push(`Includes this month so far (${live.so_far}), projected to ${live.quantity} for the full month.`);
    return f;
  }

  #compute(ctx, merchantId, customerRef, { monthlyUsage, preference, horizonMonths }) {
    const live = monthlyUsage == null ? this.liveProjection(ctx, merchantId, customerRef) : null;
    const forecast = this.forecast(ctx, { monthlyUsage, horizonMonths, live });
    const recommendation = recommendPlan({
      plans: ctx.eligible,
      forecast,
      preference: PREFERENCES[preference] ? preference : 'balanced',
      currentPlanId: ctx.customer.current_plan_id,
    });
    return { forecast, recommendation };
  }

  /**
   * @param {object} opts
   * @param {boolean|'template'} [opts.explain] true = AI (cached per snapshot), 'template' = deterministic only, false = none
   * @param {boolean} [opts.record] log an impression for analytics (once per view, not per slider move)
   */
  async recommend(merchantId, customerRef, { monthlyUsage, preference = 'balanced', horizonMonths = 12, explain = true, record = true } = {}) {
    const ctx = await this.context(merchantId, customerRef);
    const isDefault = customerRef && monthlyUsage == null && (preference ?? 'balanced') === 'balanced' && horizonMonths === 12;
    let forecast;
    let recommendation;
    let explanation = null;
    let source = 'computed';
    const snap = isDefault ? this.cache.get(merchantId, customerRef) : null;

    if (snap?.recommendation && snap.catalog_version === ctx.catalog_version && !snap.stale) {
      ({ forecast, recommendation } = structuredClone({ forecast: snap.forecast, recommendation: snap.recommendation }));
      source = 'precomputed';
      if (explain === true && snap.explanation) explanation = snap.explanation;
    } else {
      ({ forecast, recommendation } = this.#compute(ctx, merchantId, customerRef, { monthlyUsage, preference, horizonMonths }));
      if (isDefault) {
        const maxUsage = Math.max(200, forecast.summary.high_monthly * 4);
        this.cache.set(merchantId, customerRef, {
          forecast: structuredClone(forecast),
          recommendation: structuredClone(recommendation),
          catalog_version: ctx.catalog_version,
          thresholds: breakEvenThresholds(ctx.eligible, maxUsage),
          computed_at: new Date().toISOString(),
          stale: null,
          explanation: null,
        });
      }
    }

    const usageLabel = ctx.manifest.usage?.label ?? 'units per month';
    if (explain === 'template') explanation = this.advisor.template({ recommendation, forecast, usageLabel });
    else if (explain === true && !explanation) {
      explanation = await this.advisor.explain({ merchantName: ctx.manifest.name, usageLabel, recommendation, forecast });
      if (isDefault) this.cache.set(merchantId, customerRef, { explanation });
    }

    if (record) {
      const rec = this.store.insert(merchantId, 'recommendations', {
        customer_reference: customerRef ?? 'anonymous',
        recommended_plan_id: recommendation.recommended_plan_id,
        current_plan_id: ctx.customer.current_plan_id,
        estimated_savings: recommendation.estimated_savings,
        forecast_source: forecast.source,
        preference: recommendation.preference,
        explanation_source: explanation?.source ?? null,
        served_from: source,
        // 12-month estimates per plan, used later to measure merchant revenue impact of choices.
        expected_monthly_usage: forecast.summary.expected_monthly,
        plan_estimates: Object.fromEntries(recommendation.ranked_plans.map((p) => [p.plan_id, p.estimated_cost])),
      });
      recommendation.recommendation_id = rec.id;
      this.store.metric(merchantId, 'recommendation_shown', { customer_reference: customerRef, plan_id: recommendation.recommended_plan_id });
    }
    const snapNow = isDefault ? this.cache.get(merchantId, customerRef) : null;
    return { ctx, forecast, recommendation, explanation, served: { recommendation: source, merchant_data: ctx.cache_status, computed_at: snapNow?.computed_at ?? null } };
  }

  /**
   * Called for every usage event. O(#break-even points): no recomputation, no merchant calls.
   * Marks the precomputed recommendation stale only when this month's projected usage moves to the
   * other side of a break-even point from the forecast the recommendation was based on.
   */
  onUsage(merchantId, customerRef, { periodUsage, now = new Date() }) {
    const snap = this.cache.get(merchantId, customerRef);
    if (!snap?.recommendation || snap.stale || !snap.thresholds?.length) return { stale: false };
    const projected = projectMonth(periodUsage, now);
    if (projected == null) return { stale: false };
    const expected = snap.forecast.summary.expected_monthly;
    if (band(snap.thresholds, projected) === band(snap.thresholds, expected)) return { stale: false };
    const reason = `projected ${projected}/month crossed a break-even point (forecast was ${expected})`;
    this.cache.markStale(merchantId, customerRef, reason);
    this.store.audit(merchantId, 'recommendation_stale', { customer_reference: customerRef, reason });
    // Rare path (only on a crossing): recompute off the ingestion path and tell the merchant if a
    // different plan would now save the customer money, so it can send a timely nudge.
    setImmediate(() => this.#checkSavings(merchantId, customerRef, reason).catch(() => {}));
    return { stale: true, reason };
  }

  async #checkSavings(merchantId, customerRef, reason) {
    const { recommendation: r, ctx } = await this.recommend(merchantId, customerRef, { explain: false, record: false });
    if (!this.events || !ctx.customer.current_plan_id || r.recommended_plan_id === ctx.customer.current_plan_id || !(r.estimated_savings > 0)) return;
    this.events.emit(merchantId, 'recommendation.savings_available', {
      customer_reference: customerRef,
      current_plan_id: ctx.customer.current_plan_id,
      recommended_plan_id: r.recommended_plan_id,
      recommended_plan_name: r.recommended_plan_name,
      estimated_savings_12m: r.estimated_savings,
      reason,
    });
  }

  /** Bulk refresh, e.g. nightly or right after month close. Returns timing so cost is visible. */
  async precompute(merchantId, customerRefs, { withExplanations = false } = {}) {
    const started = Date.now();
    const results = { refreshed: 0, failed: [] };
    for (const ref of customerRefs) {
      try {
        this.cache.invalidate(merchantId, ref);
        await this.recommend(merchantId, ref, { explain: withExplanations, record: false });
        this.cache.stats.precomputed += 1;
        results.refreshed += 1;
      } catch (err) {
        results.failed.push({ customer_reference: ref, error: err.message });
      }
    }
    return { ...results, ms: Date.now() - started };
  }

  /** Compact read-only view for the AI tool `compare_plans`. */
  async compareForAI(merchantId, customerRef, { monthly_usage, preference }) {
    const { recommendation: r, forecast } = await this.recommend(merchantId, customerRef, { monthlyUsage: monthly_usage, preference: preference ?? 'balanced', explain: false, record: false });
    return {
      recommended_plan_id: r.recommended_plan_id,
      recommended_plan_name: r.recommended_plan_name,
      preference: r.preference,
      forecast_source: forecast.source,
      expected_monthly_usage: forecast.summary.expected_monthly,
      usage_range: [forecast.summary.low_monthly, forecast.summary.high_monthly],
      estimated_savings_vs_current_or_standard: r.estimated_savings,
      plans: r.ranked_plans.map((p) => ({
        plan_id: p.plan_id,
        plan_name: p.plan_name,
        estimated_monthly_cost: p.estimated_monthly_cost,
        estimated_cost_12_months: p.estimated_cost,
        low_cost_scenario: p.low_cost_scenario,
        high_cost_scenario: p.high_cost_scenario,
        upfront_payment: p.upfront_payment,
      })),
      break_even: r.break_even_points,
      current_plan_id: r.current_plan_id,
    };
  }

  async usageSummary(merchantId, customerRef) {
    const ctx = await this.context(merchantId, customerRef);
    const f = this.forecast(ctx);
    return { months_of_history: ctx.history.length, recent: ctx.history.slice(-6), forecast: f.summary, history_stats: f.history_forecast && { average: f.history_forecast.historical_average, min: f.history_forecast.historical_min, max: f.history_forecast.historical_max, trend: f.history_forecast.trend } };
  }

  /** Alternatives to cancelling: cheaper plans for this customer + policy-gated pause/discount. */
  async retentionOptions(merchantId, customerRef) {
    const ctx = await this.context(merchantId, customerRef);
    const m = ctx.merchant;
    const offerHistory = this.store.find(merchantId, 'offers', (o) => o.customer_reference === customerRef);
    if (ctx.customer.last_retention_offer_at && !offerHistory.some((o) => o.granted_at === ctx.customer.last_retention_offer_at)) {
      offerHistory.push({ type: 'discount', granted_at: ctx.customer.last_retention_offer_at, source: 'merchant_record' });
    }
    const evalr = evaluateRetention({ customer: ctx.customer, offerHistory, policy: m.policy, capabilities: { ...ctx.capabilities, pause_subscription: ctx.capabilities.pause_subscription } });
    if (!ctx.capabilities.retention_offers && evalr.discount.eligible) evalr.discount = { eligible: false, reason: 'merchant integration does not support retention offers' };
    const forecast = this.forecast(ctx);
    const estimates = estimatePlans(ctx.eligible, forecast);
    const current = estimates.find((e) => e.plan_id === ctx.customer.current_plan_id);
    const alternatives = estimates
      .filter((e) => e.plan_id !== ctx.customer.current_plan_id && (!current || e.estimated_cost < current.estimated_cost))
      .sort((a, b) => a.estimated_cost - b.estimated_cost)
      .map((e) => ({ plan_id: e.plan_id, plan_name: e.plan_name, estimated_monthly_cost: e.estimated_monthly_cost, estimated_cost: e.estimated_cost, savings_vs_current: current ? Math.round((current.estimated_cost - e.estimated_cost) * 100) / 100 : null, high_cost_scenario: e.high_cost_scenario, upfront_payment: e.upfront_payment }));
    const discountOffer = evalr.discount.eligible && current
      ? { percent: evalr.discount.percent, months: evalr.discount.months, discounted_monthly_price: Math.round(current.estimated_monthly_cost * (1 - evalr.discount.percent / 100) * 100) / 100, reverts_to: current.estimated_monthly_cost, note: `After ${evalr.discount.months} months the price returns to ${current.estimated_monthly_cost}/month.` }
      : null;
    return {
      current_plan_id: ctx.customer.current_plan_id,
      current_estimated_monthly_cost: current?.estimated_monthly_cost ?? null,
      alternatives,
      pause: evalr.pause,
      discount: { ...evalr.discount, offer: discountOffer },
      can_cancel: ctx.capabilities.cancel_subscription,
    };
  }
}
