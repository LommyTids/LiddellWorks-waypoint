const assert = require('node:assert/strict');
const { chromium, webkit } = require('playwright');
const { spawn } = require('node:child_process');
const { waitForSaveToSettle } = require('./test-helpers');
const PORT = 8841, BASE = 'http://127.0.0.1:' + PORT + '/WayPoint';
const fixture = { tripId: 'plus-code-trip', name: 'Plus Code test', startDate: '2026-10-07', endDate: '2026-10-08', homeCurrency: 'GBP', currencyRates: {}, companions: [], contacts: [], expenses: [], activities: [], destinations: [], accommodation: [], transport: [] };
const hakone = { name: 'Hakone', formattedAddress: 'Hakone, Kanagawa, Japan', lat: 35.2324, lng: 139.1069 };
async function run(engine, label) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [], queries = []; let ambiguous = false;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    await page.route('**/api/location-search?*', route => {
      const query = new URL(route.request().url()).searchParams;
      queries.push(query.get('q'));
      assert.equal(query.get('lat'), null);
      return route.fulfill({ json: { results: ambiguous ? [hakone, { ...hakone, name: 'Other locality' }] : [hakone], attribution: { label: 'LocationIQ' } } });
    });
    assert((await page.request.post(BASE + '/api/login', { data: { username: 'admin', password: 'testpass123' } })).ok());
    await page.goto(BASE);
    assert((await page.request.post(BASE + '/api/data', { data: { trips: [fixture] } })).ok());
    await page.reload(); await page.locator('[data-action="open-trip"][data-id="plus-code-trip"]').click();
    await page.evaluate(() => openActivityForm(state.trips[0], null, { title: 'Hakone visit', startDate: '2026-10-07', endDate: '2026-10-07', allDay: true, address: 'Original venue address' }));
    const picker = page.locator('[data-location-picker]');
    await picker.locator('[data-action="toggle-location-input"]').click();
    assert.equal(await picker.locator('[data-location-reference-row]').isVisible(), false);
    await picker.locator('[data-location-input]').fill('7X4W+XH Hakone, Kanagawa, Japan');
    await picker.locator('[data-action="preview-location-input"]').click();
    await picker.locator('[data-location-candidate]').waitFor({ state: 'visible' });
    assert.match(await picker.locator('[data-location-candidate-label]').textContent(), /8Q7W7X4W\+XH.*Hakone/);
    assert.equal(await page.evaluate(() => state.trips[0].destinations.length), 0);
    assert.equal(await picker.locator('[name="addressLat"]').inputValue(), '');
    await page.screenshot({ path: '/private/tmp/waypoint-plus-code-' + label + '.png', fullPage: true });
    await picker.locator('[data-action="apply-location-input"]').click();
    assert.equal(await picker.locator('[name="address"]').inputValue(), 'Original venue address');
    assert.equal(Number(await picker.locator('[name="addressLat"]').inputValue()), 35.2574375);
    const response = page.waitForResponse(r => r.url() === BASE + '/api/data' && r.request().method() === 'POST');
    await page.locator('#entity-form button[type="submit"]').click();
    assert((await response).ok()); await waitForSaveToSettle(page);
    await page.reload(); await page.waitForFunction(() => state.trips[0]?.activities.length === 1);
    const saved = await page.evaluate(() => state.trips[0]);
    assert.equal(saved.destinations.length, 0); assert.equal(saved.activities[0].destinationId, '');
    assert.equal(saved.activities[0].addressLat, 35.2574375); assert.equal(saved.activities[0].addressLng, 138.9964375);
    assert.equal(saved.activities[0].address, 'Original venue address');
    await page.evaluate(() => openActivityForm(state.trips[0], state.trips[0].activities[0]));
    await picker.locator('[data-action="toggle-location-input"]').click();
    ambiguous = true;
    await picker.locator('[data-location-input]').fill('7X4W+XH Hakone');
    await picker.locator('[data-location-input]').press('Enter');
    await picker.locator('[data-action="select-plus-code-locality"]').first().waitFor({ state: 'visible' });
    assert.equal(await picker.locator('[data-location-candidate]').isVisible(), false);
    await picker.locator('[data-action="select-plus-code-locality"]').first().click();
    await picker.locator('[data-location-candidate]').waitFor({ state: 'visible' });
    assert.match(await picker.locator('[data-location-candidate-label]').textContent(), /8Q7W7X4W\+XH/);
    assert.deepEqual(queries, ['Hakone, Kanagawa, Japan', 'Hakone']);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    console.log(label + ': named short code without destinations, preview/apply/save/reopen, ambiguous locality selection passed');
  } finally { await browser.close(); }
}
(async () => {
  const server = spawn(process.execPath, ['mock-server.js', String(PORT)], { stdio: 'inherit' });
  try {
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(BASE)).ok()) break; } catch (_) {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await run(chromium, 'chromium'); await run(webkit, 'webkit');
  } finally { server.kill('SIGTERM'); }
})().catch(error => { console.error(error); process.exitCode = 1; });
