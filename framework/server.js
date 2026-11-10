// Production entry point: FlexPrice only, no demo merchants or simulators.
//   FLEXPRICE_MERCHANTS_FILE=./merchants.json node framework/server.js

import path from 'node:path';
import { config } from './config.js';
import { createFlexPrice, loadMerchantsFromFile } from './index.js';
import { Store } from './core/store.js';

const file = process.env.FLEXPRICE_MERCHANTS_FILE;
if (!file) {
  console.error('Set FLEXPRICE_MERCHANTS_FILE to a merchant registrations JSON file (see docs/FRAMEWORK.md).');
  process.exit(1);
}
const store = new Store({ persistPath: process.env.FLEXPRICE_PERSIST_PATH ? path.resolve(process.env.FLEXPRICE_PERSIST_PATH) : null });
const { app, services } = createFlexPrice({ merchants: loadMerchantsFromFile(file), config, store });
services.events.start(15_000); // retry undelivered merchant webhooks
app.listen(config.port, () => {
  console.log(`FlexPrice AI listening on ${config.publicBaseUrl} · merchants: ${[...services.registry.keys()].join(', ')} · payments: ${services.billing.paymentsMode} · AI: ${services.advisor.enabled ? config.ai.model : 'fallback'}`);
});
