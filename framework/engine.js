// FlexPrice decision engine as an embeddable library: pure functions, no I/O, no network, no LLM.
// Merchants with strict latency or data-residency needs can run pricing, forecasting and
// recommendation inside their own services (e.g. in the plans-page backend or a batch job)
// and use the FlexPrice service only for what needs state: consent, billing, PayPal, insights.
//
//   import { forecastUsage, recommendPlan, normalizePlan } from 'flexprice-ai/engine';
//   const forecast = forecastUsage({ history });
//   const rec = recommendPlan({ plans: plans.map(normalizePlan), forecast, currentPlanId });

export { normalizePlan, normalizeUsageRecord, normalizeUsageHistory, ValidationError } from './core/models.js';
export { monthlyCost, horizonCost, breakEven, usageAtCap, estimatePlans } from './core/pricing-engine.js';
export { forecastUsage } from './core/forecaster.js';
export { recommendPlan, PREFERENCES } from './core/recommender.js';
export { resolvePolicy, filterEligiblePlans, evaluateRetention, authorizePlanChange, validateCatalog, DEFAULT_POLICY } from './core/policy-engine.js';
export { simulateCatalog, applyCatalogChanges, summarizeCohort, DEFAULT_ASSUMPTIONS } from './core/catalog-simulator.js';
export { optimizeMeteredPricing } from './core/pricing-optimizer.js';
