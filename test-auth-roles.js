// Regression test for the PER-TRIP ownership + grants permission system
// (see the big "WHO IS ALLOWED IN" and "SAVING SAFELY" comments at the
// top of src/worker.js, mirrored in mock-server.js): the first-run
// "/api/setup" bootstrap screen (which now creates the site's
// undisclosed "uber-user" account, not a global "Admin"); that creating
// a trip makes you its permanent Superuser automatically; the "Share
// this trip" panel a Superuser uses to grant Admin/User/Viewer access to
// existing accounts; that a User/Viewer grant is scoped to exactly the
// items tagged with the companion it's linked as; and — the trickiest
// part of this whole design — that the save endpoint's safe per-trip
// merge genuinely can't be tricked into corrupting or deleting data
// outside whatever the requesting account is actually allowed to touch,
// even via a raw fetch() that bypasses the UI entirely and hand-crafts
// a malicious request body.
//
// Runs its own mock server with --empty-users (see mock-server.js) so it
// can exercise the true first-run experience — every OTHER test file
// uses the normal pre-seeded uber-user account (see test-helpers.js)
// since they don't care about the bootstrap flow itself.
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const { loginAs } = require('./test-helpers');

const PORT = 8809;
const SETUP_KEY = 'setup-key-for-tests'; // matches mock-server.js's SETUP_KEY

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
  const server = spawn('node', ['mock-server.js', String(PORT), '--empty-users'], { cwd: __dirname, stdio: 'inherit' });
  try {
    await waitForServer('http://localhost:' + PORT + '/WayPoint');
    const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    const directFetchStatus = (url, opts) => page.evaluate(([u, o]) => fetch(u, o).then((r) => r.status), [url, Object.assign({ credentials: 'same-origin' }, opts || {})]);
    const directFetchJson = (url, opts) => page.evaluate(([u, o]) => fetch(u, o).then((r) => r.json()), [url, Object.assign({ credentials: 'same-origin' }, opts || {})]);

    // ================= 1. First-run setup ==============================
    await page.goto('http://localhost:' + PORT + '/WayPoint');
    await page.waitForSelector('#setup-form', { timeout: 5000 });
    console.log('1. No accounts yet -> shows the first-run setup screen (not a login form):', (await page.locator('#login-form').count()) === 0);

    await page.fill('#setup-form input[name="setupKey"]', 'wrong-key');
    await page.fill('#setup-form input[name="username"]', 'boss');
    await page.fill('#setup-form input[name="password"]', 'adminpass1');
    await page.click('#setup-form button[type="submit"]');
    await page.waitForSelector('.auth-error', { timeout: 5000 });
    console.log('2. Wrong setup key is rejected with an error, still on the setup screen:', (await page.locator('#setup-form').count()) === 1);

    await page.fill('#setup-form input[name="setupKey"]', SETUP_KEY);
    await page.fill('#setup-form input[name="username"]', 'boss');
    await page.fill('#setup-form input[name="password"]', 'adminpass1');
    await page.click('#setup-form button[type="submit"]');
    await page.waitForSelector('.empty-state, .trip-grid', { timeout: 5000 });
    const accountBarText = await page.locator('#account-bar').textContent();
    console.log('3. Correct setup key creates the account and logs straight in (site owner):', /boss/.test(accountBarText), accountBarText);

    // These two look trivial and are not: the `isUberUser` flag going
    // missing from the login/whoami/setup responses is EXACTLY the bug
    // that reached production once already. Everything still worked
    // except that the site owner silently lost the "Manage accounts"
    // button and had no way to create anyone else's login. Nothing
    // asserted the flag at the time, so nothing caught it — the mock
    // server had it right and the real Worker had drifted. Assert both
    // the API field and the button it drives.
    const whoamiAsOwner = await directFetchJson('/WayPoint/api/whoami');
    console.log('    ...and /api/whoami reports isUberUser for the site owner:', whoamiAsOwner.isUberUser === true, whoamiAsOwner.isUberUser);
    console.log('    ...so the "Manage accounts" button is actually there:', (await page.locator('[data-action="open-manage-users"]').count()) === 1);

    const replaySetupStatus = await directFetchStatus('/WayPoint/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ setupKey: SETUP_KEY, username: 'someone-else', password: 'irrelevant1' }) });
    console.log('4. Setup refuses to run a second time (403) now that an account exists:', replaySetupStatus === 403, replaySetupStatus);

    // ================= 2. boss creates Trip A and becomes its Superuser =
    await page.click('[data-action="new-trip"]');
    await page.fill('input[name="name"]', 'Roles Test Trip');
    await page.fill('input[name="startDate"]', '2028-01-01');
    await page.fill('input[name="endDate"]', '2028-01-10');
    await page.fill('input[name="homeCurrency"]', 'GBP');
    await page.click('#entity-form button[type="submit"]');
    await page.waitForTimeout(100);
    const tripAId = await page.evaluate(() => currentTripId);
    console.log('5. Creating a trip immediately shows full-scope controls (Superuser by default):', (await page.locator('[data-action="edit-trip"]').count()) > 0);

    await page.click('[data-action="switch-tab"][data-tab="companions"]');
    await page.click('[data-action="new-companion"]');
    await page.fill('input[name="name"]', 'Sarah');
    await page.click('#entity-form button[type="submit"]');
    await page.waitForTimeout(80);
    await page.click('[data-action="new-companion"]');
    await page.fill('input[name="name"]', 'Mike');
    await page.click('#entity-form button[type="submit"]');
    await page.waitForTimeout(80);

    // D1 tagged Sarah only; D2 tagged Mike only.
    await page.click('[data-action="switch-tab"][data-tab="destinations"]');
    await page.click('[data-action="new-destination"]');
    await page.fill('input[name="name"]', 'Sarah Only Place');
    await page.fill('input[name="arriveDate"]', '2028-01-02');
    await page.fill('input[name="departDate"]', '2028-01-04');
    await page.locator('.tag-picker-item', { hasText: 'Sarah' }).locator('input[type="checkbox"]').check();
    await page.click('#entity-form button[type="submit"]');
    await page.waitForTimeout(80);
    await page.click('[data-action="new-destination"]');
    await page.fill('input[name="name"]', 'Mike Only Place');
    await page.fill('input[name="arriveDate"]', '2028-01-05');
    await page.fill('input[name="departDate"]', '2028-01-07');
    await page.locator('.tag-picker-item', { hasText: 'Mike' }).locator('input[type="checkbox"]').check();
    await page.click('#entity-form button[type="submit"]');
    await page.waitForTimeout(80);

    // Activity tagged Mike only.
    await page.click('[data-action="switch-tab"][data-tab="activities"]');
    await page.click('[data-action="new-activity"]');
    await page.fill('input[name="title"]', 'Mike\'s solo museum trip');
    await page.fill('input[name="date"]', '2028-01-06');
    await page.locator('.tag-picker-item', { hasText: 'Mike' }).locator('input[type="checkbox"]').check();
    await page.click('#entity-form button[type="submit"]');
    await page.waitForTimeout(80);

    // Transport tagged BOTH.
    await page.click('[data-action="switch-tab"][data-tab="transport"]');
    await page.click('[data-action="new-transport"]');
    await page.fill('input[name="fromLocation"]', 'LHR');
    await page.fill('input[name="toLocation"]', 'BKK');
    await page.fill('input[name="departDate"]', '2028-01-02');
    await page.fill('input[name="arriveDate"]', '2028-01-02');
    await page.locator('.tag-picker-item', { hasText: 'Sarah' }).locator('input[type="checkbox"]').check();
    await page.locator('.tag-picker-item', { hasText: 'Mike' }).locator('input[type="checkbox"]').check();
    await page.click('#entity-form button[type="submit"]');
    await page.waitForTimeout(80);

    // An expense — a "user"/"viewer" grant should never see ANY expenses.
    await page.click('[data-action="switch-tab"][data-tab="expenses"]');
    await page.click('[data-action="new-expense"]');
    await page.fill('input[name="description"]', 'Group dinner');
    await page.fill('input[name="date"]', '2028-01-02');
    await page.fill('input[name="amount"]', '80');
    await page.fill('input[name="currency"]', 'GBP');
    await page.click('#entity-form button[type="submit"]');
    await page.waitForTimeout(80);
    await page.click('[data-action="back-to-dashboard"]');

    // ================= 3. Manage accounts (site owner only) — logins only,
    // no role/links here anymore (that all moved to the Share panel). ====
    await page.click('[data-action="open-manage-users"]');
    await page.waitForSelector('.tab-panel-head h2:has-text("Manage accounts")', { timeout: 5000 });
    console.log('6. Manage accounts screen has no role selector anymore (roles are per-trip now):', (await page.locator('select[name="role"]').count()) === 0);

    for (const acct of [['admin1', 'adminpass1'], ['sarah1', 'sarahpass1'], ['viewer1', 'viewerpass1'], ['outsider1', 'outsiderpass1']]) {
      await page.click('[data-action="new-user"]');
      await page.fill('#user-form input[name="username"]', acct[0]);
      await page.fill('#user-form input[name="password"]', acct[1]);
      await page.click('#user-form button[type="submit"]');
      await page.waitForTimeout(80);
    }
    // 5, not 4: the site owner's own account (boss) is listed here too —
    // Manage accounts shows every login, including the one you're using.
    const managedRows = await page.locator('.item-list .item-row').allTextContents();
    console.log('7. All four new accounts were created (plus boss\'s own):', managedRows.length === 5, managedRows.length);

    // ================= 4. Share Trip A: admin1 -> Admin, sarah1 -> User
    // (as Sarah), viewer1 -> Viewer (as Mike). outsider1 gets nothing. ===
    await page.click('[data-action="back-to-dashboard"]');
    await page.click('.trip-card');
    await page.click('[data-action="switch-tab"][data-tab="settings"]');
    await page.waitForSelector('.share-panel', { timeout: 5000 });

    async function shareWith(username, role, companionName) {
      await page.fill('#share-form input[name="username"]', username);
      await page.selectOption('#share-form select[name="role"]', role);
      if (companionName) {
        await page.waitForTimeout(30);
        await page.selectOption('#share-form select[name="companionId"]', { label: companionName });
      }
      await page.click('#share-form button[type="submit"]');
      await page.waitForTimeout(120);
      await page.waitForSelector('.share-panel', { timeout: 5000 });
    }
    await shareWith('admin1', 'admin');
    await shareWith('sarah1', 'user', 'Sarah');
    await shareWith('viewer1', 'viewer', 'Mike');

    const shareRows = await page.locator('.share-panel .item-list .item-row').allTextContents();
    console.log('8. Share panel lists all three grants with the right roles/scopes:',
      shareRows.length === 3 &&
      shareRows.some((t) => /admin1/.test(t) && /Admin/.test(t)) &&
      shareRows.some((t) => /sarah1/.test(t) && /User/.test(t) && /Sarah/.test(t)) &&
      shareRows.some((t) => /viewer1/.test(t) && /Viewer/.test(t) && /Mike/.test(t)),
      shareRows);

    const shareUnknownStatus = await directFetchStatus('/WayPoint/api/trip-grants', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tripId: tripAId, username: 'nobody-such-account', role: 'viewer', companionId: 'x' }) });
    console.log('9. Sharing with a username that doesn\'t exist is refused:', shareUnknownStatus === 404, shareUnknownStatus);

    // ================= 5. admin1: full read/write on Trip A, but no
    // sharing control, and sees a trip of their OWN as its Superuser =====
    await page.click('[data-action="logout"]');
    await page.waitForSelector('#login-form', { timeout: 5000 });
    await loginAs(page, 'admin1', 'adminpass1');
    await page.waitForSelector('.trip-grid', { timeout: 5000 });
    console.log('10. admin1 (Admin grant) sees Trip A:', (await page.locator('.trip-card').count()) === 1);
    // The other half of the isUberUser check above: an ordinary account
    // must NOT be told it's the uber-user, and must not get the button.
    const whoamiAsAdmin1 = await directFetchJson('/WayPoint/api/whoami');
    console.log('    ...and an ordinary account is NOT flagged as the uber-user:', whoamiAsAdmin1.isUberUser === false, whoamiAsAdmin1.isUberUser);
    console.log('    ...so it never sees the "Manage accounts" button:', (await page.locator('[data-action="open-manage-users"]').count()) === 0);
    await page.click('.trip-card');
    await page.click('[data-action="switch-tab"][data-tab="destinations"]');
    console.log('11. admin1 (Admin grant) can Add items (full read/write on the trip\'s data):', await page.locator('[data-action="new-destination"]').isVisible());
    await page.click('[data-action="switch-tab"][data-tab="settings"]');
    console.log('12. admin1 does NOT see the "Share this trip" panel (only a Superuser can share):', (await page.locator('.share-panel').count()) === 0);
    const admin1ShareAttempt = await directFetchStatus('/WayPoint/api/trip-grants', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tripId: tripAId, username: 'outsider1', role: 'viewer', companionId: 'x' }) });
    console.log('13. ...and the server refuses a direct sharing attempt from admin1 too (not just hides the UI):', admin1ShareAttempt === 403, admin1ShareAttempt);

    // admin1 creates their OWN trip and becomes ITS Superuser.
    await page.click('[data-action="back-to-dashboard"]');
    await page.click('[data-action="new-trip"]');
    await page.fill('input[name="name"]', "Admin1's Own Trip");
    await page.fill('input[name="startDate"]', '2028-05-01');
    await page.fill('input[name="endDate"]', '2028-05-05');
    await page.fill('input[name="homeCurrency"]', 'GBP');
    await page.click('#entity-form button[type="submit"]');
    await page.waitForTimeout(100);
    const tripBId = await page.evaluate(() => currentTripId);
    await page.click('[data-action="switch-tab"][data-tab="settings"]');
    console.log('14. On a trip THEY created, admin1 IS the Superuser (Share panel visible):', (await page.locator('.share-panel').count()) === 1);
    await page.click('[data-action="back-to-dashboard"]');
    await page.click('[data-action="logout"]');
    await page.waitForSelector('#login-form', { timeout: 5000 });

    // ================= 6. sarah1 ("user" grant, scoped to Sarah) =======
    await loginAs(page, 'sarah1', 'sarahpass1');
    await page.waitForSelector('.trip-grid', { timeout: 5000 });
    const sarahTripCards = await page.locator('.trip-card').allTextContents();
    console.log('15. sarah1 sees ONLY Trip A (not admin1\'s trip, not the fully-unshared one):',
      sarahTripCards.length === 1 && /Roles Test Trip/.test(sarahTripCards[0]));

    await page.click('.trip-card');
    console.log('16. sarah1 cannot edit/delete the trip itself (no Superuser/Admin controls in the header):', (await page.locator('[data-action="edit-trip"]').count()) === 0);
    await page.click('[data-action="switch-tab"][data-tab="destinations"]');
    const sarahDestRows = await page.locator('.item-list .item-row').allTextContents();
    console.log('17. Destinations: only the Sarah-tagged one shows, the Mike-only one is excluded:',
      sarahDestRows.length === 1 && /Sarah Only Place/.test(sarahDestRows[0]), sarahDestRows);
    console.log('    ...and there\'s no "Add destination" button (a "user" grant can\'t create items):', (await page.locator('[data-action="new-destination"]').count()) === 0);

    await page.click('[data-action="switch-tab"][data-tab="activities"]');
    console.log('18. Activities: the Mike-only activity is fully excluded (empty tab):', (await page.locator('.empty-state').count()) === 1);

    await page.click('[data-action="switch-tab"][data-tab="transport"]');
    console.log('19. Transport: the leg tagged to BOTH companions is included:', (await page.locator('.item-list .item-row').count()) === 1);

    console.log('20. Expenses tab is hidden entirely for a "user" grant:', (await page.locator('[data-tab="expenses"]').count()) === 0);

    // Edit sarah1's own tagged destination: the tag-picker is locked, but
    // an ordinary field can still be changed and saved.
    await page.click('[data-action="switch-tab"][data-tab="destinations"]');
    await page.locator('.item-row', { hasText: 'Sarah Only Place' }).locator('[data-action="edit-destination"]').click();
    await page.waitForTimeout(50);
    const tagPickerDisabled = await page.locator('.tag-picker-item input[type="checkbox"]').first().isDisabled();
    console.log('21. Editing their own tagged item locks the Companions tag-picker:', tagPickerDisabled);
    await page.fill('textarea[name="notes"]', 'sarah added a note');
    await page.click('#entity-form button[type="submit"]');
    await page.waitForTimeout(100);
    const sarahEditedRow = await page.locator('.item-row', { hasText: 'Sarah Only Place' }).textContent();
    console.log('22. That field-level edit actually saved:', /sarah added a note/.test(sarahEditedRow));
    console.log('    ...and there\'s no Delete button on their own item (can edit, never delete):', (await page.locator('.item-row', { hasText: 'Sarah Only Place' }).locator('[data-action="delete-destination"]').count()) === 0);

    // ---- The important part: server-side write boundaries, proven with
    // a raw fetch() that bypasses the UI and hand-crafts a hostile body.
    const sarahScoped = await directFetchJson('/WayPoint/api/data');
    const tripAScoped = sarahScoped.trips.find((t) => t.tripId === tripAId);
    const sarahOnlyDest = tripAScoped.destinations.find((d) => d.name === 'Sarah Only Place');
    const attackBody = JSON.parse(JSON.stringify(sarahScoped));
    const attackTrip = attackBody.trips.find((t) => t.tripId === tripAId);
    attackTrip.name = 'HACKED BY SARAH';                                    // (a) trip-level field
    attackTrip.destinations.find((d) => d.destinationId === sarahOnlyDest.destinationId).companions.push('mike-fake-id'); // (b) retag
    attackTrip.destinations = attackTrip.destinations.filter((d) => d.destinationId !== sarahOnlyDest.destinationId);      // (c) delete
    attackTrip.destinations.push({ destinationId: 'sneaky-new-id', name: 'Sneaky New Place', companions: [sarahOnlyDest.companions[0]], arriveDate: '2028-01-02', departDate: '2028-01-03', notes: '' }); // (d) create
    attackBody.trips.push({ tripId: tripBId, name: 'STOLEN', ownerId: 'sarah-does-not-own-this', grants: [], destinations: [], activities: [], accommodation: [], transport: [], contacts: [], companions: [], expenses: [] }); // (e) touch a trip she has no access to at all
    await directFetchStatus('/WayPoint/api/data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(attackBody) });

    await page.click('[data-action="logout"]');
    await page.waitForSelector('#login-form', { timeout: 5000 });
    await loginAs(page, 'admin1', 'adminpass1');
    await page.waitForSelector('.trip-grid', { timeout: 5000 });
    const afterAttack = await directFetchJson('/WayPoint/api/data');
    const tripAAfter = afterAttack.trips.find((t) => t.tripId === tripAId);
    const tripBAfter = afterAttack.trips.find((t) => t.tripId === tripBId);
    console.log('23. Safe merge-save: trip name survived the attack unchanged:', tripAAfter.name === 'Roles Test Trip', tripAAfter.name);
    console.log('    ...the retag attempt was ignored (still just Sarah):', JSON.stringify(tripAAfter.destinations.find((d) => d.destinationId === sarahOnlyDest.destinationId).companions) === JSON.stringify(sarahOnlyDest.companions));
    console.log('    ...the "deleted" item is still there:', tripAAfter.destinations.some((d) => d.destinationId === sarahOnlyDest.destinationId));
    console.log('    ...the "created" item was NOT added:', !tripAAfter.destinations.some((d) => d.destinationId === 'sneaky-new-id'));
    console.log('    ...and Trip B (admin1\'s, sarah1 has zero access to) was completely untouched:', tripBAfter.name === "Admin1's Own Trip", tripBAfter.name);
    await page.click('[data-action="logout"]');
    await page.waitForSelector('#login-form', { timeout: 5000 });

    // ================= 7. viewer1 ("viewer" grant, scoped to Mike, read-
    // only) ==============================================================
    await loginAs(page, 'viewer1', 'viewerpass1');
    await page.waitForSelector('.trip-grid', { timeout: 5000 });
    await page.click('.trip-card');
    await page.click('[data-action="switch-tab"][data-tab="activities"]');
    const viewerActivityRows = await page.locator('.item-list .item-row').allTextContents();
    console.log('24. viewer1 (as Mike) sees the Mike-tagged activity:', viewerActivityRows.length === 1 && /museum/.test(viewerActivityRows[0]));
    console.log('    ...with NO edit or delete controls at all (read-only, even for their own tagged item):', (await page.locator('.item-row .item-actions').count()) === 0);
    const viewerWriteStatus = await directFetchStatus('/WayPoint/api/data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trips: [] }) });
    const viewerAfterWrite = await directFetchJson('/WayPoint/api/data');
    console.log('25. A raw POST from viewer1 (even an empty {trips:[]}) changes nothing server-side:', viewerAfterWrite.trips.length === 1 && viewerAfterWrite.trips[0].tripId === tripAId, viewerWriteStatus);
    console.log('    ...and Manage accounts is refused server-side too (not just hidden):', (await directFetchStatus('/WayPoint/api/users')) === 403);
    await page.click('[data-action="logout"]');
    await page.waitForSelector('#login-form', { timeout: 5000 });

    // ================= 8. outsider1: no grant at all -> trip invisible =
    await loginAs(page, 'outsider1', 'outsiderpass1');
    await page.waitForSelector('.empty-state, .trip-grid', { timeout: 5000 });
    console.log('26. An account with no grant on any trip sees none at all:', (await page.locator('.trip-card').count()) === 0);
    await page.click('[data-action="logout"]');
    await page.waitForSelector('#login-form', { timeout: 5000 });

    // ================= 9. boss (uber-user): full access to admin1's trip
    // it was never granted, and stays invisible in that trip's own share
    // list — see "undisclosed" in the big comment at the top of
    // src/worker.js. =====================================================
    await loginAs(page, 'boss', 'adminpass1');
    await page.waitForSelector('.trip-grid', { timeout: 5000 });
    const bossTripCards = await page.locator('.trip-card').allTextContents();
    console.log('27. The uber-user sees EVERY trip, including one it was never shared on:',
      bossTripCards.length === 2 && bossTripCards.some((t) => /Admin1's Own Trip/.test(t)));
    const bossView = await directFetchJson('/WayPoint/api/data');
    const tripBAsBoss = bossView.trips.find((t) => t.tripId === tripBId);
    console.log('28. ...with full Superuser-equivalent access to it:', tripBAsBoss.myGrant && tripBAsBoss.myGrant.role === 'superuser');
    console.log('    ...yet the uber-user never appears in that trip\'s own grants list:', !(tripBAsBoss.grants || []).some((g) => g.username === 'boss'));

    // Revoke viewer1's access to Trip A via the Share panel, then confirm
    // it disappears for them.
    await page.click('.trip-card', { hasText: 'Roles Test Trip' });
    await page.click('[data-action="switch-tab"][data-tab="settings"]');
    await page.waitForSelector('.share-panel', { timeout: 5000 });
    await page.locator('.share-panel .item-row', { hasText: 'viewer1' }).locator('[data-action="revoke-grant"]').click();
    await page.click('[data-action="confirm-yes"]');
    await page.waitForTimeout(120);
    const rowsAfterRevoke = await page.locator('.share-panel .item-list .item-row').allTextContents();
    console.log('29. Revoking viewer1\'s access removes it from the Share panel:', !rowsAfterRevoke.some((t) => /viewer1/.test(t)));

    // The last-uber-user safety net: can't delete the only site-owner
    // account, even via a direct request.
    const usersAsBoss = await directFetchJson('/WayPoint/api/users');
    const bossId = usersAsBoss.users.find((u) => u.username === 'boss').id;
    const deleteBossStatus = await directFetchStatus('/WayPoint/api/users/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: bossId }) });
    console.log('30. Deleting the last remaining site-owner account is refused:', deleteBossStatus === 400, deleteBossStatus);

    await page.click('[data-action="logout"]');
    await page.waitForSelector('#login-form', { timeout: 5000 });
    await loginAs(page, 'viewer1', 'viewerpass1');
    await page.waitForSelector('.empty-state, .trip-grid', { timeout: 5000 });
    console.log('31. ...and viewer1 no longer sees Trip A at all after being revoked:', (await page.locator('.trip-card').count()) === 0);

    console.log('\nPage errors:', errors.length ? errors : 'NONE');
    await browser.close();
  } finally {
    server.kill();
  }
})();
