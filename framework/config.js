import 'dotenv/config';

const env = process.env;

export const config = {
  port: Number(env.PORT || 4000),
  publicBaseUrl: env.PUBLIC_BASE_URL || `http://localhost:${env.PORT || 4000}`,
  paypal: {
    clientId: env.PAYPAL_CLIENT_ID || '',
    clientSecret: env.PAYPAL_CLIENT_SECRET || '',
    env: env.PAYPAL_ENV === 'live' ? 'live' : 'sandbox',
    webhookId: env.PAYPAL_WEBHOOK_ID || '',
    get mode() {
      return this.clientId && this.clientSecret ? this.env : 'disabled';
    },
    get apiBase() {
      return this.env === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
    },
  },
  cache: {
    // Safety-net TTL for per-customer snapshots; event-driven invalidation does the real work.
    snapshotTtlMs: Number(env.FLEXPRICE_SNAPSHOT_TTL_MS || 6 * 3600_000),
  },
  ai: {
    apiKey: env.ANTHROPIC_API_KEY || '',
    model: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
    timeoutMs: Number(env.AI_TIMEOUT_MS || 12000),
    get enabled() {
      return Boolean(this.apiKey);
    },
  },
};
