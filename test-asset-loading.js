// Exercise the real HTML asset graph after splitting the application by feature.
// Synthetic data stays in our own mock server; every nonlocal request is blocked.
const assert = require('assert');
const { chromium, webkit } = require('playwright');
const { spawn } = require('child_process');
const http = require('http');
const { loginAsAdmin, waitForSaveToSettle } = require('./test-helpers');

const PORT = 8832;
const BASE = 'http://127.0.0.1:' + PORT + '/WayPoint';
const ORIGIN = new URL(BASE).origin;

async function waitForServer(server) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (server.exitCode !== null) throw new Error('Asset test mock server exited before startup');
    const ready = await new Promise((resolve) => {
      const request = http.get(BASE, (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      });
      request.setTimeout(500, () => request.destroy());
      request.on('error', () => resolve(false));
    });
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Asset test mock server did not start');
}

function fixture() {
  return {
    tripId: 'asset-test-trip', name: 'Synthetic Pacific trip',
    startDate: '2030-04-01', endDate: '2030-04-03', homeCurrency: 'GBP',
    currencyRates: {}, notes: '', companions: [], contacts: [], expenses: [],
    accommodation: [], activities: [],
    destinations: [{
      destinationId: 'asset-destination', name: 'Synthetic Tokyo', country: 'Japan',
      arriveDate: '2030-04-01', departDate: '2030-04-03',
      lat: 35.6762, lng: 139.6503, boundaryRef: 'synthetic-unavailable-boundary',
      companions: []
    }],
    transport: [{
      transportId: 'asset-flight', mode: 'Flight', fromLocation: 'Synthetic Tokyo',
      toLocation: 'Synthetic Los Angeles', departDateTime: '2030-04-02T09:00',
      arriveDateTime: '2030-04-02T12:00', fromLat: 35.6762, fromLng: 139.6503,
      toLat: 34.0522, toLng: -118.2437, companions: []
    }]
  };
}

