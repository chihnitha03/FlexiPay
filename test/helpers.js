import { createDemoApp } from '../demo/app.js';
import { createFlexPrice } from '../framework/index.js';
import { Store } from '../framework/core/store.js';

const baseConfig = (overrides = {}) => ({
  port: 0,
  publicBaseUrl: 'http://127.0.0.1',
  paypal: { mode: 'disabled', clientId: '', clientSecret: '', webhookId: '' },
  ai: { enabled: false, apiKey: '', model: 'test', timeoutMs: 1000 },
  ...overrides,
});

async function listen(build) {
  let port;
  const config = baseConfig(build.config);
  const { app, services } = build.create({ config, selfBaseUrl: () => `http://127.0.0.1:${port}` });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  port = server.address().port;
  config.publicBaseUrl = `http://127.0.0.1:${port}`;
  if (services.paypal) services.paypal.publicBaseUrl = config.publicBaseUrl;
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, path, { body, token, key } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token && { 'X-FlexPrice-Session': token }), ...(key && { Authorization: `Bearer ${key}` }) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { base, call, services, close: () => new Promise((r) => server.close(r)) };
}

/** Full demo (framework + mock merchants + PayPal simulator). */
export function startTestServer(overrides = {}) {
  return listen({
    config: overrides.config,
    create: ({ config, selfBaseUrl }) => createDemoApp({ config, store: new Store(), selfBaseUrl, fetchImpl: overrides.fetchImpl }),
  });
}

/** Framework only, with caller-supplied merchant registrations. */
export function startFrameworkServer({ merchants, paypal, config } = {}) {
  return listen({ config, create: ({ config: c }) => createFlexPrice({ merchants, config: c, store: new Store(), paypal }) });
}
