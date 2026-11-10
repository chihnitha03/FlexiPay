// DEMO ONLY — composes the FlexPrice framework with simulation pieces:
//   • three mock merchants (demo/registry.js, demo/merchants/*)
//   • an offline PayPal simulator (used when no PayPal credentials are configured)
//   • demo helper endpoints under /api/v1/demo (stand-ins for each merchant's own login system;
//     they expose demo API keys and must never exist in a real deployment)
//   • demo web pages (landing page, merchant sites)

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFlexPrice } from '../framework/index.js';
import { config as defaultConfig } from '../framework/config.js';
import { Store } from '../framework/core/store.js';
import { signSession } from '../framework/core/session-token.js';
import { demoMerchants } from './registry.js';
import { streamflixRouter } from './merchants/streamflix-backend.js';
import { PayPalSimulator } from './paypal-simulator/simulator.js';
import { paypalSimRouter } from './paypal-simulator/routes.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function createDemoApp({ config = defaultConfig, store = new Store(), selfBaseUrl = () => config.publicBaseUrl, fetchImpl } = {}) {
  const { merchants, demoCustomers } = demoMerchants({ selfBaseUrl });
  const useSimulator = !(config.paypal.clientId && config.paypal.clientSecret);
  let simulator = null;

  return createFlexPrice({
    merchants,
    config,
    store,
    fetchImpl,
    paypal: useSimulator ? ({ deliverWebhook }) => (simulator = new PayPalSimulator({ publicBaseUrl: config.publicBaseUrl, webhookSink: deliverWebhook })) : undefined,
    extend(app, services) {
      services.simulator = simulator;
      services.demoCustomers = demoCustomers;

      app.use('/mock-merchants/streamflix', streamflixRouter());
      if (simulator) app.use('/paypal-sim', paypalSimRouter(simulator));

      const demo = express.Router();
      demo.get('/merchants', (_req, res) => res.json(merchants.map((m) => ({ id: m.id, name: m.name, integration: m.integration, admin_api_key: m.adminApiKey }))));
      demo.get('/:merchantId/customers', async (req, res) => {
        const list = demoCustomers[req.params.merchantId];
        if (!list) return res.status(404).json({ error: 'unknown merchant' });
        res.json(await list());
      });
      demo.post('/:merchantId/session', async (req, res) => {
        const m = services.registry.get(req.params.merchantId);
        const customers = m ? await demoCustomers[m.id]() : [];
        if (!customers.some((c) => c.uid === req.body?.uid)) return res.status(404).json({ error: 'unknown demo customer' });
        res.json({ token: signSession({ merchantId: m.id, customerRef: req.body.uid }, m.widgetSecret) });
      });
      app.use('/api/v1/demo', demo);
      app.use(express.static(path.join(here, 'public'), { extensions: ['html'] }));
    },
  });
}
