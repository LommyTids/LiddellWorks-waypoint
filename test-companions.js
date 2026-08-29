// Regression test for the "travel companions" feature: a per-trip list of
// people (see COMPANION_FIELDS/openCompanionForm()/renderCompanionsTab()
// in index.html) that can be tagged onto destinations, activities,
// accommodation and transport legs via the 'tag-picker' field type (see
// tagPickerHtml() -- actually the 'tag-picker' case inside fieldHtml() --
// and readTagPicker()). This is also the foundation the "User" role's
// scoped visibility is built on (see test-auth-roles.js) -- a companion's
// id is exactly what a "user" account's trip link points at -- but THIS
// file only covers the tagging feature itself, on an ordinary Admin
// session, not the permissions layer.
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const { loginAsAdmin, waitForSaveToSettle, waitForModalToClose } = require('./test-helpers');

const PORT = 8808;

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

    await page.goto('http://localhost:' + PORT + '/WayPoint');
    await loginAsAdmin(page);
    await page.click('[data-action="new-trip"]');
    await page.fill('input[name="name"]', 'Companions Test');
    await page.fill('input[name="startDate"]', '2027-11-01');
    await page.fill('input[name="endDate"]', '2027-11-10');
    await page.fill('input[name="homeCurrency"]', 'GBP');
    await page.click('#entity-form button[type="submit"]');
    await waitForSaveToSettle(page);
    const tripId = await page.evaluate(() => currentTripId);

    // ---- Companions tab: empty state, then add two. ----
    await page.click('[data-action="switch-tab"][data-tab="companions"]');
    const emptyStateShown = (await page.locator('.empty-state').count()) === 1;
    console.log('1. Companions tab starts empty:', emptyStateShown);

    await page.click('[data-action="new-companion"]');
    await page.fill('input[name="name"]', 'Sarah');
    await page.click('#entity-form button[type="submit"]');
    await waitForSaveToSettle(page);
    await page.click('[data-action="new-companion"]');
    await page.fill('input[name="name"]', 'Mike');
    await page.click('#entity-form button[type="submit"]');
    await waitForSaveToSettle(page);
    const companionRows = await page.locator('.item-list .item-row').count();
    console.log('2. Both companions listed:', companionRows === 2, companionRows);

    // ---- Destination form offers both as checkboxes; tag just Sarah. ----
    await page.click('[data-action="switch-tab"][data-tab="destinations"]');
    await page.click('[data-action="new-destination"]');
    const pickerOptionCount = await page.locator('.tag-picker .tag-picker-item').count();
    console.log('3. Destination form\'s Companions picker offers both:', pickerOptionCount === 2, pickerOptionCount);
    await page.fill('input[name="name"]', 'Chiang Mai');
    await page.fill('input[name="arriveDate"]', '2027-11-02');
    await page.fill('input[name="departDate"]', '2027-11-05');
    await page.locator('.tag-picker-item', { hasText: 'Sarah' }).locator('input[type="checkbox"]').check();
    await page.click('#entity-form button[type="submit"]');
    await waitForSaveToSettle(page);
    const destTagText = await page.locator('.item-row .item-tags').first().textContent();
    console.log('4. Destination row shows the "Sarah" tag:', /Sarah/.test(destTagText) && !/Mike/.test(destTagText), destTagText);

    // ---- Activity: tag Mike only. ----
    await page.click('[data-action="switch-tab"][data-tab="activities"]');
    await page.click('[data-action="new-activity"]');
    await page.fill('input[name="title"]', 'Cooking class');
    await page.fill('input[name="date"]', '2027-11-03');
    await page.locator('.tag-picker-item', { hasText: 'Mike' }).locator('input[type="checkbox"]').check();
    await page.click('#entity-form button[type="submit"]');
    await waitForSaveToSettle(page);
    const activityTagText = await page.locator('.item-row .item-tags').first().textContent();
    console.log('5. Activity row shows the "Mike" tag:', /Mike/.test(activityTagText) && !/Sarah/.test(activityTagText), activityTagText);

    // ---- Transport: tag BOTH. ----
    await page.click('[data-action="switch-tab"][data-tab="transport"]');
    await page.click('[data-action="new-transport"]');
    await page.fill('input[name="fromLocation"]', 'LHR');
    await page.fill('input[name="toLocation"]', 'CNX');
    await page.fill('input[name="departDate"]', '2027-11-02');
    await page.fill('input[name="arriveDate"]', '2027-11-02');
    await page.locator('.tag-picker-item', { hasText: 'Sarah' }).locator('input[type="checkbox"]').check();
    await page.locator('.tag-picker-item', { hasText: 'Mike' }).locator('input[type="checkbox"]').check();
    await page.click('#entity-form button[type="submit"]');
    await waitForSaveToSettle(page);
    const transportTagText = await page.locator('.item-row .item-tags').first().textContent();
    console.log('6. Transport row shows BOTH tags:', /Sarah/.test(transportTagText) && /Mike/.test(transportTagText), transportTagText);

    // ---- Accommodation: tag Sarah, then edit and confirm the checkbox
    // comes back pre-checked (round-trips correctly). ----
    await page.click('[data-action="switch-tab"][data-tab="accommodation"]');
    await page.click('[data-action="new-accommodation"]');
    await page.fill('input[name="name"]', 'Riverside Guesthouse');
    await page.fill('input[name="checkInDate"]', '2027-11-02');
    await page.fill('input[name="checkOutDate"]', '2027-11-05');
    await page.locator('.tag-picker-item', { hasText: 'Sarah' }).locator('input[type="checkbox"]').check();
    await page.click('#entity-form button[type="submit"]');
    await waitForSaveToSettle(page);
    await page.locator('.item-row', { hasText: 'Riverside Guesthouse' }).locator('[data-action="edit-accommodation"]').click();
    await page.waitForTimeout(50);
    const sarahCheckedOnEdit = await page.locator('.tag-picker-item', { hasText: 'Sarah' }).locator('input[type="checkbox"]').isChecked();
    const mikeCheckedOnEdit = await page.locator('.tag-picker-item', { hasText: 'Mike' }).locator('input[type="checkbox"]').isChecked();
    console.log('7. Editing re-shows the saved tag state correctly:', sarahCheckedOnEdit === true && mikeCheckedOnEdit === false, { sarahCheckedOnEdit, mikeCheckedOnEdit });
    await page.click('.modal-head [data-action="close-modal"]');

    // ---- Renaming a companion updates every tag that references them
    // (tags are stored as an id, resolved to a name at render time — see
    // companionTags() — so nothing else needs to change). ----
    await page.click('[data-action="switch-tab"][data-tab="companions"]');
    await page.locator('.item-row', { hasText: 'Sarah' }).locator('[data-action="edit-companion"]').click();
    await page.fill('input[name="name"]', 'Sarah T.');
    await page.click('#entity-form button[type="submit"]');
    await waitForSaveToSettle(page);
    await page.click('[data-action="switch-tab"][data-tab="destinations"]');
    const renamedTagText = await page.locator('.item-row .item-tags').first().textContent();
    console.log('8. Renaming a companion updates their tag everywhere:', /Sarah T\./.test(renamedTagText), renamedTagText);

    // ---- Deleting a companion doesn't break the items that were tagged
    // to them — the tag just quietly disappears (no crash, no stale
    // reference shown). ----
    await page.click('[data-action="switch-tab"][data-tab="companions"]');
    await page.locator('.item-row', { hasText: 'Mike' }).locator('[data-action="delete-companion"]').click();
    await page.click('[data-action="confirm-yes"]');
    await waitForSaveToSettle(page);
    await page.click('[data-action="switch-tab"][data-tab="activities"]');
    const activityTagAfterDelete = await page.locator('.item-row .item-tags').first().textContent();
    console.log('9. Deleting a tagged companion leaves the item intact, tag just gone:', activityTagAfterDelete.trim() === '', JSON.stringify(activityTagAfterDelete));

    // ================= Companions & Avatars: smiley colour, account
    // linking, and the accountId-protection guarantees around it. Uses a
    // fresh companion ("Priya") rather than the already-renamed/deleted
    // Sarah/Mike above, to keep this section's own before/after state
    // easy to follow. =====================================================
    const fetchJson = (url, opts) => page.evaluate(([u, o]) => fetch(u, o).then((r) => r.json()), [url, Object.assign({ credentials: 'same-origin' }, opts || {})]);

    await page.click('[data-action="switch-tab"][data-tab="companions"]');
    await page.click('[data-action="new-companion"]');
    // The 'avatar-color' field renders one real (visually hidden) radio
    // input per swatch, wrapped in a <label> together with the visible
    // circle -- clicking the circle is exactly what a real person does,
    // and (via the native label-wraps-input relationship) is what
    // actually selects the radio. See the 'avatar-color' case in
    // fieldHtml() in index.html.
    await page.fill('input[name="name"]', 'Priya');
    await page.locator('.avatar-swatch-label[title="pink"] .avatar-swatch-btn').click();
    const pinkRadioChecked = await page.locator('input.avatar-swatch-radio[value="pink"]').isChecked();
    console.log('10. Picking a smiley colour swatch actually checks its (hidden) radio input:', pinkRadioChecked);
    await page.click('#entity-form button[type="submit"]');
    await waitForSaveToSettle(page);

    // The chosen colour actually lands on the INNER smiley glyph (its
    // `color:` style), not the outer circle's own background -- the
    // outer circle is always the fixed grey reserved for a non-account
    // companion (AVATAR_GREY_HEX) -- see avatarMarkerHtml()'s "smiley"
    // branch in index.html. So look for the hex anywhere in the marker's
    // markup, not just its own style attribute.
    const priyaMarkerOuterHtml = await page.locator('.item-row', { hasText: 'Priya' }).locator('.avatar-marker').first().evaluate((el) => el.outerHTML);
    console.log('11. Priya\'s row shows an avatar marker using the chosen smiley colour (pink = #EC4899):', /#EC4899/i.test(priyaMarkerOuterHtml || ''), priyaMarkerOuterHtml);
    const priyaMarkerGlyphBefore = (await page.locator('.item-row', { hasText: 'Priya' }).locator('.avatar-marker').first().textContent() || '').trim();
    console.log('    ...and (not linked to any account yet) it\'s the smiley glyph, not an animal:', priyaMarkerGlyphBefore === '☺', JSON.stringify(priyaMarkerGlyphBefore));

    // ---- Link Priya to the logged-in account itself (nothing stops a
    // companion being linked to the very account doing the linking -- see
    // handleCompanionLink() in src/worker.js, which never special-cases
    // "yourself"). The logged-in account here is the mock server's
    // pre-seeded uber-user ("admin") -- and the uber-user deliberately
    // never appears in any trip's own `grants` list (see the "undisclosed"
    // reasoning in src/worker.js, also covered in test-auth-roles.js), so
    // renderCompanionsTab() has nothing to look its username up in and
    // correctly falls back to the generic "has a login" tag rather than
    // guessing a name -- see its own comment for exactly this case. ----
    await page.locator('.item-row', { hasText: 'Priya' }).locator('[data-action="link-companion"]').click();
    await page.waitForSelector('#companion-link-form', { timeout: 5000 });
    await page.fill('#companion-link-form input[name="username"]', 'admin');
    await page.click('#companion-link-form button[type="submit"]');
    await waitForModalToClose(page, '#companion-link-form');
    const linkedTagText = await page.locator('.item-row', { hasText: 'Priya' }).locator('.tag').allTextContents();
    console.log('12. Linking Priya to the uber-user shows the "has a login" fallback tag (it has no grant to name it by):', linkedTagText.some((t) => /has a login/.test(t)), linkedTagText);
    const priyaMarkerGlyphAfterLink = (await page.locator('.item-row', { hasText: 'Priya' }).locator('.avatar-marker').first().textContent() || '').trim();
    console.log('    ...and the marker switches from the smiley to the linked account\'s own animal (no longer ☺):', priyaMarkerGlyphAfterLink !== '☺' && priyaMarkerGlyphAfterLink !== '', priyaMarkerGlyphAfterLink);

    // ---- An unrelated, ordinary save (editing the trip's home currency,
    // nothing to do with companions at all) must NOT wipe the link out --
    // this is exactly the data-loss shape reconcileCompanionAccountLinks()
    // in src/worker.js exists to prevent (see its own long comment: the
    // first-instinct "just strip accountId from every incoming companion"
    // approach would silently destroy every link on the next unrelated
    // save). ----
    await page.click('[data-action="switch-tab"][data-tab="settings"]');
    await page.fill('input[name="homeCurrency"]', 'USD');
    await page.click('#rates-form button[type="submit"]');
    await waitForSaveToSettle(page);
    await page.fill('input[name="homeCurrency"]', 'GBP'); // put it back for the rest of this file, while still on Settings
    await page.click('#rates-form button[type="submit"]');
    await waitForSaveToSettle(page);
    // Reload the whole page before checking -- persist() re-renders
    // OPTIMISTICALLY from the browser's own already-mutated copy of
    // `state`, before either save's POST has even reached the server, so
    // just reading the DOM at this point would only prove the CLIENT
    // still believes the link exists, not that the SERVER'S stored copy
    // does. A full reload forces a fresh GET, which is the only way to
    // see what actually made it into storage -- exactly the distinction
    // that matters for what this check is trying to prove.
    //
    // NOTE: this does NOT land back on the dashboard's trip grid. See
    // persist()'s sessionStorage.setItem('waypoint-nav', ...) and
    // renderBoot()'s read of it: the app deliberately remembers which
    // trip and tab were open and restores straight back into it on
    // reload/refresh (so a save-triggered reload doesn't kick the user
    // back to the dashboard). Since we were on the Settings tab when we
    // reloaded, we land right back in this same trip's Settings tab --
    // so just wait for the trip view to re-render, then switch tabs
    // directly, rather than waiting for a dashboard that isn't coming.
    await page.reload();
    await page.waitForSelector('[data-action="switch-tab"][data-tab="companions"]', { timeout: 5000 });
    await page.click('[data-action="switch-tab"][data-tab="companions"]');
    const linkedTagAfterUnrelatedSave = await page.locator('.item-row', { hasText: 'Priya' }).locator('.tag').allTextContents();
    console.log('13. Two unrelated saves later (changing the home currency, then changing it back) and a fresh page reload, Priya\'s account link is still intact server-side:',
      linkedTagAfterUnrelatedSave.some((t) => /has a login/.test(t)), linkedTagAfterUnrelatedSave);

    // ---- The server refuses to smuggle a fake accountId onto a DIFFERENT
    // (never-linked) companion via a raw, hand-crafted save, even from
    // this same full-scope (Superuser) session. ----
    const beforeSmuggle = await fetchJson('/WayPoint/api/data');
    const tripNow = beforeSmuggle.trips.find((t) => t.tripId === tripId);
    const smuggleBody = JSON.parse(JSON.stringify(beforeSmuggle));
    const smuggleTrip = smuggleBody.trips.find((t) => t.tripId === tripId);
    const sarahTNow = smuggleTrip.companions.find((c) => c.name === 'Sarah T.');
    sarahTNow.accountId = 'totally-fake-account-id';
    await page.evaluate((body) => fetch('/WayPoint/api/data', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), smuggleBody);
    const afterSmuggle = await fetchJson('/WayPoint/api/data');
    const sarahTAfterSmuggle = afterSmuggle.trips.find((t) => t.tripId === tripId).companions.find((c) => c.name === 'Sarah T.');
    console.log('14. A hand-crafted accountId on a never-linked companion is refused even from a full-scope session:', !sarahTAfterSmuggle.accountId, sarahTAfterSmuggle.accountId);
    // And Priya's REAL link (also present in that same hostile request,
    // unmodified) is left exactly as it was -- proving the guard
    // reasserts real stored values rather than blanket-stripping the
    // field (which would have also destroyed this legitimate one).
    const priyaAfterSmuggle = afterSmuggle.trips.find((t) => t.tripId === tripId).companions.find((c) => c.name === 'Priya');
    const priyaBeforeSmuggle = tripNow.companions.find((c) => c.name === 'Priya');
    console.log('    ...while Priya\'s real, legitimate link survives that same request untouched:', priyaAfterSmuggle.accountId === priyaBeforeSmuggle.accountId && !!priyaAfterSmuggle.accountId, priyaAfterSmuggle.accountId);

    // ---- Unlink Priya (submit the link form with a blank username) --
    // reverts back to the smiley marker. ----
    await page.locator('.item-row', { hasText: 'Priya' }).locator('[data-action="link-companion"]').click();
    await page.waitForSelector('#companion-link-form', { timeout: 5000 });
    await page.fill('#companion-link-form input[name="username"]', '');
    await page.click('#companion-link-form button[type="submit"]');
    await waitForModalToClose(page, '#companion-link-form');
    const linkedTagAfterUnlink = await page.locator('.item-row', { hasText: 'Priya' }).locator('.tag').allTextContents();
    const priyaMarkerGlyphAfterUnlink = (await page.locator('.item-row', { hasText: 'Priya' }).locator('.avatar-marker').first().textContent() || '').trim();
    console.log('15. Unlinking Priya removes the "linked to" tag and reverts the marker to the smiley:',
      !linkedTagAfterUnlink.some((t) => /admin/.test(t)) && priyaMarkerGlyphAfterUnlink === '☺', { linkedTagAfterUnlink, priyaMarkerGlyphAfterUnlink });

    // ---- The dashboard trip card shows a bare avatar marker per
    // companion on the trip (tripCardAvatarsHtml() in index.html) --
    // Sarah T. and Priya, 2 in total at this point. ----
    await page.click('[data-action="back-to-dashboard"]');
    const tripCardMarkerCount = await page.locator('.trip-card', { hasText: 'Companions Test' }).locator('.trip-card-avatars .avatar-marker').count();
    console.log('16. The dashboard trip card shows one avatar marker per companion:', tripCardMarkerCount === 2, tripCardMarkerCount);

    // ================= Guest vs Companion: the one-step "Add companion"
    // flow (create + link in a single form) -- see
    // openAddLinkedCompanionForm()/submitAddLinkedCompanion() in
    // index.html. This session is logged in as the uber-user ("admin"),
    // who canLinkCompanion() this trip, so both "Add guest" and
    // "Add companion" should be offered. =================================
    await page.click('.trip-card', { hasText: 'Companions Test' });
    await page.click('[data-action="switch-tab"][data-tab="companions"]');
    console.log('17. A Superuser/Admin session sees BOTH "Add guest" and the separate "Add companion" button:',
      (await page.locator('[data-action="new-companion"]').count()) === 1 && (await page.locator('[data-action="new-linked-companion"]').count()) === 1);

    await page.click('[data-action="new-linked-companion"]');
    await page.waitForSelector('#add-linked-companion-form', { timeout: 5000 });
    await page.fill('#add-linked-companion-form input[name="name"]', 'Diego');
    await page.fill('#add-linked-companion-form input[name="username"]', 'admin');
    await page.click('#add-linked-companion-form button[type="submit"]');
    // This one submit does THREE things in sequence under the hood --
    // an ordinary optimistic companion-add save, a wait for it to
    // actually land, then a call to the standalone link endpoint, which
    // itself does a full state reload on success (see
    // submitAddLinkedCompanion()'s own comment) -- so give it more room
    // than the usual single-save wait.
    await page.waitForSelector('.item-row:has-text("Diego") .tag:has-text("Super")', { timeout: 5000 });
    const diegoTags = await page.locator('.item-row', { hasText: 'Diego' }).locator('.tag').allTextContents();
    const diegoMarkerGlyph = (await page.locator('.item-row', { hasText: 'Diego' }).locator('.avatar-marker').first().textContent() || '').trim();
    console.log('18. "Add companion" creates Diego already linked -- resolved access level "Super", not a plain "Guest":',
      diegoTags.includes('Super') && !diegoTags.includes('Guest'), diegoTags);
    console.log('    ...and Diego\'s marker is already the linked account\'s own animal, never the generic smiley:', diegoMarkerGlyph !== '☺' && diegoMarkerGlyph !== '', diegoMarkerGlyph);
    // Confirm it happened server-side too, not just optimistically --
    // Diego really is a new companion, really linked to the uber-user's
    // real account id, not just something the client is pretending.
    const afterAddLinked = await fetchJson('/WayPoint/api/data');
    const diegoStored = afterAddLinked.trips.find((t) => t.tripId === tripId).companions.find((c) => c.name === 'Diego');
    console.log('    ...and the server genuinely stored Diego linked to a real account id:', !!diegoStored && !!diegoStored.accountId, diegoStored && diegoStored.accountId);

    // ================= New trip: "Who's coming with you?" box (see
    // TRIP_FIELDS_NEW / parseCompanionNamesBox() in index.html) -- a
    // quick-add box on the trip-CREATION form itself, so companions can
    // be typed in right when a trip is first set up, not only
    // afterwards from the Companions tab. =================================
    await page.click('[data-action="back-to-dashboard"]');
    await page.click('[data-action="new-trip"]');
    const companionBoxOnNewTrip = await page.locator('textarea[name="companionNames"]').count();
    console.log('19. The New trip form shows the "Who\'s coming with you?" box:', companionBoxOnNewTrip === 1, companionBoxOnNewTrip);

    await page.fill('input[name="name"]', 'Family Roadtrip');
    await page.fill('input[name="homeCurrency"]', 'GBP');
    // One per line AND a comma-separated pair on one line -- exercises
    // both separators parseCompanionNamesBox() accepts, plus blank
    // lines in between, which should just be dropped rather than
    // becoming an empty-named companion.
    await page.fill('textarea[name="companionNames"]', 'Jamie\n\nTaylor, Robin');
    await page.click('#entity-form button[type="submit"]');
    await waitForSaveToSettle(page);
    const roadtripId = await page.evaluate(() => currentTripId);

    await page.click('[data-action="switch-tab"][data-tab="companions"]');
    const roadtripCompanionNames = (await page.locator('.item-row .item-title').allTextContents()).map((s) => s.trim());
    console.log('20. All three names typed into the box became companions on the new trip, blank line dropped:',
      roadtripCompanionNames.length === 3 && ['Jamie', 'Taylor', 'Robin'].every((n) => roadtripCompanionNames.includes(n)), roadtripCompanionNames);

    const roadtripGuestTags = await page.locator('.item-row', { hasText: 'Jamie' }).locator('.tag').allTextContents();
    console.log('    ...and each comes in as a plain Guest (no login), not pre-linked to anything:', roadtripGuestTags.includes('Guest'), roadtripGuestTags);

    // Confirmed server-side too, not just an optimistic render.
    const afterRoadtrip = await fetchJson('/WayPoint/api/data');
    const roadtripStored = afterRoadtrip.trips.find((t) => t.tripId === roadtripId);
    console.log('    ...and the server actually stored all three, none carrying an accountId:',
      roadtripStored.companions.length === 3 && roadtripStored.companions.every((c) => !c.accountId),
      roadtripStored.companions.map((c) => c.name));

    // Leaving the box blank creates a trip with no companions at all --
    // the box is optional, not required.
    await page.click('[data-action="back-to-dashboard"]');
    await page.click('[data-action="new-trip"]');
    await page.fill('input[name="name"]', 'Solo Trip');
    await page.fill('input[name="homeCurrency"]', 'GBP');
    await page.click('#entity-form button[type="submit"]');
    await waitForSaveToSettle(page);
    await page.click('[data-action="switch-tab"][data-tab="companions"]');
    const soloEmptyState = (await page.locator('.empty-state').count()) === 1;
    console.log('21. Leaving the box blank on a new trip creates no companions (empty state still shown):', soloEmptyState);

    // And editing an EXISTING trip never shows the box -- it's a
    // one-shot creation-time convenience, not a general companions
    // editor (that's what the Companions tab itself is for).
    await page.click('[data-action="back-to-dashboard"]');
    await page.locator('.trip-card', { hasText: 'Family Roadtrip' }).locator('[data-action="edit-trip"]').click();
    await page.waitForSelector('#entity-form', { timeout: 5000 });
    const companionBoxOnEditTrip = await page.locator('textarea[name="companionNames"]').count();
    console.log('22. The Edit trip form does NOT show the "Who\'s coming with you?" box:', companionBoxOnEditTrip === 0, companionBoxOnEditTrip);
    await page.click('.modal-head [data-action="close-modal"]');
    await page.waitForTimeout(100);

    console.log('\nPage errors:', errors.length ? errors : 'NONE');
    await browser.close();
  } finally {
    server.kill();
  }
})();
