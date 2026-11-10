# FlexPrice Merchant Adapter Contract (v1)

An adapter is a **thin translation layer** between FlexPrice and an existing merchant backend. It doesn't replace the merchant's billing, entitlement or identity systems. It exposes them through a small, standard interface.

You can implement it in two ways:

1. **HTTP adapter (any language).** Expose the REST endpoints below on your backend, and FlexPrice calls them with `HttpAdapter`. Hand-written reference: `demo/merchants/streamflix-backend.js`. In Node you can skip the routing entirely with the SDK:
   ```js
   import { createAdapterRouter } from 'flexprice-ai/sdk';
   app.use('/flexprice', createAdapterRouter(myAdapter, { apiKey: process.env.FLEXPRICE_ADAPTER_KEY }));
   ```
   `createAdapterRouter` handles bearer auth and `Idempotency-Key` replay, and only exposes the capabilities you declare.
2. **In-process adapter (JavaScript).** Implement the methods directly. Reference: `demo/merchants/codecloud-adapter.js`.

A merchant that only wants the Pricing Advisor can use the **static catalog adapter** (`framework/adapters/static-catalog-adapter.js`) and supply nothing but plans.

## Capabilities

Every adapter **must** declare its capabilities in the manifest. FlexPrice never assumes support for anything undeclared: plans that need missing capabilities are hidden, and actions that need them are never offered.

| Capability | Method | HTTP endpoint | Enables |
|---|---|---|---|
| `plans` *(required)* | `getPlans()` | `GET /flexprice/plans` → `{plans: Plan[]}` | Pricing Advisor |
| `customer_context` | `getCustomerContext(ref)` | `GET /flexprice/customers/:ref` | Current plan, tenure, eligibility |
| `usage_history` | `getUsage(ref, {from,to})` | `GET /flexprice/customers/:ref/usage?from&to` → `{usage:[{period:'YYYY-MM', quantity}]}` | Personalized forecasts |
| `usage_estimate` | `getUsageEstimate(ref, period)` | — | Merchant-provided forecast |
| `usage_metering` | `recordUsage(event)` | `POST /flexprice/usage` | Usage-based plans |
| `change_plan` | `changePlan(ref, planId, {idempotencyKey, consentReference, paymentReference})` | `POST /flexprice/customers/:ref/plan-change` + `Idempotency-Key` | In-widget plan switching |
| `subscription_status` | `getSubscriptionStatus(ref)` | `GET /flexprice/customers/:ref/subscription` → `{plan_id, status, entitlements}` | Post-payment verification |
| `pause_subscription` | `pauseSubscription(ref, {months, idempotencyKey})` | `POST /flexprice/customers/:ref/pause` | Pause as a retention option |
| `cancel_subscription` | `cancelSubscription(ref, {reason, idempotencyKey})` | `POST /flexprice/customers/:ref/cancel` | Cancellation through your workflow |
| `retention_offers` | `applyRetentionOffer(ref, {percent, months}, {idempotencyKey})` | `POST /flexprice/customers/:ref/retention-offer` | Policy-approved discounts |
| `billing_status` | `getBillingStatus(referenceId)` | — | Merchant-side billing verification |
| `cohort_usage` | `getCohortUsage()` | `GET /flexprice/cohort-usage` → `{cohort:[{current_plan_id, avg_monthly_usage}]}` | Pricing Insights over your whole base. **Anonymized: no customer identifiers** (FlexPrice strips any extra fields) |

**Adaptive Billing mode** requires `usage_metering` + `change_plan` + `subscription_status`.

## Manifest

`GET /flexprice/manifest`

```json
{
  "merchant_id": "streamflix",
  "name": "StreamFlix",
  "vertical": "streaming",
  "capabilities": ["plans", "customer_context", "usage_history", "usage_metering", "change_plan", "subscription_status"],
  "usage": { "metric": "watch_hours", "unit": "hours", "label": "hours watched per month", "default_monthly_usage": 15, "slider_max": 80 },
  "checkout_url": "https://merchant.example.com/checkout",
  "branding": { "primary": "#e50914", "logo_text": "StreamFlix" }
}
```

## Plan

```json
{
  "plan_id": "SF-LITE",
  "name": "Lite + Hours",
  "billing_model": "hybrid",            // fixed | usage | hybrid | tiered
  "billing_interval": "month",          // month | year (metered plans must be monthly)
  "currency": "USD",
  "base_price": 6.99,
  "usage_metric": "watch_hours",
  "unit": "hours",
  "unit_price": 0.45,                   // usage + hybrid
  "included_usage": 10,
  "tier_rules": null,                   // tiered: [{ "up_to": 20, "unit_price": 0.5 }, …, { "up_to": null, "unit_price": 0.15 }]
  "minimum_charge": 0,
  "spending_cap": 18.99,                // required for metered plans by default policy
  "terms": { "summary": "…customer-facing terms…", "commitment_months": 0, "cancel_anytime": true, "auto_renews": true },
  "eligibility_rules": { "new_customers_only": false, "min_tenure_months": 0, "regions": ["US"] },
  "features": ["HD streaming", "10 hours included"]
}
```

Plans are validated by `normalizePlan()` (`framework/core/models.js`) and checked against the merchant policy guardrails (`validateCatalog()`). Invalid plans are rejected and never shown.

## Customer context

```json
{
  "customer_reference": "sf-1001",       // stable merchant-issued reference; no PII required
  "display_name": "Asha",                // optional, shown in widget only, never sent to the AI
  "current_plan_id": "SF-STD-M",
  "tenure_months": 14,
  "region": "US",
  "has_active_discount": false,
  "last_retention_offer_at": null,       // lets FlexPrice honour offers granted outside FlexPrice
  "subscription_status": "active"        // active | paused | cancelled | none
}
```

## Usage event (merchant → FlexPrice)

`POST /api/v1/merchant/usage` with `Authorization: Bearer <merchant API key>`

```json
{ "event_id": "evt_123", "customer_reference": "sf-1001", "metric": "watch_hours",
  "quantity": 1.5, "unit": "hours", "occurred_at": "2026-10-25T18:00:00Z", "source": "player" }
```

Events are deduplicated by `event_id` and aggregated per calendar month. They are rated with the customer's current plan and clamped at the spending cap. What happens at the cap is set by `cap_reached_behavior`: `stop_billing`, `pause_service` or `require_approval`.

## Authentication & idempotency

- FlexPrice → merchant: `Authorization: Bearer <adapter key>`. Mutations carry an `Idempotency-Key`, and replaying it must return the original result.
- Merchant → FlexPrice: `Authorization: Bearer <merchant API key>`. The key alone determines the tenant.
- Merchant site → widget: a short-lived HMAC session token signed with the merchant's widget secret (`signWidgetSession()` in `framework/sdk/index.js`).

## Conformance

`GET /api/v1/merchant/validate` (or **Run adapter validation** in the dashboard) checks the manifest, plan schema, policy guardrails, and a sample customer context, usage history and subscription read. It also reports which modes (Pricing Advisor / Adaptive Billing) the adapter qualifies for.
