const assert = require('node:assert/strict');
const { chromium, webkit } = require('playwright');
const { spawn } = require('node:child_process');
const { waitForSaveToSettle } = require('./test-helpers');
const PORT = 8838, BASE = 'http://127.0.0.1:' + PORT + '/WayPoint';
const fixture = { tripId: 'timezone-trip', name: 'Timezone test', startDate: '2026-10-06', endDate: '2026-10-08', homeCurrency: 'GBP', currencyRates: {}, companions: [], contacts: [], expenses: [], activities: [], destinations: [], accommodation: [], transport: [] };
async function run(engine, label, timezoneId) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({ timezoneId, viewport: { width: 390, height: 844 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    assert((await page.request.post(BASE + '/api/login', { data: { username: 'admin', password: 'testpass123' } })).ok());
    await page.goto(BASE);
    assert((await page.request.post(BASE + '/api/data', { data: { trips: [fixture] } })).ok());
    await page.reload();
    await page.locator('[data-action="open-trip"][data-id="timezone-trip"]').click();
    await page.evaluate(() => openTransportForm(state.trips[0], null, { mode: 'Flight', fromLocation: 'ICN', toLocation: 'SFO', departDate: '2026-10-07', departTime: '18:00', arriveDate: '2026-10-07', arriveTime: '11:00' }));
    const duration = page.locator('[data-journey-duration]');
    await page.waitForFunction(() => document.querySelector('[name="departDate"]')._dateDisplay);
    assert.equal(await duration.textContent(), '9 hours');
    assert.equal(await page.locator('[name="departDate"]').evaluate(el => el._dateDisplay.value), '07/Oct/2026');
    assert.equal(await page.locator('[name="arriveDate"]').getAttribute('min'), null);
    // Use the visible, formatted text fields as a person would.
    const arrival = page.locator('.formatted-date').filter({ has: page.locator('[name="arriveDate"]') }).locator('input[type="text"]');
    await arrival.fill('06/Oct/2026'); await arrival.press('Tab');
    await page.locator('[name="departTime"]').fill('01:00');
    await page.locator('[name="arriveTime"]').fill('19:00');
    assert.equal(await duration.textContent(), '10 hours');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const response = page.waitForResponse(r => r.url() === BASE + '/api/data' && r.request().method() === 'POST');
    await page.locator('#entity-form button[type="submit"]').click();
    assert((await response).ok()); await waitForSaveToSettle(page);
    await page.reload(); await page.waitForFunction(() => state.trips[0]?.transport.length === 1);
    const saved = await page.evaluate(() => state.trips[0].transport[0]);
    assert.equal(saved.departTimezone, 'Asia/Seoul'); assert.equal(saved.arriveTimezone, 'America/Los_Angeles');
    assert.equal(saved.arriveDateTime, '2026-10-06T19:00');
    await page.evaluate(() => openTransportForm(state.trips[0], state.trips[0].transport[0]));
    assert.equal(await duration.textContent(), '10 hours');
    await page.locator('[name="arriveTime"]').fill('01:00');
    assert.match(await duration.textContent(), /before departure/);
    await page.locator('#entity-form button[type="submit"]').click();
    assert.equal(await page.locator('#entity-form').count(), 1);
    // Invalid dates remain visible and invalid after another field changes.
    await arrival.fill('31/Feb/2026');
    await page.locator('[name="arriveTime"]').fill('19:00');
    assert.equal(await arrival.inputValue(), '31/Feb/2026');
    assert.equal(await arrival.evaluate(el => el.validity.valid), false);
    await arrival.fill('06/Oct/2026'); await arrival.press('Tab');
    // A changed location invalidates old coordinates and recomputes the zone.
    await page.locator('[name="toLocation"]').fill('JFK'); await page.locator('[name="toLocation"]').press('Tab');
    assert.match(await page.locator('[data-journey-local="end"]').textContent(), /America\/New_York/);
    // Explicit manual fallback for an unresolved location.
    await page.locator('[name="toLocation"]').fill('Unknown place'); await page.locator('[name="toLocation"]').press('Tab');
    assert.match(await duration.textContent(), /Select timezone/);
    await page.locator('summary', { hasText: /^Timezones$/ }).click();
    await page.locator('[name="arriveTimezoneOverride"]').fill('America/Los_Angeles');
    assert.equal(await duration.textContent(), '10 hours');
    await page.screenshot({ path: '/private/tmp/waypoint-timezones-' + label + '.png', fullPage: true });
    assert.deepEqual(errors, []);
    console.log(label + ' (' + timezoneId + '): formatted dates, location changes, validation, save/reopen passed');
  } finally { await browser.close(); }
}
(async () => {
  const server = spawn(process.execPath, ['mock-server.js', String(PORT)], { stdio: 'inherit' });
  try {
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(BASE)).ok()) break; } catch (_) {}
      await new Promise(r => setTimeout(r, 100));
    }
    await run(chromium, 'chromium', 'Europe/London');
    await run(webkit, 'webkit', 'Pacific/Auckland');
  } finally { server.kill('SIGTERM'); }
})().catch(error => { console.error(error); process.exitCode = 1; });