async function assertHttpAssets() {
  for (const url of [BASE, BASE + '/']) {
    const response = await fetch(url);
    assert.strictEqual(response.status, 200, url + ' must serve the app');
    assert(/^text\/html(?:;|$)/.test(response.headers.get('content-type')), 'App document has incorrect MIME');
    const html = await response.text();
    const assets = Array.from(html.matchAll(/<(script|link)\b[^>]*\b(?:src|href)="(\/WayPoint\/[^\"]+)"[^>]*>/g));
    const applicationStyles = assets.filter((match) => match[1] === 'link' && match[2].startsWith('/WayPoint/styles/'));
    assert.deepStrictEqual(applicationStyles.map(match => match[2]),
      ['base', 'forms', 'views', 'map'].map(name => '/WayPoint/styles/' + name + '.css'), 'Application stylesheet order changed');
    const applicationScripts = assets.filter((match) => match[1] === 'script' && match[2].startsWith('/WayPoint/js/'));
    assert.strictEqual(applicationScripts[0]?.[2], '/WayPoint/js/core.js', 'Core must load first');
    assert.strictEqual(applicationScripts.at(-1)?.[2], '/WayPoint/js/boot.js', 'Boot must load last');
    for (const script of applicationScripts) {
      assert(!/\s(?:async|defer)(?:\s|=|>)/i.test(script[0]) && !/\btype\s*=\s*["']module["']/i.test(script[0]),
        'Application scripts must execute synchronously as classic scripts: ' + script[2]);
    }
    for (const match of assets) {
      const asset = await fetch(new URL(match[2], url));
      assert.strictEqual(asset.status, 200, 'Asset did not load: ' + match[2]);
      const mime = match[1] === 'script' ? /^(?:text|application)\/javascript(?:;|$)/ : /^text\/css(?:;|$)/;
      assert(mime.test(asset.headers.get('content-type') || ''), 'Incorrect asset MIME: ' + match[2]);
      assert((await asset.text()).trim(), 'Asset is empty: ' + match[2]);
    }
  }
  console.log('HTTP asset paths and MIME checks passed for /WayPoint and /WayPoint/');
}

async function assertAssets(page, url, responses) {
  responses.clear();
  const documentResponse = await page.goto(url, { waitUntil: 'load' });
  assert.strictEqual(documentResponse.status(), 200, url + ' must serve the app');
  const assets = await page.evaluate(() => Array.from(document.querySelectorAll(
    'script[src], link[rel="stylesheet"][href]'
  )).filter((el) => new URL(el.src || el.href).origin === location.origin).map((el) => ({
    url: el.src || el.href, raw: el.getAttribute('src') || el.getAttribute('href'),
    type: el.tagName === 'SCRIPT' ? 'script' : 'style'
  })));
  assert.deepStrictEqual(assets.filter(asset => asset.type === 'style' && asset.raw.startsWith('/WayPoint/styles/')).map(asset => asset.raw),
    ['base', 'forms', 'views', 'map'].map(name => '/WayPoint/styles/' + name + '.css'), 'Application stylesheet order changed');
  const applicationScripts = assets.filter((asset) => asset.type === 'script' && asset.raw.startsWith('/WayPoint/js/'));
  assert.strictEqual(applicationScripts[0]?.raw, '/WayPoint/js/core.js', 'Core must load first');
  assert.strictEqual(applicationScripts.at(-1)?.raw, '/WayPoint/js/boot.js', 'Boot must load last');
  for (const asset of assets) {
    assert(asset.raw.startsWith('/WayPoint/'), 'Asset URL must work without a trailing slash: ' + asset.raw);
    const response = responses.get(asset.url);
    assert(response, 'Browser did not request ' + asset.url);
    assert.strictEqual(response.status, 200, 'Asset did not load: ' + asset.url);
    const mime = asset.type === 'script' ? /^(?:text|application)\/javascript(?:;|$)/ : /^text\/css(?:;|$)/;
    assert(mime.test(response.mime), 'Incorrect asset MIME: ' + asset.url + ' (' + response.mime + ')');
  }
  assert(await page.evaluate(() => {
    const scripts = Array.from(document.querySelectorAll('script[src^="/WayPoint/js/"]'));
    return scripts.length > 1 && scripts.every(script => !script.async && !script.defer && !script.type) && typeof render === 'function' &&
      typeof L === 'object' && typeof WayPointIcons === 'object' &&
      !!getComputedStyle(document.documentElement).getPropertyValue('--wp-map-transport').trim();
  }), 'Classic application script, dependencies or design tokens did not initialize');
}

async function assertMap(page) {
  await page.waitForFunction(() => {
    const status = document.getElementById('map-status');
    return status && /2 mapped items/.test(status.textContent) &&
      mapState.instance && mapState.routeArrows.length === 1 &&
      Object.keys(mapState.boundaryRequests).length === 0;
  });
  // A marker alone is insufficient: the CSS triangle and its JS rotation
  // must both survive extraction, including after Leaflet changes its zoom.
  await page.waitForFunction(() => {
    const arrow = mapState.routeArrows[0];
    const el = arrow && arrow.marker.getElement().querySelector('.transport-arrow');
    if (!el) return false;
    const style = getComputedStyle(el);
    const before = mapState.instance.latLngToLayerPoint([arrow.before.lat, arrow.before.lng]);
    const after = mapState.instance.latLngToLayerPoint([arrow.after.lat, arrow.after.lng]);
    const expected = Math.atan2(after.y - before.y, after.x - before.x) * 180 / Math.PI;
    const match = el.style.transform.match(/^rotate\(([-\d.]+)deg\)$/);
    return parseFloat(style.borderLeftWidth) > 0 && parseFloat(style.borderTopWidth) > 0 &&
      style.borderLeftStyle === 'solid' && match && Math.abs(Number(match[1]) - expected) < 0.01;
  });
  await page.locator('.transport-arrow').waitFor({ state: 'visible' });
  assert.strictEqual(await page.locator('#map-status.has-warning').count(), 0, 'Optional boundary failure hid the route');
}

async function runEngine(label, engine) {
  const browser = await engine.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [], responses = new Map();
    let boundaryRequests = 0;
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('response', (response) => responses.set(response.url(), {
      status: response.status(), mime: response.headers()['content-type'] || ''
    }));
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== ORIGIN) return route.abort();
      if (url.pathname === '/WayPoint/api/location-boundaries') {
        boundaryRequests++;
        return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Synthetic outage"}' });
      }
      return route.continue();
    });

    await assertAssets(page, BASE, responses);
    await loginAsAdmin(page);
    const seeded = await page.request.post(BASE + '/api/data', { data: { trips: [fixture()] } });
    assert(seeded.ok(), 'Synthetic fixture could not be saved');
    await assertAssets(page, BASE + '/', responses);
    await page.locator('[data-action="open-trip"][data-id="asset-test-trip"]').click();

    // Exercise the application's save pipeline, then reload from the mock API.
    await page.locator('[data-action="edit-trip"]').first().click();
    const savedName = 'Saved Pacific trip ' + label;
    await page.locator('#entity-form input[name="name"]').fill(savedName);
    const saveResponse = page.waitForResponse((response) =>
      response.url() === BASE + '/api/data' && response.request().method() === 'POST');
    await page.locator('#entity-form button[type="submit"]').click();
    assert((await saveResponse).ok(), 'Trip edit was rejected');
    await waitForSaveToSettle(page);
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction((name) => state.trips.some((trip) => trip.name === name) &&
      appLoadState === 'ready' && stateIsTrustworthy, savedName);
    if (await page.locator('[data-action="open-trip"][data-id="asset-test-trip"]').count()) {
      await page.locator('[data-action="open-trip"][data-id="asset-test-trip"]').click();
    }

    await page.locator('#trip-nav-map').click();
    await assertMap(page);
    assert(boundaryRequests > 0, 'Boundary failure path was not exercised');
    const initialZoom = await page.evaluate(() => mapState.instance.getZoom());
    await page.locator('.leaflet-control-zoom-in').click();
    await page.waitForFunction((zoom) => mapState.instance.getZoom() > zoom, initialZoom);
    await assertMap(page);
    await page.locator('#trip-nav-timeline').click();
    assert(await page.evaluate(() => mapState.instance === null), 'Leaving map did not destroy its instance');
    await page.locator('#trip-nav-map').click();
    await assertMap(page);
    assert.deepStrictEqual(errors, [], label + ' uncaught browser errors');
    console.log(label + ' asset loading, save/reload and map regression checks passed');
  } finally {
    await browser.close();
  }
}

(async () => {
  const server = spawn(process.execPath, ['mock-server.js', String(PORT)], { cwd: __dirname, stdio: 'inherit' });
  try {
    await waitForServer(server);
    await assertHttpAssets();
    await runEngine('Chromium', chromium);
    await runEngine('WebKit', webkit);
  } finally {
    if (server.exitCode === null) {
      await new Promise((resolve) => { server.once('exit', resolve); server.kill('SIGTERM'); });
    }
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
