// LearnHub — an online-learning merchant using the zero-code static catalog integration.
// It lists a per-course metered plan, but because the integration declares no usage metering
// FlexPrice automatically hides that plan (capability gating, PRD §5.3).

import { StaticCatalogAdapter } from '../../framework/adapters/static-catalog-adapter.js';

export const learnhubAdapter = () =>
  new StaticCatalogAdapter({
    manifest: {
      merchant_id: 'learnhub',
      name: 'LearnHub Academy',
      vertical: 'education',
      usage: { metric: 'lessons', unit: 'lessons', label: 'lessons per month', default_monthly_usage: 8, slider_max: 60 },
      checkout_url: 'https://learnhub.example.com/checkout',
      branding: { primary: '#059669', logo_text: 'LearnHub' },
    },
    plans: [
      { plan_id: 'lh_monthly', name: 'All-Access Monthly', billing_model: 'fixed', billing_interval: 'month', base_price: 19, currency: 'USD', features: ['All courses', 'Certificates'], terms: { summary: '$19 billed monthly. Cancel anytime.' } },
      { plan_id: 'lh_annual', name: 'All-Access Annual', billing_model: 'fixed', billing_interval: 'year', base_price: 168, currency: 'USD', features: ['All courses', 'Certificates', 'Save 26%'], terms: { summary: '$168 billed annually.' } },
      { plan_id: 'lh_per_lesson', name: 'Pay Per Lesson', billing_model: 'usage', billing_interval: 'month', base_price: 0, unit_price: 1.5, usage_metric: 'lessons', unit: 'lessons', spending_cap: 25, currency: 'USD', features: ['Pay per lesson'], terms: { summary: '$1.50 per lesson, capped at $25.' } },
    ],
  });
