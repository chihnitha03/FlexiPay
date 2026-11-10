// Serving-path behaviour: caching, precompute, event-driven invalidation, and the engine library.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestServer } from './helpers.js';
import { projectMonth } from '../framework/services/pricing-service.js';

let t;
before(async () => (t = await startTestServer()));
after(() => t.close());
const session = async (uid) => (await t.call('POST', '/api/v1/demo/streamflix/session', { body: { uid } })).body.token;
const W = '/api/v1/widget/streamflix';

test('view → precomputed snapshot; what-if slider moves make zero merchant calls and no analytics rows', async () => {
  const token = await session('sf-1003');
  const gw = t.services.registry.get('streamflix').gateway;
  const first = await t.call('POST', `${W}/recommend`, { token, body: { explain: false } });
  assert.equal(first.body.served.merchant_data, 'miss');
  assert.equal(first.body.served.recommendation, 'computed');

  const calls = gw.health.calls;
  const rows = t.services.store.find('streamflix', 'recommendations').length;
  const again = await t.call('POST', `${W}/recommend`, { token, body: { explain: false } });
  assert.equal(again.body.served.recommendation, 'precomputed');
  for (let u = 5; u <= 30; u += 5) {
    const r = await t.call('POST', `${W}/recommend`, { token, body: { monthly_usage: u, explain: 'template', record: false } });
    assert.equal(r.body.served.merchant_data, 'hit');
    assert.equal(r.body.explanation.source, 'template');
  }
  assert.equal(gw.health.calls - calls, 0, 'no adapter calls after the first view');
  assert.equal(t.services.store.find('streamflix', 'recommendations').length - rows, 1, 'only the view is recorded');
});

test('merchant can invalidate; precompute refreshes in bulk', async () => {
  const key = 'sf_admin_demo_key';
  await t.call('POST', '/api/v1/merchant/customers/sf-1003/invalidate', { key });
  const token = await session('sf-1003');
  const r = await t.call('POST', `${W}/recommend`, { token, body: { explain: false } });
  assert.equal(r.body.served.merchant_data, 'miss');
  const pre = await t.call('POST', '/api/v1/merchant/precompute', { key, body: { customer_refs: ['sf-1001', 'sf-1002', 'sf-1004'] } });
  assert.equal(pre.body.refreshed, 3);
  const r2 = await t.call('POST', `${W}/recommend`, { token: await session('sf-1002'), body: { explain: false } });
  assert.equal(r2.body.served.recommendation, 'precomputed');
  assert.equal(r2.body.served.merchant_data, 'hit');
});

test('usage events only mark the snapshot stale when a break-even point is crossed', () => {
  const pricing = t.services.pricing;
  const m = 'streamflix';
  // seed a snapshot with a known forecast and thresholds
  t.services.pricing.cache.set(m, 'sf-x', { customer: { customer_reference: 'sf-x' }, history: [], recommendation: { recommended_plan_id: 'SF-PAYG' }, forecast: { summary: { expected_monthly: 7 } }, thresholds: [16.6, 25], catalog_version: 'v', stale: null });
  const mid = new Date(Date.UTC(2026, 10, 15)); // day 15 of 30 → projection ×2
  assert.equal(pricing.onUsage(m, 'sf-x', { periodUsage: 5, now: mid }).stale, false); // projects 10/month: same band
  assert.equal(pricing.onUsage(m, 'sf-x', { periodUsage: 9, now: mid }).stale, true); // projects 18/month: crossed 16.6
  assert.match(pricing.cache.get(m, 'sf-x').stale, /crossed a break-even/);
});

test('month projection waits for enough days of data', () => {
  assert.equal(projectMonth(10, new Date(Date.UTC(2026, 10, 3))), null);
  assert.equal(projectMonth(10, new Date(Date.UTC(2026, 10, 15))), 20);
});

test('engine library is pure: no network, storage, LLM or framework service imports', async () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'framework');
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = fs.readFileSync(file, 'utf8');
    for (const [, spec] of src.matchAll(/from '([^']+)'/g)) {
      assert.ok(!/^node:(http|https|net|fs)|express|\/ai\/|\/paypal\/|\/services\/|store\.js/.test(spec), `${path.basename(file)} imports ${spec}`);
      if (spec.startsWith('.')) walk(path.resolve(path.dirname(file), spec));
    }
    assert.ok(!/\bfetch\(/.test(src), `${path.basename(file)} calls fetch`);
  };
  walk(path.join(dir, 'engine.js'));
  const engine = await import('../framework/engine.js');
  const plans = [{ plan_id: 'm', name: 'M', billing_model: 'fixed', base_price: 10 }, { plan_id: 'u', name: 'U', billing_model: 'usage', usage_metric: 'h', unit_price: 1, spending_cap: 12 }].map(engine.normalizePlan);
  const rec = engine.recommendPlan({ plans, forecast: engine.forecastUsage({ customerEstimate: 3 }) });
  assert.equal(rec.recommended_plan_id, 'u');
});
