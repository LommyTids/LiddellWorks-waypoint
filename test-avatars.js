// Regression test for the Companions/Avatars feature's AVATAR half (see
// claude/waypoint-companions-plan.md in the project, and the big
// "COMPANIONS & AVATARS" comment near AVATAR_COLOR_TOKENS in src/worker.js,
// mirrored in mock-server.js): every ACCOUNT gets a self-picked coloured
// circle + animal, every COMPANION not linked to an account gets a fixed
// grey circle + a chosen-colour smiley, and a companion linked to an
// account inherits that account's own marker instead. This file covers:
//   1. The palette allowlists actually reject anything not on the list.
//   2. The self-service avatar picker (openAvatarPicker()/submitAvatarPick()
//      in index.html) works end to end, and only ever changes YOUR OWN
//      account's avatar, never anyone else's.
//   3. resolveCompanionAvatars() (src/worker.js) resolves correctly in
//      each of its three real shapes: linked to an account, not linked
//      but with an explicit smiley colour chosen, and not linked with
//      NOTHING ever chosen (the deterministic default).
//
// See test-companions.js for the tagging/linking UI itself, and
// test-auth-roles.js for how sharing a trip auto-links a companion's
// account — this file is purely about what a marker actually RESOLVES to.
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const { loginAsAdmin, waitForSaveToSettle } = require('./test-helpers');

const PORT = 8812;

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

