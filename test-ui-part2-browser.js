// Blocking cross-engine UI gate for the second overhaul branch. It uses only
// synthetic in-memory trip data and never touches a production deployment.
const { chromium, webkit } = require('playwright');
const { spawn } = require('child_process');
const http = require('http');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loginAsAdmin } = require('./test-helpers');

const PORT = 8821;
const BASE = 'http://127.0.0.1:' + PORT + '/WayPoint';
const SCREENSHOTS = '/private/tmp/waypoint-atlas-qa';
fs.mkdirSync(SCREENSHOTS, { recursive: true });

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

function departuresFixture(role = 'superuser') {
  const trip = fixture(role);
  trip.tripId = 'qa-six-cdg';
  trip.name = 'Six separate departures';
  trip.companions = Array.from({ length: 6 }, (_, i) => ({ companionId: 'cdg-person-' + i, name: 'CDG Traveller ' + (i + 1), notes: '' }));
  trip.destinations = [];
  trip.activities = [];
  trip.accommodation = [];
  trip.expenses = [];
  const airports = ['LHR', 'JFK', 'HND', 'FCO', 'AMS', 'ATH'];
  trip.transport = trip.companions.map((person, i) => ({
    transportId: 'cdg-leg-' + i, mode: 'Flight', carrier: 'Synthetic Air', flightNumber: 'AF' + (100 + i),
    fromLocation: 'CDG — Paris Charles de Gaulle', toLocation: airports[i] + ' — Synthetic destination',
    departDateTime: '2030-04-04T09:' + String(i * 10).padStart(2, '0'), arriveDateTime: '2030-04-04T18:00',
    departTimezone: 'Europe/Paris', arriveTimezone: 'Europe/Paris',
    fromLat: 49.0097, fromLng: 2.5479, toLat: 51.47 + i * 0.01, toLng: -0.4543,
    bookingRef: 'CDG-BOOKING-' + i, companions: [person.companionId], notes: 'Independent booking ' + i
  }));
  if (role === 'user' || role === 'viewer') {
    trip.myGrant.companionId = trip.companions[0].companionId;
    // Model the server boundary: scoped accounts never receive other legs.
    trip.transport = trip.transport.slice(0, 1);
  }
  return trip;
}

async function seedView(page, role, tab, theme, trip = fixture(role)) {
  await page.evaluate(({ trip, tab, theme, role }) => {
    document.documentElement.dataset.theme = theme;
    state = { trips: [trip] };
    stateIsTrustworthy = true;
    appLoadState = 'ready';
    connectionState = 'online';
    currentUser = { id: 'qa-user', username: role + '-qa', isUberUser: role === 'superuser', avatar: { color: 'teal', animal: 'owl' } };
    currentView = 'trip'; currentTripId = trip.tripId; currentTab = tab;
    timelineDayExpansion = {};
    timelineJourneyExpansion = {};
    timelineJumpDates = {};
    timelineOpenedOn = '';
    companionSelection = {};
    itemScopePreference = {};
    applyAuthUI(); updateSystemFeedback(); render();
  }, { trip, tab, theme, role });
}

async function assertNoOverflow(page, label) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 1) throw new Error(label + ' has ' + overflow + 'px horizontal overflow');
}

