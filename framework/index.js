// FlexPrice AI framework — the part merchants deploy / integrate with.
//
//   import { createFlexPrice } from 'flexprice-ai';
//   const { app } = createFlexPrice({ merchants: [ ...registrations ] });
//   app.listen(4000);
//
// Exposes: Widget API (/api/v1/widget/:merchant), Merchant API (/api/v1/merchant),
// PayPal webhooks (/webhooks/paypal), the embeddable widget (/widget/flexprice-widget.js),
// the merchant dashboard (/dashboard/) and the PayPal return page (/checkout/return.html).
// Nothing demo-specific lives here: mock merchants and the PayPal simulator are in /demo.

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as defaultConfig } from './config.js';
import { Store } from './core/store.js';
import { UsageLedger } from './core/usage-ledger.js';
import { buildRegistry } from './registry.js';
import { Advisor } from './ai/advisor.js';
import { PayPalClient } from './paypal/client.js';
import { PricingService } from './services/pricing-service.js';
import { BillingService } from './services/billing-service.js';
import { InsightsService } from './services/insights-service.js';
import { SnapshotCache } from './core/snapshot-cache.js';
import { EventService } from './services/event-service.js';
import { widgetApi } from './routes/widget-api.js';
import { merchantApi } from './routes/merchant-api.js';
import { webhookRoutes } from './routes/webhooks.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function rateLimit({ windowMs, max }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const h = (hits.get(req.ip) || []).filter((t) => now - t < windowMs);
    h.push(now);
    hits.set(req.ip, h);
    if (h.length > max) return res.status(429).json({ error: 'too many requests' });
    next();
  };
}

function defaultPayPal(config) {
  if (!config.paypal.clientId || !config.paypal.clientSecret) return null;
  return new PayPalClient({ clientId: config.paypal.clientId, clientSecret: config.paypal.clientSecret, apiBase: config.paypal.apiBase, webhookId: config.paypal.webhookId });
}

/**
 * @param {object} opts
 * @param {import('./registry.js').MerchantRegistration[]} opts.merchants
 * @param {object} [opts.config]
 * @param {Store} [opts.store]
 * @param {object|((ctx: {deliverWebhook: Function}) => object)} [opts.paypal]
 *        PayPal client override (instance or factory). Defaults to the real REST client when
 *        credentials are configured; otherwise payments are disabled (advice still works).
 * @param {typeof fetch} [opts.fetchImpl] fetch used for the Claude API (tests)
 * @param {(app: express.Express, services: object) => void} [opts.extend]
 *        mount extra routes before the error handler (used by the demo)
 */
export function createFlexPrice({ merchants, config = defaultConfig, store = new Store(), paypal, fetchImpl, extend } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');

  const registry = buildRegistry(merchants ?? []);
  const ledger = new UsageLedger(store);
  const advisor = new Advisor({ config, fetchImpl });
  const cache = new SnapshotCache({ ttlMs: config.cache?.snapshotTtlMs });
  const pricing = new PricingService({ registry, store, advisor, ledger, cache });
  let billing;
  const deliverWebhook = (headers, event) => billing.handleWebhook(headers, event);
  const paypalClient = typeof paypal === 'function' ? paypal({ deliverWebhook }) : paypal ?? defaultPayPal(config);
  const events = new EventService({ store, registry });
  pricing.events = events;
  billing = new BillingService({ pricing, store, paypal: paypalClient, ledger, config, events });
  const insights = new InsightsService({ pricing, advisor, store });
  const services = { registry, store, ledger, advisor, pricing, billing, insights, events, paypal: paypalClient, config };

  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin' });
    next();
  });
  // Keep the raw body: signature verification (webhooks) must hash the exact bytes received.
  app.use(express.json({ limit: '256kb', verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); } }));

  // Widget API is embeddable on merchant domains; auth is a header token, never cookies.
  app.use('/api/v1/widget', (req, res, next) => {
    res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-FlexPrice-Session', 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS' });
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use('/api/v1/widget/:merchantId/chat', rateLimit({ windowMs: 60_000, max: 30 }));
  app.use('/api/v1/widget/:merchantId', rateLimit({ windowMs: 60_000, max: 240 }), widgetApi(services));
  app.use('/api/v1/merchant', merchantApi(services));
  app.use('/webhooks', webhookRoutes(services));
  app.get('/api/v1/health', (_req, res) =>
    res.json({ ok: true, paypal_mode: billing.paymentsMode, ai_enabled: advisor.enabled, ai_model: advisor.enabled ? config.ai.model : null, merchants: [...registry.keys()] }),
  );
  app.use(express.static(path.join(here, 'public'), { extensions: ['html'] }));

  extend?.(app, services);

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status >= 500 && status !== 503) console.error(`[${req.method} ${req.originalUrl}]`, err);
    res.status(status).json({ error: status >= 500 && !err.status ? 'internal error' : err.message, details: err.details ?? err.reasons ?? undefined, debug_id: err.debugId ?? undefined });
  });

  return { app, services };
}

export { Store } from './core/store.js';
export { HttpAdapter } from './adapters/http-adapter.js';
export { StaticCatalogAdapter } from './adapters/static-catalog-adapter.js';
export { CAPABILITY_METHODS } from './adapters/contract.js';
export { loadMerchantsFromFile } from './registry.js';
export { signSession } from './core/session-token.js';
export { EVENT_TYPES } from './services/event-service.js';
