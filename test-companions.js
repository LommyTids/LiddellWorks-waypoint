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
const { loginAsAdmin } = require('./test-helpers');

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
    await page.waitForTimeout(150);

    // ---- Companions tab: empty state, then add two. ----
    await page.click('[data-action="switch-tab"][data-tab="companions"]');
    const emptyStateShown = (await page.locator('.empty-state').count()) === 1;
    console.log('1. Companions tab starts empty:', emptyStateShown);

    await page.click('[data-action="new-companion"]');
    await page.fill('input[name="name"]', 'Sarah');
    await page.click('#entity-form button[type="submit"]');
    await page.waitForTimeout(100);
    await page.click('[data-action="new-companion"]');
    await page.fill('input[name="name"]', 'Mike');
    await page.click('#entity-form button[type="submit"]');
    await page.waitForTimeout(100);
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
    await page.waitForTimeout(100);
    const destTagText = await page.locator('.item-row .item-tags').first().textContent();
    console.log('4. Destination row shows the "Sarah" tag:', /Sarah/.test(destTagText) && !/Mike/.test(destTagText), destTagText);

    // ---- Activity: tag Mike only. ----
    await page.click('[data-action="switch-tab"][data-tab="activities"]');
    await page.click('[data-action="new-activity"]');
    await page.fill('input[name="title"]', 'Cooking class');
    await page.fill('input[name="date"]', '2027-11-03');
    await page.locator('.tag-picker-item', { hasText: 'Mike' }).locator('input[type="checkbox"]').check();
    await page.click('#entity-form button[type="submit"]');
    await page.waitForTimeout(100);
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
    await page.waitForTimeout(100);
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
    await page.waitForTimeout(100);
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
    await page.waitForTimeout(100);
    await page.click('[data-action="switch-tab"][data-tab="destinations"]');
    const renamedTagText = await page.locator('.item-row .item-tags').first().textContent();
    console.log('8. Renaming a companion updates their tag everywhere:', /Sarah T\./.test(renamedTagText), renamedTagText);

    // ---- Deleting a companion doesn't break the items that were tagged
    // to them — the tag just quietly disappears (no crash, no stale
    // reference shown). ----
    await page.click('[data-action="switch-tab"][data-tab="companions"]');
    await page.locator('.item-row', { hasText: 'Mike' }).locator('[data-action="delete-companion"]').click();
    await page.click('[data-action="confirm-yes"]');
    await page.waitForTimeout(100);
    await page.click('[data-action="switch-tab"][data-tab="activities"]');
    const activityTagAfterDelete = await page.locator('.item-row .item-tags').first().textContent();
    console.log('9. Deleting a tagged companion leaves the item intact, tag just gone:', activityTagAfterDelete.trim() === '', JSON.stringify(activityTagAfterDelete));

    console.log('\nPage errors:', errors.length ? errors : 'NONE');
    await browser.close();
  } finally {
    server.kill();
  }
})();