// Mirrors deterministicIndex() in src/worker.js / mock-server.js exactly
// (and deterministicAvatarIndex() in public/WayPoint/data/avatars.js) --
// duplicated here (rather than requiring one of those files, which are
// written as a Worker module / a Node server respectively, not a shared
// library) purely so this test can independently compute what the
// deterministic DEFAULT color/animal for a given id ought to be, to check
// the server's own answer against.
const AVATAR_COLOR_TOKENS = ['red', 'orange', 'amber', 'green', 'teal', 'cyan', 'blue', 'indigo', 'purple', 'pink'];
const AVATAR_ANIMAL_TOKENS = ['penguin', 'lion', 'fox', 'owl', 'panda', 'koala', 'tiger', 'elephant', 'giraffe', 'rabbit', 'bear', 'wolf', 'cat', 'dog', 'monkey', 'dolphin'];
function deterministicIndex(seed, listLength) {
  let hash = 0;
  const text = String(seed || '');
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  return hash % listLength;
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

    await page.goto('http://localhost:' + PORT + '/WayPoint');
    await loginAsAdmin(page);

    // ================= 1. Palette allowlists ===========================
    const badColorStatus = await fetchStatus('/WayPoint/api/account/avatar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ color: 'mauve', animal: 'penguin' }) });
    console.log('1. An out-of-palette colour is refused (400):', badColorStatus === 400, badColorStatus);
    const badAnimalStatus = await fetchStatus('/WayPoint/api/account/avatar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ color: 'red', animal: 'dragon' }) });
    console.log('2. An out-of-palette animal is refused (400):', badAnimalStatus === 400, badAnimalStatus);
    const missingBodyStatus = await fetchStatus('/WayPoint/api/account/avatar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    console.log('   ...and an empty body is refused the same way:', missingBodyStatus === 400, missingBodyStatus);

    // ================= 2. Self-service avatar picker (UI) ==============
    // Before ever picking anything, whoami/login already returns a real,
    // allowlisted {color,animal} pair (resolveAccountAvatar()'s
    // deterministic-default fallback) -- never null, never a placeholder.
    const whoamiBeforePick = await fetchJson('/WayPoint/api/whoami');
    console.log('3. Before ever picking one, the account already has a real, allowlisted default avatar:',
      AVATAR_COLOR_TOKENS.indexOf(whoamiBeforePick.avatar.color) !== -1 && AVATAR_ANIMAL_TOKENS.indexOf(whoamiBeforePick.avatar.animal) !== -1,
      whoamiBeforePick.avatar);
    const expectedDefaultColor = AVATAR_COLOR_TOKENS[deterministicIndex(whoamiBeforePick.id, AVATAR_COLOR_TOKENS.length)];
    console.log('   ...and it\'s the SAME deterministic pick this test can compute independently, not a random one:',
      whoamiBeforePick.avatar.color === expectedDefaultColor, { got: whoamiBeforePick.avatar.color, expected: expectedDefaultColor });

    const topbarMarkerBefore = await page.locator('.account-avatar-btn .avatar-marker').first().textContent();
    console.log('4. The topbar swatch button already shows that default avatar (an animal glyph) before ever opening the picker:', /\p{Emoji}/u.test(topbarMarkerBefore || ''), topbarMarkerBefore);

    await page.click('[data-action="open-avatar-picker"]');
    await page.waitForSelector('#avatar-pick-form', { timeout: 5000 });
    console.log('5. The picker offers all 10 colours and all 16 animals:',
      (await page.locator('.avatar-picker-section', { hasText: 'Colour' }).locator('.avatar-swatch-btn').count()) === 10 &&
      (await page.locator('.avatar-picker-section', { hasText: 'Animal' }).locator('.avatar-swatch-btn').count()) === 16);

    await page.locator('.avatar-swatch-btn[data-value="teal"]').click();
    await page.locator('.avatar-swatch-btn[data-value="owl"]').click();
    // Read back via computed style rather than the raw attribute -- this
    // was set through the DOM (`el.style.background = '#14B8A6'`), which
    // the browser re-serializes into rgb(20, 184, 166) form, not the
    // literal hex string, when queried back.
    const previewBgAfterPick = await page.locator('#avatar-picker-preview-marker').evaluate((el) => getComputedStyle(el).backgroundColor);
    const previewGlyphAfterPick = (await page.locator('#avatar-picker-preview-marker').textContent() || '').trim();
    console.log('6. Picking swatches updates the live preview immediately (teal background, owl glyph):',
      previewBgAfterPick === 'rgb(20, 184, 166)' && previewGlyphAfterPick === '🦉', { previewBgAfterPick, previewGlyphAfterPick });

    await page.click('#avatar-pick-form button[type="submit"]');
    await page.waitForTimeout(150);
    const topbarMarkerAfter = await page.locator('.account-avatar-btn .avatar-marker').first().textContent();
    console.log('7. Saving closes the picker and updates the topbar swatch to the new pick (owl):', (topbarMarkerAfter || '').trim() === '🦉', topbarMarkerAfter);

    // Persisted server-side, not just in the page's own in-memory state --
    // confirm via a fresh whoami call.
    const whoamiAfterPick = await fetchJson('/WayPoint/api/whoami');
    console.log('8. The new avatar round-trips through the server (fresh /api/whoami agrees):',
      whoamiAfterPick.avatar.color === 'teal' && whoamiAfterPick.avatar.animal === 'owl', whoamiAfterPick.avatar);

    // ================= 3. Restricted to your OWN account ================
    // Create a second account (bob) via Manage Users (uber-user only),
    // confirm HIS avatar is untouched by admin's own pick above, then log
    // in as bob and confirm bob picking HIS OWN avatar doesn't touch
    // admin's, either -- the endpoint never takes an id in the request
    // body at all (see handleAccountAvatarUpdate() in src/worker.js --
    // it always writes to the SESSION's own account), so there's no id
    // field to even try smuggling, but this proves the end-to-end
    // behavior anyway.
    // carol is created here too (not used until section 4 below) simply
    // to keep all the account setup for this file in one place.
    await page.click('[data-action="open-manage-users"]');
    await page.waitForSelector('.tab-panel-head h2:has-text("Manage accounts")', { timeout: 5000 });
    await page.click('[data-action="new-user"]');
    await page.fill('#user-form input[name="username"]', 'bob');
    await page.fill('#user-form input[name="password"]', 'bobpass1');
    await page.click('#user-form button[type="submit"]');
    await page.waitForTimeout(100);
    await page.click('[data-action="new-user"]');
    await page.fill('#user-form input[name="username"]', 'carol');
    await page.fill('#user-form input[name="password"]', 'carolpass1');
    await page.click('#user-form button[type="submit"]');
    await page.waitForTimeout(100);
    await page.click('[data-action="back-to-dashboard"]');

    await page.click('[data-action="logout"]');
    await page.waitForSelector('#login-form', { timeout: 5000 });
    await page.fill('#login-form input[name="username"]', 'bob');
    await page.fill('#login-form input[name="password"]', 'bobpass1');
    await page.click('#login-form button[type="submit"]');
    await page.waitForSelector('.empty-state, .trip-grid', { timeout: 5000 });
    const whoamiAsBobBefore = await fetchJson('/WayPoint/api/whoami');
    console.log('9. bob\'s own default avatar is unaffected by admin\'s pick (different account, different deterministic default in general):',
      AVATAR_COLOR_TOKENS.indexOf(whoamiAsBobBefore.avatar.color) !== -1, whoamiAsBobBefore.avatar);
    await fetchStatus('/WayPoint/api/account/avatar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ color: 'pink', animal: 'dolphin' }) });
    const whoamiAsBobAfter = await fetchJson('/WayPoint/api/whoami');
    console.log('10. bob picking his own avatar (pink dolphin) only changes HIS:', whoamiAsBobAfter.avatar.color === 'pink' && whoamiAsBobAfter.avatar.animal === 'dolphin', whoamiAsBobAfter.avatar);

    await page.click('[data-action="logout"]');
    await page.waitForSelector('#login-form', { timeout: 5000 });
    await loginAsAdmin(page);
    const whoamiAdminUnaffected = await fetchJson('/WayPoint/api/whoami');
    console.log('    ...and admin\'s own avatar (teal owl) is completely unaffected by bob\'s pick:',
      whoamiAdminUnaffected.avatar.color === 'teal' && whoamiAdminUnaffected.avatar.animal === 'owl', whoamiAdminUnaffected.avatar);

    // ================= 4. companionAvatars resolution: all three shapes =
    await page.click('[data-action="new-trip"]');
    await page.fill('input[name="name"]', 'Avatar Resolution Trip');
    await page.fill('input[name="startDate"]', '2029-09-01');
    await page.fill('input[name="endDate"]', '2029-09-05');
    await page.fill('input[name="homeCurrency"]', 'GBP');
    await page.click('#entity-form button[type="submit"]');
    await waitForSaveToSettle(page);
    const tripId = await page.evaluate(() => currentTripId);

    await page.click('[data-action="switch-tab"][data-tab="companions"]');
    // Shape (a): "BobCompanion" -- will be linked to bob's account, so its
    // marker should become bob's own (pink dolphin), NOT a smiley at all.
    await page.click('[data-action="new-companion"]');
    await page.fill('input[name="name"]', 'BobCompanion');
    await page.click('#entity-form button[type="submit"]');
    await waitForSaveToSettle(page);
    // Shape (b): "CaseyCompanion" -- never linked, but given an explicit
    // smiley colour (amber) when added.
    await page.click('[data-action="new-companion"]');
    await page.fill('input[name="name"]', 'CaseyCompanion');
    await page.locator('.avatar-swatch-label[title="amber"] .avatar-swatch-btn').click();
    await page.click('#entity-form button[type="submit"]');
    await waitForSaveToSettle(page);
    // A fourth companion made purely so section 4's "scoped role sees the
    // same map" check below has something to share/scope against without
    // touching bob's link (see that section's own comment) -- created
    // here, through the UI, alongside the other two for the same reason
    // as the note above: every companion-CRUD action from here on needs
    // to go through the UI's own updateState()/persist(), not a raw
    // fetch() behind its back, or the NEXT UI action would resend the
    // page's now-stale copy of `state` and silently wipe out whatever the
    // raw fetch had added (this bit a first draft of this test: adding
    // "Dana" via raw fetch and THEN clicking "Add guest" for a later
    // one erased Dana, since the click's save round-tripped the page's
    // stale pre-Dana copy of the trip). So every raw fetch() write in
    // this section happens LAST, once no more UI-driven companion
    // creation is left to accidentally overwrite it with stale data.
    await page.click('[data-action="new-companion"]');
    await page.fill('input[name="name"]', 'ScopeOnlyCompanion');
    await page.click('#entity-form button[type="submit"]');
    await waitForSaveToSettle(page);

    // Shape (c): "DanaCompanion" -- never linked, and never given a
    // smiley either. Added via a raw request (bypassing the UI's own
    // optimistic default-avatar computation entirely) so this is a true
    // "the SERVER had to invent a default from nothing" case, not just
    // "the browser already filled one in". Safe to do now (see the long
    // comment above) since no more UI companion-CRUD happens after this.
    const beforeDana = await fetchJson('/WayPoint/api/data');
    const tripBeforeDana = beforeDana.trips.find((t) => t.tripId === tripId);
    const danaId = 'dana-companion-id';
    tripBeforeDana.companions.push({ companionId: danaId, name: 'DanaCompanion', notes: '' });
    await page.evaluate((body) => fetch('/WayPoint/api/data', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), beforeDana);

    // Link BobCompanion to bob -- a targeted, dedicated endpoint (not
    // /api/data), so unlike the companion-CRUD above this one is always
    // safe regardless of the page's own stale/fresh state.
    const tripDataForLink = await fetchJson('/WayPoint/api/data');
    const bobCompanionId = tripDataForLink.trips.find((t) => t.tripId === tripId).companions.find((c) => c.name === 'BobCompanion').companionId;
    await fetchStatus('/WayPoint/api/companions/link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tripId: tripId, companionId: bobCompanionId, username: 'bob' }) });

    const finalData = await fetchJson('/WayPoint/api/data');
    const finalTrip = finalData.trips.find((t) => t.tripId === tripId);
    const avatars = finalTrip.companionAvatars;

    console.log('11. (a) Linked companion resolves to the linked account\'s OWN avatar (bob = pink dolphin), not a smiley:',
      avatars[bobCompanionId] && avatars[bobCompanionId].type === 'account' && avatars[bobCompanionId].color === 'pink' && avatars[bobCompanionId].animal === 'dolphin',
      avatars[bobCompanionId]);

    const caseyId = finalTrip.companions.find((c) => c.name === 'CaseyCompanion').companionId;
    console.log('12. (b) An unlinked companion with an explicitly chosen smiley colour resolves to exactly that:',
      avatars[caseyId] && avatars[caseyId].type === 'smiley' && avatars[caseyId].color === 'amber', avatars[caseyId]);

    const expectedDanaColor = AVATAR_COLOR_TOKENS[deterministicIndex(danaId, AVATAR_COLOR_TOKENS.length)];
    console.log('13. (c) An unlinked companion with NO smiley ever chosen resolves to the deterministic default:',
      avatars[danaId] && avatars[danaId].type === 'smiley' && avatars[danaId].color === expectedDanaColor,
      { got: avatars[danaId], expected: expectedDanaColor });

    // Stable across repeated fetches -- a deterministic default, not a
    // fresh random one on every request.
    const secondFetch = await fetchJson('/WayPoint/api/data');
    const avatarsAgain = secondFetch.trips.find((t) => t.tripId === tripId).companionAvatars;
    console.log('    ...and it\'s stable across repeated requests, not re-randomised each time:', avatarsAgain[danaId].color === avatars[danaId].color);

    // ---- And the same companionAvatars map (with all three shapes) is
    // sent to a SCOPED role too, not just the full-scope one that set all
    // this up -- see resolveCompanionAvatars()'s own comment on why it's
    // safe to hand to everyone. Share the trip with CAROL (not bob) as
    // Viewer, scoped to ScopeOnlyCompanion -- using a different account
    // than bob's is deliberate: sharing AS BobCompanion or CaseyCompanion
    // would auto-link whoever it's shared with to that companion (and,
    // per assignCompanionAccountId()'s 1:1 guarantee, silently UN-link
    // bob from BobCompanion in the process, since one account can only
    // ever hold one companion's link per trip) -- exactly correct
    // behavior, but not what this step means to test. Sharing with a
    // wholly unrelated third account keeps shapes (a)/(b)/(c) above
    // completely undisturbed. A raw call to /api/trip-grants (the same
    // endpoint the Companions tab's own "manage access" form now talks
    // to -- see submitCompanionAccess() in index.html) rather than
    // driving that form through the UI, since this section is well past
    // the "no more UI companion-CRUD" boundary explained further up. ----
    const scopeOnlyCompanionId = finalTrip.companions.find((c) => c.name === 'ScopeOnlyCompanion').companionId;
    await fetchStatus('/WayPoint/api/trip-grants', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tripId: tripId, username: 'carol', role: 'viewer', companionId: scopeOnlyCompanionId }) });

    await page.click('[data-action="logout"]');
    await page.waitForSelector('#login-form', { timeout: 5000 });
    await page.fill('#login-form input[name="username"]', 'carol');
    await page.fill('#login-form input[name="password"]', 'carolpass1');
    await page.click('#login-form button[type="submit"]');
    await page.waitForSelector('.trip-grid', { timeout: 5000 });
    const carolScopedData = await fetchJson('/WayPoint/api/data');
    const carolScopedTrip = carolScopedData.trips.find((t) => t.tripId === tripId);
    console.log('14. A scoped ("viewer") role\'s own GET response carries the exact same resolved companionAvatars map:',
      carolScopedTrip.companionAvatars[bobCompanionId] && carolScopedTrip.companionAvatars[bobCompanionId].type === 'account' && carolScopedTrip.companionAvatars[bobCompanionId].color === 'pink' &&
      carolScopedTrip.companionAvatars[caseyId] && carolScopedTrip.companionAvatars[caseyId].color === 'amber' &&
      carolScopedTrip.companionAvatars[danaId] && carolScopedTrip.companionAvatars[danaId].color === expectedDanaColor,
      carolScopedTrip.companionAvatars);

    console.log('\nPage errors:', errors.length ? errors : 'NONE');
    await browser.close();
  } finally {
    server.kill();
  }
})();
