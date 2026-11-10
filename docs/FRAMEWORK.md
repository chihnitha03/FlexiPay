# What FlexPrice provides vs. what the demo simulates

The repository has two top-level parts, and the framework never imports from the demo.

```
framework/   ← THE PRODUCT. What a company deploys or integrates with.
demo/        ← SIMULATION ONLY. Mock merchants, PayPal simulator, demo pages, demo helper endpoints.
test/        unit + API + framework-isolation tests; test/e2e = browser walkthrough of the demo
docs/
```

`test/framework.test.js` enforces this boundary. It starts the framework alone, with an adapter built from the SDK, and checks that none of the demo routes exist. It then runs advice, validation, usage ingestion and insights.

## 1. The framework (`framework/`): what companies get

| Component | Path | What it is |
|---|---|---|
| **Server factory** | `framework/index.js` → `createFlexPrice({ merchants, config, store, paypal })` | An Express app that mounts the APIs, widget and dashboard. PayPal and storage can be injected |
| **Production entry** | `framework/server.js` (`npm run start:framework`) | Loads merchant registrations from JSON (`FLEXPRICE_MERCHANTS_FILE`) with secrets from env vars. See `docs/examples/merchants.example.json` |
| **Merchant registry** | `framework/registry.js` | Validates registrations; `loadMerchantsFromFile()` |
| **Adapter contract** | `framework/adapters/contract.js`, [ADAPTER_CONTRACT.md](ADAPTER_CONTRACT.md) | The interface a merchant implements, with explicit capability declarations |
| **Adapter gateway** | `framework/adapters/gateway.js` | Wraps any adapter: enforces capabilities, validates responses, adds timeouts, caching and health metrics |
| **Built-in adapters** | `framework/adapters/http-adapter.js`, `static-catalog-adapter.js` | REST (any language) and zero-code catalog integration |
| **Merchant SDK** | `framework/sdk/index.js` (`flexprice-ai/sdk`) | Used inside the merchant's backend: `signWidgetSession`, `FlexPriceMerchantClient` (usage, billing runs), `createAdapterRouter` (turns an adapter object into the REST contract) |
| **Engine library** | `framework/engine.js` (`flexprice-ai/engine`) | The deterministic forecaster, pricing engine, recommender, policy engine, simulator and solver as pure functions, for running inside the merchant's own services. See [SCALABILITY.md](SCALABILITY.md) |
| **Core engines** | `framework/core/*` | Pricing engine, forecaster, recommender, policy engine, usage ledger, catalog simulator, store, session tokens. All deterministic |
| **AI** | `framework/ai/*` | Claude client, customer advisor, merchant pricing copilot, grounding guard, PII redaction. See [AI.md](AI.md) |
| **PayPal** | `framework/paypal/client.js` | REST client: OAuth, Orders v2, Payments refunds, Vault v3, Subscriptions catalog, webhook verification |
| **Services** | `framework/services/*` | Pricing orchestration, billing (consent → checkout → verify → fulfil, vault, invoices, billing runs, webhooks, reconciliation), insights |
| **Widget API** | `framework/routes/widget-api.js` | Public, CORS-enabled API used by the widget, authenticated with a merchant-signed session token |
| **Merchant API** | `framework/routes/merchant-api.js` | Server-to-server and dashboard API, authenticated with the merchant API key |
| **Webhooks** | `framework/routes/webhooks.js` | `POST /webhooks/paypal` |
| **Embeddable widget** | `framework/public/widget/flexprice-widget.js` | The `<flexprice-advisor>` web component |
| **Merchant dashboard** | `framework/public/dashboard/` | Sign-in with a merchant API key; KPIs, revenue impact, insights, validation, payments, audit |
| **PayPal return page** | `framework/public/checkout/return.html` | `return_url` / `cancel_url` target |

### API endpoints FlexPrice provides

**Widget API**: `/api/v1/widget/:merchant/…`, with optional `X-FlexPrice-Session: <token signed by merchant>`

| Method | Path | Purpose |
|---|---|---|
| GET | `/config` | Branding, usage metric, capabilities, payments mode, AI status |
| POST | `/recommend` | Forecast + per-plan estimates + recommendation (deterministic, fast) |
| POST | `/explain` | Natural-language explanation of the recommendation (Claude or template) |
| POST | `/chat` | Conversational advisor → `{ reply, actions[], source }` |
| GET | `/plans/:id/terms` | Disclosure + `terms_hash` (includes the future-charge authorization for metered plans) |
| POST | `/consents` | Records acceptance of the exact terms |
| POST | `/checkout` | PayPal order, PayPal Vault setup token, or direct switch |
| POST | `/checkout/:orderId/capture` | Server-side capture → verification → plan change → read-back |
| POST | `/checkout/:checkoutId/payment-method` | Completes Vault setup (save PayPal, nothing charged) |
| GET / DELETE | `/payment-method` | View or remove the saved PayPal account |
| POST | `/retention/options`, `/retention/accept` | Policy-gated alternatives, pause, discount, cancel |
| GET | `/usage/current` | Live meter, cap status, invoices |
| POST | `/invoices/:id/pay` | Customer-present invoice payment |

**Merchant API**: `/api/v1/merchant/…`, with `Authorization: Bearer <merchant API key>`

