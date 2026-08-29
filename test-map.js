// Regression test for the Map tab. Runs against the mock server (like
// test-deploy.js) but additionally intercepts the two external services
// the Map tab talks to — Nominatim (geocoding) and the OpenStreetMap tile
// server — with canned responses, since this sandbox can't reach the real
// internet. The real deployment talks to the genuine services; this test
// only verifies OUR code's side of that integration: gathering the right
// points/legs, drawing the right number of markers/lines, caching lookups
// so a reload doesn't re-geocode, and the layer toggles actually working.
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const { loginAsAdmin, waitForSaveToSettle } = require('./test-helpers');

const PORT = 8788;
let geocodeCallCount = 0;

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
    page.on('console', (msg) => console.log('CONSOLE[' + msg.type() + ']:', msg.text()));

    // ---- Fake Nominatim: deterministic fake coordinates per query, and a fake miss for anything containing "Nowhereville" ----
    await page.route('https://nominatim.openstreetmap.org/**', (route) => {
      geocodeCallCount++;
      const url = new URL(route.request().url());
      const q = url.searchParams.get('q') || '';
      if (q.indexOf('Nowhereville') !== -1) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      }
      const lat = 10 + (q.length % 40);
      const lon = 10 + ((q.length * 3) % 60);
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ lat: String(lat), lon: String(lon) }]) });
    });
    // ---- Fake map tiles: a trivial 1x1 PNG so Leaflet doesn't error trying to load real tiles ----
    const onePxPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    await page.route('https://*.tile.openstreetmap.org/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: onePxPng }));

    await page.goto('http://localhost:' + PORT + '/WayPoint');
    await loginAsAdmin(page);

    // ---- Set up a trip with two destinations, one accommodation, and one transport leg ----
    await page.click('[data-action="new-trip"]');
    await page.fill('input[name="name"]', 'Map Test Trip');
    await page.fill('input[name="startDate"]', '2027-02-01');
    await page.fill('input[name="endDate"]', '2027-02-10');
    await page.fill('input[name="homeCurrency"]', 'GBP');
    await page.click('#entity-form button[type="submit"]');
    await waitForSaveToSettle(page);

    // Map tab with nothing added yet -> empty state
    await page.click('[data-action="switch-tab"][data-tab="map"]');
    await page.waitForTimeout(100);
    const emptyText = await page.locator('#app').innerText();
    console.log('1. Map tab shows empty state before any data exists:', emptyText.includes('Nothing to show yet'));

    await page.click('[data-action="switch-tab"][data-tab="destinations"]');
    await page.click('[data-action="new-destination"]');
    await page.fill('input[name="country"]', 'Thailand');
    await page.fill('input[name="name"]', 'Bangkok');
    await page.fill('input[name="arriveDate"]', '2027-02-01');
    await page.fill('input[name="departDate"]', '2027-02-05');
    await page.click('#entity-form button[type="submit"]');
    await waitForSaveToSettle(page);
    await page.click('[data-action="new-destination"]');
    await page.fill('input[name="country"]', 'Nowhereville-Fakecountry');
    await page.fill('input[name="name"]', 'Nowhereville');
    await page.fill('input[name="arriveDate"]', '2027-02-05');
    await page.fill('input[name="departDate"]', '2027-02-10');
    await page.click('#entity-form button[type="submit"]');
    await waitForSaveToSettle(page);

    await page.click('[data-action="switch-tab"][data-tab="accommodation"]');
    await page.click('[data-action="new-accommodation"]');
    await page.fill('input[name="name"]', 'Riverside Guesthouse');
    await page.fill('input[name="address"]', '99 Riverside Rd, Bangkok');
    await page.fill('input[name="checkInDate"]', '2027-02-01');
    await page.fill('input[name="checkOutDate"]', '2027-02-05');
    await page.click('#entity-form button[type="submit"]');
    await waitForSaveToSettle(page);

    await page.click('[data-action="switch-tab"][data-tab="transport"]');
    await page.click('[data-action="new-transport"]');
    await page.fill('input[name="fromLocation"]', 'Bangkok, Thailand');
    await page.fill('input[name="toLocation"]', 'Nowhereville, Nowhereville-Fakecountry');
    await page.fill('input[name="departDate"]', '2027-02-05');
    await page.fill('input[name="arriveDate"]', '2027-02-05');
    await page.click('#entity-form button[type="submit"]');
    await waitForSaveToSettle(page);

    // ---- Now visit the Map tab and let geocoding run ----
    await page.click('[data-action="switch-tab"][data-tab="map"]');
    try {
      await page.waitForFunction(() => {
        const el = document.getElementById('map-status');
        return el && /placed on the map/.test(el.textContent);
      }, { timeout: 15000 });
    } catch (e) {
      console.log('DEBUG status text at timeout:', await page.locator('#map-status').textContent().catch(() => '(no #map-status found)'));
      console.log('DEBUG leaflet L defined:', await page.evaluate(() => typeof window.L));
      console.log('DEBUG mapState:', await page.evaluate(() => JSON.stringify(window.mapState && { hasInstance: !!mapState.instance, hasLayers: !!mapState.layers })));
      throw e;
    }

    const statusText = await page.locator('#map-status').textContent();
    console.log('2. Map status after geocoding:', statusText.trim());
    console.log('   Mentions 1 location not found (Nowhereville has no real match):', /1 couldn.t be found/.test(statusText));

    const markerCounts = await page.evaluate(() => ({
      destinations: mapState.layers.destinations.getLayers().length,
      accommodation: mapState.layers.accommodation.getLayers().length,
      transport: mapState.layers.transport.getLayers().length
    }));
    console.log('3. Destination markers placed (expect 1 — Bangkok; Nowhereville has no match):', markerCounts.destinations === 1);
    console.log('   Accommodation marker placed (expect 1):', markerCounts.accommodation === 1);
    console.log('   Transport line NOT drawn (expect 0 — one end has no coordinates):', markerCounts.transport === 0);

    const callsAfterFirstLoad = geocodeCallCount;

    // ---- Toggle the destinations layer off and back on, purely client-side ----
    await page.click('.map-toggle input[data-layer="destinations"]');
    await page.waitForTimeout(50);
    let hasLayer = await page.evaluate(() => mapState.instance.hasLayer(mapState.layers.destinations));
    console.log('4. Unchecking "Destinations" removes that layer from the map:', hasLayer === false);
    await page.click('.map-toggle input[data-layer="destinations"]');
    await page.waitForTimeout(50);
    hasLayer = await page.evaluate(() => mapState.instance.hasLayer(mapState.layers.destinations));
    console.log('   Re-checking it adds it back:', hasLayer === true);

    // ---- Reload and revisit the Map tab: should use the cache, not re-geocode ----
    // A successful geocode also triggers a background save of the newly
    // resolved coordinates into trip.geocodeCache — this needs to have
    // actually reached the mock server before reloading below, or the
    // reload finds an empty cache and re-geocodes everything, which is
    // exactly what assertion 5 exists to catch. See waitForSaveToSettle()'s
    // own comment in test-helpers.js for why a fixed short wait isn't
    // reliably enough time any more (the security-fixes branch's save
    // pacing/retry logic in persist()).
    await waitForSaveToSettle(page);
    // sessionStorage remembers we were on the Map tab, so the reload lands
    // straight back there rather than the dashboard.
    await page.reload();
    await page.waitForSelector('#map-canvas, .trip-grid', { timeout: 5000 });
    await page.waitForFunction(() => {
      const el = document.getElementById('map-status');
      return el && /placed on the map/.test(el.textContent);
    }, { timeout: 20000 });
    console.log('5. After reload, no new geocode calls were made (cache reused):', geocodeCallCount === callsAfterFirstLoad);

    console.log('\nPage errors:', errors.length ? errors : 'NONE');
    await browser.close();
  } finally {
    server.kill();
  }
})();
