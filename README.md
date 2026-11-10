# FlexPrice AI

**AI-powered pricing advisor and adaptive billing framework, with payments on PayPal.**

FlexPrice helps subscription businesses offer **monthly, annual, usage-based, hybrid and tiered** plans side by side. It forecasts each customer's usage, compares every eligible plan over the same horizon, recommends the best fit, explains it with **Claude**, collects payment (including automatic usage billing) through **PayPal**, and shows the merchant the revenue/churn trade-off along with AI-proposed catalog improvements. Throughout, the merchant's own backend stays the source of truth.

## Repository layout: product vs. demo

| | Directory | Contents |
|---|---|---|
| 🧩 **Framework (the product)** | [`framework/`](framework/) | Pricing/forecast/policy engines, adapter contract + gateway, PayPal client, Claude integrations, Widget API, Merchant API, webhooks, the embeddable `<flexprice-advisor>` widget, the merchant dashboard and the merchant SDK |
| 🎭 **Demo (simulation only)** | [`demo/`](demo/) | Three mock merchants (StreamFlix, CodeCloud, LearnHub), synthetic data, an offline PayPal simulator, demo helper endpoints (fake logins and demo keys) and demo web pages |

**→ Full breakdown, with every endpoint FlexPrice provides and every piece that is simulated: [docs/FRAMEWORK.md](docs/FRAMEWORK.md)**

The framework never imports demo code, and `test/framework.test.js` runs it standalone to prove it.

## Quick start

```bash
npm install
npm start               # DEMO: framework + mock merchants + PayPal simulator → http://localhost:4000
npm test                # 58 unit / API / framework-isolation / billing / scaling / mocked-AI tests
npm run test:e2e        # browser walkthrough of the demo (needs `npm start` running)

# Production-style: framework only, merchants from config
FLEXPRICE_MERCHANTS_FILE=docs/examples/merchants.example.json npm run start:framework
```

Optional `.env` (see `.env.example`):
- `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` / `PAYPAL_WEBHOOK_ID`: real PayPal sandbox. Otherwise the demo uses the simulator, and the framework alone reports payments as `disabled`.
- `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL`: Claude. Otherwise deterministic fallbacks are used.

| Page | |
|---|---|
| `/` | Demo landing page |
| `/demo/site.html?m=streamflix` · `codecloud` · `learnhub` | Mock merchant sites embedding the real widget |
| `/dashboard/` | Merchant dashboard (framework): sign in with a merchant API key; demo mode offers quick-pick |

A 6-minute walkthrough is in [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md).

## AI: what it does, inputs and outputs

FlexPrice calls **Claude through the Anthropic Messages API** (`POST /v1/messages`, model set by `ANTHROPIC_MODEL`). There are three integrations:

| Feature | Input to Claude | Claude's tools | Output |
|---|---|---|---|
| **Explain recommendation** (customer) | Engine-computed facts: forecast, per-plan estimates, break-evens, decision factors. No identity | — | 3–4 sentence explanation |
| **Conversational advisor** (customer) | PII-redacted chat message + history | `compare_plans`, `usage_summary`, `retention_options` (all read-only, engine-backed) | Reply + UI actions (`set_usage`, `set_preference`, `highlight_plan`, `show_retention`) |
| **Pricing copilot** (merchant) | Catalog, aggregated usage histograms, baseline simulation, guardrails | `simulate_catalog`, `submit_proposals` | Up to 3 catalog experiments, each re-validated and re-simulated on the server |

The LLM never computes prices, decides eligibility or moves money. Forecasting, pricing, recommendation, policy and simulation are deterministic. Every `$`/`%` the model writes is checked against engine output, and anything unverified is replaced. **Details and example payloads: [docs/AI.md](docs/AI.md)**

## PayPal integration

| Capability | Used for |
|---|---|
| OAuth 2.0 client credentials | Server-side token, cached |
| **Orders v2** create / capture / get, with `PayPal-Request-Id` | First-period, annual and invoice payments; the amount is always computed on the server |
| **Vault v3**: save with purchase (`store_in_vault`), setup tokens → payment tokens, delete | Saved PayPal account for **renewals of fixed plans** and **month-end usage invoices**: merchant-initiated charges with `vault_id` after a notice period, with retries and manual fallback |
| **JS SDK Smart Buttons** (separate namespaces for checkout and vault) | Buyer approval in sandbox/live |
| Payments v2 refunds | Dashboard refunds |
| **Webhooks** + verify-webhook-signature | Verified, deduplicated; recovers approved-but-uncaptured orders |
| Subscriptions v1 products/plans | Mirror fixed plans into the PayPal catalog |

A redirect is never treated as proof of payment. The server verifies status, amount, currency and `custom_id`, then changes the plan with the merchant and reads it back. Fulfilment failures after payment are reconciled without charging twice.

## Critical review

The flaws found in the idea and the implementation, what was fixed, and what remains open are in **[docs/REVIEW.md](docs/REVIEW.md)**. The most important finding: by default, recommending best-fit plans **reduces merchant revenue (~−12% in the StreamFlix simulation) even though it reduces churn**. FlexPrice now makes that visible and proposes fair plan-design fixes rather than hiding cheaper options.

## Docs
- [docs/FRAMEWORK.md](docs/FRAMEWORK.md): framework vs. demo, all endpoints, integration steps
- [docs/ADAPTER_CONTRACT.md](docs/ADAPTER_CONTRACT.md): the merchant adapter specification
- [docs/AI.md](docs/AI.md): AI features, inputs/outputs, guardrails, data sent to Anthropic
- [docs/SCALABILITY.md](docs/SCALABILITY.md): what costs time, caching/precompute, event-driven invalidation, deployment models (self-hosted, embedded library, SaaS)
- [docs/REVIEW.md](docs/REVIEW.md): flaws, refinements, open items
- [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md): presentation walkthrough
- [presentation/FlexPrice-AI.pptx](presentation/FlexPrice-AI.pptx): pitch deck (13 slides, speaker notes). Rebuild with `python3 presentation/build_deck.py`
