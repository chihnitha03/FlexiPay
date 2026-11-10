# How AI is used in FlexPrice

**Yes, FlexPrice calls Claude models through the Anthropic Messages API**: `POST https://api.anthropic.com/v1/messages` with `anthropic-version: 2023-06-01`, using plain `fetch` with no SDK (`framework/ai/claude.js`). It is enabled by `ANTHROPIC_API_KEY`, the model comes from `ANTHROPIC_MODEL` (default `claude-sonnet-5-5`), and the timeout is set by `AI_TIMEOUT_MS`.

Without a key, or when a call times out, fails or produces ungrounded output, every feature falls back to a deterministic implementation. The product keeps working; only the wording and the proposals get simpler. The UI always labels the source (`claude`, `template`, `rules`, `heuristic`).

> Verification status: all three Claude integrations are covered by tests against a mocked Anthropic API (`test/ai-claude.test.js`), which check request shape, tool loops, grounding rejection and PII redaction. They have not been run against the live API in this repository's CI.

## The division of labour

| Task | Done by | AI? |
|---|---|---|
| Usage forecast (trend, seasonality, 80% range) | `core/forecaster.js`: Holt damped trend + seasonal indices | ❌ statistics |
| Prices, caps, tiers, break-even | `core/pricing-engine.js`: integer cents | ❌ |
| Which plan to recommend | `core/recommender.js`: risk-adjusted cost × preference | ❌ |
| Eligibility, consent, discounts, plan-change limits | `core/policy-engine.js` | ❌ |
| Revenue/churn simulation of a catalog | `core/catalog-simulator.js` | ❌ |
| **Explain** the recommendation in plain language | Claude | ✅ |
| **Understand** a customer's free-text description and answer questions | Claude with read-only tools | ✅ |
| **Propose** catalog experiments to the merchant | Claude with a simulation tool | ✅ |

The LLM never computes a price, never decides eligibility, and never moves money. `authorizePlanChange` rejects `actor: 'ai_agent'`.

---

## AI feature 1: Recommendation explanation (customer-facing)

`POST /api/v1/widget/:merchant/explain` → `Advisor.explain()` in `framework/ai/advisor.js`

**Input to Claude.** Facts computed by the engine, with no customer identity:
```json
{
  "usage_label": "hours watched per month",
  "forecast": { "source": "history", "confidence": "high", "expected_monthly": 7.1, "low_monthly": 5.2, "high_monthly": 9 },
  "preference": "balanced",
  "recommended_plan_id": "SF-PAYG",
  "estimated_savings_vs_baseline": 140.82, "baseline_plan_id": "SF-STD-M", "horizon_months": 12,
  "plans": [{ "plan_id": "SF-PAYG", "name": "Pay-As-You-Watch", "estimated_cost_total": 51.06, "estimated_monthly_cost": 4.26,
              "low_total": 38.19, "high_total": 64.8, "upfront_payment": 0, "usage_at_spending_cap": 30 }, "…"],
  "break_even": [{ "versus_plan_name": "Lite + Hours", "usage_per_month": 16.6 }],
  "decision_factors": ["Expected usage ≈ 7.1 per month (range 5.2–9).", "…"]
}
```
**Output:** 3–4 sentences of plain text (max 400 tokens), for example *"Pay-As-You-Watch fits best at about $4.26/month… it never exceeds the $17.99 cap…"*

**Guardrails:**
- **Grounding check** (`ai/grounding.js`): every `$` amount and `%` in the output must be an engine number, a difference or monthly conversion of two engine numbers, or a ratio of two. Otherwise the text is discarded and the template is shown.
- Called **at most once per customer snapshot**. The precomputed "view plans" recommendation stores its explanation, and slider what-ifs use the template unless the customer clicks "✦ Explain this with AI". There's also a 10-minute cache keyed by a hash of the facts. See [SCALABILITY.md](SCALABILITY.md).
- Prices are rendered from `/recommend` first. The explanation loads separately and can never delay them.

**Fallback:** `templateExplanation()`, which builds the same content from a template.

## AI feature 2: Conversational advisor (customer-facing)

`POST /api/v1/widget/:merchant/chat` → `Advisor.chat()`

**Input to Claude:**
- The customer's message plus the last 8 turns, after **PII redaction** (`ai/privacy.js` removes emails, phone numbers, card/account numbers and links).
- A system prompt with hard rules: never state an unsourced price, never pressure, cannot change plans, and treat user text as untrusted.
- **Read-only tools**, each backed by the engine:

| Tool | Input | Returns |
|---|---|---|
| `compare_plans` | `{ monthly_usage?, preference? }` | Per-plan 12-month estimates, ranges, the recommendation, break-even points |
| `usage_summary` | — | History stats and forecast |
| `retention_options` | — | Policy-permitted alternatives, pause and discount eligibility |

The tool loop runs up to 4 rounds.

