// Per-customer snapshot cache: the merchant data FlexPrice needs (customer context, monthly usage
// history) plus the precomputed default recommendation and its explanation.
//
// Why: the deterministic engine costs ~0.05 ms per customer; the expensive parts of "view plans"
// are network calls to the merchant backend and LLM calls. Snapshots let a view be served without
// either, and are invalidated by events that actually change the answer (plan change, month close,
// catalog change, usage crossing a break-even point) instead of being recomputed on every event.
//
// In-memory LRU with TTL for a single process. In production, back this interface with Redis or
// another shared store so all API instances see the same snapshots.

export class SnapshotCache {
  constructor({ ttlMs = 6 * 3600_000, max = 100_000 } = {}) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.map = new Map();
    this.stats = { hits: 0, misses: 0, invalidations: 0, precomputed: 0 };
  }

  #key(merchantId, customerRef) {
    return `${merchantId}:${customerRef}`;
  }

  get(merchantId, customerRef) {
    const k = this.#key(merchantId, customerRef);
    const e = this.map.get(k);
    if (!e || e.expires_at < Date.now()) {
      if (e) this.map.delete(k);
      this.stats.misses += 1;
      return null;
    }
    // LRU: re-insert to mark as most recently used
    this.map.delete(k);
    this.map.set(k, e);
    this.stats.hits += 1;
    return e;
  }

  set(merchantId, customerRef, patch) {
    const k = this.#key(merchantId, customerRef);
    const prev = this.map.get(k);
    const e = { ...(prev && prev.expires_at >= Date.now() ? prev : {}), ...patch, expires_at: Date.now() + this.ttlMs };
    this.map.delete(k);
    this.map.set(k, e);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
    return e;
  }

  invalidate(merchantId, customerRef) {
    if (this.map.delete(this.#key(merchantId, customerRef))) this.stats.invalidations += 1;
  }

  /** Mark the recommendation stale but keep the (still valid) merchant data. */
  markStale(merchantId, customerRef, reason) {
    const e = this.map.get(this.#key(merchantId, customerRef));
    if (e?.recommendation) {
      e.stale = reason;
      this.stats.invalidations += 1;
    }
  }

  info() {
    return { ...this.stats, entries: this.map.size, ttl_ms: this.ttlMs };
  }
}
