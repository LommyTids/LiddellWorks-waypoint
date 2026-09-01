// Regression test for the Activity timing redesign: all-day entries, linked
// start/end dates, timed multi-day activities and backwards-compatible
// editing of an activity saved before startDate/endDate existed.
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const { loginAsAdmin, waitForSaveToSettle } = require('./test-helpers');

const PORT = 8815;

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
    page.on('pageerror', (error) => errors.push(error.message));

    await page.goto('http://localhost:' + PORT + '/WayPoint');
    await loginAsAdmin(page);
    await page.click('[data-action="new-trip"]');
    await page.fill('input[name="name"]', 'Activity Timing Test');
    await page.fill('input[name="startDate"]', '2027-10-01');
    await page.fill('input[name="endDate"]', '2027-10-10');
    await page.fill('input[name="homeCurrency"]', 'GBP');
    await page.click('#entity-form button[type="submit"]');
    await waitForSaveToSettle(page);

    await page.click('[data-action="switch-tab"][data-tab="activities"]');
    await page.click('[data-action="new-activity"]');
    const allDayByDefault = await page.locator('input[name="allDay"]').isChecked();
    const timesDisabledByDefault = await page.locator('input[name="startTime"]').isDisabled() && await page.locator('input[name="endTime"]').isDisabled();
    console.log('1. New activity starts as all-day and hides time entry:', allDayByDefault && timesDisabledByDefault);

    await page.fill('input[name="title"]', 'Festival weekend');
    await page.fill('input[name="startDate"]', '2027-10-03');
    const copiedEndDate = await page.locator('input[name="endDate"]').inputValue();
    console.log('2. Start date automatically fills the end date:', copiedEndDate === '2027-10-03', copiedEndDate);

    await page.uncheck('input[name="allDay"]');
    const timesEnabledAfterToggle = !(await page.locator('input[name="startTime"]').isDisabled()) && !(await page.locator('input[name="endTime"]').isDisabled());
    console.log('3. Turning off all-day reveals enabled time fields:', timesEnabledAfterToggle);
    await page.fill('input[name="startTime"]', '18:30');
    await page.fill('input[name="endTime"]', '23:00');
    await page.fill('input[name="endDate"]', '2027-10-05');
    await page.fill('input[name="startDate"]', '2027-10-04');
    const retainedCustomEndDate = await page.locator('input[name="endDate"]').inputValue();
    console.log('4. A manually changed end date is not overwritten:', retainedCustomEndDate === '2027-10-05', retainedCustomEndDate);

    await page.click('#entity-form button[type="submit"]');
    await waitForSaveToSettle(page);
    const saved = await page.evaluate(() => currentTrip().activities[0]);
    const savedCorrectly = saved.date === '2027-10-04' && saved.startDate === '2027-10-04' && saved.endDate === '2027-10-05' &&
      saved.allDay === false && saved.startTime === '18:30' && saved.endTime === '23:00';
    console.log('5. Timed multi-day activity saves the full range:', savedCorrectly, JSON.stringify(saved));
    const activityText = await page.locator('.item-row', { hasText: 'Festival weekend' }).textContent();
    console.log('6. Activities list shows the full date range:', /4 Oct 2027.*5 Oct 2027/.test(activityText), activityText);

    await page.evaluate(() => {
      currentTrip().activities.push({ activityId: 'legacy-activity', title: 'Legacy museum day', date: '2027-10-06', startTime: '', endTime: '', companions: [] });
      render();
    });
    await page.click('[data-action="switch-tab"][data-tab="activities"]');
    await page.locator('.item-row', { hasText: 'Legacy museum day' }).locator('[data-action="edit-activity"]').click();
    const legacyAllDay = await page.locator('input[name="allDay"]').isChecked();
    const legacyStart = await page.locator('input[name="startDate"]').inputValue();
    const legacyEnd = await page.locator('input[name="endDate"]').inputValue();
    console.log('7. Legacy single-date activity edits as an all-day range:', legacyAllDay && legacyStart === '2027-10-06' && legacyEnd === '2027-10-06', { legacyAllDay, legacyStart, legacyEnd });
    await page.click('.modal-head [data-action="close-modal"]');

    console.log('Page errors:', errors.length ? errors : 'NONE');
    await browser.close();
  } finally {
    server.kill();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