async function assertAtlasGeometry(page, label, viewport) {
  const layout = await page.evaluate(() => {
    const main = document.querySelector('.atlas-trip-main');
    const selectors = ['.atlas-add-strip', '.atlas-companion-bar', '.atlas-section-controls', '#trip-panel'];
    const bands = selectors.map(selector => {
      const element = document.querySelector(selector);
      if (!element) return {selector, missing: true};
      const rect = element.getBoundingClientRect();
      return {selector, directChild: element.parentElement === main, x: rect.x, top: rect.top, bottom: rect.bottom, width: rect.width};
    });
    const viewButtons = ['timeline', 'map'].map(tab => {
      const button = document.querySelector('.atlas-itinerary-switch [data-tab="' + tab + '"]');
      if (!button) return {missing: true};
      const rect = button.getBoundingClientRect();
      return {top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: rect.width};
    });
    return {bands, viewButtons};
  });
  for (const band of layout.bands) {
    assert.equal(band.missing, undefined, label + ': missing ' + band.selector);
    assert.equal(band.directChild, true, label + ': ' + band.selector + ' must be a direct child of .atlas-trip-main, not nested inside another band');
  }
  for (let i = 1; i < layout.bands.length; i++) {
    assert(layout.bands[i].top >= layout.bands[i - 1].bottom - 1, label + ': ' + layout.bands[i].selector + ' must stack beneath the preceding band');
  }
  const panel = layout.bands.at(-1);
  if (viewport.width === 1440) assert(panel.width > 900, label + ': itinerary panel is too narrow (' + panel.width + 'px)');
  if (viewport.width === 390) assert(panel.width > 330, label + ': mobile itinerary panel is too narrow (' + panel.width + 'px)');
  const [agenda, map] = layout.viewButtons;
  assert(!agenda.missing && !map.missing, label + ': Agenda and Map controls are missing');
  assert(Math.abs(agenda.top - map.top) <= 1, label + ': Agenda and Map must share a row');
  assert(agenda.right <= map.left + 1, label + ': Agenda and Map controls overlap');
  assert(agenda.width >= 44 && map.width >= 44, label + ': itinerary view controls are not usable touch targets');
}

