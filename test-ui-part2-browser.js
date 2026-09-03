// Blocking cross-engine UI gate for the second overhaul branch. It uses only
// synthetic in-memory trip data and never touches a production deployment.
const { chromium, webkit } = require('playwright');
const { spawn } = require('child_process');
const http = require('http');
const { loginAsAdmin } = require('./test-helpers');

const PORT = 8821;
const BASE = 'http://127.0.0.1:' + PORT + '/WayPoint';

function waitForServer(tries = 40) {
  return new Promise((resolve, reject) => {
    const attempt = (left) => http.get(BASE, () => resolve()).on('error', () => {
      if (!left) reject(new Error('mock server did not start'));
      else setTimeout(() => attempt(left - 1), 100);
    });
    attempt(tries);
  });
}

function fixture(role) {
  return {
    tripId: 'qa-trip', revision: 1, name: 'Synthetic Silk Road', startDate: '2030-04-01', endDate: '2030-04-05', homeCurrency: 'GBP', currencyRates: { JPY: 0.0052 }, notes: '',
    myGrant: { role, companionId: role === 'user' || role === 'viewer' ? 'c1' : '' }, grants: [], companionAccessLevels: {}, companionAvatars: { c1: { type: 'smiley', color: 'teal' } },
    companions: [{ companionId: 'c1', name: 'Synthetic Traveller', companions: [] }], contacts: [],
    destinations: [{ destinationId: 'd1', name: 'Tokyo', country: 'Japan', arriveDate: '2030-04-01', departDate: '2030-04-05', timezone: 'Asia/Tokyo', lat: 35.6762, lng: 139.6503, companions: ['c1'] }],
    activities: [
      { activityId: 'a1', title: 'Museum visit', category: 'Culture', startDate: '2030-04-02', endDate: '2030-04-02', startTime: '10:00', endTime: '12:00', allDay: false, address: 'Synthetic address', addressLat: 35.68, addressLng: 139.76, companions: ['c1'], costAmount: 2200, costCurrency: 'JPY' },
      { activityId: 'a2', title: 'Unmapped market', category: 'Food', startDate: '2030-04-03', endDate: '2030-04-03', startTime: '18:00', endTime: '20:00', allDay: false, address: '', companions: ['c1'] }
    ],
    transport: [{ transportId: 't1', mode: 'Rail', carrier: 'QA Rail', fromLocation: 'Tokyo', toLocation: 'Kyoto', departDateTime: '2030-04-04T09:00', arriveDateTime: '2030-04-04T11:00', fromLat: 35.68, fromLng: 139.76, toLat: 35.01, toLng: 135.76, companions: ['c1'], costAmount: 90, costCurrency: 'GBP' }],
    accommodation: [{ accommodationId: 's1', name: 'Test Hotel', type: 'Hotel', address: 'Synthetic hotel', checkIn: '2030-04-01T15:00', checkOut: '2030-04-05T11:00', lat: 35.67, lng: 139.74, companions: ['c1'], costAmount: 400, costCurrency: 'GBP' }],
    expenses: [{ expenseId: 'e1', description: 'Dinner', category: 'Food', date: '2030-04-03', amount: 5000, currency: 'JPY', receiptRef: 'QA-RECEIPT' }]
  };
}

async function seedView(page, role, tab, theme) {
  await page.evaluate(({ trip, tab, theme, role }) => {
    document.documentElement.dataset.theme = theme;
    state = { trips: [trip] };
    stateIsTrustworthy = true;
    appLoadState = 'ready';
    connectionState = 'online';
    currentUser = { id: 'qa-user', username: role + '-qa', isUberUser: role === 'superuser', avatar: { color: 'teal', animal: 'owl' } };
    currentView = 'trip'; currentTripId = trip.tripId; currentTab = tab;
    applyAuthUI(); updateSystemFeedback(); render();
  }, { trip: fixture(role), tab, theme, role });
}

async function assertNoOverflow(page, label) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 1) throw new Error(label + ' has ' + overflow + 'px horizontal overflow');
}

