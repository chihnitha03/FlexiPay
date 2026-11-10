# Critical review: flaws found and refinements made

This review covers both the idea (product and business model) and the implementation. **Fixed** means it was changed and tested in this revision. **Open** items are known gaps, each with a recommendation.

## A. Product / business-model flaws

### A1. The advisor can cannibalize merchant revenue *(quantified; mitigated, still open as a business risk)*
Recommending the cheapest fitting plan moves light users from $15.99 to about $4/month. With the default assumptions, the new Pricing Insights simulation shows that showing best-fit recommendations to every StreamFlix customer **lowers 12-month revenue by about $10k (−12%)**, even though it prevents about 55 churned customers out of 600. A merchant pitched only on "retention" could adopt this and lose money.

**Refinements made**
- The merchant can now *see* the trade-off. The dashboard shows *revenue shifted by switches*, *revenue retained by saves* and *net impact*. Insights shows the advisor's effect on the whole cohort.
- **Revenue-neutral pricing solver** (`framework/core/pricing-optimizer.js`). It searches usage-plan parameters (unit price, minimum, base fee, included usage, cap, tier scale) within ±30% guardrails to **maximize customer savings, subject to revenue ≥ today and nobody paying more**. Existing subscribers keep their current price (grandfathering).
  - StreamFlix result: PAYG $0.69/h with a $10.99 minimum, and Lite at $8.99 with 5 h included. The revenue gap shrinks from −$10.0k to −$5.8k, customers still save $10.1k/yr, and nobody pays more.
  - **Neutrality from the existing base alone is not reachable** under any assumptions tested. Every dollar an existing customer saves is a dollar the merchant doesn't collect; only avoided churn and new customers offset it. The solver therefore reports the **break-even acquisition**: StreamFlix needs ~66 new customers (11% of base) who would only subscribe because flexible plans exist; CodeCloud ~52 (13%). The merchant can enter an expected acquisition % and see whether that clears the bar.
