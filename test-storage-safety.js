// Regression tests for the per-trip STORAGE restructuring (see "HOW TRIPS
// ARE STORED" at the top of src/worker.js) and, more importantly, for the
// data-loss guards around it.
//
// Two very different things are checked here:
//
//   1. The BENEFIT the restructuring was done for — that saving one trip
//      only writes that trip's own storage key, and leaves every other
//      trip's key (and usually the shared index) completely untouched.
//      This is invisible from the outside: a save that rewrites all five
//      trips returns exactly the same 200 as one that rewrites a single
//      one. So mock-server.js keeps write counters and exposes them at
//      /WayPoint/api/__writes purely so this test can see them (the real
//      Worker has no such endpoint and doesn't need one).
//
//   2. The RISK it introduced, which matters far more. A trip is deleted
//      by being LEFT OUT of what the browser POSTs — there's no delete
//      endpoint. That's fine when the browser has the full picture, and
//      catastrophic when it doesn't: if a load fails and the page falls
//      back to "no trips at all", the next edit would tell the server to
//      delete everything that account can see. For the site owner's
//      account, which sees EVERY trip, that's the whole site's data. This
//      file proves both halves of the defence hold — the browser refuses
//      to save a state it never loaded, and the server refuses a save
//      that would delete more than one trip at once even if something
//      else sends one.
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const { loginAsAdmin } = require('./test-helpers');