async function runEngine(engineName, browserType) {
  const browser = await browserType.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route(/fonts\.googleapis\.com|fonts\.gstatic\.com|tile\.openstreetmap\.org/, (route) => route.abort());
    await page.goto(BASE);
    await loginAsAdmin(page);

    const viewports = [{ width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1440, height: 1000 }];
    const roles = ['superuser', 'admin', 'user', 'viewer'];
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      for (const theme of ['light', 'dark']) {
        for (const role of roles) {
          await seedView(page, role, 'timeline', theme);
          await assertNoOverflow(page, engineName + ' ' + viewport.width + ' ' + theme + ' ' + role);
          const editTripCount = await page.locator('[data-action="edit-trip"]').count();
          if ((role === 'superuser' || role === 'admin') !== (editTripCount > 0)) throw new Error(role + ' trip edit controls are wrong');
          const editActivityCount = await page.locator('[data-action="edit-activity"]').count();
          if (role === 'viewer' && editActivityCount) throw new Error('viewer received an edit action');
          if (role === 'user' && !editActivityCount) throw new Error('tagged user lost their item edit action');
          if (role === 'viewer' && !(await page.locator('.status-badge.is-readonly').count())) throw new Error('viewer read-only badge missing');
        }

        await seedView(page, 'superuser', 'expenses', theme);
        const ledgerDisplay = await page.locator('.expense-ledger').evaluate((el) => getComputedStyle(el).display);
        const tableDisplay = await page.locator('.expense-table').evaluate((el) => getComputedStyle(el).display);
        if (viewport.width === 390 && (ledgerDisplay === 'none' || tableDisplay !== 'none')) throw new Error('mobile expense ledger did not replace table');
        if (viewport.width > 640 && tableDisplay === 'none') throw new Error('desktop expense table is hidden');
        await assertNoOverflow(page, engineName + ' expenses ' + viewport.width + ' ' + theme);
      }
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await seedView(page, 'superuser', 'map', 'light');
    await page.waitForSelector('.map-filter-chip');
    const columns = await page.locator('.map-filter-bar').evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
    if (columns !== 2) throw new Error('mobile map layer grid is not 2x2');
    if (!(await page.locator('.map-unmapped-row').count())) throw new Error('missing-location recovery list did not render');
    await page.click('[data-action="toggle-map-layer"][data-layer="activities"]');
    if (await page.locator('[data-action="reset-map-view"]').isDisabled()) throw new Error('map Reset did not enable after a filter change');
    await page.click('[data-action="reset-map-view"]');
    if (!(await page.locator('[data-action="reset-map-view"]').isDisabled())) throw new Error('map Reset did not restore defaults');
    await page.evaluate(() => { mapState.rangeStart = '2030-04-03'; mapState.rangeEnd = '2030-04-03'; updateMapRangeUi(currentTrip()); });
    const labels = await page.locator('.map-range-handle-label').evaluateAll((els) => els.map((el) => el.getBoundingClientRect()));
    if (labels.some((box) => box.left < 0 || box.right > 390)) throw new Error('map range label escaped the viewport');
    if (!(labels[0].bottom <= labels[1].top || labels[1].bottom <= labels[0].top)) throw new Error('map range labels overlap');

    await page.setViewportSize({ width: 1440, height: 1000 });
    for (const action of ['new-destination', 'new-activity', 'new-transport', 'new-accommodation']) {
      const tab = action.replace('new-', '').replace('destination', 'destinations').replace('activity', 'activities');
      await seedView(page, 'superuser', tab, 'dark');
      await page.click('[data-action="' + action + '"]');
      if (!(await page.locator('#entity-form .journey').count())) throw new Error(action + ' did not use Journey');
      await page.click('#entity-form button[type="submit"]');
      await page.waitForSelector('#entity-form .field-error');
      await page.click('[data-action="close-modal"]');
    }

    await seedView(page, 'viewer', 'settings', 'light');
    if (!(await page.locator('.empty-state.is-permission').count())) throw new Error('permission-restricted state missing');
    await seedView(page, 'superuser', 'timeline', 'light');
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    if (!(await page.locator('#system-banner.is-visible[data-kind="offline"]').count())) throw new Error('offline banner missing');
    if (!(await page.locator('[data-action="edit-trip"]').isDisabled())) throw new Error('offline edit control remained enabled');

    if (errors.length) throw new Error(engineName + ' page errors: ' + errors.join(' | '));
    console.log(engineName + ' responsive, role, workflow and state checks passed');
  } finally {
    await browser.close();
  }
}

(async () => {
  const server = spawn('node', ['mock-server.js', String(PORT)], { cwd: __dirname, stdio: 'inherit' });
  try {
    await waitForServer();
    await runEngine('Chromium', chromium);
    await runEngine('WebKit', webkit);
    console.log('cross-engine UI merge gate passed');
  } finally {
    server.kill('SIGTERM');
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
