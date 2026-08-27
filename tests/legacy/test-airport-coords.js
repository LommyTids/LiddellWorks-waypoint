// Regression test for the "SFO – ICN doesn't resolve on the Map tab"
// bug report: a Flight leg between two airports in COMMON_AIRPORTS
// (data/airports.js) should place correctly on the map using the
// curated coordinate list, WITHOUT ever calling Nominatim — this test
// makes Nominatim fail every request, so if the leg still draws, the
// coordinate path (not the old free-text geocoding path) is what did
// it. Also covers the "additional API details get saved into Notes"
// fix, using the same flight-lookup mock pattern as
// test-flight-lookup.js.
const { chromium } = require('playwright');
const { spawn } = require('child_process');

const PORT = 8797;

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

    let nominatimCalls = 0;
    // Nominatim is made to fail every request — if any leg still shows
    // up on the map, it did NOT come from geocoding.
    await page.route('https://nominatim.openstreetmap.org/**', (route) => {
      nominatimCalls++;
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });
    const onePxPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    await page.route('https://*.tile.openstreetmap.org/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: onePxPng }));

    // ---- Flight lookup mock (AF275-shaped, includes aircraft/terminal/gate/location) ----
    await page.route('**/WayPoint/api/flight-lookup*', (route) => {
      const url = new URL(route.request().url());
      const fn = (url.searchParams.get('flightNumber') || '').toUpperCase();
      if (fn === 'AF999') {
        return route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({
            airline: 'Air France',
            aircraft: 'Boeing 777-300ER',
            origin: { code: 'CDG', name: 'Paris Charles de Gaulle', municipality: 'Paris', country: 'France', location: { lat: 49.0097, lng: 2.5479 } },
            // A small regional airport NOT in COMMON_AIRPORTS, so this
            // exercises the AeroDataBox-location fallback specifically.
            destination: { code: 'ZZZ', name: 'Somewhere Regional', municipality: 'Somewhereville', country: 'Nowhereland', location: { lat: 12.3456, lng: 65.4321 } },
            departure: { date: '2027-07-01', time: '10:00', terminal: '2E', gate: 'K34' },
            arrival: { date: '2027-07-01', time: '18:00', terminal: '', gate: '' },
            matchCount: 1
          })
        });
      }
      return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'No flight found for that number and date.' }) });
    });

    await page.goto('http://localhost:' + PORT + '/WayPoint');
    await page.waitForSelector('.empty-state, .trip-grid', { timeout: 5000 });
    await page.click('[data-action="new-trip"]');
    await page.fill('input[name="name"]', 'Airport Coords Test');
    await page.fill('input[name="startDate"]', '2027-07-01');
    await page.fill('input[name="endDate"]', '2027-07-10');
    await page.fill('input[name="homeCurrency"]', 'GBP');
    await page.click('#entity-form button[type="submit"]');
    await page.waitForTimeout(150);

    // ---- Leg 1: SFO -> ICN, typed exactly as the bug report — both are
    // in COMMON_AIRPORTS, so this should resolve via the static list. ----
    await page.click('[data-action="switch-tab"][data-tab="transport"]');
    await page.click('[data-action="new-transport"]');
    await page.fill('input[name="fromLocation"]', 'SFO');
    await page.fill('input[name="toLocation"]', 'ICN');
    await page.fill('input[name="departDate"]', '2027-07-02');
    await page.fill('input[name="arriveDate"]', '2027-07-03');
    await page.click('#entity-form button[type="submit"]');
    await page.waitForTimeout(100);

    const savedLeg1 = await page.evaluate(() => currentTrip().transport[0]);
    console.log('1. SFO fromLat saved:', savedLeg1.fromLat, typeof savedLeg1.fromLat === 'number');
    console.log('2. ICN toLat saved:', savedLeg1.toLat, typeof savedLeg1.toLat === 'number');

    // ---- Leg 2: use the flight-lookup button for a leg ending at an
    // airport NOT in COMMON_AIRPORTS, to exercise the AeroDataBox
    // location fallback (lastFlightLookupCoords). ----
    await page.click('[data-action="new-transport"]');
    await page.fill('input[name="flightNumber"]', 'af999');
    await page.fill('#flight-lookup-date', '2027-07-01');
    await page.click('[data-action="lookup-flight"]');
    await page.waitForFunction(() => /Filled in from AeroDataBox/.test(document.getElementById('flight-lookup-status').textContent), { timeout: 5000 });
    const notesAfterLookup = await page.locator('textarea[name="notes"]').inputValue();
    console.log('3. Notes auto-filled with flight details:', /Aircraft: Boeing 777-300ER/.test(notesAfterLookup) && /terminal 2E, gate K34/.test(notesAfterLookup));
    console.log('   Notes block delimiters present:', notesAfterLookup.indexOf('Flight lookup details') !== -1);

    // Click "Look up" a second time — notes should be REPLACED, not duplicated.
    await page.click('[data-action="lookup-flight"]');
    await page.waitForTimeout(300);
    const notesAfterSecondLookup = await page.locator('textarea[name="notes"]').inputValue();
    const occurrences = (notesAfterSecondLookup.match(/Aircraft: Boeing 777-300ER/g) || []).length;
    console.log('4. Re-running Look up does not duplicate the Notes block:', occurrences === 1, occurrences);

    await page.click('#entity-form button[type="submit"]');
    await page.waitForTimeout(100);
    const savedLeg2 = await page.evaluate(() => currentTrip().transport[1]);
    console.log('5. CDG (known hub) fromLat came from the static list:', savedLeg2.fromLat === 49.0097);
    console.log('6. ZZZ (unknown airport) toLat came from AeroDataBox location fallback:', savedLeg2.toLat === 12.3456, savedLeg2.toLat);
    console.log('   Saved notes carried through onto the record:', /Somewhere/.test(savedLeg2.notes) === false && /Aircraft/.test(savedLeg2.notes));

    // ---- Now check the Map tab: both legs should draw fully, and
    // Nominatim should never have been called at all. ----
    await page.click('[data-action="switch-tab"][data-tab="map"]');
    await page.waitForFunction(() => {
      const el = document.getElementById('map-status');
      return el && /placed on the map/.test(el.textContent);
    }, { timeout: 15000 });
    const mapStatusText = await page.locator('#map-status').textContent();
    console.log('7. Map status:', mapStatusText);
    console.log('8. Both legs placed, none missing:', /^All locations placed on the map\.$/.test(mapStatusText.trim()));

    const transportLayerCount = await page.evaluate(() => mapState.layers.transport.getLayers().length);
    console.log('9. Transport layer has 4 entries (2 lines + 2 arrows):', transportLayerCount === 4, transportLayerCount);

    console.log('10. Nominatim was never called (both legs used known coordinates):', nominatimCalls === 0, nominatimCalls);

    console.log('\nPage errors:', errors.length ? errors : 'NONE');
    await browser.close();
  } finally {
    server.kill();
  }
})();
