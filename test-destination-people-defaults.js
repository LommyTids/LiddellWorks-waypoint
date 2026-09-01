// Regression coverage for destination People tags, the virtual trip-owner
// Superuser participant, and editable defaults on new activities.
const assert = require('assert');
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const { loginAsAdmin, waitForSaveToSettle } = require('./test-helpers');

const PORT = 8816;
const SUPERUSER_PARTICIPANT_ID = '__trip_superuser__';

function waitForServer(url, tries) {
  return new Promise((resolve, reject) => {
    const attempt = (remaining) => {
      require('http').get(url, () => resolve()).on('error', () => {
        if (remaining <= 0) return reject(new Error('server never came up'));
        setTimeout(() => attempt(remaining - 1), 150);
      });
    };
    attempt(tries || 30);
  });
}

(async () => {
  const server = spawn('node', ['mock-server.js', String(PORT)], { cwd: __dirname, stdio: 'inherit' });
  let browser;
  try {
    await waitForServer('http://localhost:' + PORT + '/WayPoint');
    browser = await chromium.launch({ executablePath: chromium.executablePath(), args: ['--no-sandbox'] });
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await page.goto('http://localhost:' + PORT + '/WayPoint');
    await loginAsAdmin(page);
    await page.click('[data-action="new-trip"]');
    await page.fill('input[name="name"]', 'Destination People Test');
    await page.fill('input[name="startDate"]', '2028-04-01');
    await page.fill('input[name="endDate"]', '2028-04-10');
    await page.fill('input[name="homeCurrency"]', 'GBP');
    await page.click('#entity-form button[type="submit"]');
    await waitForSaveToSettle(page);

    await page.click('[data-action="switch-tab"][data-tab="companions"]');
    await page.click('[data-action="new-companion"]');
    await page.fill('input[name="name"]', 'Sarah');
    await page.click('#entity-form button[type="submit"]');
    await waitForSaveToSettle(page);
    const sarahId = await page.evaluate(() => currentTrip().companions.find((c) => c.name === 'Sarah').companionId);

    await page.click('[data-action="switch-tab"][data-tab="destinations"]');
    await page.click('[data-action="new-destination"]');
    const ownerChoice = page.locator('.tag-picker-item', { hasText: 'admin' });
    assert.strictEqual(await ownerChoice.count(), 1, 'trip owner should appear once in the destination People picker');
    assert.match(await ownerChoice.textContent(), /Superuser/, 'trip owner should be explicitly labelled Superuser');
    assert.strictEqual(await ownerChoice.locator('.avatar-marker').count(), 1, 'trip owner should use the account avatar');

    await page.fill('input[name="name"]', 'Seoul');
    await page.fill('input[name="arriveDate"]', '2028-04-02');
    await page.fill('input[name="departDate"]', '2028-04-06');
    await ownerChoice.locator('input[type="checkbox"]').check();
    await page.locator('.tag-picker-item', { hasText: 'Sarah' }).locator('input[type="checkbox"]').check();
    await page.click('#entity-form button[type="submit"]');
    await waitForSaveToSettle(page);

    const destination = await page.evaluate(() => currentTrip().destinations[0]);
    assert.deepStrictEqual(new Set(destination.companions), new Set([SUPERUSER_PARTICIPANT_ID, sarahId]), 'destination should persist both people ids');
    const destinationText = await page.locator('.item-row', { hasText: 'Seoul' }).textContent();
    assert.match(destinationText, /admin.*Superuser/, 'destination row should render the explicit Superuser tag');
    assert.match(destinationText, /Sarah/, 'destination row should render the companion tag');

    await page.click('[data-action="switch-tab"][data-tab="activities"]');
    await page.click('[data-action="new-activity"]');
    const ownerActivityCheckbox = page.locator('input[data-tag-person-id="' + SUPERUSER_PARTICIPANT_ID + '"]');
    const sarahActivityCheckbox = page.locator('input[data-tag-person-id="' + sarahId + '"]');
    assert.strictEqual(await ownerActivityCheckbox.isChecked(), false, 'new activity starts without guesses before an area is selected');
    assert.strictEqual(await sarahActivityCheckbox.isChecked(), false, 'new activity starts without companion guesses before an area is selected');

    await page.selectOption('select[name="destinationId"]', destination.destinationId);
    assert.strictEqual(await ownerActivityCheckbox.isChecked(), true, 'selecting the destination should default the Superuser tag');
    assert.strictEqual(await sarahActivityCheckbox.isChecked(), true, 'selecting the destination should default its companion tags');

    // Defaults stay editable per activity.
    await sarahActivityCheckbox.uncheck();
    await page.fill('input[name="title"]', 'Owner-only lunch');
    await page.fill('input[name="startDate"]', '2028-04-03');
    await page.click('#entity-form button[type="submit"]');
    await waitForSaveToSettle(page);
    const activity = await page.evaluate(() => currentTrip().activities[0]);
    assert.deepStrictEqual(activity.companions, [SUPERUSER_PARTICIPANT_ID], 'activity should save the adjusted default, not force destination membership');

    // A Timeline quick-add with one unambiguous active destination gets
    // that destination as a seed, so its People defaults must be checked
    // on the first render without waiting for a change event.
    await page.click('[data-action="switch-tab"][data-tab="timeline"]');
    await page.locator('[data-action="timeline-add-activity"][data-day="2028-04-04"]').click();
    assert.strictEqual(await page.locator('select[name="destinationId"]').inputValue(), destination.destinationId, 'timeline quick-add should seed its active destination');
    assert.strictEqual(await page.locator('input[data-tag-person-id="' + SUPERUSER_PARTICIPANT_ID + '"]').isChecked(), true, 'seeded activity should inherit the Superuser on first render');
    assert.strictEqual(await page.locator('input[data-tag-person-id="' + sarahId + '"]').isChecked(), true, 'seeded activity should inherit companions on first render');
    await page.click('.modal-head [data-action="close-modal"]');

    const stored = await page.evaluate(() => fetch('/WayPoint/api/data', { credentials: 'same-origin' }).then((response) => response.json()));
    const storedTrip = stored.trips.find((trip) => trip.name === 'Destination People Test');
    assert.strictEqual(storedTrip.superuserParticipant.participantId, SUPERUSER_PARTICIPANT_ID, 'server response should resolve the virtual Superuser participant');
    assert.deepStrictEqual(storedTrip.activities[0].companions, [SUPERUSER_PARTICIPANT_ID], 'server should persist the Superuser tag safely');
    assert.deepStrictEqual(pageErrors, [], 'page should not raise runtime errors');

    console.log('Destination People defaults: PASS');
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
