// DEMO entry point: framework + mock merchants + PayPal simulator + demo pages.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../framework/config.js';
import { Store } from '../framework/core/store.js';
import { createDemoApp } from './app.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const store = new Store({ persistPath: process.env.FLEXPRICE_PERSIST === '1' ? path.join(here, '..', 'data', 'runtime', 'state.json') : null });
const { app, services } = createDemoApp({ config, store, selfBaseUrl: () => `http://127.0.0.1:${config.port}` });

services.events.start(5000); // retry undelivered merchant webhooks
app.listen(config.port, () => {
  console.log(`\n  FlexPrice AI — DEMO MODE at ${config.publicBaseUrl}`);
  console.log(`  • PayPal:  ${services.billing.paymentsMode}${services.simulator ? ' (offline simulator; set PAYPAL_CLIENT_ID/SECRET for sandbox)' : ''}`);
  console.log(`  • AI:      ${services.advisor.enabled ? `Claude (${config.ai.model})` : 'deterministic fallback (set ANTHROPIC_API_KEY for Claude)'}`);
  console.log(`  • Demo:    ${config.publicBaseUrl}/  |  Dashboard: ${config.publicBaseUrl}/dashboard/\n`);
});
