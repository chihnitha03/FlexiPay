// Merchant registry: one entry per tenant. Production deployments load registrations from a
// JSON file / database (see loadMerchantsFromFile); the demo registers its mock merchants in code.

import fs from 'node:fs';
import { AdapterGateway } from './adapters/gateway.js';
import { HttpAdapter } from './adapters/http-adapter.js';
import { StaticCatalogAdapter } from './adapters/static-catalog-adapter.js';
import { resolvePolicy } from './core/policy-engine.js';

/**
 * @typedef {object} MerchantRegistration
 * @property {string} id
 * @property {string} name
 * @property {object} adapter            any object implementing the adapter contract
 * @property {string} widgetSecret       HMAC secret the merchant backend uses to sign widget sessions
 * @property {string} adminApiKey        key the merchant uses for the merchant API
 * @property {string} [integration]      label shown in the dashboard
 * @property {object} [policy]           overrides for DEFAULT_POLICY
 * @property {{brand_name?: string}} [paypal]
 * @property {string} [validationCustomerRef] sample customer for conformance checks
 * @property {{url: string|(() => string), secret: string}} [events] merchant endpoint for signed event webhooks
 */
export function buildRegistry(registrations) {
  const map = new Map();
  for (const r of registrations) {
    for (const k of ['id', 'name', 'adapter', 'widgetSecret', 'adminApiKey']) {
      if (!r[k]) throw new Error(`Merchant registration '${r.id ?? '?'}' is missing '${k}'`);
    }
    if (map.has(r.id)) throw new Error(`Duplicate merchant id '${r.id}'`);
    map.set(r.id, {
      integration: 'custom',
      paypal: { brand_name: r.name },
      ...r,
      policy: resolvePolicy(r.policy),
      gateway: new AdapterGateway(r.id, r.adapter),
    });
  }
  return map;
}

/**
 * Load registrations from JSON. Secrets are referenced by environment variable name, never stored
 * in the file:
 * [{ "id": "acme", "name": "Acme", "adapter": { "type": "http", "base_url": "https://acme/api",
 *    "api_key_env": "ACME_ADAPTER_KEY" }, "widget_secret_env": "ACME_WIDGET_SECRET",
 *    "admin_api_key_env": "ACME_FLEXPRICE_KEY", "policy": {...} }]
 */
export function loadMerchantsFromFile(file, env = process.env) {
  const secret = (name, field) => {
    const v = env[name];
    if (!v) throw new Error(`Environment variable ${name} (for ${field}) is not set`);
    return v;
  };
  return JSON.parse(fs.readFileSync(file, 'utf8')).map((m) => {
    let adapter;
    if (m.adapter.type === 'http') adapter = new HttpAdapter({ baseUrl: m.adapter.base_url, apiKey: secret(m.adapter.api_key_env, 'adapter.api_key_env') });
    else if (m.adapter.type === 'static') adapter = new StaticCatalogAdapter({ manifest: m.adapter.manifest, plans: m.adapter.plans });
    else throw new Error(`Unsupported adapter type '${m.adapter.type}' for ${m.id}`);
    return {
      id: m.id,
      name: m.name,
      integration: m.adapter.type === 'http' ? 'http-adapter' : 'static-catalog',
      adapter,
      widgetSecret: secret(m.widget_secret_env, 'widget_secret_env'),
      adminApiKey: secret(m.admin_api_key_env, 'admin_api_key_env'),
      policy: m.policy,
      paypal: m.paypal,
      validationCustomerRef: m.validation_customer_ref,
      events: m.events?.url ? { url: m.events.url, secret: secret(m.events.secret_env, 'events.secret_env') } : undefined,
    };
  });
}
