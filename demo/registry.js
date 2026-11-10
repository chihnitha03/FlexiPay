// DEMO ONLY — registers the three mock merchants with the framework. A real deployment replaces
// this file with registrations loaded from config (framework/registry.js → loadMerchantsFromFile).

import { HttpAdapter } from '../framework/adapters/http-adapter.js';
import { CodeCloudAdapter } from './merchants/codecloud-adapter.js';
import { learnhubAdapter } from './merchants/learnhub-catalog.js';
import { STREAMFLIX } from './merchants/streamflix-backend.js';

/** Returns { merchants: MerchantRegistration[], demoCustomers: {merchantId: () => Promise<[]>} } */
export function demoMerchants({ selfBaseUrl }) {
  const codecloud = new CodeCloudAdapter();
  const merchants = [
    {
      id: 'streamflix',
      name: 'StreamFlix',
      integration: 'http-adapter',
      // StreamFlix is a separate backend reached over HTTP, exactly like a real merchant.
      adapter: new HttpAdapter({ baseUrl: () => `${selfBaseUrl()}/mock-merchants/streamflix`, apiKey: STREAMFLIX.adapterApiKey }),
      widgetSecret: STREAMFLIX.widgetSecret,
      adminApiKey: STREAMFLIX.flexpriceApiKey,
      policy: { cap_reached_behavior: 'stop_billing', retention: { discount_percent: 25, discount_months: 2 }, plan_change: { min_days_between_changes: 14 } },
      paypal: { brand_name: 'StreamFlix' },
      validationCustomerRef: 'sf-1001',
      // StreamFlix receives signed FlexPrice events (invoices, renewals, savings nudges) here.
      events: { url: () => `${selfBaseUrl()}/mock-merchants/streamflix/hooks/flexprice`, secret: STREAMFLIX.eventsSecret },
    },
    {
      id: 'codecloud',
      name: 'CodeCloud API',
      integration: 'sdk-adapter',
      adapter: codecloud,
      widgetSecret: process.env.CODECLOUD_WIDGET_SECRET || 'cc_widget_demo_secret',
      adminApiKey: process.env.CODECLOUD_FLEXPRICE_KEY || 'cc_admin_demo_key',
      policy: { cap_reached_behavior: 'require_approval', retention: { allow_pause: false, discount_percent: 15 } },
      paypal: { brand_name: 'CodeCloud' },
      validationCustomerRef: 'acct_9001',
    },
    {
      id: 'learnhub',
      name: 'LearnHub Academy',
      integration: 'static-catalog',
      adapter: learnhubAdapter(),
      widgetSecret: process.env.LEARNHUB_WIDGET_SECRET || 'lh_widget_demo_secret',
      adminApiKey: process.env.LEARNHUB_FLEXPRICE_KEY || 'lh_admin_demo_key',
      policy: { retention: { enabled: false } },
      paypal: { brand_name: 'LearnHub Academy' },
    },
  ];
  const demoCustomers = {
    streamflix: async () => (await fetch(`${selfBaseUrl()}/mock-merchants/streamflix/site/accounts`)).json(),
    codecloud: async () => codecloud.demoCustomers(),
    learnhub: async () => [],
  };
  return { merchants, demoCustomers };
}
