// Regression test for the self-hosted adaptation. Runs the mock server
// (see mock-server.js) and drives the real index.html through Playwright,
// checking the things that changed: loading data via fetch(), saving via
// fetch(), the save indicator, CSV export via Blob download, and that a
// full page reload picks up what was just saved (proving persist() and
// loadInitialState() are actually talking to the same store — something
// the old Artifact-only version couldn't be tested for in this sandbox).
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');

const PORT = 8787;

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
    page.on('console', (msg) => { if (msg.type() === 'error') errors.push('CONSOLE: ' + msg.text()); });

    await page.goto('http://localhost:' + PORT + '/WayPoint');
    await page.waitForSelector('.empty-state, .trip-grid', { timeout: 5000 });
    console.log('1. Page loaded via fetch() (no app-data script tag needed):', true);

    // ---- Create a trip ----
    await page.click('[data-action="new-trip"]');
    await page.fill('input[name="name"]', 'Deploy Test Trip');
    await page.fill('input[name="startDate"]', '2027-01-01');
    await page.fill('input[name="endDate"]', '2027-01-05');
    await page.fill('input[name="homeCurrency"]', 'GBP');
    await page.click('#entity-form button[type="submit"]');
    await page.waitForTimeout(150);
    const onTripView = await page.locator('.trip-title-row h1').textContent();
    console.log('2. Trip created, now viewing:', onTripView.trim());

    // ---- Wait for the save indicator to show "Saved" (proves the POST completed) ----
    await page.waitForFunction(() => {
      const el = document.getElementById('save-indicator');
      return el && el.textContent === 'Saved';
    }, { timeout: 5000 });
    console.log('3. Save indicator shows "Saved" after fetch() POST:', true);

    // ---- Add a destination with a timezone, to exercise a richer save ----
    await page.click('[data-action="switch-tab"][data-tab="destinations"]');
    await page.click('[data-action="new-destination"]');
    await page.fill('input[name="country"]', 'Japan');
    await page.fill('input[name="name"]', 'Tokyo');
    await page.fill('input[name="arriveDate"]', '2027-01-01');
    await page.fill('input[name="departDate"]', '2027-01-05');
    await page.fill('input[name="timezone"]', 'Asia/Tokyo');
    await page.click('#entity-form button[type="submit"]');
    await page.waitForTimeout(150);

    // ---- Reload the page entirely: does loadInitialState() fetch what persist() saved? ----
    // sessionStorage remembers we were last on the trip's destinations tab,
    // so the reload lands straight back there rather than the dashboard.
    await page.reload();
    await page.waitForSelector('.trip-title-row, .trip-grid', { timeout: 5000 });
    const afterReloadText = await page.locator('#app').innerText();
    console.log('4. After a full page reload, trip survives (fetched back from the mock KV store):', afterReloadText.includes('Deploy Test Trip'));
    console.log('5. Destination (Tokyo, Japan) also survived the reload:', afterReloadText.includes('Tokyo') && afterReloadText.includes('Japan'));

    // ---- CSV export via the new Blob/<a download> path (no claude.use('downloads')) ----
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 5000 }),
      page.click('[data-action="switch-tab"][data-tab="expenses"]').then(() => page.click('[data-action="export-csv"]'))
    ]);
    console.log('6. CSV export triggers a real browser download:', download.suggestedFilename().endsWith('.csv'));

    console.log('\nPage errors:', errors.length ? errors : 'NONE');
    await browser.close();
  } finally {
    server.kill();
  }
})();
