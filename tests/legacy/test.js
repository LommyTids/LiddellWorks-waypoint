const { chromium } = require('playwright');
const { spawn } = require('child_process');

// This used to load index.html straight off disk via a file:// URL.
// That stopped working once the big COMMON_CURRENCIES/COMMON_COUNTRIES/
// etc. lists moved out of index.html into separate files loaded via
// <script src="/WayPoint/data/...">  (see data/*.js) — an absolute
// path like that has nowhere to resolve to under file://, so those
// scripts silently failed to load and every form depending on them
// (new trip, new destination, ...) broke. Spinning up the same tiny
// mock server the newer tests (test-deploy.js etc.) use gives this
// page a real /WayPoint/ origin those absolute paths resolve against,
// same as the real deployment — everything else about this test is
// unchanged.
const PORT = 8794;

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
  const server = spawn('node', ['mock-server.js', String(PORT)], { cwd: __dirname + '/../..', stdio: 'inherit' });
  try {
  await waitForServer('http://localhost:' + PORT + '/WayPoint');
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('pageerror', (err) => consoleErrors.push('PAGEERROR: ' + err.message));
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push('CONSOLE: ' + msg.text()); });

  await page.goto('http://localhost:' + PORT + '/WayPoint');

  // ---- 1. Dashboard empty state ----
  let emptyVisible = await page.locator('.empty-state').isVisible();
  console.log('1. Empty dashboard state visible:', emptyVisible);

  // ---- 2. Create a trip ----
  await page.click('[data-action="new-trip"]');
  await page.fill('input[name="name"]', 'Southeast Asia Loop');
  await page.fill('input[name="startDate"]', '2026-09-10');
  await page.fill('input[name="endDate"]', '2026-09-20');
  await page.fill('input[name="homeCurrency"]', 'GBP');
  await page.click('#entity-form button[type="submit"]');
  await page.waitForTimeout(100);
  let onTripView = await page.locator('.trip-title-row h1').textContent();
  console.log('2. Trip created, now viewing:', onTripView.trim());

  // ---- 3. Add a destination ----
  await page.click('[data-action="switch-tab"][data-tab="destinations"]');
  await page.click('[data-action="new-destination"]');
  await page.fill('input[name="name"]', 'Bangkok');
  await page.fill('input[name="country"]', 'Thailand');
  await page.fill('input[name="arriveDate"]', '2026-09-10');
  await page.fill('input[name="departDate"]', '2026-09-13');
  await page.click('#entity-form button[type="submit"]');
  await page.waitForTimeout(100);
  await page.click('[data-action="new-destination"]');
  await page.fill('input[name="name"]', 'Chiang Mai');
  await page.fill('input[name="country"]', 'Thailand');
  await page.fill('input[name="arriveDate"]', '2026-09-14');
  await page.fill('input[name="departDate"]', '2026-09-20');
  await page.click('#entity-form button[type="submit"]');
  await page.waitForTimeout(100);
  let destCount = await page.locator('.item-row').count();
  console.log('3. Destinations added:', destCount, '(expect 2)');

  // ---- 4. Add an overnight train (transport spanning midnight) ----
  await page.click('[data-action="switch-tab"][data-tab="transport"]');
  await page.click('[data-action="new-transport"]');
  await page.selectOption('select[name="mode"]', 'Train');
  await page.fill('input[name="fromLocation"]', 'Bangkok');
  await page.fill('input[name="toLocation"]', 'Chiang Mai');
  await page.fill('input[name="departDate"]', '2026-09-13');
  await page.fill('input[name="departTime"]', '19:35');
  await page.fill('input[name="arriveDate"]', '2026-09-14');
  await page.fill('input[name="arriveTime"]', '08:25');
  await page.fill('input[name="bookingRef"]', 'SRT-88213');
  await page.fill('input[name="costAmount"]', '1200');
  await page.fill('input[name="costCurrency"]', 'THB');
  await page.click('#entity-form button[type="submit"]');
  await page.waitForTimeout(100);
  let transportRows = await page.locator('.item-row').count();
  console.log('4. Transport legs added:', transportRows, '(expect 1)');

  // ---- 5. Add accommodation in Chiang Mai ----
  await page.click('[data-action="switch-tab"][data-tab="accommodation"]');
  await page.click('[data-action="new-accommodation"]');
  await page.fill('input[name="name"]', 'Riverside Guesthouse');
  await page.fill('input[name="address"]', '99 Riverside Rd, Chiang Mai');
  await page.fill('input[name="checkInDate"]', '2026-09-14');
  await page.fill('input[name="checkInTime"]', '10:00');
  await page.fill('input[name="checkOutDate"]', '2026-09-20');
  await page.fill('input[name="checkOutTime"]', '11:00');
  await page.fill('input[name="costAmount"]', '4200');
  await page.fill('input[name="costCurrency"]', 'THB');
  await page.click('#entity-form button[type="submit"]');
  await page.waitForTimeout(100);

  // ---- 6. Check Timeline shows the overnight leg on both days + areas ----
  await page.click('[data-action="switch-tab"][data-tab="timeline"]');
  await page.waitForTimeout(100);
  const timelineText = await page.locator('#app').innerText();
  const hasDepart = timelineText.includes('Bangkok') && timelineText.includes('Train: Bangkok');
  const hasArriveContinuation = timelineText.includes('Arrive: Chiang Mai');
  const hasOvernightNote = timelineText.includes('Overnight');
  console.log('6. Timeline shows departure leg:', hasDepart);
  console.log('   Timeline shows arrival continuation on next day:', hasArriveContinuation);
  console.log('   Timeline shows an overnight note somewhere:', hasOvernightNote);
  const dayCount = await page.locator('.day-card').count();
  console.log('   Day cards rendered:', dayCount, '(expect 11 for Sep 10-20)');

  // ---- 7. Expenses tab: rate-needed warning (THB has no rate yet) ----
  await page.click('[data-action="switch-tab"][data-tab="expenses"]');
  await page.waitForTimeout(100);
  const expensesText = await page.locator('#app').innerText();
  console.log('7. Expenses tab mentions "need an exchange rate":', expensesText.includes('need an exchange rate'));
  console.log('   Expenses tab shows "rate needed" in table:', expensesText.includes('rate needed'));

  // ---- 8. Set exchange rate in Settings, confirm totals update ----
  await page.click('[data-action="switch-tab"][data-tab="settings"]');
  await page.waitForTimeout(100);
  await page.fill('input[name="rate_THB"]', '0.022');
  await page.click('#rates-form button[type="submit"]');
  await page.waitForTimeout(150);
  await page.click('[data-action="switch-tab"][data-tab="expenses"]');
  await page.waitForTimeout(100);
  const expensesText2 = await page.locator('#app').innerText();
  console.log('8. After setting rate, "rate needed" gone:', !expensesText2.includes('rate needed'));
  // 1200 + 4200 = 5400 THB * 0.022 = 118.80 GBP
  console.log('   Contains expected total 118.80:', expensesText2.includes('118.80'));

  // ---- 9. Add a standalone expense, verify it appears ----
  await page.click('[data-action="new-expense"]');
  await page.fill('input[name="description"]', 'Street food dinner');
  await page.fill('input[name="date"]', '2026-09-15');
  await page.fill('input[name="amount"]', '150');
  await page.fill('input[name="currency"]', 'THB');
  await page.click('#entity-form button[type="submit"]');
  await page.waitForTimeout(100);
  const expensesText3 = await page.locator('#app').innerText();
  console.log('9. Standalone expense appears:', expensesText3.includes('Street food dinner'));

  // ---- 10. Dashboard shows correct spend total ----
  await page.click('[data-action="back-to-dashboard"]');
  await page.waitForTimeout(100);
  const dashText = await page.locator('#app').innerText();
  console.log('10. Dashboard shows trip card:', dashText.includes('Southeast Asia Loop'));
  // total should now be 5400+150=5550 THB * 0.022 = 122.10
  console.log('    Dashboard shows updated total 122.10:', dashText.includes('122.10'));

  console.log('\n--- Console/page errors captured ---');
  if (consoleErrors.length === 0) console.log('NONE');
  else consoleErrors.forEach(e => console.log(e));

  await browser.close();
  } finally {
    server.kill();
  }
})();
