// Regression test for the airport field's suggestion dropdown and the
// "resolved to a real coordinate" hint (fieldHtml's 'airport' case,
// the generic openSuggestions()/searchAirports(),
// updateAirportResolveHint() in index.html). The dropdown itself is
// the same generic, app-rendered one every suggestible field uses (see
// test-suggest-dropdown-consistency.js for the shared-mechanism
// coverage) — this file focuses on what's specific to airport: it
// still finds a secondary airport by code or city (searching the full
// ~7,900-airport AIRPORT_DB, not just COMMON_AIRPORTS' curated ~126),
// still gives an honest live signal of whether what's typed will place
// precisely on the Map tab, and — the original bug report that started
// all of this — that typing is never interrupted and the dropdown
// never covers the input itself.
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const { loginAsAdmin } = require('./test-helpers');

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
    await loginAsAdmin(page);
    await page.click('[data-action="new-trip"]');
    await page.fill('input[name="name"]', 'Suggestions Test');
    await page.fill('input[name="startDate"]', '2027-08-01');
    await page.fill('input[name="endDate"]', '2027-08-10');
    await page.fill('input[name="homeCurrency"]', 'GBP');
    await page.click('#entity-form button[type="submit"]');
    await page.waitForTimeout(150);

    await page.click('[data-action="switch-tab"][data-tab="transport"]');
    await page.click('[data-action="new-transport"]');

    // ---- Focusing the field opens the dropdown, seeded with the
    // curated ~126 (same starting point as the old datalist). ----
    await page.click('input[name="fromLocation"]');
    await page.waitForTimeout(50);
    const initialCount = await page.locator('#fromLocation-suggest .suggest-item').count();
    console.log('1. Dropdown opens on focus with the curated shortlist (~126):', initialCount > 100 && initialCount < 150, initialCount);
    const initiallyOpen = await page.locator('#fromLocation-suggest').evaluate((el) => el.classList.contains('is-open'));
    console.log('   Dropdown has is-open class:', initiallyOpen);

    // ---- Typing a code NOT in the curated 126 (Birmingham) should
    // still surface it once the search widens to AIRPORT_DB. ----
    await page.fill('input[name="fromLocation"]', 'BHX');
    await page.waitForTimeout(300); // past the 120ms debounce
    const bhxOption = await page.locator('#fromLocation-suggest .suggest-item', { hasText: 'BHX —' }).count();
    console.log('2. BHX (secondary airport) appears as a suggestion once typed:', bhxOption === 1, bhxOption);

    // ---- The dropdown must never cover the input itself — it should
    // sit entirely below the input's bottom edge. This is the actual
    // bug report: a native datalist popup could overlap the box. ----
    const geometry = await page.evaluate(() => {
      const input = document.querySelector('input[name="fromLocation"]');
      const dropdown = document.getElementById('fromLocation-suggest');
      const i = input.getBoundingClientRect();
      const d = dropdown.getBoundingClientRect();
      return { inputBottom: i.bottom, dropdownTop: d.top };
    });
    console.log('3. Dropdown sits below the input, never covering it:', geometry.dropdownTop >= geometry.inputBottom - 1, geometry);

    // ---- The live resolve-hint should confirm a precise match. ----
    const hintText1 = await page.locator('#fromLocation-resolve-hint').textContent();
    const hintClass1 = await page.locator('#fromLocation-resolve-hint').getAttribute('class');
    console.log('4. Resolve hint confirms a precise match:', /Mapped precisely/.test(hintText1), hintText1);
    console.log('   Resolve hint has is-ok class:', /is-ok/.test(hintClass1));

    // ---- Typing something that isn't a real airport code shows the
    // "no match" hint instead — and typing itself is never interrupted
    // (the whole point of moving off native datalist): type character
    // by character and confirm every keystroke actually lands. ----
    await page.fill('input[name="fromLocation"]', '');
    await page.type('input[name="fromLocation"]', 'Chongqing', { delay: 30 });
    await page.waitForTimeout(300);
    const typedValue = await page.locator('input[name="fromLocation"]').inputValue();
    console.log('5. Typing is never interrupted mid-word ("Chongqing" lands in full):', typedValue === 'Chongqing', JSON.stringify(typedValue));
    const hintText2 = await page.locator('#fromLocation-resolve-hint').textContent();
    console.log('6. Resolve hint shows "no match" for a city name (not yet a code):', /No exact airport match/.test(hintText2), hintText2);
    const ckgOption = await page.locator('#fromLocation-suggest .suggest-item', { hasText: 'CKG —' }).count();
    console.log('   Chongqing (CKG) still surfaced as a suggestion despite not being curated:', ckgOption === 1, ckgOption);

    // ---- Clicking a suggestion fills the field and updates the hint,
    // without the field ever blurring out from under the click. ----
    await page.locator('#fromLocation-suggest .suggest-item', { hasText: 'CKG —' }).click();
    await page.waitForTimeout(100);
    const afterClickValue = await page.locator('input[name="fromLocation"]').inputValue();
    const afterClickHint = await page.locator('#fromLocation-resolve-hint').textContent();
    console.log('7. Clicking a suggestion fills the field:', /^CKG —/.test(afterClickValue), afterClickValue);
    console.log('   ...and the hint updates to reflect it:', /Mapped precisely/.test(afterClickHint));
    const closedAfterClick = await page.locator('#fromLocation-suggest').evaluate((el) => !el.classList.contains('is-open'));
    console.log('   ...and the dropdown closes:', closedAfterClick);

    // ---- Keyboard navigation: ArrowDown highlights an item, Enter
    // selects it. ----
    await page.fill('input[name="toLocation"]', 'london');
    await page.waitForTimeout(300);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    const activeItem = await page.locator('#toLocation-suggest .suggest-item.is-active').textContent();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(100);
    const toValue = await page.locator('input[name="toLocation"]').inputValue();
    console.log('8. ArrowDown highlights an item and Enter selects it:', toValue === activeItem, { activeItem, toValue });

    // ---- "london" search surfaces MORE London-area airports than
    // just the curated 4 (LHR/LGW/STN/LTN). ----
    await page.fill('input[name="toLocation"]', 'london');
    await page.waitForTimeout(300);
    const londonMatches = await page.locator('#toLocation-suggest .suggest-item').evaluateAll(
      (items) => items.filter((el) => /London/.test(el.textContent)).map((el) => el.textContent)
    );
    console.log('9. Typing "london" surfaces multiple London airports:', londonMatches.length >= 4, londonMatches);

    // ---- Suggestions list stays capped at a reasonable size, not
    // thousands of options rendered into the DOM. ----
    const cappedCount = await page.locator('#toLocation-suggest .suggest-item').count();
    console.log('10. Suggestion list stays capped (<=30) while searching:', cappedCount <= 30, cappedCount);

    // ---- Clicking elsewhere in the form closes the dropdown. ----
    await page.click('input[name="fromLocation"]');
    await page.waitForTimeout(50);
    await page.click('input[name="flightNumber"]');
    await page.waitForTimeout(250);
    const closedOnBlur = await page.locator('#fromLocation-suggest').evaluate((el) => !el.classList.contains('is-open'));
    console.log('11. Dropdown closes when focus moves to another field:', closedOnBlur);

    console.log('\nPage errors:', errors.length ? errors : 'NONE');
    await browser.close();
  } finally {
    server.kill();
  }
})();
