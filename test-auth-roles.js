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
    // The Share panel moved from Settings to the Companions tab as part of
    // the Companions/Avatars feature (Phase 2) -- see renderCompanionsTab()/
    // renderSharePanel() in index.html, and renderSettingsTab()'s own
    // comment on why it left Settings ("who's tagged" and "who can log in"
    // turned out to be one and the same "who's on this trip" question).
    await page.click('[data-action="back-to-dashboard"]');
    await page.click('.trip-card');
    await page.click('[data-action="switch-tab"][data-tab="companions"]');
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

    // ================= 5. admin1: full read/write on Trip A, PLUS (as of
    // Companions/Avatars Phase 2) limited sharing rights of their own --
    // they can share as User/Viewer, but can't grant Admin access or
    // revoke another Admin's -- and sees a trip of their OWN as its
    // Superuser, with no such limits there. =============================
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

    // ---- Phase 2: admin1 DOES see the Share panel now (moved to the
    // Companions tab, visible to Superuser OR Admin), but its role
    // dropdown has no "admin" option -- only the trip's actual owner can
    // grant that. ----
    await page.click('[data-action="switch-tab"][data-tab="companions"]');
    await page.waitForSelector('.share-panel', { timeout: 5000 });
    console.log('12. admin1 DOES see the "Share access" panel (Admin can share too, as of Phase 2):', (await page.locator('.share-panel').count()) === 1);
    const admin1RoleOptions = await page.locator('#share-form select[name="role"] option').allTextContents();
    console.log('    ...but its role dropdown offers no "Admin" option (only the owner can grant that):', !admin1RoleOptions.some((t) => /^Admin\b/.test(t.trim())), admin1RoleOptions);

    // A hostile direct request proves the server enforces this too, not
    // just the dropdown: asking to grant role:'admin' is refused 403 no
    // matter what companion/username is named.
    const admin1GrantAdminAttempt = await directFetchStatus('/WayPoint/api/trip-grants', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tripId: tripAId, username: 'outsider1', role: 'admin' }) });
    console.log('13. ...and the server refuses admin1 granting Admin access even via a raw request:', admin1GrantAdminAttempt === 403, admin1GrantAdminAttempt);
    // Sharing as User/Viewer, on the other hand, is now genuinely allowed
    // for an Admin -- a bogus companion id reaches real validation (400,
    // "that companion isn't on this trip") rather than being blocked at
    // the permission check (403) the way it used to be before Phase 2.
    const admin1BogusCompanionAttempt = await directFetchStatus('/WayPoint/api/trip-grants', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tripId: tripAId, username: 'outsider1', role: 'viewer', companionId: 'no-such-companion' }) });
    console.log('    ...but sharing as Viewer with a bogus companion id reaches real validation (400), not a blanket 403:', admin1BogusCompanionAttempt === 400, admin1BogusCompanionAttempt);

    // Add a companion of their own to share against, then actually share
    // Trip A's access to outsider1 as that companion -- proving admin1's
    // sharing rights genuinely work end to end, not just that the old
    // blanket refusal is gone.
    await page.click('[data-action="new-companion"]');
    await page.fill('input[name="name"]', 'Admin1Companion');
    await page.click('#entity-form button[type="submit"]');
    await page.waitForTimeout(100);
    await page.fill('#share-form input[name="username"]', 'outsider1');
    await page.selectOption('#share-form select[name="role"]', 'viewer');
    await page.waitForTimeout(30);
    await page.selectOption('#share-form select[name="companionId"]', { label: 'Admin1Companion' });
    await page.click('#share-form button[type="submit"]');
    await page.waitForTimeout(120);
    await page.waitForSelector('.share-panel', { timeout: 5000 });
    const rowsAfterAdmin1Share = await page.locator('.share-panel .item-list .item-row').allTextContents();
    console.log('14. admin1 successfully shares Trip A with outsider1 as Viewer:', rowsAfterAdmin1Share.some((t) => /outsider1/.test(t) && /Viewer/.test(t) && /Admin1Companion/.test(t)), rowsAfterAdmin1Share);

    // Sharing as a companion also auto-links that companion's avatar to
    // the account it was shared with (see the COMPANIONS & AVATARS
    // comment in src/worker.js) -- confirm the link actually happened,
    // from admin1's own full-scope view (only a Superuser/Admin ever sees
    // a companion's raw accountId at all).
    const admin1DataAfterShare = await directFetchJson('/WayPoint/api/data');
    const tripAAsAdmin1 = admin1DataAfterShare.trips.find((t) => t.tripId === tripAId);
    const outsider1AccountId = tripAAsAdmin1.grants.find((g) => g.username === 'outsider1').accountId;
    const admin1CompanionRecord = tripAAsAdmin1.companions.find((c) => c.name === 'Admin1Companion');
    console.log('    ...and sharing auto-linked that companion\'s avatar to outsider1\'s account:', admin1CompanionRecord.accountId === outsider1AccountId, { linked: admin1CompanionRecord.accountId, expected: outsider1AccountId });

    // ---- Phase 2's other symmetric restriction: an Admin can revoke a
    // User/Viewer grant, but never another Admin's -- not even their OWN
    // admin grant (the check doesn't special-case "yourself"; only the
    // trip's real owner may touch an admin-role grant at all). ----
    const admin1SelfRevokeAttempt = await directFetchStatus('/WayPoint/api/trip-grants/revoke', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tripId: tripAId, accountId: whoamiAsAdmin1.id }) });
    console.log('15. admin1 is refused revoking an Admin-role grant, even their own:', admin1SelfRevokeAttempt === 403, admin1SelfRevokeAttempt);

    const admin1RevokeOutsiderStatus = await directFetchStatus('/WayPoint/api/trip-grants/revoke', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tripId: tripAId, accountId: outsider1AccountId }) });
    const rowsAfterAdmin1Revoke = await directFetchJson('/WayPoint/api/data');
    const tripAAfterAdmin1Revoke = rowsAfterAdmin1Revoke.trips.find((t) => t.tripId === tripAId);
    console.log('    ...but CAN revoke the Viewer grant they themselves just created:', admin1RevokeOutsiderStatus === 200 && !tripAAfterAdmin1Revoke.grants.some((g) => g.username === 'outsider1'), admin1RevokeOutsiderStatus);
    // Revoking deliberately does NOT clear the companion's accountId link
    // (see handleTripGrantsRevoke()'s own comment in src/worker.js) --
    // outsider1 no longer has ACCESS to the trip, but their avatar link
    // to Admin1Companion is left alone until someone explicitly changes
    // it (via the link button, or by sharing that companion again).
    const admin1CompanionAfterRevoke = tripAAfterAdmin1Revoke.companions.find((c) => c.name === 'Admin1Companion');
    console.log('    ...and revoking does NOT clear the avatar link it created:', admin1CompanionAfterRevoke.accountId === outsider1AccountId, admin1CompanionAfterRevoke.accountId);

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
    // Settings no longer HOSTS the Share panel itself (see the Phase-2
    // comment above step 4) -- just a one-line pointer to the Companions
    // tab, shown to anyone who canShareTrip() this trip.
    await page.click('[data-action="switch-tab"][data-tab="settings"]');
    console.log('16. Settings only points at the Companions tab for sharing now, rather than hosting the panel itself:',
      (await page.locator('.share-panel').count()) === 0 && (await page.locator('[data-action="switch-tab"][data-tab="companions"]', { hasText: 'Companions tab' }).count()) === 1);
    await page.click('[data-action="switch-tab"][data-tab="companions"]');
    await page.waitForSelector('.share-panel', { timeout: 5000 });
    const admin1OwnTripRoleOptions = await page.locator('#share-form select[name="role"] option').allTextContents();
    console.log('    ...and on a trip THEY created, admin1 IS its Superuser -- the role dropdown DOES offer Admin here:',
      admin1OwnTripRoleOptions.some((t) => /^Admin\b/.test(t.trim())), admin1OwnTripRoleOptions);
    await page.click('[data-action="back-to-dashboard"]');
    await page.click('[data-action="logout"]');
    await page.waitForSelector('#login-form', { timeout: 5000 });

    // ================= 6. sarah1 ("user" grant, scoped to Sarah) =======
    await loginAs(page, 'sarah1', 'sarahpass1');
    await page.waitForSelector('.trip-grid', { timeout: 5000 });
    // Captured for the accountId-smuggling check further down: sharing
    // sarah1 as companion "Sarah" back in step 4 already legitimately
    // linked Sarah's companion record to sarah1's OWN account id (see
    // handleTripGrantsUpsert()'s auto-link) -- that's real, expected
    // state, not something to attack away.
    const whoamiAsSarah1 = await directFetchJson('/WayPoint/api/whoami');
    const sarahTripCards = await page.locator('.trip-card').allTextContents();
    console.log('17. sarah1 sees ONLY Trip A (not admin1\'s trip, not the fully-unshared one):',
      sarahTripCards.length === 1 && /Roles Test Trip/.test(sarahTripCards[0]));

    await page.click('.trip-card');
    console.log('18. sarah1 cannot edit/delete the trip itself (no Superuser/Admin controls in the header):', (await page.locator('[data-action="edit-trip"]').count()) === 0);
    await page.click('[data-action="switch-tab"][data-tab="destinations"]');
    const sarahDestRows = await page.locator('.item-list .item-row').allTextContents();
    console.log('19. Destinations: only the Sarah-tagged one shows, the Mike-only one is excluded:',
      sarahDestRows.length === 1 && /Sarah Only Place/.test(sarahDestRows[0]), sarahDestRows);
    console.log('    ...and there\'s no "Add destination" button (a "user" grant can\'t create items):', (await page.locator('[data-action="new-destination"]').count()) === 0);

    await page.click('[data-action="switch-tab"][data-tab="activities"]');
    console.log('20. Activities: the Mike-only activity is fully excluded (empty tab):', (await page.locator('.empty-state').count()) === 1);

    await page.click('[data-action="switch-tab"][data-tab="transport"]');
    console.log('21. Transport: the leg tagged to BOTH companions is included:', (await page.locator('.item-list .item-row').count()) === 1);

    console.log('22. Expenses tab is hidden entirely for a "user" grant:', (await page.locator('[data-tab="expenses"]').count()) === 0);

    // Edit sarah1's own tagged destination: the tag-picker is locked, but
    // an ordinary field can still be changed and saved.
    await page.click('[data-action="switch-tab"][data-tab="destinations"]');
    await page.locator('.item-row', { hasText: 'Sarah Only Place' }).locator('[data-action="edit-destination"]').click();
    await page.waitForTimeout(50);
    const tagPickerDisabled = await page.locator('.tag-picker-item input[type="checkbox"]').first().isDisabled();
    console.log('23. Editing their own tagged item locks the Companions tag-picker:', tagPickerDisabled);
    await page.fill('textarea[name="notes"]', 'sarah added a note');
    await page.click('#entity-form button[type="submit"]');
    await page.waitForTimeout(100);
    const sarahEditedRow = await page.locator('.item-row', { hasText: 'Sarah Only Place' }).textContent();
    console.log('24. That field-level edit actually saved:', /sarah added a note/.test(sarahEditedRow));
    console.log('    ...and there\'s no Delete button on their own item (can edit, never delete):', (await page.locator('.item-row', { hasText: 'Sarah Only Place' }).locator('[data-action="delete-destination"]').count()) === 0);

    // ================= 6b. sarah1 ("user" grant): Phase 3 of Companions/
    // Avatars -- may APPEND a brand-new companion (name + smiley colour
    // only), but can never edit, delete, retag or link one that already
    // exists. See canAddCompanion()/COMPANION_FIELDS_LIMITED in
    // index.html and mergeUserScopedCompanions() in src/worker.js. =====
    await page.click('[data-action="switch-tab"][data-tab="companions"]');
    console.log('25. sarah1 (a "user" grant) DOES see an "Add companion" button (Phase 3):', (await page.locator('[data-action="new-companion"]').count()) === 1);
    console.log('    ...but no link-to-account button on the existing companions (linking stays Superuser/Admin only):', (await page.locator('[data-action="link-companion"]').count()) === 0);
    console.log('    ...and no edit/delete controls on Sarah or Mike either (append-only, never touch what\'s already there):', (await page.locator('.item-row [data-action="edit-companion"], .item-row [data-action="delete-companion"]').count()) === 0);

    await page.click('[data-action="new-companion"]');
    // Phase 3's limited field list -- name + smiley colour only, no Notes
    // field at all (a genuinely shorter form, not the full one with
    // fields merely hidden -- see COMPANION_FIELDS_LIMITED's comment).
    console.log('    ...and the Add-companion form has no Notes field (a "user" submission would never keep one anyway):', (await page.locator('textarea[name="notes"]').count()) === 0);
    await page.fill('input[name="name"]', 'Sarah\'s Friend');
    await page.click('#entity-form button[type="submit"]');
    await page.waitForTimeout(100);
    const companionRowsAfterAppend = await page.locator('.item-list .item-row').allTextContents();
    console.log('26. The new companion was actually added, and still has no edit/delete/link controls of its own:',
      companionRowsAfterAppend.some((t) => /Sarah's Friend/.test(t)), companionRowsAfterAppend);

    // ---- The important part: server-side write boundaries, proven with
    // a raw fetch() that bypasses the UI and hand-crafts a hostile body.
    const sarahScoped = await directFetchJson('/WayPoint/api/data');
    const tripAScoped = sarahScoped.trips.find((t) => t.tripId === tripAId);
    const sarahOnlyDest = tripAScoped.destinations.find((d) => d.name === 'Sarah Only Place');
    // A scoped "user"/"viewer" role never sees a companion's raw
    // accountId (only the resolved companionAvatars map) -- see
    // buildVisibleTrip() in src/worker.js.
    console.log('27. accountId is stripped from every companion in a scoped role\'s own GET response:', tripAScoped.companions.every((c) => !('accountId' in c)), tripAScoped.companions.map((c) => Object.keys(c)));
    const attackBody = JSON.parse(JSON.stringify(sarahScoped));
    const attackTrip = attackBody.trips.find((t) => t.tripId === tripAId);
    attackTrip.name = 'HACKED BY SARAH';                                    // (a) trip-level field
    attackTrip.destinations.find((d) => d.destinationId === sarahOnlyDest.destinationId).companions.push('mike-fake-id'); // (b) retag
    attackTrip.destinations = attackTrip.destinations.filter((d) => d.destinationId !== sarahOnlyDest.destinationId);      // (c) delete
    attackTrip.destinations.push({ destinationId: 'sneaky-new-id', name: 'Sneaky New Place', companions: [sarahOnlyDest.companions[0]], arriveDate: '2028-01-02', departDate: '2028-01-03', notes: '' }); // (d) create
    attackBody.trips.push({ tripId: tripBId, name: 'STOLEN', ownerId: 'sarah-does-not-own-this', grants: [], destinations: [], activities: [], accommodation: [], transport: [], contacts: [], companions: [], expenses: [] }); // (e) touch a trip she has no access to at all
    attackTrip.companions.find((c) => c.name === 'Sarah').name = 'HACKED NAME';               // (f) rename an existing companion
    attackTrip.companions = attackTrip.companions.filter((c) => c.name !== 'Mike');            // (g) delete an existing companion
    attackTrip.companions.find((c) => c.name === 'HACKED NAME').accountId = whoamiAsAdmin1.id; // (h) smuggle a protected accountId onto one she can edit
    await directFetchStatus('/WayPoint/api/data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(attackBody) });

    await page.click('[data-action="logout"]');
    await page.waitForSelector('#login-form', { timeout: 5000 });
    await loginAs(page, 'admin1', 'adminpass1');
    await page.waitForSelector('.trip-grid', { timeout: 5000 });
    const afterAttack = await directFetchJson('/WayPoint/api/data');
    const tripAAfter = afterAttack.trips.find((t) => t.tripId === tripAId);
    const tripBAfter = afterAttack.trips.find((t) => t.tripId === tripBId);
    console.log('28. Safe merge-save: trip name survived the attack unchanged:', tripAAfter.name === 'Roles Test Trip', tripAAfter.name);
    console.log('    ...the retag attempt was ignored (still just Sarah):', JSON.stringify(tripAAfter.destinations.find((d) => d.destinationId === sarahOnlyDest.destinationId).companions) === JSON.stringify(sarahOnlyDest.companions));
    console.log('    ...the "deleted" item is still there:', tripAAfter.destinations.some((d) => d.destinationId === sarahOnlyDest.destinationId));
    console.log('    ...the "created" item was NOT added:', !tripAAfter.destinations.some((d) => d.destinationId === 'sneaky-new-id'));
    console.log('    ...and Trip B (admin1\'s, sarah1 has zero access to) was completely untouched:', tripBAfter.name === "Admin1's Own Trip", tripBAfter.name);
    console.log('    ...the existing companion "Sarah" was NOT renamed (a "user" grant can only ever append, never edit an existing one):',
      tripAAfter.companions.some((c) => c.name === 'Sarah') && !tripAAfter.companions.some((c) => c.name === 'HACKED NAME'));
    console.log('    ...the "deleted" companion "Mike" is still there too:', tripAAfter.companions.some((c) => c.name === 'Mike'));
    // Sarah's companion already carries a REAL, legitimate accountId link
    // from step 4's share (sarah1's own account, via the auto-link) --
    // this proves the smuggled value (admin1's id) never overwrote it,
    // not that the field is empty.
    const sarahCompanionAfterAttack = tripAAfter.companions.find((c) => c.name === 'Sarah') || {};
    console.log('    ...and the smuggled accountId (admin1\'s) never got attached -- Sarah\'s real link (to sarah1) survived untouched:',
      sarahCompanionAfterAttack.accountId === whoamiAsSarah1.id && sarahCompanionAfterAttack.accountId !== whoamiAsAdmin1.id,
      sarahCompanionAfterAttack.accountId);
    console.log('    ...while the companion sarah1 legitimately appended earlier ("Sarah\'s Friend") did survive, untouched:',
      tripAAfter.companions.some((c) => c.name === "Sarah's Friend"));
    await page.click('[data-action="logout"]');
    await page.waitForSelector('#login-form', { timeout: 5000 });

    // ================= 7. viewer1 ("viewer" grant, scoped to Mike, read-
    // only) ==============================================================
    await loginAs(page, 'viewer1', 'viewerpass1');
    await page.waitForSelector('.trip-grid', { timeout: 5000 });
    await page.click('.trip-card');
    await page.click('[data-action="switch-tab"][data-tab="activities"]');
    const viewerActivityRows = await page.locator('.item-list .item-row').allTextContents();
    console.log('29. viewer1 (as Mike) sees the Mike-tagged activity:', viewerActivityRows.length === 1 && /museum/.test(viewerActivityRows[0]));
    console.log('    ...with NO edit or delete controls at all (read-only, even for their own tagged item):', (await page.locator('.item-row .item-actions').count()) === 0);
    const viewerWriteStatus = await directFetchStatus('/WayPoint/api/data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trips: [] }) });
    const viewerAfterWrite = await directFetchJson('/WayPoint/api/data');
    console.log('30. A raw POST from viewer1 (even an empty {trips:[]}) changes nothing server-side:', viewerAfterWrite.trips.length === 1 && viewerAfterWrite.trips[0].tripId === tripAId, viewerWriteStatus);
    console.log('    ...and Manage accounts is refused server-side too (not just hidden):', (await directFetchStatus('/WayPoint/api/users')) === 403);
    // A "viewer" grant can't add a companion either -- Phase 3 explicitly
    // grants that only to a "user" grant (see canAddCompanion() -- read-
    // only means read-only, even for that one exception).
    await page.click('[data-action="switch-tab"][data-tab="companions"]');
    console.log('    ...and viewer1 sees no "Add companion" button either (Phase 3 is "user"-only, never "viewer"):', (await page.locator('[data-action="new-companion"]').count()) === 0);
    await page.click('[data-action="logout"]');
    await page.waitForSelector('#login-form', { timeout: 5000 });

    // ================= 8. outsider1: no grant at all -> trip invisible =
    await loginAs(page, 'outsider1', 'outsiderpass1');
    await page.waitForSelector('.empty-state, .trip-grid', { timeout: 5000 });
    console.log('31. An account with no grant on any trip sees none at all:', (await page.locator('.trip-card').count()) === 0);
    await page.click('[data-action="logout"]');
    await page.waitForSelector('#login-form', { timeout: 5000 });

    // ================= 9. boss (uber-user): full access to admin1's trip
    // it was never granted, and stays invisible in that trip's own share
    // list — see "undisclosed" in the big comment at the top of
    // src/worker.js. =====================================================
    await loginAs(page, 'boss', 'adminpass1');
    await page.waitForSelector('.trip-grid', { timeout: 5000 });
    const bossTripCards = await page.locator('.trip-card').allTextContents();
    console.log('32. The uber-user sees EVERY trip, including one it was never shared on:',
      bossTripCards.length === 2 && bossTripCards.some((t) => /Admin1's Own Trip/.test(t)));
    const bossView = await directFetchJson('/WayPoint/api/data');
    const tripBAsBoss = bossView.trips.find((t) => t.tripId === tripBId);
    console.log('33. ...with full Superuser-equivalent access to it:', tripBAsBoss.myGrant && tripBAsBoss.myGrant.role === 'superuser');
    console.log('    ...yet the uber-user never appears in that trip\'s own grants list:', !(tripBAsBoss.grants || []).some((g) => g.username === 'boss'));

    // Revoke viewer1's access to Trip A via the Share panel (Companions
    // tab now, not Settings -- see the Phase-2 comment above step 4), then
    // confirm it disappears for them.
    await page.click('.trip-card', { hasText: 'Roles Test Trip' });
    await page.click('[data-action="switch-tab"][data-tab="companions"]');
    await page.waitForSelector('.share-panel', { timeout: 5000 });
    await page.locator('.share-panel .item-row', { hasText: 'viewer1' }).locator('[data-action="revoke-grant"]').click();
    await page.click('[data-action="confirm-yes"]');
    await page.waitForTimeout(120);
    const rowsAfterRevoke = await page.locator('.share-panel .item-list .item-row').allTextContents();
    console.log('34. Revoking viewer1\'s access removes it from the Share panel:', !rowsAfterRevoke.some((t) => /viewer1/.test(t)));

    // The last-uber-user safety net: can't delete the only site-owner
    // account, even via a direct request.
    const usersAsBoss = await directFetchJson('/WayPoint/api/users');
    const bossId = usersAsBoss.users.find((u) => u.username === 'boss').id;
    const deleteBossStatus = await directFetchStatus('/WayPoint/api/users/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: bossId }) });
    console.log('35. Deleting the last remaining site-owner account is refused:', deleteBossStatus === 400, deleteBossStatus);

    await page.click('[data-action="logout"]');
    await page.waitForSelector('#login-form', { timeout: 5000 });
    await loginAs(page, 'viewer1', 'viewerpass1');
    await page.waitForSelector('.empty-state, .trip-grid', { timeout: 5000 });
    console.log('36. ...and viewer1 no longer sees Trip A at all after being revoked:', (await page.locator('.trip-card').count()) === 0);

    console.log('\nPage errors:', errors.length ? errors : 'NONE');
    await browser.close();
  } finally {
    server.kill();
  }
})();
