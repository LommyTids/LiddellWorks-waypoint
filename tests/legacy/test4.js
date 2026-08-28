const { chromium } = require('playwright');
const { spawn } = require('child_process');

// See test.js in this same folder for why this loads via a local mock
// server instead of a file:// URL — the short version: index.html's
// datalist source lists (COMMON_CURRENCIES etc.) now load from
// /WayPoint/data/*.js, an absolute path that only resolves against a
// real HTTP origin.
const PORT = 8796;

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
      next.trips.push({ id: 't1', name: 'Trip', startDate: '', endDate: '', homeCurrency: 'GBP', notes: '',
        currencyRates: {}, destinations: [], activities: [], transport: [], accommodation: [], contacts: [], expenses: [] });
    });
    currentView = 'trip'; currentTripId = 't1'; currentTab = 'destinations'; render();
  });

  await page.click('[data-action="new-destination"]');
  const fieldOrder = await page.$$eval('#entity-form input, #entity-form textarea', els => els.map(e => e.name));
  console.log('Field order:', fieldOrder);
  console.log('1. Country comes before name:', fieldOrder.indexOf('country') < fieldOrder.indexOf('name') && fieldOrder.indexOf('country') !== -1);

  const listAttr = await page.locator('input[name="country"]').getAttribute('list');
  console.log('2. Country input has list=country-list:', listAttr === 'country-list');
  const optionCount = await page.locator('#country-list option').count();
  console.log('3. country-list datalist has options:', optionCount, '(expect > 100)');
  const hasThailand = await page.locator('#country-list option[value="Thailand"]').count();
  console.log('4. Thailand is in the list:', hasThailand === 1);

  // fill and save, confirm stored + displayed correctly
  await page.fill('input[name="country"]', 'Thailand');
  await page.fill('input[name="name"]', 'Chiang Mai');
  await page.fill('input[name="arriveDate"]', '2026-09-14');
  await page.fill('input[name="departDate"]', '2026-09-20');
  await page.click('#entity-form button[type="submit"]');
  await page.waitForTimeout(100);
  const text = await page.locator('#app').innerText();
  console.log('5. Destination row displays "Chiang Mai, Thailand":', text.includes('Chiang Mai, Thailand'));

  console.log('\nErrors:', errors.length ? errors : 'NONE');
  await browser.close();
  } finally {
    server.kill();
  }
})();
