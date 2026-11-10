// AdapterGateway wraps any merchant adapter with: capability enforcement, response validation
// against the standard data models, timeouts, plan caching and health telemetry.

import { CAPABILITY_METHODS, REQUIRED_CAPABILITIES, CapabilityError } from './contract.js';
import { normalizePlan, normalizeUsageHistory, ValidationError } from '../core/models.js';

const PLAN_TTL_MS = 60_000;

export class AdapterGateway {
  constructor(merchantId, adapter, { timeoutMs = 5000 } = {}) {
    this.merchantId = merchantId;
    this.adapter = adapter;
    this.timeoutMs = timeoutMs;
    this.manifest = null;
    this.planCache = null;
    this.health = { calls: 0, errors: 0, last_error: null, last_latency_ms: null, avg_latency_ms: 0, last_ok_at: null };
  }

  async #call(name, ...args) {
    const started = Date.now();
    this.health.calls += 1;
    let timer;
    try {
      const result = await Promise.race([
        this.adapter[name](...args),
        new Promise((_, rej) => {
          timer = setTimeout(() => rej(Object.assign(new Error(`Adapter ${name} timed out`), { status: 504 })), this.timeoutMs);
        }),
      ]);
      const ms = Date.now() - started;
      this.health.last_latency_ms = ms;
      this.health.avg_latency_ms = Math.round(this.health.avg_latency_ms * 0.8 + ms * 0.2);
      this.health.last_ok_at = new Date().toISOString();
      return result;
    } catch (err) {
      this.health.errors += 1;
      this.health.last_error = { method: name, message: err.message, at: new Date().toISOString() };
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async getManifest({ refresh = false } = {}) {
    if (!this.manifest || refresh) {
      const m = await this.#call('getManifest');
      const caps = new Set(m.capabilities || []);
      for (const c of caps) {
        if (!CAPABILITY_METHODS[c]) throw new ValidationError(`Unknown capability '${c}' declared by adapter`);
        if (typeof this.adapter[CAPABILITY_METHODS[c]] !== 'function') throw new ValidationError(`Capability '${c}' declared but ${CAPABILITY_METHODS[c]}() is not implemented`);
      }
      for (const c of REQUIRED_CAPABILITIES) if (!caps.has(c)) throw new ValidationError(`Required capability '${c}' missing`);
      this.manifest = { ...m, capabilities: [...caps] };
    }
    return this.manifest;
  }

  async capabilities() {
    const m = await this.getManifest();
    return Object.fromEntries(Object.keys(CAPABILITY_METHODS).map((c) => [c, m.capabilities.includes(c)]));
  }

  async #require(capability) {
    const caps = await this.capabilities();
    if (!caps[capability]) throw new CapabilityError(capability);
  }

  async has(capability) {
    return (await this.capabilities())[capability];
  }

  async getPlans({ refresh = false } = {}) {
    if (!refresh && this.planCache && this.planCache.expires > Date.now()) return this.planCache.plans;
    const raw = await this.#call('getPlans');
    const plans = raw.map(normalizePlan);
    this.planCache = { plans, expires: Date.now() + PLAN_TTL_MS };
    return plans;
  }

  async getPlan(planId) {
    return (await this.getPlans()).find((p) => p.plan_id === planId) ?? null;
  }

  async getCustomerContext(ref) {
    if (!(await this.has('customer_context'))) return { customer_reference: ref, current_plan_id: null, tenure_months: 0, subscription_status: 'none' };
    const ctx = await this.#call('getCustomerContext', ref);
    if (!ctx || ctx.customer_reference !== ref) throw new ValidationError('Adapter returned context for a different customer');
    return { current_plan_id: null, tenure_months: 0, subscription_status: 'none', ...ctx };
  }

  async getUsage(ref, period) {
    if (!(await this.has('usage_history'))) return [];
    return normalizeUsageHistory(await this.#call('getUsage', ref, period));
  }

  async recordUsage(event) {
    await this.#require('usage_metering');
    return this.#call('recordUsage', event);
  }

  async changePlan(ref, planId, opts) {
    await this.#require('change_plan');
    if (!opts?.idempotencyKey) throw new ValidationError('idempotencyKey is required for changePlan');
    return this.#call('changePlan', ref, planId, opts);
  }

  async getSubscriptionStatus(ref) {
    await this.#require('subscription_status');
    return this.#call('getSubscriptionStatus', ref);
  }

  async pauseSubscription(ref, opts) {
    await this.#require('pause_subscription');
    return this.#call('pauseSubscription', ref, opts);
  }

  async cancelSubscription(ref, opts) {
    await this.#require('cancel_subscription');
    return this.#call('cancelSubscription', ref, opts);
  }

  /** Anonymized cohort sample; entries are validated and identifiers stripped. */
  async getCohortUsage() {
    if (!(await this.has('cohort_usage'))) return null;
    const rows = await this.#call('getCohortUsage');
    if (!Array.isArray(rows)) throw new ValidationError('getCohortUsage must return an array');
    return rows
      .filter((r) => r && Number.isFinite(r.avg_monthly_usage) && r.avg_monthly_usage >= 0)
      .slice(0, 20000)
      .map((r) => ({ current_plan_id: r.current_plan_id ?? null, avg_monthly_usage: r.avg_monthly_usage }));
  }

  async applyRetentionOffer(ref, offer, opts) {
    await this.#require('retention_offers');
    return this.#call('applyRetentionOffer', ref, offer, opts);
  }
}
