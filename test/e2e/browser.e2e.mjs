// Browser end-to-end walkthrough of the demo (widget + PayPal simulator + dashboard).
//   npm start            # in one terminal
//   npm run test:e2e     # in another (BASE_URL defaults to http://localhost:4000)
// Screenshots are written to test/e2e/screenshots/.

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const SHOTS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());
const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
const w = page.locator('flexprice-advisor');
const shot = (name, full = false) => page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: full });
let failed = 0;
const step = async (name, fn) => {
  try {
    await fn();
    console.log('✓', name);
  } catch (e) {
    failed += 1;
    console.log('✗', name, '—', e.message.split('\n')[0]);
    await shot(`FAIL-${name.replace(/\W+/g, '_')}`, true);
  }
};
const frame = () => page.frameLocator('flexprice-advisor >> iframe.pp');

await page.goto(`${BASE}/demo/site.html?m=streamflix&c=sf-1002`);
await step('widget loads with history-based recommendation', async () => {
  await w.locator('.plan').first().waitFor();
  await w.getByText('Why Standard Annual?').waitFor();
  await shot('1-streamflix', true);
});
await step('chat converts "2 movies a week" into usage', async () => {
  await w.locator('#chatin').fill('I watch maybe 2 movies a week');
  await w.locator('#chatform button').click();
  await w.locator('.msg.assistant').first().waitFor();
  await page.waitForTimeout(600);
  const v = await w.locator('#usage-val').innerText();
  if (!v.startsWith('17.3')) throw new Error(`usage not applied: ${v}`);
});
await step('annual plan paid with PayPal (server-side capture + verification)', async () => {
  await w.locator('[data-choose="SF-STD-Y"]').click();
  await w.locator('#agree').check();
  await w.locator('#ppsim').click();
  await frame().locator('button.pay').waitFor();
  await shot('2-paypal');
  await frame().locator('button.pay').click();
  await w.getByText("You're on").waitFor({ timeout: 8000 });
  await shot('3-success');
  await w.locator('#done').click();
});
await step('declined card leaves customer uncharged', async () => {
  await page.selectOption('#who', 'sf-1003');
  await w.locator('[data-choose="SF-STD-Y"]').click();
  await w.locator('#agree').check();
  await w.locator('#ppsim').click();
  await frame().locator('button.decline').click();
  await w.getByText('declined').waitFor({ timeout: 5000 });
});
await step('pay-as-you-watch: PayPal vaulted, usage metered, invoice auto-charged after notice', async () => {
  await page.selectOption('#who', 'sf-1001');
  await w.locator('[data-choose="SF-PAYG"]').click();
  await w.locator('#agree').check();
  await shot('4-vault-terms');
  await w.locator('#ppsim').click();
  await frame().getByText('Agree and Save').click();
  await w.getByText("You're on").waitFor({ timeout: 5000 });
  await w.locator('#done').click();
  await page.click('button[data-q="20"]');
  await page.click('button[data-q="20"]');
  await page.waitForTimeout(500);
  await page.click('#close');
  await w.getByText('Will be charged to your saved PayPal').waitFor({ timeout: 5000 });
  await shot('5-meter', true);
  await page.click('#runbill');
  await w.getByText(/invoice \$[\d.]+ paid/).waitFor({ timeout: 5000 });
  await page.locator('#inbox', { hasText: 'saved PayPal account' }).waitFor({ timeout: 5000 });
  await shot('5b-inbox', true);
});
await step('retention: alternatives and pause, no unearned discount', async () => {
  await page.selectOption('#who', 'sf-1004');
  await w.locator('[data-act="cancel"]').click();
  await w.getByText('Before you go').waitFor();
  await shot('6-retention');
  await w.locator('[data-ret="pause"]').click();
  await w.getByText('Paused until').waitFor();
  await w.locator('#done').click();
});
await step('CodeCloud and LearnHub load', async () => {
  await page.goto(`${BASE}/demo/site.html?m=codecloud`);
  await w.locator('.plan').first().waitFor();
  await shot('7-codecloud', true);
  await page.goto(`${BASE}/demo/site.html?m=learnhub`);
  await w.getByText('Not shown: Pay Per Lesson').waitFor();
});
await step('dashboard: sign in, validation, pricing insights', async () => {
  await page.goto(`${BASE}/dashboard/`);
  await page.locator('[data-k]').first().click();
  await page.locator('#validation b').waitFor();
  await page.click('#gen');
  await page.locator('.prop').first().waitFor();
  await page.waitForTimeout(300);
  await shot('8-dashboard', true);
});
await step('landing page', async () => {
  await page.goto(`${BASE}/`);
  await shot('0-landing', true);
});

await browser.close();
if (errors.length) console.log(errors.join('\n'));
console.log(failed ? `${failed} step(s) failed` : 'all browser steps passed');
process.exit(failed || errors.length ? 1 : 0);