async function checkAtlasDepartures(page, engineName, viewports) {
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    for (const theme of ['light', 'dark']) {
      await seedView(page, 'superuser', 'timeline', theme, departuresFixture());
      const label = engineName + ' six CDG departures ' + viewport.width + ' ' + theme;
      const group = page.locator('.timeline-journey-group');
      const legs = group.locator('.timeline-journey-leg');
      assert.equal(await group.count(), 1, label + ': expected one visual group');
      assert.match(await group.locator('h4').innerText(), /6 departures from CDG/);
      assert.deepEqual(await legs.evaluateAll(els => els.map(el => el.dataset.timelineJourney)), Array.from({length: 6}, (_, i) => 'cdg-leg-' + i), label + ': bookings lost or merged');
      for (let i = 0; i < 6; i++) {
        const leg = legs.nth(i);
        assert.equal(await leg.evaluate(el => el.open), false, label + ': starts compact');
        const summary = leg.locator('summary');
        assert(summary && await summary.isVisible(), label + ': hidden journey summary');
        const summaryText = await summary.innerText();
        assert(summaryText.includes('CDG Traveller ' + (i + 1)), label + ': wrong or missing named participant');
        assert(summaryText.includes('AF' + (100 + i)), label + ': missing independent flight number');
        assert(summaryText.includes('09:' + String(i * 10).padStart(2, '0')), label + ': missing departure time');
        assert.equal(await leg.locator('[data-action="edit-transport"][data-id="cdg-leg-' + i + '"]').count(), 1, label + ': edit identity changed');
      }
      await assertNoOverflow(page, label);
      await assertAtlasGeometry(page, label, viewport);
      if (theme === 'light' && (viewport.width === 390 || viewport.width === 1440)) {
        await page.screenshot({ path: path.join(SCREENSHOTS, engineName.toLowerCase() + '-agenda-six-cdg-' + viewport.width + '-light.png'), fullPage: true });
      }

      // Native disclosures work by keyboard, retain each booking separately,
      // and survive a real filter control's render rather than a fixed delay.
      await legs.nth(0).locator('summary').focus();
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('[data-timeline-journey="cdg-leg-0"]').open);
      assert.equal(await legs.nth(1).evaluate(el => el.open), false, label + ': opening one journey opened another');
      await page.locator('.atlas-companion-bar [data-action="show-all-people"]').click();
      assert.equal(await legs.nth(0).evaluate(el => el.open), true, label + ': rendering lost the open booking');
      await legs.nth(1).locator('summary').focus();
      await page.keyboard.press('Space');
      await page.waitForFunction(() => document.querySelector('[data-timeline-journey="cdg-leg-1"]').open);
      await legs.nth(0).locator('summary').click();
      assert.equal(await legs.nth(0).evaluate(el => el.open), false);
      assert.equal(await legs.nth(1).evaluate(el => el.open), true, label + ': disclosures are not independent');

      // Source editing opens one original booking and its own assignment.
      await legs.nth(2).locator('summary').click();
      await legs.nth(2).locator('[data-action="edit-transport"]').click();
      assert.equal(await page.locator('#entity-form input[name="flightNumber"]').inputValue(), 'AF102');
      assert.equal(await page.locator('#entity-form input[name="bookingRef"]').inputValue(), 'CDG-BOOKING-2');
      assert.equal(await page.locator('#entity-form input[data-tag-person-id="cdg-person-2"]').isChecked(), true);
      assert.equal(await page.locator('#entity-form input[data-tag-person-id="cdg-person-1"]').isChecked(), false);
      await page.locator('.modal-head [data-action="close-modal"]').click();
      await page.waitForSelector('#entity-form', {state: 'detached'});

      // Collapse/expand all remains keyboard operable after replacing the page.
      const all = page.locator('[data-action="timeline-toggle-all"]');
      await all.focus();
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => [...document.querySelectorAll('.day-content')].every(el => el.hidden));
      assert.match(await all.innerText(), /Expand all/);
      await page.waitForFunction(() => document.activeElement && document.activeElement.dataset.action === 'timeline-toggle-all');
      assert.equal(await all.evaluate(el => el === document.activeElement), true, label + ': collapse all lost keyboard focus');
      await page.keyboard.press('Space');
      await page.waitForFunction(() => [...document.querySelectorAll('.day-content')].every(el => !el.hidden));
      assert.match(await all.innerText(), /Collapse all/);

      const day = page.locator('[data-timeline-day="2030-04-04"]');
      await day.locator('.day-head').focus();
      await page.keyboard.press('Enter');
      assert.equal(await day.locator('.day-content').evaluate(el => el.hidden), true);
      assert.match(await day.locator('.day-head').innerText(), /CDG Traveller 6/, label + ': collapsed day lost participant context');
      // Use the visible formatted date field exactly as a keyboard user would.
      // Native fill can itself commit and rebuild the input, so dispatching a
      // second change onto the replacement would jump to its initial date.
      const jump = page.locator('.timeline-date-jump input[type="text"]');
      await jump.fill('04/Apr/2030');
      await jump.press('Tab');
      await page.waitForFunction(() => {
        const head = document.querySelector('[data-timeline-day="2030-04-04"] .day-head');
        return head.getAttribute('aria-expanded') === 'true' && document.activeElement === head;
      });
      assert.equal(await page.locator('[data-timeline-jump-date]').inputValue(), '2030-04-04', label + ': date jump lost the selected date after rendering');

      // The local filter narrows only the view and the count. Assignments and
      // independent booking records survive; reset returns all six journeys.
      await page.locator('.atlas-companion-bar [data-action="toggle-companion-filter"][data-id="cdg-person-0"]').click();
      assert.equal(await page.locator('.timeline-journey-group').count(), 0, label + ': a one-person result still implies six departures');
      assert.equal(await page.locator('[data-action="edit-transport"][data-id="cdg-leg-0"]').count(), 1);
      assert.equal(await page.locator('[data-action="edit-transport"][data-id="cdg-leg-1"]').count(), 0, label + ': hidden plan still rendered');
      assert.equal(await page.evaluate(() => currentTrip().transport.length), 6, label + ': a view filter mutated source bookings');
      await page.locator('.atlas-companion-bar [data-action="show-all-people"]').click();
      assert.equal(await page.locator('.timeline-journey-leg').count(), 6);
    }
  }
  for (const role of ['user', 'viewer']) {
    await seedView(page, role, 'timeline', 'light', departuresFixture(role));
    assert.equal(await page.locator('.timeline-journey-group').count(), 0, role + ': restricted response should not imply hidden group size');
    assert.equal(await page.locator('[data-id="cdg-leg-1"]').count(), 0, role + ': another person’s leg was rendered');
    assert.equal(await page.locator('.atlas-add-strip').count(), 0, role + ': forbidden itinerary creation shown');
    assert(!await page.locator('#trip-panel').innerText().then(text => text.includes('CDG Traveller 2')), role + ': hidden traveller plan leaked');
  }
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
          const full = role === 'superuser' || role === 'admin';
          if (full) await assertAtlasGeometry(page, engineName + ' Atlas ' + viewport.width + ' ' + theme + ' ' + role, viewport);
          for (const action of ['new-destination', 'new-transport', 'new-accommodation', 'new-activity']) {
            const count = await page.locator('.atlas-add-strip [data-action="' + action + '"]').count();
            if (full !== (count > 0)) throw new Error(role + ' Atlas ' + action + ' authorization is wrong');
          }
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

    await checkAtlasDepartures(page, engineName, viewports);

    await page.setViewportSize({ width: 1440, height: 1000 });
    await seedView(page, 'superuser', 'map', 'dark');
    await page.waitForSelector('.leaflet-container');
    await page.screenshot({ path: path.join(SCREENSHOTS, engineName.toLowerCase() + '-map-1440-dark.png'), fullPage: true });

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
      await page.locator('[data-action="' + action + '"]').first().click();
      if (!(await page.locator('#entity-form .journey').count())) throw new Error(action + ' did not use Journey');
      await page.click('#entity-form button[type="submit"]');
      await page.waitForSelector('#entity-form .field-error');
      await page.click('.modal-head [data-action="close-modal"]');
    }

    // Editors must work on populated records, not just empty create forms.
    // Long/realistic values expose intrinsic-width bugs that static checks miss.
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      for (const theme of ['light', 'dark']) {
        for (const [tab, action] of [['destinations','edit-destination'], ['transport','edit-transport'], ['accommodation','edit-accommodation'], ['activities','edit-activity']]) {
          await seedView(page, 'superuser', tab, theme);
          await page.locator('[data-action="' + action + '"]').first().click();
          await page.waitForSelector('#entity-form');
          await assertNoOverflow(page, engineName + ' ' + action + ' ' + viewport.width + ' ' + theme);
          const dialog = await page.locator('.modal').boundingBox();
          const save = await page.locator('#entity-form button[type="submit"]').boundingBox();
          if (!save || save.y + save.height > viewport.height || save.y + save.height > dialog.y + dialog.height + 1) throw new Error(action + ' Save is clipped');
          await page.click('.modal-head [data-action="close-modal"]');
        }
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await seedView(page, 'superuser', 'destinations', 'light');
    await page.locator('[data-action="edit-destination"]').first().click();
    await page.locator('input[name="timezone"]').focus();
    await page.keyboard.press('Escape');
    if (!(await page.locator('#entity-form').count())) throw new Error('Escape dismissed the form instead of suggestions');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#entity-form', { state: 'detached' });

    await seedView(page, 'superuser', 'expenses', 'dark');
    if (!(await page.locator('.expense-ledger [data-action="edit-expense"]').count())) throw new Error('Mobile expense editor missing');
    await seedView(page, 'superuser', 'settings', 'dark');
    if (!(await page.locator('#trip-panel [data-action="edit-trip"]').isVisible())) throw new Error('Mobile Settings lost trip editor');
    if (await page.locator('.settings-dependencies').evaluate(el => el.open)) throw new Error('Dependency section starts expanded');

    await seedView(page, 'viewer', 'settings', 'light');
    if (!(await page.locator('.empty-state.is-permission').count())) throw new Error('permission-restricted state missing');
    await seedView(page, 'superuser', 'timeline', 'light');
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    if (!(await page.locator('#system-banner.is-visible[data-kind="offline"]').count())) throw new Error('offline banner missing');
    if (!(await page.locator('.atlas-add-strip [data-action="new-activity"]').isDisabled())) throw new Error('offline Atlas Add control remained enabled');

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