| Method | Path | Purpose |
|---|---|---|
| POST | `/usage` | Trusted usage events (single or ≤500 batch), deduplicated by `event_id` |
| POST | `/customers/:ref/close-period` | Rate a billing period into an invoice; schedule automatic collection after the notice period |
| POST | `/customers/:ref/invalidate` | Tell FlexPrice a customer changed outside FlexPrice (drops the cached snapshot) |
| POST | `/precompute` | Bulk-refresh precomputed recommendations, e.g. nightly or after month close (≤1000 per call) |
| POST | `/billing/run` | Charge due automatic invoices with the vaulted account; retries; fallback to manual. Call from a scheduler |
| POST | `/insights` · GET `/insights/latest` | Pricing Insights (advisor revenue/churn impact + catalog experiments) |
| GET | `/overview` | KPIs including revenue shifted, revenue retained and net impact |
| GET | `/validate` | Adapter conformance suite (`?customer=<ref>` adds customer-level checks) |
| GET | `/cost-curves`, `/plans`, `/audit`, `/checkouts`, `/invoices`, `/subscriptions` | Read models for the dashboard |
| GET | `/events` · POST `/events/:id/redeliver` · POST `/events/test` | Outbound event webhooks: delivery log, redelivery, test ping |
| POST | `/reconcile`, `/checkouts/:id/refund`, `/paypal/sync-catalog` | Operations |

**Webhooks:** `POST /webhooks/paypal` (signature verified, deduplicated)

### Merchant event webhooks

Configure `events: { url, secret_env }` in the merchant registration. FlexPrice POSTs each event as JSON with the header `FlexPrice-Signature: t=<unix>,v1=<HMAC-SHA256(secret, "<t>.<raw body>")>`. Verify it with `verifyEventSignature({ payload: rawBody, header, secret })` from `flexprice-ai/sdk`, then deduplicate on `id`. Deliveries are retried with backoff (1 m, 5 m, 30 m, 2 h, 6 h).

Event types: `plan.changed`, `payment.captured`, `payment_method.saved/removed`, `invoice.created/paid/payment_failed/past_due`, `subscription.renewal_upcoming/renewed/past_due/paused/cancelled`, `usage.cap_reached`, `recommendation.savings_available`, `refund.issued`, `test.ping`.

### Billing schedule

For plans sold through FlexPrice:
- **Fixed plans** renew on their anniversary date. A notice goes out N days before, then the saved PayPal account is charged at renewal.
- **Usage plans** are invoiced monthly; the charge happens after the notice period.
- **Switching plans** credits the unused days of the current prepaid period. Leftover credit is applied to future bills.

Run `POST /billing/run` from a scheduler (e.g. every 15 minutes). It's idempotent.

### What a company has to do to integrate

1. **Register** in the merchants JSON: id, name, adapter location, and the env var names for three secrets.
2. **Expose the adapter.** Either implement the REST contract in any language, or mount `createAdapterRouter(myAdapter, { apiKey })` in a Node backend. Declare only the capabilities you support. The minimum is `plans`.
3. **Sign widget sessions** in your backend after your own login: `signWidgetSession({ merchantId, customerRef, secret })`.
4. **Embed** `<flexprice-advisor merchant="…" session-token="…">` on your pricing or account page.
5. *(Adaptive Billing only)* **Push usage** with `FlexPriceMerchantClient.recordUsage()`, and **schedule** `POST /billing/run` (it handles renewals, month-end usage invoices, retries).
6. **Receive events** at your webhook endpoint to email customers and update entitlements.
7. **Configure PayPal** credentials and point a PayPal webhook at `/webhooks/paypal`.
8. Run **validation** from the dashboard.

## 2. The demo (`demo/`): simulation only

| Piece | Path | Stands in for |
|---|---|---|
| Demo composition | `demo/app.js`, `demo/server.js` (`npm start`) | A deployment that also hosts fake merchants |
| Demo merchant registrations | `demo/registry.js` | The production merchants JSON |
| **StreamFlix** mock backend | `demo/merchants/streamflix-backend.js` | A real merchant's backend with its own data model and a hand-written REST adapter. It also has fake "site" endpoints: login/session signing, player watch events |
| **CodeCloud** mock adapter | `demo/merchants/codecloud-adapter.js` | A merchant using an in-process JS adapter |
| **LearnHub** catalog | `demo/merchants/learnhub-catalog.js` | A zero-code catalog integration |
| Synthetic data | `demo/seed.js` | Customer usage histories and anonymized cohorts |
| **PayPal simulator** | `demo/paypal-simulator/` | PayPal's REST API and buyer approval pages, used only when no PayPal credentials are configured |
| Demo helper API | `/api/v1/demo/*` (in `demo/app.js`) | Each merchant's login system: lists demo customers and **demo API keys**, and signs sessions. **Must never exist in production** |
| Demo pages | `demo/public/` | Landing page and mock merchant websites. Only the embedded widget on them is FlexPrice |
| "Merchant backend simulator" panel | `demo/public/demo/site.html` | The merchant's player/gateway sending usage, its month-end job, and a "skip notice period" time machine |

The widget has a single simulator-specific hook. In `simulator` mode it shows PayPal approval in an iframe and listens for `postMessage`, because the simulator can't run PayPal's JS SDK. In `sandbox` and `live` modes the widget uses the official PayPal JS SDK buttons and that hook is inactive.