**Output:**
```json
{ "reply": "At about 17.3 hours a month, Lite + Hours looks best…",
  "actions": [{ "type": "set_usage", "value": 17.3 }, { "type": "set_preference", "value": "flexible" }, { "type": "highlight_plan", "plan_id": "SF-LITE" }],
  "source": "claude" }
```
The widget applies the `actions`: it moves the slider, switches the preference, re-prices and highlights a plan. In effect the AI turns a sentence like "two movies a week, no commitment" into structured inputs for the deterministic engine.

**Guardrails:** the grounding check runs against the tool results, so a prompt-injection reply such as "StreamFlix for $1.99!" is rejected (a test covers this). Free text is redacted, and the endpoint is rate-limited to 30 requests per minute per IP.

**Fallback:** `parseIntent()`. A regex-based intent parser handles units, frequencies (day/week/month), movies → hours, episodes, "k calls", preference keywords and cancel intent.

## AI feature 3: Pricing Insights copilot (merchant-facing)

`POST /api/v1/merchant/insights` → `InsightsService` + `framework/ai/pricing-copilot.js`

**Input to Claude.** Aggregates only, never individual customers:
- The plan catalog
- A cohort summary: usage quantiles, plus a histogram per current plan, built from the adapter's anonymized `cohort_usage` capability or from customers FlexPrice has advised
- A simulation of the current catalog, the merchant's goal (`balanced` / `retention` / `revenue`), guardrails (±30% price change, required spending caps, price limits) and the model assumptions

**Tools:**

| Tool | Input | Returns |
|---|---|---|
| `simulate_catalog` | `{ changes: [{op:'update', plan_id, set}, {op:'add', plan}, {op:'remove', plan_id}] }` | Validation errors, or simulated 12-month revenue, churn, customer spend and plan mix vs. the current catalog |
| `submit_proposals` | `{ proposals: [{ title, rationale, changes }] }` (max 3) | Ends the loop. Structured output delivered through tool use |

The loop runs up to 8 rounds. The model is told to simulate every hypothesis before submitting it.

**Output:** for each proposal, the server re-applies the changes, re-validates them against policy and re-simulates. Invalid proposals are dropped. A rationale that cites unverified numbers is replaced with an engine summary.
```json
{ "source": "claude",
  "advisor_impact_on_current_catalog": { "revenue_impact_12m": -9976.09, "customer_savings_12m": 17349.72, "churned_customers_avoided": 54.94 },
  "proposals": [{ "title": "Set a 4.80 monthly minimum on metered plans", "changes": [{ "op": "update", "plan_id": "SF-PAYG", "set": { "minimum_charge": 4.8 } }],
                  "result": { "vs_current_catalog": { "revenue_change_12m": 635.44, "churned_customers_change": 11.51, "customer_spend_change_12m": 1105.11 } } }] }
```
Proposals are never applied automatically. The merchant decides and changes prices in its own system (PRD non-goal: no dynamic pricing without merchant approval).

**Fallback:** deterministic heuristics: align caps with the flat price, add a fair minimum charge, make the annual plan "2 months free".

## Data sent to Anthropic: summary

| Sent | Never sent |
|---|---|
| Plan catalog, engine-computed estimates, usage aggregates, redacted customer chat text | Customer names, emails, account IDs, payment details, session tokens, merchant secrets, individual cohort rows |

---

## Should pricing use a trained ML model, fine-tuned periodically?

**Not for computing prices.** Prices, caps and bills must stay deterministic, auditable formulas that the merchant approved and the customer consented to. A model that outputs prices would be hard to explain, can drift, and becomes individualized pricing (a PRD non-goal with legal risk). The **inputs** to pricing decisions, however, are exactly where ML belongs once there is enough data:

| What to learn | Today | With data (ML) | Retrain |
|---|---|---|---|
| Future usage per customer | Holt + seasonality per customer | One model across all customers (e.g. gradient-boosted trees or a global time-series model) using usage history, tenure, seasonality and plan; quantile outputs for low/high | Monthly; promote only if backtest error beats the current model |
| Churn propensity vs. price/value | Assumed `base_annual_churn`, `overpay_churn_sensitivity` | Survival / classification model on cancellations, calibrated so predicted ≈ observed | Monthly/quarterly |
| Adoption of recommendations | Assumed 35% | Measured directly from `recommendation_shown` → `plan_selected` events | Continuous |
| Acquisition uplift from flexible plans | Merchant's estimate | **Only an experiment can tell**: show flexible plans to a random X% of signups (holdout) | Per experiment |

The trained models plug into the same places the assumptions sit now: the forecaster and the simulator's assumptions. The **solver stays deterministic**, so every price recommendation is still explainable ("this cap keeps revenue ≥ today under the measured churn curve").

Two cautions:
- **Observational data is confounded.** Customers who chose PAYG differ from those who didn't. Price sensitivity (elasticity) must come from randomized experiments or bandits with guardrails, not from fitting historical choices.
- **"Fine-tuning" an LLM isn't needed** here. Claude only explains and proposes, and gets fresh facts in every prompt. The models worth retraining are the small, tabular ones above.

Suggested trigger for switching from assumptions to learned parameters: ~6+ months of usage history for a few thousand customers, a few hundred observed cancellations, and at least one completed holdout experiment.
