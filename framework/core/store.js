// Tenant-isolated state store. Every collection is partitioned by merchant ID so one merchant
// can never read another merchant's data. In-memory with optional JSON snapshot persistence;
// swap for Postgres/Redis in production without changing callers.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const COLLECTIONS = ['audit', 'consents', 'offers', 'usage_events', 'invoices', 'checkouts', 'metrics', 'plan_changes', 'recommendations', 'payment_methods', 'insights', 'events', 'subscriptions', 'credits'];

export class Store {
  constructor({ persistPath = null } = {}) {
    this.persistPath = persistPath;
    this.tenants = new Map();
    this.idempotency = new Map(); // `${merchant}:${key}` -> { status, result }
    this.webhookEvents = new Set();
    if (persistPath && fs.existsSync(persistPath)) this.#load();
  }

  tenant(merchantId) {
    if (!merchantId) throw new Error('merchantId is required');
    if (!this.tenants.has(merchantId)) {
      this.tenants.set(merchantId, Object.fromEntries(COLLECTIONS.map((c) => [c, []])));
    }
    return this.tenants.get(merchantId);
  }

  insert(merchantId, collection, doc) {
    const row = { id: doc.id ?? `${collection.slice(0, 3)}_${crypto.randomUUID().slice(0, 12)}`, created_at: new Date().toISOString(), ...doc };
    this.tenant(merchantId)[collection].push(row);
    this.#persist();
    return row;
  }

  find(merchantId, collection, predicate = () => true) {
    return this.tenant(merchantId)[collection].filter(predicate);
  }

  findOne(merchantId, collection, predicate) {
    return this.tenant(merchantId)[collection].find(predicate) ?? null;
  }

  update(merchantId, collection, id, patch) {
    const row = this.findOne(merchantId, collection, (r) => r.id === id);
    if (!row) return null;
    Object.assign(row, patch, { updated_at: new Date().toISOString() });
    this.#persist();
    return row;
  }

  audit(merchantId, type, data = {}) {
    return this.insert(merchantId, 'audit', { type, ...data });
  }

  metric(merchantId, name, data = {}) {
    return this.insert(merchantId, 'metrics', { name, ...data });
  }

  /**
   * Run `fn` at most once per idempotency key. Concurrent duplicates await the first result;
   * completed duplicates replay the stored result (PRD §6.3).
   */
  async idempotent(merchantId, key, fn) {
    const k = `${merchantId}:${key}`;
    const existing = this.idempotency.get(k);
    if (existing) return existing.promise ?? existing.result;
    const promise = (async () => fn())();
    this.idempotency.set(k, { promise });
    try {
      const result = await promise;
      this.idempotency.set(k, { result });
      return result;
    } catch (err) {
      this.idempotency.delete(k); // failures may be retried
      throw err;
    }
  }

  /** Returns true the first time an event ID is seen. */
  markWebhookProcessed(eventId) {
    if (this.webhookEvents.has(eventId)) return false;
    this.webhookEvents.add(eventId);
    this.#persist();
    return true;
  }

  #persist() {
    if (!this.persistPath) return;
    clearTimeout(this._t);
    this._t = setTimeout(() => {
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
      const snapshot = {
        tenants: Object.fromEntries(this.tenants),
        webhookEvents: [...this.webhookEvents],
        idempotency: Object.fromEntries([...this.idempotency].filter(([, v]) => 'result' in v)),
      };
      fs.writeFileSync(this.persistPath, JSON.stringify(snapshot));
    }, 50);
  }

  #load() {
    try {
      const s = JSON.parse(fs.readFileSync(this.persistPath, 'utf8'));
      for (const [k, v] of Object.entries(s.tenants || {})) this.tenants.set(k, { ...Object.fromEntries(COLLECTIONS.map((c) => [c, []])), ...v });
      (s.webhookEvents || []).forEach((e) => this.webhookEvents.add(e));
      for (const [k, v] of Object.entries(s.idempotency || {})) this.idempotency.set(k, v);
    } catch {
      /* corrupt snapshot: start fresh */
    }
  }
}
