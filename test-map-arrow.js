// Focused check for the new direction-arrow marker on the Map tab —
// test-map.js's one transport leg deliberately has a missing endpoint
// (to test the "couldn't be found" path), so it never exercises the
// arrow-drawing code at all. This spins up a trip with a transport leg
// where BOTH ends resolve, and checks a marker actually gets added
// alongside the line, with a sane rotation angle.
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const { loginAsAdmin } = require('./test-helpers');

const PORT = 8793;

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

    // Two fixed, distinct points so we can reason about the resulting angle.
    await page.route('https://nominatim.openstreetmap.org/**', (route) => {
      const url = new URL(route.request().url());
      const q = url.searchParams.get('q') || '';
      if (q.indexOf('London') !== -1) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ lat: '51.5', lon: '-0.1' }]) });
      if (q.indexOf('Paris') !== -1) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ lat: '48.85', lon: '2.35' }]) });
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });
    const onePxPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    await page.route('https://*.tile.openstreetmap.org/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: onePxPng }));

    await page.goto('http://localhost:' + PORT + '/WayPoint');
    await loginAsAdmin(page);
    await page.click('[data-action="new-trip"]');
    await page.fill('input[name="name"]', 'Arrow Test Trip');
    await page.fill('input[name="startDate"]', '2027-05-01');
    await page.fill('input[name="endDate"]', '2027-05-10');
    await page.fill('input[name="homeCurrency"]', 'GBP');
    await page.click('#entity-form button[type="submit"]');
    await page.waitForTimeout(150);

    await page.click('[data-action="switch-tab"][data-tab="transport"]');
    await page.click('[data-action="new-transport"]');
    await page.fill('input[name="fromLocation"]', 'London');
    await page.fill('input[name="toLocation"]', 'Paris');
    await page.fill('input[name="departDate"]', '2027-05-02');
    await page.fill('input[name="arriveDate"]', '2027-05-02');
    await page.click('#entity-form button[type="submit"]');
    await page.waitForTimeout(100);

    await page.click('[data-action="switch-tab"][data-tab="map"]');
    await page.waitForFunction(() => {
      const el = document.getElementById('map-status');
      return el && /placed on the map/.test(el.textContent);
    }, { timeout: 15000 });

    const transportLayerCount = await page.evaluate(() => mapState.layers.transport.getLayers().length);
    console.log('1. Transport layer has 2 entries (1 line + 1 arrow marker):', transportLayerCount === 2, transportLayerCount);

    const arrowInfo = await page.evaluate(() => {
      var layers = mapState.layers.transport.getLayers();
      var arrowLayer = layers.filter(function (l) { return l instanceof L.Marker; })[0];
      if (!arrowLayer) return null;
      var el = arrowLayer.getElement();
      var innerDiv = el && el.querySelector('.transport-arrow');
      return {
        hasIcon: !!innerDiv,
        style: innerDiv ? innerDiv.getAttribute('style') : null,
        colorMatches: innerDiv ? /border-left-color:\s*#1e88ff/.test(innerDiv.getAttribute('style')) : false,
        hasRotation: innerDiv ? /rotate\(/.test(innerDiv.getAttribute('style')) : false
      };
    });
    console.log('2. Arrow marker rendered with the transport colour:', arrowInfo && arrowInfo.colorMatches, arrowInfo);
    console.log('3. Arrow marker has a rotation transform applied:', arrowInfo && arrowInfo.hasRotation);

    // London (51.5, -0.1) -> Paris (48.85, 2.35): east and slightly south,
    // so on a standard map (north-up, no rotation) the angle should point
    // generally rightward-and-down: positive x, positive y in screen
    // space -> an angle between 0 and 90 degrees.
    const angle = await page.evaluate(() => {
      var layers = mapState.layers.transport.getLayers();
      var arrowLayer = layers.filter(function (l) { return l instanceof L.Marker; })[0];
      var innerDiv = arrowLayer.getElement().querySelector('.transport-arrow');
      var m = innerDiv.getAttribute('style').match(/rotate\(([-\d.]+)deg\)/);
      return m ? parseFloat(m[1]) : null;
    });
    console.log('4. Angle points roughly east-southeast (between 0 and 90 deg):', angle !== null && angle > 0 && angle < 90, angle);

    console.log('\nPage errors:', errors.length ? errors : 'NONE');
    await browser.close();
  } finally {
    server.kill();
  }
})();