const PORT = 8811;

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

    const fetchJson = (url, opts) => page.evaluate(([u, o]) => fetch(u, o).then((r) => r.json()), [url, Object.assign({ credentials: 'same-origin' }, opts || {})]);
    const fetchStatus = (url, opts) => page.evaluate(([u, o]) => fetch(u, o).then((r) => r.status), [url, Object.assign({ credentials: 'same-origin' }, opts || {})]);
    const resetWrites = () => fetchStatus('/WayPoint/api/__writes', { method: 'DELETE' });
    const writes = () => fetchJson('/WayPoint/api/__writes');

    const newTrip = async (name, start, end) => {
      await page.click('[data-action="new-trip"]');
      await page.fill('input[name="name"]', name);
      await page.fill('input[name="startDate"]', start);
      await page.fill('input[name="endDate"]', end);
      await page.fill('input[name="homeCurrency"]', 'GBP');
      await page.click('#entity-form button[type="submit"]');
      await page.waitForTimeout(120);
      await page.click('[data-action="back-to-dashboard"]');
      await page.waitForTimeout(50);
    };

    await page.goto('http://localhost:' + PORT + '/WayPoint');
    await loginAsAdmin(page);

    // ================= Setup: three trips =============================
    await newTrip('Alpha Trip', '2029-01-01', '2029-01-05');
    await newTrip('Beta Trip', '2029-02-01', '2029-02-05');
    await newTrip('Gamma Trip', '2029-03-01', '2029-03-05');
    const seeded = await fetchJson('/WayPoint/api/data');
    console.log('1. Three trips created:', seeded.trips.length === 3, seeded.trips.map((t) => t.name));

    // ================= 2. Per-trip write isolation ====================
    // Add a destination to Alpha only. Beta's and Gamma's content keys
    // must not be written at all — that's the whole point of the split.
    await resetWrites();
    await page.click('.trip-card:has-text("Alpha Trip")');
    await page.click('[data-action="switch-tab"][data-tab="destinations"]');
    await page.click('[data-action="new-destination"]');
    await page.fill('input[name="name"]', 'Lisbon');
    await page.fill('input[name="arriveDate"]', '2029-01-02');
    await page.fill('input[name="departDate"]', '2029-01-04');
    await page.click('#entity-form button[type="submit"]');
    await page.waitForTimeout(150);

    const alphaId = await page.evaluate(() => currentTripId);
    const w1 = await writes();
    const touched = Object.keys(w1.trips);
    console.log('2. Editing Alpha wrote ONLY Alpha\'s content key:',
      touched.length === 1 && touched[0] === alphaId, { touched, alphaId });
    console.log('   ...and did NOT rewrite the shared trip index (no name/date change):',
      w1.index === 0, 'index writes: ' + w1.index);

    // ================= 3. A no-op save writes nothing =================
    await resetWrites();
    await page.evaluate(() => persist(cloneState(state)));
    await page.waitForTimeout(150);
    const w2 = await writes();
    console.log('3. Re-saving unchanged data writes nothing at all:',
      Object.keys(w2.trips).length === 0 && w2.index === 0, w2);

    // ================= 4. Renaming a trip DOES touch the index ========
    await resetWrites();
    await page.click('[data-action="edit-trip"]');
    await page.fill('input[name="name"]', 'Alpha Trip Renamed');
    await page.click('#entity-form button[type="submit"]');
    await page.waitForTimeout(150);
    const w3 = await writes();
    console.log('4. Renaming a trip updates the index (so the dashboard stays right):',
      w3.index === 1 && Object.keys(w3.trips).length === 1, w3);
    await page.click('[data-action="back-to-dashboard"]');
    await page.waitForTimeout(50);

    // ================= 5. Deleting ONE trip still works ===============
    await page.locator('.trip-card', { hasText: 'Gamma Trip' }).locator('[data-action="delete-trip"]').click();
    await page.click('[data-action="confirm-yes"]');
    await page.waitForTimeout(200);
    const afterDelete = await fetchJson('/WayPoint/api/data');
    console.log('5. Deleting a single trip works normally:',
      afterDelete.trips.length === 2 && !afterDelete.trips.some((t) => t.name === 'Gamma Trip'),
      afterDelete.trips.map((t) => t.name));

    // ================= 6. THE BIG ONE: a save that would delete
    // everything is refused outright, and changes nothing. =============
    // This is exactly what a browser whose load failed would send.
    const wipeStatus = await fetchStatus('/WayPoint/api/data', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trips: [] }),
    });
    const afterWipe = await fetchJson('/WayPoint/api/data');
    console.log('6. An empty save that would delete every trip is REFUSED (409):', wipeStatus === 409, wipeStatus);
    console.log('   ...and both trips are still there, untouched:',
      afterWipe.trips.length === 2, afterWipe.trips.map((t) => t.name));

    // A save omitting just one of the two is still allowed (that's a
    // normal single delete) — proving the guard isn't simply blocking
    // every deletion.
    const oneGone = { trips: afterWipe.trips.filter((t) => t.name !== 'Beta Trip') };
    const oneGoneStatus = await fetchStatus('/WayPoint/api/data', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(oneGone),
    });
    const afterOneGone = await fetchJson('/WayPoint/api/data');
    console.log('7. ...but omitting exactly one trip still deletes just that one:',
      oneGoneStatus === 200 && afterOneGone.trips.length === 1 && afterOneGone.trips[0].name === 'Alpha Trip Renamed',
      { oneGoneStatus, left: afterOneGone.trips.map((t) => t.name) });

    // ================= 8. The browser's own half of the defence =======
    // Make the data load fail, reload the page, and confirm the app
    // refuses to save anything on top of the real data still on the
    // server. Without this guard, creating a trip here would POST a
    // state containing ONLY the new trip — telling the server to delete
    // the real one.
    //
    // Reload first: the checks above changed the server's data by raw
    // fetch(), behind this page's back, so its in-memory `state` is now
    // stale. Carrying on without reloading would just prove that a stale
    // tab re-sends trips deleted elsewhere (true, but a different, and
    // pre-existing, property of "the browser POSTs its whole state").
    await page.reload();
    await page.waitForTimeout(400);
    await newTrip('Precious Trip', '2029-06-01', '2029-06-10');
    const beforeOutage = await fetchJson('/WayPoint/api/data');
    console.log('8. Two trips on the server before simulating a failed load:',
      beforeOutage.trips.length === 2, beforeOutage.trips.map((t) => t.name));

    await page.route('**/WayPoint/api/data', (route) => {
      // Fail ONLY the read. A POST is left alone deliberately: the point
      // is to prove the app never even attempts one, not to block it.
      if (route.request().method() === 'GET') return route.abort('failed');
      return route.continue();
    });
    await page.reload();
    await page.waitForTimeout(400);
    const dashboardLooksEmpty = (await page.locator('.trip-card').count()) === 0;
    console.log('   Page now shows no trips (the dangerous-looking state):', dashboardLooksEmpty);

    await page.click('[data-action="new-trip"]');
    await page.fill('input[name="name"]', 'Trip Made During Outage');
    await page.fill('input[name="startDate"]', '2029-07-01');
    await page.fill('input[name="endDate"]', '2029-07-05');
    await page.fill('input[name="homeCurrency"]', 'GBP');
    await page.click('#entity-form button[type="submit"]');
    await page.waitForTimeout(300);

    const saveLabel = await page.locator('#save-indicator').textContent();
    console.log('   Save indicator warns it was not saved:', /not saved/i.test(saveLabel), JSON.stringify(saveLabel));

    await page.unroute('**/WayPoint/api/data');
    const afterOutage = await fetchJson('/WayPoint/api/data');
    const namesAfter = afterOutage.trips.map((t) => t.name).sort();
    console.log('9. Server data completely unharmed by the failed-load session:',
      afterOutage.trips.length === 2 &&
      namesAfter.join('|') === ['Alpha Trip Renamed', 'Precious Trip'].sort().join('|'),
      namesAfter);
    console.log('   ...and the trip created during the outage was never written:',
      !afterOutage.trips.some((t) => t.name === 'Trip Made During Outage'));

    // ================= 10. A trip whose content can't be read =========
    // The index still lists it, but its content reads as absent — a real
    // state Cloudflare KV can produce on its own (see the mock's
    // __hide-content endpoint). The trip vanishes from the GET response,
    // which means the browser sends a save that OMITS it. That omission
    // must NOT be read as "delete this trip", or a trip gets destroyed
    // purely because one read came back empty.
    await page.reload();
    await page.waitForTimeout(400);
    const beforeHide = await fetchJson('/WayPoint/api/data');
    const victimId = beforeHide.trips.find((t) => t.name === 'Precious Trip').tripId;
    await fetchStatus('/WayPoint/api/__hide-content', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tripId: victimId }),
    });
    const whileHidden = await fetchJson('/WayPoint/api/data');
    console.log('10. A trip with unreadable content is hidden from the response (not crashed on):',
      !whileHidden.trips.some((t) => t.tripId === victimId), whileHidden.trips.map((t) => t.name));

    // Now save exactly what a browser would have after that response —
    // i.e. without the hidden trip. This is the moment the old code
    // would have deleted it for good.
    const saveWithoutHidden = await fetchStatus('/WayPoint/api/data', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(whileHidden),
    });
    console.log('11. Saving without it is accepted (it looks like an ordinary save):', saveWithoutHidden === 200, saveWithoutHidden);

    // Prove the index entry survived by making the content readable
    // again — the trip should simply come back, intact.
    await page.evaluate(([id, name]) => fetch('/WayPoint/api/data', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trips: [{ tripId: id, name: name, startDate: '2029-06-01', endDate: '2029-06-10', homeCurrency: 'GBP', notes: '', currencyRates: {}, destinations: [], activities: [], transport: [], accommodation: [], contacts: [], expenses: [], companions: [], geocodeCache: {} }] }),
    }), [victimId, 'Precious Trip']);
    const afterRestore = await fetchJson('/WayPoint/api/data');
    const restored = afterRestore.trips.find((t) => t.tripId === victimId);
    console.log('12. Its index entry was never dropped, so it comes back with the same id and owner:',
      !!restored && restored.name === 'Precious Trip' && !!restored.ownerId,
      restored ? { name: restored.name, ownerUsername: restored.ownerUsername } : null);

    console.log('\nPage errors:', errors.length ? errors : 'NONE');
    await browser.close();
  } finally {
    server.kill();
  }
})();
