// Regression test for making every suggestible field (currency,
// country, city, timezone) use the SAME app-rendered dropdown as the
// airport field, instead of only airport having it while the rest
// still used a native <datalist> (see the "Generic suggestion
// dropdown" section in index.html, and suggestInputHtml() just above
// fieldHtml()). Airport's own dropdown behavior (widened search,
// resolve-hint, keyboard nav, click-to-select) already has dedicated
// coverage in test-airport-suggestions.js — this file checks that the
// OTHER fields got the same treatment: no leftover `list="..."`
// attributes or native <datalist> elements anywhere, each field opens
// an app-rendered dropdown seeded from its own list on focus, narrows
// as you type, and fills the field on click — including the Settings
// tab's Home currency field, which is hand-built outside the normal
// fieldHtml()/openForm() modal system but should still match exactly.
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const { loginAsAdmin } = require('./test-helpers');

const PORT = 8807;

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
    await page.fill('input[name="name"]', 'Dropdown Consistency Test');
    await page.fill('input[name="startDate"]', '2027-10-01');
    await page.fill('input[name="endDate"]', '2027-10-10');
    await page.fill('input[name="homeCurrency"]', 'GBP');
    await page.click('#entity-form button[type="submit"]');
    await page.waitForTimeout(150);

    // ---- No leftover native <datalist>/list="..." anywhere. ----
    const leftoverDatalists = await page.evaluate(() => document.querySelectorAll('datalist').length);
    console.log('1. No native <datalist> elements left in the page:', leftoverDatalists === 0, leftoverDatalists);

    // ---- Destination form: country, city ("Place / area"), timezone —
    // all three should render the same wrapper/dropdown markup. ----
    await page.click('[data-action="switch-tab"][data-tab="destinations"]');
    await page.click('[data-action="new-destination"]');

    const fieldsToCheck = [
      { name: 'country', suggestType: 'country', sampleQuery: 'Tha', expectedSubstr: 'Thailand' },
      { name: 'name', suggestType: 'city', sampleQuery: 'Bang', expectedSubstr: 'Bangkok' },
      { name: 'timezone', suggestType: 'timezone', sampleQuery: 'Asia/Ba', expectedSubstr: 'Asia/Bangkok' }
    ];
    for (const f of fieldsToCheck) {
      const noListAttr = await page.locator(`[name="${f.name}"]`).evaluate((el) => el.getAttribute('list') === null);
      const suggestType = await page.locator(`[name="${f.name}"]`).getAttribute('data-suggest-type');
      const inWrap = await page.locator(`[name="${f.name}"]`).evaluate((el) => !!el.closest('.suggest-input-wrap'));
      console.log(`2. [${f.name}] has no native list attr, correct data-suggest-type, sits in .suggest-input-wrap:`,
        noListAttr && suggestType === f.suggestType && inWrap, { noListAttr, suggestType, inWrap });

      await page.click(`[name="${f.name}"]`);
      await page.waitForTimeout(50);
      const opensOnFocus = await page.locator(`#${f.name}-suggest`).evaluate((el) => el.classList.contains('is-open') && el.children.length > 0);
      console.log(`   [${f.name}] dropdown opens on focus with a seeded list:`, opensOnFocus);

      await page.fill(`[name="${f.name}"]`, f.sampleQuery);
      await page.waitForTimeout(200);
      const matchCount = await page.locator(`#${f.name}-suggest .suggest-item`, { hasText: f.expectedSubstr }).count();
      console.log(`   [${f.name}] typing "${f.sampleQuery}" surfaces "${f.expectedSubstr}":`, matchCount >= 1, matchCount);

      await page.locator(`#${f.name}-suggest .suggest-item`, { hasText: f.expectedSubstr }).first().click();
      await page.waitForTimeout(50);
      const filledValue = await page.locator(`[name="${f.name}"]`).inputValue();
      console.log(`   [${f.name}] clicking a suggestion fills the field:`, filledValue.indexOf(f.expectedSubstr) !== -1, filledValue);
    }
    // (Scoped to the modal-head X button specifically — the backdrop
    // and the Cancel button both also carry data-action="close-modal",
    // and clicking the plain unscoped selector can land on the
    // backdrop at a point the visible modal box still covers, which
    // doesn't actually close it.)
    await page.click('.modal-head [data-action="close-modal"]');
    await page.waitForTimeout(50);

    // ---- Settings tab's Home currency field — hand-built outside
    // fieldHtml()/openForm(), but should behave identically. ----
    await page.click('[data-action="switch-tab"][data-tab="settings"]');
    const settingsNoListAttr = await page.locator('input[name="homeCurrency"]').evaluate((el) => el.getAttribute('list') === null);
    const settingsSuggestType = await page.locator('input[name="homeCurrency"]').getAttribute('data-suggest-type');
    console.log('3. Settings "Home currency" field also uses the generic dropdown:', settingsNoListAttr && settingsSuggestType === 'currency', { settingsNoListAttr, settingsSuggestType });

    await page.click('input[name="homeCurrency"]');
    await page.waitForTimeout(50);
    const settingsOpensOnFocus = await page.locator('#homeCurrency-suggest').evaluate((el) => el.classList.contains('is-open') && el.children.length > 0);
    console.log('   Settings currency dropdown opens on focus:', settingsOpensOnFocus);
    await page.fill('input[name="homeCurrency"]', 'JP');
    await page.waitForTimeout(200);
    const jpyMatch = await page.locator('#homeCurrency-suggest .suggest-item', { hasText: 'JPY' }).count();
    console.log('   Typing "JP" surfaces JPY:', jpyMatch === 1, jpyMatch);
    await page.locator('#homeCurrency-suggest .suggest-item', { hasText: 'JPY' }).click();
    await page.waitForTimeout(50);
    const settingsFilledValue = await page.locator('input[name="homeCurrency"]').inputValue();
    console.log('   Clicking JPY fills the field:', settingsFilledValue === 'JPY', settingsFilledValue);

    console.log('\nPage errors:', errors.length ? errors : 'NONE');
    await browser.close();
  } finally {
    server.kill();
  }
})();
