const { chromium } = require('playwright');
const { spawn } = require('child_process');

// See test.js in this same folder for why this loads via a local mock
// server instead of a file:// URL — the short version: index.html's
// datalist source lists (COMMON_CURRENCIES etc.) now load from
// /WayPoint/data/*.js, an absolute path that only resolves against a
// real HTTP origin.
const PORT = 8795;

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
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('http://localhost:' + PORT + '/WayPoint');

  await page.evaluate(() => {
    updateState(next => {
      next.trips.push({
        id: 't1', name: 'Test Trip', startDate: '2026-11-01', endDate: '2026-11-05', homeCurrency: 'GBP', notes: '',
        currencyRates: {}, destinations: [], activities: [], transport: [], accommodation: [], contacts: [], expenses: []
      });
    });
    currentView = 'trip'; currentTripId = 't1'; currentTab = 'transport'; render();
  });

  // ---- Transport: default mode is Flight, should show Flight number field ----
  await page.click('[data-action="new-transport"]');
  let hasFlightNum = await page.locator('input[name="flightNumber"]').count();
  let hasLicensePlate = await page.locator('input[name="licensePlate"]').count();
  console.log('1. New transport form defaults to Flight, has flightNumber field:', hasFlightNum === 1);
  console.log('   Does NOT have licensePlate field:', hasLicensePlate === 0);

  // fill some common fields before switching mode, to test values survive the switch
  await page.fill('input[name="fromLocation"]', 'London');
  await page.fill('input[name="toLocation"]', 'Paris');
  await page.fill('input[name="carrier"]', 'Eurostar-to-be-overwritten');
  await page.fill('input[name="bookingRef"]', 'REF123');

  // ---- Switch mode to Car: flightNumber should disappear, licensePlate should appear ----
  await page.selectOption('select[name="mode"]', 'Car');
  await page.waitForTimeout(50);
  hasFlightNum = await page.locator('input[name="flightNumber"]').count();
  hasLicensePlate = await page.locator('input[name="licensePlate"]').count();
  console.log('2. After switching to Car: flightNumber field gone:', hasFlightNum === 0);
  console.log('   licensePlate field present:', hasLicensePlate === 1);
  const fromVal = await page.locator('input[name="fromLocation"]').inputValue();
  const toVal = await page.locator('input[name="toLocation"]').inputValue();
  const bookingRefVal = await page.locator('input[name="bookingRef"]').inputValue();
  console.log('   fromLocation preserved across mode switch:', fromVal === 'London');
  console.log('   toLocation preserved across mode switch:', toVal === 'Paris');
  console.log('   bookingRef preserved across mode switch:', bookingRefVal === 'REF123');

  // Fill car-specific fields and submit
  await page.fill('input[name="carrier"]', 'Hertz');
  await page.fill('input[name="licensePlate"]', 'AB12 CDE');
  await page.fill('input[name="departDate"]', '2026-11-02');
  await page.fill('input[name="arriveDate"]', '2026-11-02');
  await page.click('#entity-form button[type="submit"]');
  await page.waitForTimeout(100);

  const car = await page.evaluate(() => currentTrip().transport[0]);
  console.log('3. Saved car record has no flightNumber:', car.flightNumber === '');
  console.log('   Saved car record has licensePlate:', car.licensePlate === 'AB12 CDE');
  console.log('   Saved car record has carrier Hertz:', car.carrier === 'Hertz');

  const transportTabText = await page.locator('#app').innerText();
  console.log('4. Transport tab shows license plate tag:', transportTabText.includes('AB12 CDE'));

  // ---- Now add a flight leg, verify flight number shows up ----
  await page.click('[data-action="new-transport"]');
  await page.fill('input[name="fromLocation"]', 'Paris');
  await page.fill('input[name="toLocation"]', 'Tokyo');
  await page.fill('input[name="flightNumber"]', 'AF275');
  await page.fill('input[name="departDate"]', '2026-11-03');
  await page.fill('input[name="arriveDate"]', '2026-11-04');
  await page.click('#entity-form button[type="submit"]');
  await page.waitForTimeout(100);
  const transportTabText2 = await page.locator('#app').innerText();
  console.log('5. Transport tab shows flight number AF275:', transportTabText2.includes('AF275'));

  await page.click('[data-action="switch-tab"][data-tab="timeline"]');
  await page.waitForTimeout(50);
  const timelineText = await page.locator('#app').innerText();
  console.log('6. Timeline shows flight number in leg title:', timelineText.includes('AF275'));

  // ---- Destinations: timezone field + offset ----
  await page.click('[data-action="switch-tab"][data-tab="destinations"]');
  await page.click('[data-action="new-destination"]');
  await page.fill('input[name="name"]', 'Tokyo');
  await page.fill('input[name="arriveDate"]', '2026-11-04');
  await page.fill('input[name="departDate"]', '2026-11-05');
  await page.fill('input[name="timezone"]', 'Asia/Tokyo');
  await page.click('#entity-form button[type="submit"]');
  await page.waitForTimeout(100);
  const destText = await page.locator('#app').innerText();
  console.log('7. Destination tab shows Asia/Tokyo:', destText.includes('Asia/Tokyo'));
  console.log('   Destination tab shows a GMT offset:', /GMT\+?\d/.test(destText));

  await page.click('[data-action="switch-tab"][data-tab="timeline"]');
  await page.waitForTimeout(50);
  const timelineText2 = await page.locator('#app').innerText();
  console.log('8. Timeline area chip shows offset for Tokyo day:', /Tokyo.*GMT\+?\d/.test(timelineText2.replace(/\n/g,' ')));

  console.log('\nErrors:', errors.length ? errors : 'NONE');
  await browser.close();
  } finally {
    server.kill();
  }
})();
