// Regression test for the "Look up" flight-number button on the
// transport form. Runs against the mock server like test-deploy.js /
// test-map.js, but intercepts OUR OWN /WayPoint/api/flight-lookup
// endpoint (rather than the real AeroDataBox/RapidAPI) with canned
// responses — this test is only checking the frontend's side of the
// integration (button visibility per mode, requiring a depart date,
// populating fields on success, showing the right message on a
// not-found/error response). The real deployment's Worker is what
// actually talks to AeroDataBox with the RapidAPI key; that
// server-side proxying is exercised by reading src/worker.js, not by
// this browser test (this sandbox has no route to the real internet).
const { chromium } = require('playwright');
const { spawn } = require('child_process');

const PORT = 8792;

function waitForServer(url, tries) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      require('http').get(url, () => resolve()).on('error', () => {
        if (n <= 0) return reject(new Error('server never came up'));
        setTimeout(() => attempt(n - 1), 150);
      });
    };
    attempt(tries || 30);
  });
}

(async () => {
  const server = spawn('node', ['mock-server.js', String(PORT)], { cwd: __dirname, stdio: 'inherit' });
  try {
    await waitForServer('http://localhost:' + PORT + '/WayPoint');

    const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    // ---- Fake /WayPoint/api/flight-lookup responses (AeroDataBox-shaped, as reshaped by handleFlightLookup) ----
    await page.route('**/WayPoint/api/flight-lookup*', (route) => {
      const url = new URL(route.request().url());
      const fn = (url.searchParams.get('flightNumber') || '').toUpperCase();
      const date = url.searchParams.get('date') || '';
      if (fn === 'BA15' && date === '2027-04-05') {
        return route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({
            airline: 'British Airways',
            aircraft: 'Airbus A380-800',
            origin: { code: 'SIN', name: 'Singapore Changi Airport', municipality: 'Singapore' },
            destination: { code: 'SYD', name: 'Sydney Kingsford Smith International Airport', municipality: 'Sydney' },
            departure: { date: '2027-04-05', time: '23:35', terminal: '1', gate: 'B12' },
            arrival: { date: '2027-04-06', time: '11:05', terminal: 'T1', gate: '' },
            matchCount: 1
          })
        });
      }
      if (fn === 'ZZ999') {
        return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'No flight found for that number and date.' }) });
      }
      return route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'The flight lookup service had a problem — try again in a moment.' }) });
    });

    await page.goto('http://localhost:' + PORT + '/WayPoint');
    await page.waitForSelector('.empty-state, .trip-grid', { timeout: 5000 });
    await page.click('[data-action="new-trip"]');
    await page.fill('input[name="name"]', 'Flight Lookup Test');
    await page.fill('input[name="startDate"]', '2027-04-01');
    await page.fill('input[name="endDate"]', '2027-04-10');
    await page.fill('input[name="homeCurrency"]', 'GBP');
    await page.click('#entity-form button[type="submit"]');
    await page.waitForTimeout(150);

    // ---- Open the transport form (defaults to Flight mode) ----
    await page.click('[data-action="switch-tab"][data-tab="transport"]');
    await page.click('[data-action="new-transport"]');

    const lookupBtnVisibleOnFlight = await page.locator('[data-action="lookup-flight"]').count();
    console.log('1. "Look up" button present in Flight mode:', lookupBtnVisibleOnFlight === 1);

    // Empty flight number -> clicking shows a validation message, no request made
    await page.click('[data-action="lookup-flight"]');
    await page.waitForTimeout(100);
    let statusText = await page.locator('#flight-lookup-status').textContent();
    console.log('2. Clicking with no flight number shows a prompt:', /Type a flight number/.test(statusText));

    // Flight number but no depart date -> different validation message, still no request
    await page.fill('input[name="flightNumber"]', 'ba15');
    await page.click('[data-action="lookup-flight"]');
    await page.waitForTimeout(100);
    statusText = await page.locator('#flight-lookup-status').textContent();
    console.log('3. Clicking with no depart date shows a prompt:', /Depart date/.test(statusText));

    // Successful lookup -> fields populate, including times/arrival date
    await page.fill('input[name="departDate"]', '2027-04-05');
    await page.click('[data-action="lookup-flight"]');
    await page.waitForFunction(() => /Filled in from AeroDataBox/.test(document.getElementById('flight-lookup-status').textContent), { timeout: 5000 });
    const carrierVal = await page.locator('input[name="carrier"]').inputValue();
    const fromVal = await page.locator('input[name="fromLocation"]').inputValue();
    const toVal = await page.locator('input[name="toLocation"]').inputValue();
    const departTimeVal = await page.locator('input[name="departTime"]').inputValue();
    const arriveDateVal = await page.locator('input[name="arriveDate"]').inputValue();
    const arriveTimeVal = await page.locator('input[name="arriveTime"]').inputValue();
    console.log('4. Carrier filled in:', carrierVal === 'British Airways', carrierVal);
    console.log('5. From filled in:', fromVal === 'SIN — Singapore Changi Airport', fromVal);
    console.log('6. To filled in:', toVal === 'SYD — Sydney Kingsford Smith International Airport', toVal);
    console.log('7. Depart time filled in:', departTimeVal === '23:35', departTimeVal);
    console.log('8. Arrive date filled in (next day, overnight flight):', arriveDateVal === '2027-04-06', arriveDateVal);
    console.log('9. Arrive time filled in:', arriveTimeVal === '11:05', arriveTimeVal);
    const finalStatusText = await page.locator('#flight-lookup-status').textContent();
    console.log('10. Status mentions terminal/gate as FYI:', /terminal 1/.test(finalStatusText) && /gate B12/.test(finalStatusText), finalStatusText);

    // Not-found lookup -> error message, existing field values untouched
    await page.fill('input[name="flightNumber"]', 'zz999');
    await page.click('[data-action="lookup-flight"]');
    await page.waitForFunction(() => /No flight found/.test(document.getElementById('flight-lookup-status').textContent), { timeout: 5000 });
    const carrierValAfter404 = await page.locator('input[name="carrier"]').inputValue();
    console.log('11. Not-found shows the right error message: true');
    console.log('12. Carrier value unchanged after a not-found lookup:', carrierValAfter404 === 'British Airways');

    // ---- Switch to Car mode: button and status area should be gone ----
    await page.selectOption('select[name="mode"]', 'Car');
    await page.waitForTimeout(100);
    const lookupBtnCount = await page.locator('[data-action="lookup-flight"]').count();
    console.log('13. "Look up" button gone in Car mode:', lookupBtnCount === 0);
    const fromSuggestType = await page.locator('input[name="fromLocation"]').getAttribute('data-suggest-type');
    console.log('    From field back to city suggestions in Car mode:', fromSuggestType === 'city');

    console.log('\nPage errors:', errors.length ? errors : 'NONE');
    await browser.close();
  } finally {
    server.kill();
  }
})();
