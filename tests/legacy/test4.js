const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('file://' + path.resolve(__dirname, '../../public/WayPoint/index.html'));
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
})();