- We deliberately did **not** add a "suppress downgrade recommendations" option. Hiding the cheaper option is a dark pattern, and it contradicts the PRD's transparency goal.
- A modelling flaw was found and fixed. Churn depended on overpayment vs. the best plan *in the catalog under test*, so making cheap plans worse appeared to "reduce churn" and the solver exploited it (it briefly reported a fake revenue-neutral result). Churn is now measured against a fixed fair-value reference (today's best-fit cost), and tests guard against regression.

**Open / recommended**
- Position the advisor where it adds revenue: at **signup** (acquisition) and at **cancel intent** (retention), rather than nudging happy monthly payers. That needs an "advisor placement" setting.
- The behavioural parameters (adoption 35%, churn sensitivity, acquisition %) are assumptions. They must be **measured with holdout experiments** before any pricing decision; see "ML roadmap" in [AI.md](AI.md).

### A2. Usage billing needed the customer to come back and pay *(fixed)*
Before this revision, a pay-as-you-go invoice could only be paid by the customer opening the widget and approving a PayPal checkout every month. That's unrealistic: most invoices would go unpaid.

**Fixed:** **PayPal Vault + merchant-initiated charges.**
- The customer saves their PayPal account during checkout: with the purchase when something is due today (`attributes.vault.store_in_vault`), or through a Vault v3 setup token when nothing is due.
- Consent includes an explicit authorization: *"charge after each month, never more than $17.99, notified 3 days before"*.
- `closePeriod` schedules the charge after the notice period. `POST /billing/run` charges with `payment_source.paypal.vault_id`, verifies the result like any capture, retries up to 3 times, then falls back to manual payment.
- The customer can remove the saved account at any time; pending invoices then become manual.

### A3. AI was thin and only customer-facing *(fixed)*
Explanations and intent parsing are useful but shallow. **Fixed:** a merchant-side **Pricing Copilot**. Claude reads aggregate usage, forms hypotheses, must test each one with a deterministic `simulate_catalog` tool, and submits structured proposals. These are re-validated against guardrails and re-simulated on the server.

### A4. Customers could game plans month to month *(fixed)*
A customer could switch to pay-as-you-go in a light month and back to unlimited in a heavy month. **Fixed:** policy `plan_change.min_days_between_changes`. StreamFlix uses 14 days.

### A5. Mid-cycle switches had no proration *(fixed)*
A customer who had already paid this month's $15.99 and switched to annual paid the full $159.99. **Fixed** (`prorationCredit()` in `billing-service.js`, policy `plan_change.proration: 'credit'`): the unused whole days of the current prepaid period are credited against the new plan.
- This works whether FlexPrice or the merchant billed the old plan; the adapter reports `current_period_start/end`.
- The credit is shown line by line before consent and bound into the terms hash.
- Leftover credit (e.g. annual → monthly) becomes **account credit**, consumed first by future renewals and usage invoices.
- Example: Ben switching to annual mid-month pays $156.90 instead of $159.99.

### A6. Fixed-plan renewals weren't collected by FlexPrice *(fixed)*
**Fixed:** FlexPrice now runs a **billing schedule** for plans sold through it (`subscriptions`, `runBilling()`):
- It sends a renewal notice N days ahead (`subscription.renewal_upcoming`).
- At period end it creates a renewal invoice and charges it to the **PayPal Vault** saved account, which is saved with the first purchase under an explicit renewal authorization.
- On failure it retries, then marks the invoice past-due (`subscription.past_due`) with a manual-payment fallback.
- Usage plans roll over monthly (the month-end usage invoice is created automatically).
- Pausing moves the renewal date; cancelling stops renewals.

We chose saved-account renewals over the PayPal Subscriptions API because one schedule then handles fixed renewals, usage invoices, proration and credits together. With the Subscriptions API, PayPal runs each plan's schedule, so mid-cycle switches would require cancelling or revising PayPal subscriptions. Fixed plans can still be mirrored into the PayPal Subscriptions catalog.

### A7. The merchant had no way to notify customers *(fixed)*
FlexPrice recorded invoice notices but nobody sent them. **Fixed:** **signed merchant event webhooks** (`event-service.js`): an outbox with retries and exponential backoff, HMAC signatures (`FlexPrice-Signature`), stable event IDs, a redelivery API, and `verifyEventSignature()` in the SDK. There are 17 event types, including `invoice.created`, `invoice.payment_failed`, `subscription.renewal_upcoming`, `usage.cap_reached`, and `recommendation.savings_available` (fired when live usage crosses a break-even point and a cheaper plan now fits).

### A8. Bugs found while building A5–A7 *(fixed, with regression tests)*
- **Usage before a switch away from a metered plan was never billed.** The month-end invoice used the *new* plan, and fixed plans refuse usage invoices. Now usage events record the plan they were made on; a switch creates a final partial invoice at the old plan's rates; post-switch usage never bills the old plan.
- **The hybrid base fee was charged twice in the first month** (at signup *and* in the month-end invoice). Now a "Base fee prepaid at signup" credit line is applied.
- **Signature verification failed behind the framework's JSON parser** (raw body already consumed). The framework now keeps `req.rawBody`.
- **A local variable shadowed the event service**, so the first spending-cap crossing returned an error.
- The grounding guard misread amounts ≥ $1,000 written without commas (found earlier).

## B. Architecture / security flaws

| # | Flaw | Status |
|---|---|---|
| B1 | **The demo endpoint `/api/v1/demo/merchants` exposed every merchant's admin API key**, and `/api/v1/demo/:m/session` could mint a session for any customer. Both were always mounted. | **Fixed:** they exist only in `demo/app.js`. The framework never mounts them, and `test/framework.test.js` asserts a 404 |
| B2 | Framework and demo were entangled: hard-coded merchant registry, simulator inside the PayPal client, demo return URL in billing, demo customer lists inside merchant config | **Fixed:** `framework/` vs `demo/`; config-driven registry (`loadMerchantsFromFile`); PayPal client is injectable; framework return page |
| B3 | Dashboard depended on the demo key list | **Fixed:** API-key sign-in; demo quick-pick appears only when demo mode is detected |
| B4 | No production entry point | **Fixed:** `framework/server.js` + `docs/examples/merchants.example.json` |
| B5 | Merchants had to hand-write the REST contract | **Fixed:** SDK `createAdapterRouter()`, `signWidgetSession()`, `FlexPriceMerchantClient` |
| B6 | Usage ingestion fetched 24 months of history from the merchant for every event | **Fixed:** `context(…, { includeHistory: false })` on hot paths |
| B7 | Without PayPal credentials the framework silently used a simulator | **Fixed:** the framework reports payments as `disabled` (advice still works; checkout returns 503); only the demo injects the simulator |
| B8 | In-memory store, per-process rate limit, no webhook queue | **Open:** swap `Store` for Postgres (same interface) and use a queue for webhooks and usage |
| B9 | Session tokens can't be revoked (1-hour TTL) | **Open:** shorter TTL plus a revocation list if merchants need it |

## C. AI safety / quality flaws

| # | Flaw | Status |
|---|---|---|
| C1 | Customer chat text could contain PII and was sent to the LLM as-is | **Fixed:** `redactPII()` (email, phone, card/account numbers, links); tested |
| C2 | The grounding check covered only `$` amounts | **Fixed:** also `%` values (must be stated or a ratio of engine numbers). Plan names and non-money numbers are still unchecked (**open**) |
| C3 | One LLM call per slider movement (cost and latency) | **Fixed:** explanation cache keyed by a hash of the facts (10 min) |
| C4 | The copilot could cite invented numbers or propose out-of-policy changes | **Fixed:** grounding on rationales, guardrails (±30% price change, caps required, price limits), and server-side re-simulation; covered by tests |
| C5 | A metric bug: "customer spend change" counted only switchers, so lowering a cap showed customers spending *more* | **Found and fixed in this review** |
| C6 | Live Anthropic and PayPal sandbox calls haven't been exercised in this environment | **Open:** run with real keys before judging; the Vault JS SDK flow especially needs a sandbox test |
| C7 | One PayPal credential per deployment: in a multi-tenant hosted setup every merchant's money would go to one PayPal account | **Open:** for hosted (SaaS) mode, onboard merchants through PayPal Commerce Platform (partner referrals + `PayPal-Auth-Assertion`) so each merchant is paid directly. Self-hosted deployments already use the merchant's own credentials |

## D. Compliance & scope gaps *(open)*
- Auto-renewal and merchant-initiated charge rules (for example FTC negative-option rules, EU consumer law) vary by market. `invoice_notice_days` and the explicit authorization text are configurable, but legal review is needed per market.
- PayPal Vault and merchant-initiated (reference) transactions must be enabled on the merchant's PayPal account. Eligibility differs by country.
- Taxes/VAT, multi-currency and invoice documents (PDF/email) aren't handled. FlexPrice records `invoice_notice` audit events; the merchant is expected to send the notification. A notification webhook to the merchant would close that gap.
- Forecasts ignore the current month's live usage, and cold start relies on the merchant default or the customer's own estimate.
