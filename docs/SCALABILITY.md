# Scalability & deployment

## 1. What actually costs time on "view plans"

Measured on this codebase (one core, local machine):

| Step | Cost | Notes |
|---|---|---|
| Forecast + price all plans + recommend (deterministic engine) | **~0.05 ms per customer** (~20,000 customers/s/core) | Pure functions, no I/O. Not the bottleneck |
| Fetch customer context + 24-month usage from the merchant | 2 network calls; ~5 ms on localhost, typically 20–200 ms across networks, plus merchant DB load | **The real cost** |
| Claude explanation | ~1–3 s and a per-token cost | Optional; never blocks prices |

So the design goal isn't to make the engine faster. It's to **avoid repeated merchant round-trips and LLM calls**.

### Before vs. after this revision (1 view + 20 slider moves)

| | Before | After |
|---|---|---|
| Merchant (adapter) calls | 2 per request → ~42 | **2 on the first view, then 0** |
| Analytics rows written | 21 (one per slider move) | **1** (the view) |
| Claude calls (if enabled) | 1 per view + 1 per slider move | **≤ 1 per customer snapshot**; what-ifs use the template unless the customer clicks "Explain this with AI" |

## 2. Serving model: "compute cheap things on read, cache expensive inputs, invalidate on events"

| Request type | How it's served |
|---|---|
| **View plans** (default: history-based, balanced) | **Precomputed snapshot** per customer: forecast, recommendation, break-even thresholds and explanation. Built lazily on first view or in bulk via `POST /api/v1/merchant/precompute` |
| **What-if** (slider, preference, chat) | Computed on the fly from cached merchant data. At 0.05 ms, caching what-ifs would cost more than computing them |
| **Explanation** | Generated at most once per snapshot; template for what-ifs; AI on demand |

Snapshots live in `SnapshotCache` (`framework/core/snapshot-cache.js`): an in-memory LRU with a TTL safety net (`FLEXPRICE_SNAPSHOT_TTL_MS`, default 6 h). In production, back the same interface with Redis so every API instance shares it.

### When is a snapshot recomputed? Only when the answer can change

| Trigger | Mechanism |
|---|---|
| Customer changes plan through FlexPrice | `BillingService` invalidates after a verified plan change |
| Retention action (pause / discount / cancel) | Invalidated after the response is sent |
| Billing month closes | `closePeriod` invalidates: a new month of history exists |
| Merchant changes something outside FlexPrice | Merchant calls `POST /api/v1/merchant/customers/:ref/invalidate` |
| Plan catalog changes | Each snapshot stores a catalog version (hash); a mismatch triggers recompute on next view |
| Live usage crosses a break-even point | See below |
| Safety net | TTL |

### Should we recompute every time the customer watches something? No.

Usage events are frequent (many per day). The recommendation only changes when monthly usage moves **across a break-even point** between two plans: for StreamFlix that's 16.6 h, 22.2 h, 24.1 h, 26.6 h and 30 h. So for each usage event FlexPrice:

1. records the event (deduplicated, O(1)), and
2. projects this month's usage (month-to-date ÷ fraction of month elapsed; waits for 7+ days of data) and compares it with the snapshot's thresholds. That's a handful of comparisons, with **no recomputation and no merchant calls**.

Only if the projection lands on the other side of a threshold from the forecast is the snapshot marked **stale**. It's then recomputed on the next view (or by the next precompute batch), and the live projection is folded into the forecast. An audit event `recommendation_stale` records why. That same event is the natural hook for a proactive "you'd save $X on Pay-As-You-Watch" email.

Typical cost per customer per month: a few hundred O(1) checks, about 1 recompute at month close, and 0–1 extra recompute on a threshold crossing.

## 3. Who runs FlexPrice? Deployment models

| Model | Who operates it | Data flow | Best for |
|---|---|---|---|
| **A. Self-hosted service (recommended for large merchants)** | The merchant, inside its own VPC/Kubernetes (`npm run start:framework`, stateless, horizontally scalable) | Adapter calls stay on the internal network; the widget is served from the merchant's domain via reverse proxy (`/flexprice/*`); only PayPal and (optionally) Anthropic calls leave the network | Netflix/Prime scale, strict data residency, lowest latency |
| **B. Embedded library** | The merchant, in-process | `import { forecastUsage, recommendPlan } from 'flexprice-ai/engine'`: pure functions, no I/O (enforced by `test/scaling.test.js`). The merchant's own plans page computes recommendations with zero extra hops | Teams that only want the decision engine, or batch jobs over millions of customers |
| **C. Hosted multi-tenant SaaS** | FlexPrice (or PayPal as a value-added service) | The merchant exposes the adapter over HTTPS (bearer key, mTLS/IP allow-list recommended); the browser calls the hosted Widget API | Small and mid-size merchants without an infra team |

On "should PayPal maintain it?": PayPal's natural role is **payments** (Orders, Vault, webhooks). FlexPrice is built so payments are the only part that must go to PayPal. Running the decision engine and customer data inside the merchant (models A/B) avoids sending usage data to a third party, external latency, and a new internet-facing attack surface. A PayPal-hosted version (model C) is possible as a product offering, but it requires a data-processing agreement, because merchant usage data would then flow to PayPal.

## 4. What a Netflix/Prime-scale deployment would add

FlexPrice's interfaces were chosen so each of these is a swap, not a rewrite:

| Concern | Here | At scale |
|---|---|---|
| State (`Store`) | In-memory / JSON snapshot | Postgres (sharded by merchant), same interface |
| Snapshots (`SnapshotCache`) | In-process LRU | Redis / Memcached cluster |
| Usage ingestion (`POST /merchant/usage`) | Synchronous, ≤500 per batch | Kafka/Kinesis topic → stream aggregator maintaining per-customer monthly counters → threshold check |
| Precompute | `POST /merchant/precompute` (≤1000 per call) | Nightly/month-close batch job over the customer table, writing a precomputed recommendations table that the plans page reads with one key lookup. The engine library (model B) can run inside Spark/Flink |
| Webhooks | Handled inline | Queue + workers with retries (idempotency is already in place) |
| Widget assets | Served by the service | CDN |
| AI | Per-snapshot explanation, cached | Template by default; AI on demand; bulk explanations through the Anthropic Message Batches API; or explanations per cohort/bucket instead of per customer |
| Rate limiting | Per-process | API gateway |

## 5. What is deterministic and what calls Claude

| Component | Calls an LLM? |
|---|---|
| Forecaster, pricing engine, recommender, policy engine, catalog simulator, pricing solver | **No.** Deterministic code (`framework/core/*`, also exported as `flexprice-ai/engine`) |
| Recommendation explanation | Claude (optional): receives ~1–2 KB of computed facts, returns 3–4 sentences |
| Chat advisor | Claude (optional): receives the redacted message; calls read-only engine tools |
| Pricing copilot | Claude (optional): receives aggregated histograms; calls the simulator tool |

Claude never receives raw usage logs for the customer base. It wouldn't forecast accurately from them, and it doesn't need to. Forecasting is statistics today, and a trained tabular model is the planned upgrade once there's enough data (see [AI.md](AI.md#should-pricing-use-a-trained-ml-model-fine-tuned-periodically)).
