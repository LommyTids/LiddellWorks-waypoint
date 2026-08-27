// Regression test for the live airport-suggestion widening and
// "resolved to a real coordinate" hint (fieldHtml's 'airport' case,
// refreshAirportSuggestions(), updateAirportResolveHint() in
// index.html) — the UI improvement built on top of the SFO–ICN
// coordinate fix, so typing a secondary airport's code or city still
// surfaces it as a suggestion (searching the full ~7,900-airport
// AIRPORT_DB, not just COMMON_AIRPORTS' curated ~126), and always gives
// a clear, honest signal of whether what's typed so far will actually
// place precisely on the Map tab.
const { chromium } = require('playwright');
const { spawn } = require('child_process');

const PORT = 8801;

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
    await page.waitForSelector('.empty-state, .trip-grid', { timeout: 5000 });
    await page.click('[data-action="new-trip"]');
    await page.fill('input[name="name"]', 'Suggestions Test');
    await page.fill('input[name="startDate"]', '2027-08-01');
    await page.fill('input[name="endDate"]', '2027-08-10');
    await page.fill('input[name="homeCurrency"]', 'GBP');
    await page.click('#entity-form button[type="submit"]');
    await page.waitForTimeout(150);

    await page.click('[data-action="switch-tab"][data-tab="transport"]');
    await page.click('[data-action="new-transport"]');

    // ---- Baseline: datalist starts seeded with the curated ~126. ----
    const initialCount = await page.locator('#airport-list option').count();
    console.log('1. Datalist starts with the curated shortlist (~126):', initialCount > 100 && initialCount < 150, initialCount);

    // ---- Typing a code NOT in the curated 126 (Birmingham) should
    // still surface it once the search widens to AIRPORT_DB. ----
    await page.fill('input[name="fromLocation"]', 'BHX');
    await page.waitForTimeout(300); // past the 120ms debounce
    const bhxOption = await page.locator('#airport-list option[value^="BHX —"]').count();
    console.log('2. BHX (secondary airport) appears as a suggestion once typed:', bhxOption === 1, bhxOption);

    // ---- The live resolve-hint should confirm a precise match. ----
    const hintText1 = await page.locator('#fromLocation-resolve-hint').textContent();
    const hintClass1 = await page.locator('#fromLocation-resolve-hint').getAttribute('class');
    console.log('3. Resolve hint confirms a precise match:', /Mapped precisely/.test(hintText1), hintText1);
    console.log('   Resolve hint has is-ok class:', /is-ok/.test(hintClass1));

    // ---- Typing something that isn't a real airport code shows the
    // "no match" hint instead. ----
    await page.fill('input[name="fromLocation"]', 'Somewhere I made up');
    await page.waitForTimeout(300);
    const hintText2 = await page.locator('#fromLocation-resolve-hint').textContent();
    const hintClass2 = await page.locator('#fromLocation-resolve-hint').getAttribute('class');
    console.log('4. Resolve hint shows "no match" for made-up text:', /No exact airport match/.test(hintText2), hintText2);
    console.log('   Resolve hint has is-unresolved class:', /is-unresolved/.test(hintClass2));

    // ---- Clearing the field clears the hint. ----
    await page.fill('input[name="fromLocation"]', '');
    await page.waitForTimeout(200);
    const hintText3 = await page.locator('#fromLocation-resolve-hint').textContent();
    console.log('5. Clearing the field clears the hint:', hintText3.trim() === '', JSON.stringify(hintText3));

    // ---- Typing "london" should surface MORE London-area airports
    // than just the curated 4 (LHR/LGW/STN/LTN), since AIRPORT_DB has
    // additional London airports (e.g. London City, Southend). ----
    await page.fill('input[name="toLocation"]', 'london');
    await page.waitForTimeout(300);
    const londonMatches = await page.locator('#airport-list option').evaluateAll(
      (opts) => opts.filter((o) => /London/.test(o.value)).map((o) => o.value)
    );
    console.log('6. Typing "london" surfaces multiple London airports:', londonMatches.length >= 4, londonMatches);

    // ---- Suggestions list stays capped at a reasonable size, not
    // thousands of options rendered into the DOM. ----
    const cappedCount = await page.locator('#airport-list option').count();
    console.log('7. Suggestion list stays capped (<=30) while searching:', cappedCount <= 30, cappedCount);

    console.log('\nPage errors:', errors.length ? errors : 'NONE');
    await browser.close();
  } finally {
    server.kill();
  }
})();
