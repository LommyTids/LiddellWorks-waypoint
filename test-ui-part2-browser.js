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
    setSaveStatus('saved');
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
    const floating = document.querySelector('.atlas-floating-header');
    const selectors = ['.atlas-add-strip', '.atlas-companion-bar', '.atlas-section-controls', '#trip-panel'];
    const bands = selectors.map(selector => {
      const element = document.querySelector(selector);
      if (!element) return {selector, missing: true};
      const rect = element.getBoundingClientRect();
      return {selector, directChild: element.parentElement === (selector === '#trip-panel' ? main : floating), x: rect.x, top: rect.top, bottom: rect.bottom, width: rect.width};
    });
    const viewButtons = ['timeline', 'map'].map(tab => {
      const button = document.querySelector('.atlas-itinerary-switch [data-tab="' + tab + '"]');
      if (!button) return {missing: true};
      const rect = button.getBoundingClientRect();
      return {top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: rect.width};
    });
    return {bands, viewButtons, floatingDirectChild: !!floating && floating.parentElement === main, floatingBottom: floating && floating.getBoundingClientRect().bottom};
  });
  assert.equal(layout.floatingDirectChild, true, label + ': floating control wrapper must be a main-column sibling of the itinerary panel');
  for (const band of layout.bands) {
    assert.equal(band.missing, undefined, label + ': missing ' + band.selector);
    assert.equal(band.directChild, true, label + ': ' + band.selector + ' is nested in the wrong control band');
  }
  for (let i = 1; i < layout.bands.length; i++) {
    // The wrapper may cap/scroll its children on a small viewport. The panel
    // follows the wrapper's visible box, not offscreen internal content.
    const precedingBottom = i === layout.bands.length - 1 ? layout.floatingBottom : layout.bands[i - 1].bottom;
    assert(layout.bands[i].top >= precedingBottom - 1, label + ': ' + layout.bands[i].selector + ' must stack beneath the preceding band');
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

async function controlStyle(locator) {
  return locator.evaluate(async el => {
    // Pointer removal starts the designed hover transition; compare settled
    // semantic states rather than one engine's intermediate animation frame.
    await Promise.all(el.getAnimations().filter(animation => animation.effect.getTiming().iterations !== Infinity)
      .map(animation => animation.finished.catch(() => {})));
    const style = getComputedStyle(el);
    return {background: style.backgroundColor, border: style.borderTopColor, borderStyle: style.borderTopStyle, borderWidth: style.borderTopWidth};
  });
}

async function assertGlobalHeaderVisible(page, label) {
  const geometry = await page.evaluate(() => {
    const header = document.querySelector('.topbar').getBoundingClientRect();
    const content = [...document.querySelectorAll('.topbar > *, #brand-icon, #account-bar button, #account-bar a')].map(el => {
      const rect = el.getBoundingClientRect();
      return {element: el.id || el.className, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height};
    }).filter(rect => rect.width > 0 && rect.height > 0);
    return {top: header.top, bottom: header.bottom, content};
  });
  assert(geometry.top >= -1, label + ': global header left the viewport: ' + JSON.stringify(geometry));
  for (const control of geometry.content) {
    assert(control.top >= Math.max(0, geometry.top) - 1 && control.bottom <= geometry.bottom + 1,
      label + ': global header content is clipped: ' + JSON.stringify(control));
  }
}

async function clickHeaderFilter(locator) {
  await locator.click();
  // The filter redraw deliberately restores its header control next frame.
  // Let that accessibility transition finish before another keyboard/scroll
  // action, otherwise the pending restore can steal that action's focus.
  const control = await locator.elementHandle();
  await locator.page().waitForFunction(el => document.activeElement === el, control);
  await control.dispose();
}

async function clickInReadingArea(locator) {
  // Browser automation's default centering ignores stacked sticky bars. Model
  // a user's scroll into the reading area, and keep normal pointer hit testing.
  await locator.evaluate(el => {
    const stickyHeight = ['.topbar', '#system-banner.is-visible', '.atlas-floating-header', '.timeline-toolbar'].reduce((height, selector) => {
      const bar = document.querySelector(selector);
      return height + (bar && getComputedStyle(bar).position === 'sticky' ? bar.getBoundingClientRect().height : 0);
    }, 0);
    // A toolbar still in document flow has a much larger bottom coordinate
    // than its final sticky position, so use the eventual stacked height.
    window.scrollTo({top: scrollY + el.getBoundingClientRect().top - stickyHeight - 12, behavior: 'instant'});
  });
  const target = await locator.elementHandle();
  await locator.page().waitForFunction(el => {
    const rect = el.getBoundingClientRect();
    const at = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return at === el || el.contains(at);
  }, target, {timeout: 5000}).catch(() => {});
  await target.dispose();
  const hit = await locator.evaluate(el => {
    const rect = el.getBoundingClientRect();
    const at = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return {
      ownsPoint: at === el || el.contains(at), target: el.outerHTML.slice(0, 250),
      targetRect: {top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right},
      hitElement: at && at.outerHTML.slice(0, 250), windowScroll: scrollY,
      viewportHeight: innerHeight, documentHeight: document.documentElement.scrollHeight,
      bodyHeight: document.body.scrollHeight, renderedLegs: document.querySelectorAll('[data-timeline-journey]').length,
      bodyScroll: document.body.scrollTop, documentScroll: document.documentElement.scrollTop,
      bodyOverflow: getComputedStyle(document.body).overflow,
      documentOverflow: getComputedStyle(document.documentElement).overflow,
      hasModal: document.body.classList.contains('has-modal'),
      bars: ['.topbar', '.atlas-floating-header', '.timeline-toolbar'].map(selector => {
        const bar = document.querySelector(selector); const box = bar.getBoundingClientRect();
        return {selector, top: box.top, bottom: box.bottom, scrollTop: bar.scrollTop};
      })
    };
  });
  assert(hit.ownsPoint, 'Scrolled record control is still obscured: ' + JSON.stringify(hit));
  await locator.click();
}

async function assertDayFocusVisible(page, label, viewport) {
  // Wait for smooth scrolling as well as focus; focusing the target itself
  // does not mean the browser's movement has reached its final geometry.
  await page.waitForFunction(() => {
    const head = document.querySelector('[data-timeline-day="2030-04-04"] .day-head');
    const wrapper = document.querySelector('.atlas-floating-header');
    const nav = document.querySelector('.mobile-destination-nav');
    const navStyle = nav && getComputedStyle(nav);
    const bottom = navStyle && navStyle.display !== 'none' && navStyle.position === 'fixed' ? nav.getBoundingClientRect().top : innerHeight;
    const rect = head.getBoundingClientRect();
    const toolbar = document.querySelector('.timeline-toolbar');
    const stickyBottom = Math.max(wrapper.getBoundingClientRect().bottom, toolbar.getBoundingClientRect().bottom);
    return document.activeElement === head && rect.top >= stickyBottom - 1 && rect.bottom <= bottom + 1;
  }, null, {timeout: 5000}).catch(error => { throw new Error(label + ': focused day did not become visible beneath sticky controls: ' + error.message); });
  const geometry = await page.evaluate(() => {
    const head = document.querySelector('[data-timeline-day="2030-04-04"] .day-head');
    const header = document.querySelector('.atlas-floating-header');
    const navigation = document.querySelector('.mobile-destination-nav');
    const navStyle = navigation && getComputedStyle(navigation);
    return {
      focus: document.activeElement === head,
      headTop: head.getBoundingClientRect().top, headBottom: head.getBoundingClientRect().bottom,
      stickyBottom: Math.max(header.getBoundingClientRect().bottom, document.querySelector('.timeline-toolbar').getBoundingClientRect().bottom),
      bodyBottom: navStyle && navStyle.display !== 'none' && navStyle.position === 'fixed' ? navigation.getBoundingClientRect().top : innerHeight
    };
  });
  assert.equal(geometry.focus, true, label + ': date jump must focus the day heading');
  assert(geometry.headTop >= geometry.stickyBottom - 1, label + ': focused day is obscured by the sticky controls');
  assert(geometry.headBottom <= Math.min(viewport.height, geometry.bodyBottom) + 1, label + ': focused day is obscured by bottom navigation');
}

async function checkAtlasStickyControls(page, engineName, viewports) {
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    for (const theme of ['light', 'dark']) {
      await seedView(page, 'superuser', 'timeline', theme, departuresFixture());
      const label = engineName + ' sticky Atlas ' + viewport.width + ' ' + theme;
      await page.mouse.move(0, 0);
      const add = page.locator('.atlas-add-strip [data-action="new-activity"]');
      const amendmentStyle = await controlStyle(add);
      assert.equal(await add.evaluate(el => el.classList.contains('wp-amendment')), true, label + ': Add is not marked as an amendment control');
      assert.equal(amendmentStyle.borderStyle, 'solid', label + ': amendment controls need an outline');
      assert(parseFloat(amendmentStyle.borderWidth) > 0, label + ': amendment outline has no width');
      const amendmentColor = await page.evaluate(() => {
        const probe = document.createElement('span');
        probe.style.color = 'var(--wp-action-amendment)';
        document.body.append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      });
      assert.equal(amendmentStyle.border, amendmentColor, label + ': amendment outline does not use the amber semantic token');
      assert.deepEqual(await controlStyle(page.locator('.day-add > summary').first()), amendmentStyle, label + ': day Add should share the amendment outline treatment');
      const firstLeg = page.locator('[data-timeline-journey="cdg-leg-0"]');
      await clickInReadingArea(firstLeg.locator('summary'));
      await page.mouse.move(0, 0);
      const edit = firstLeg.locator('[data-action="edit-transport"]');
      assert.deepEqual(await controlStyle(edit), amendmentStyle, label + ': Edit should share the Add outline treatment');
      await clickInReadingArea(edit);
      await page.mouse.move(0, 0);
      assert.deepEqual(await controlStyle(page.locator('#entity-form button[type="submit"]')), amendmentStyle, label + ': Save should share the amendment outline treatment');
      const editorReturnFocus = await page.evaluateHandle(() => modalReturnFocus);
      await page.locator('.modal-head [data-action="close-modal"]').click();
      await page.waitForSelector('#entity-form', {state: 'detached'});
      await page.waitForFunction(target => document.activeElement === target, editorReturnFocus);
      await editorReturnFocus.dispose();

      // Header person selection changes only the view, not source assignments.
      await clickHeaderFilter(page.locator('.atlas-companion-bar [data-action="toggle-companion-filter"][data-id="cdg-person-0"]'));
      await page.mouse.move(0, 0);
      const person = page.locator('.atlas-companion-bar [data-id="cdg-person-0"][aria-pressed="true"]');
      const agenda = page.locator('.atlas-itinerary-switch [data-tab="timeline"][aria-current="page"]');
      const selectedStyle = await controlStyle(person);
      assert.equal(await person.evaluate(el => el.classList.contains('wp-selection')), true, label + ': selected person lacks the common selection class');
      assert.deepEqual(await controlStyle(agenda), selectedStyle, label + ': selected view and person should have the same treatment');
      if (viewport.width === 1440) assert.deepEqual(await controlStyle(page.locator('.atlas-rail-button[aria-current="page"]')), selectedStyle, label + ': selected rail section differs from the common selection treatment');
      assert.notEqual(selectedStyle.border, amendmentStyle.border, label + ': selection and amendment states need distinguishable outlines');
      await clickHeaderFilter(page.locator('.atlas-companion-bar [data-action="show-all-people"]'));
      await clickInReadingArea(page.locator('[data-timeline-journey="cdg-leg-0"] summary'));

      // A watermark lives behind interactive content and uses the real logo.
      const watermark = await page.evaluate(() => {
        for (const selector of ['body', '#app', '.atlas-trip-layout', '.atlas-trip-main', '.atlas-floating-header']) {
          const element = document.querySelector(selector);
          if (!element) continue;
          for (const pseudo of ['::before', '::after']) {
            const style = getComputedStyle(element, pseudo);
            if (style.backgroundImage.includes('waypoint-mark')) return {image: style.backgroundImage, opacity: Number(style.opacity), pointerEvents: style.pointerEvents};
          }
        }
        return null;
      });
      assert(watermark, label + ': logo watermark pseudo-element is missing');
      assert(watermark.opacity > 0 && watermark.opacity <= 0.3, label + ': logo watermark should be visible but subtle');
      assert.equal(watermark.pointerEvents, 'none', label + ': watermark must not intercept controls');

      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForFunction(() => {
        const header = document.querySelector('.atlas-floating-header').getBoundingClientRect();
        return Math.abs(header.top - document.querySelector('.topbar').getBoundingClientRect().bottom) <= 2;
      });
      const sticky = await page.evaluate(() => {
        const wrapper = document.querySelector('.atlas-floating-header');
        const rect = wrapper.getBoundingClientRect();
        const nav = document.querySelector('.mobile-destination-nav');
        const navStyle = nav && getComputedStyle(nav);
        return {
          titleBottom: document.querySelector('.atlas-trip-identity').getBoundingClientRect().bottom,
          topbarTop: document.querySelector('.topbar').getBoundingClientRect().top,
          topbarBottom: document.querySelector('.topbar').getBoundingClientRect().bottom,
          windowScroll: scrollY, bodyScroll: document.body.scrollTop, documentScroll: document.documentElement.scrollTop,
          bodyOverflow: getComputedStyle(document.body).overflow, documentOverflow: getComputedStyle(document.documentElement).overflow,
          bodySpace: (navStyle && navStyle.display !== 'none' && navStyle.position === 'fixed' ? nav.getBoundingClientRect().top : innerHeight) - rect.bottom,
          overflow: getComputedStyle(wrapper).overflowY, scrollHeight: wrapper.scrollHeight, clientHeight: wrapper.clientHeight
        };
      });
      assert(sticky.topbarTop >= -1, label + ': global topbar is clipped: ' + JSON.stringify(sticky));
      await assertGlobalHeaderVisible(page, label);
      assert(sticky.titleBottom <= sticky.topbarBottom + 1, label + ': trip title should scroll away');
      assert(sticky.bodySpace >= 100, label + ': sticky controls leave too little space to read the itinerary');
      if (sticky.scrollHeight > sticky.clientHeight + 1) {
        assert(['auto', 'scroll'].includes(sticky.overflow), label + ': capped controls must remain internally scrollable');
        const scrollable = await page.locator('.atlas-floating-header').evaluate(el => { el.scrollTop = el.scrollHeight; const moved = el.scrollTop > 0; el.scrollTop = 0; return moved; });
        assert(scrollable, label + ': small-screen header overflow cannot be reached');
      }
      // The focus target must land below the complete measured sticky header.
      const jump = page.locator('.timeline-date-jump input[type="text"]');
      await jump.fill('04/Apr/2030');
      await jump.press('Tab');
      await page.waitForFunction(() => document.activeElement && document.activeElement.matches('[data-timeline-day="2030-04-04"] .day-head'));
      await assertDayFocusVisible(page, label, viewport);
      await assertGlobalHeaderVisible(page, label + ' after date jump');
      if (viewport.width === 390 || viewport.width === 1440) {
        await page.screenshot({path: path.join(SCREENSHOTS, engineName.toLowerCase() + '-atlas-scrolled-' + viewport.width + '-' + theme + '.png')});
      }

      await page.evaluate(() => window.dispatchEvent(new Event('offline')));
      await page.waitForFunction(() => {
        const banner = document.querySelector('#system-banner');
        const wrapper = document.querySelector('.atlas-floating-header');
        return banner.classList.contains('is-visible') && Math.abs(wrapper.getBoundingClientRect().top - banner.getBoundingClientRect().bottom) <= 2;
      });
      assert.equal(await page.locator('.atlas-add-strip [data-action="new-activity"]').isDisabled(), true, label + ': offline header Add stayed enabled');

      // Map layer selection uses the same turquoise state, independent of its
      // category marker color. Re-seeding restores online editing and filters.
      await seedView(page, 'superuser', 'map', theme);
      await page.mouse.move(0, 0);
      const mapView = page.locator('.atlas-itinerary-switch [data-tab="map"][aria-current="page"]');
      const mapSelectedStyle = await controlStyle(mapView);
      const mapLayer = page.locator('.map-filter-chip[data-layer="activities"][aria-pressed="true"]');
      assert.deepEqual(await controlStyle(mapLayer), mapSelectedStyle, label + ': selected map layer differs from the common selection state');
      assert.deepEqual(mapSelectedStyle, selectedStyle, label + ': selection colors differ between Agenda and Map');
      await mapLayer.click();
      await page.mouse.move(0, 0);
      assert.notEqual((await controlStyle(page.locator('.map-filter-chip[data-layer="activities"]'))).background, mapSelectedStyle.background, label + ': deselecting a map layer left its selected background');
      await page.locator('.map-filter-chip[data-layer="activities"]').click();
      await page.mouse.move(0, 0);
      assert.deepEqual(await controlStyle(page.locator('.map-filter-chip[data-layer="activities"]')), mapSelectedStyle, label + ': reselecting a layer did not restore the shared selected treatment');
    }
  }
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
      await clickHeaderFilter(page.locator('.atlas-companion-bar [data-action="show-all-people"]'));
      assert.equal(await legs.nth(0).evaluate(el => el.open), true, label + ': rendering lost the open booking');
      await legs.nth(1).locator('summary').focus();
      await page.keyboard.press('Space');
      await page.waitForFunction(() => document.querySelector('[data-timeline-journey="cdg-leg-1"]').open);
      await clickInReadingArea(legs.nth(0).locator('summary'));
      assert.equal(await legs.nth(0).evaluate(el => el.open), false);
      assert.equal(await legs.nth(1).evaluate(el => el.open), true, label + ': disclosures are not independent');

      // Source editing opens one original booking and its own assignment.
      await clickInReadingArea(legs.nth(2).locator('summary'));
      await clickInReadingArea(legs.nth(2).locator('[data-action="edit-transport"]'));
      assert.equal(await page.locator('#entity-form input[name="flightNumber"]').inputValue(), 'AF102');
      assert.equal(await page.locator('#entity-form input[name="bookingRef"]').inputValue(), 'CDG-BOOKING-2');
      assert.equal(await page.locator('#entity-form input[data-tag-person-id="cdg-person-2"]').isChecked(), true);
      assert.equal(await page.locator('#entity-form input[data-tag-person-id="cdg-person-1"]').isChecked(), false);
      const editorReturnFocus = await page.evaluateHandle(() => modalReturnFocus);
      await page.locator('.modal-head [data-action="close-modal"]').click();
      await page.waitForSelector('#entity-form', {state: 'detached'});
      // Dismissal restores the editor opener on the next animation frame.
      // Wait for that accessibility behavior before moving keyboard focus.
      await page.waitForFunction(target => document.activeElement === target, editorReturnFocus);
      await editorReturnFocus.dispose();

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
      await page.waitForFunction(() => document.activeElement && document.activeElement.dataset.action === 'timeline-toggle-all');

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
      await clickHeaderFilter(page.locator('.atlas-companion-bar [data-action="toggle-companion-filter"][data-id="cdg-person-0"]'));
      assert.equal(await page.locator('.timeline-journey-group').count(), 0, label + ': a one-person result still implies six departures');
      assert.equal(await page.locator('[data-action="edit-transport"][data-id="cdg-leg-0"]').count(), 1);
      assert.equal(await page.locator('[data-action="edit-transport"][data-id="cdg-leg-1"]').count(), 0, label + ': hidden plan still rendered');
      assert.equal(await page.evaluate(() => currentTrip().transport.length), 6, label + ': a view filter mutated source bookings');
      await clickHeaderFilter(page.locator('.atlas-companion-bar [data-action="show-all-people"]'));
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
    await checkAtlasStickyControls(page, engineName, viewports);

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
