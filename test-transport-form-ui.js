// Regression test for the consolidated Transport form: seat number
// removed entirely; route endpoints are separate controls; each Journey
// date/time pair is grouped visually; booking and payment progressively
// disclose; and the "Paid with" selector (Cash / Points / Combo / Free)
// the new "Paid with" selector (Cash / Points / Combo / Free) that
// swaps in currency+amount+rate-override, or points program+count, or
// both, or neither — see transportPaymentFields()/transportSectionsForMode()
// and openTransportForm()'s onSubmit in index.html.
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const { loginAsAdmin } = require('./test-helpers');

const PORT = 8804;

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

    // Checks that two named fields end up in the same .field-row (i.e.
    // rendered side by side), the way fieldsHtml() auto-pairs adjacent
    // short fields.
    const sameRow = (nameA, nameB) => page.evaluate(([a, b]) => {
      const inputA = document.querySelector('[name="' + a + '"]');
      const row = inputA && inputA.closest('.field-row');
      return !!(row && row.querySelector('[name="' + b + '"]'));
    }, [nameA, nameB]);
    const sameJourneyMoment = (nameA, nameB) => page.evaluate(([a, b]) => {
      const inputA = document.querySelector('[name="' + a + '"]');
      const moment = inputA && inputA.closest('.journey-date-time-row');
      return !!(moment && moment.querySelector('[name="' + b + '"]'));
    }, [nameA, nameB]);

    await page.goto('http://localhost:' + PORT + '/WayPoint');
    await loginAsAdmin(page);
    await page.click('[data-action="new-trip"]');
    await page.fill('input[name="name"]', 'Form UI Test');
    await page.fill('input[name="startDate"]', '2027-09-01');
    await page.fill('input[name="endDate"]', '2027-09-10');
    await page.fill('input[name="homeCurrency"]', 'GBP');
    await page.click('#entity-form button[type="submit"]');
    await page.waitForTimeout(150);

    await page.click('[data-action="switch-tab"][data-tab="transport"]');
    await page.click('[data-action="new-transport"]');

    // ---- Seat is gone, in every mode. ----
    const seatFieldAbsentFlight = (await page.locator('input[name="seat"]').count()) === 0;
    let seatAbsentAllModes = seatFieldAbsentFlight;
    for (const mode of ['Train', 'Bus', 'Ferry', 'Car', 'Other']) {
      await page.selectOption('select[name="mode"]', mode);
      await page.waitForTimeout(30);
      if ((await page.locator('input[name="seat"]').count()) !== 0) seatAbsentAllModes = false;
    }
    await page.selectOption('select[name="mode"]', 'Flight');
    await page.waitForTimeout(30);
    console.log('1. Seat field removed from every transport mode:', seatAbsentAllModes);

    // ---- Layout pairing. ----
    console.log('2. From/To are separate full-width controls:', await page.locator('[name="fromLocation"]').evaluate((field) => !field.closest('.field-row')) && await page.locator('[name="toLocation"]').evaluate((field) => !field.closest('.field-row')));
    console.log('3. Depart date/time share one Journey moment:', await sameJourneyMoment('departDate', 'departTime'));
    console.log('4. Arrive date/time share one Journey moment:', await sameJourneyMoment('arriveDate', 'arriveTime'));
    await page.locator('details', { hasText: 'Booking and contact' }).locator('summary').click();
    console.log('5. Booking reference/Contact share one row:', await sameRow('bookingRef', 'contactId'));
    await page.locator('details', { hasText: 'Payment and receipt' }).locator('summary').click();

    // ---- "Paid with" defaults to Free on a brand-new leg, showing no
    // cost or points fields at all. ----
    const paymentSelectExists = (await page.locator('select[name="paymentType"]').count()) === 1;
    const defaultPaymentValue = await page.locator('select[name="paymentType"]').inputValue();
    console.log('6. "Paid with" selector present, defaults to Free on a new leg:', paymentSelectExists && defaultPaymentValue === 'Free', defaultPaymentValue);
    const noFieldsOnFree = (await page.locator('input[name="costAmount"], input[name="pointsAmount"]').count()) === 0;
    console.log('7. Free shows no cost/points fields:', noFieldsOnFree);

    // ---- Cash: currency+amount on one row, plus an (unchecked by
    // default) exchange-rate checkbox; the override input itself only
    // appears once that checkbox is ticked. ----
    await page.selectOption('select[name="paymentType"]', 'Cash');
    await page.waitForTimeout(30);
    console.log('8. Cash shows currency+amount on the same row:', await sameRow('costCurrency', 'costAmount'));
    const checkboxUnchecked = await page.locator('input[name="costRateOverrideEnabled"]').isChecked();
    console.log('9. Exchange-rate checkbox present, unchecked by default:', checkboxUnchecked === false);
    console.log('   Rate override input hidden until checked:', (await page.locator('input[name="costRate"]').count()) === 0);
    await page.check('input[name="costRateOverrideEnabled"]');
    await page.waitForTimeout(30);
    console.log('10. Checking it reveals the rate override input:', (await page.locator('input[name="costRate"]').count()) === 1);
    await page.uncheck('input[name="costRateOverrideEnabled"]');
    await page.waitForTimeout(30);
    console.log('    Unchecking it hides the rate override input again:', (await page.locator('input[name="costRate"]').count()) === 0);

    // ---- Points: a program box and a points-count box, no cash
    // fields at all. ----
    await page.selectOption('select[name="paymentType"]', 'Points');
    await page.waitForTimeout(30);
    const pointsFieldsPresent = (await page.locator('input[name="pointsProgram"]').count()) === 1 && (await page.locator('input[name="pointsAmount"]').count()) === 1;
    const cashFieldsAbsentOnPoints = (await page.locator('input[name="costAmount"], input[name="costCurrency"]').count()) === 0;
    console.log('11. Points shows a program box and a points-count box:', pointsFieldsPresent);
    console.log('    ...and no cash fields:', cashFieldsAbsentOnPoints);

    // ---- Combo: both sections together. ----
    await page.selectOption('select[name="paymentType"]', 'Combo');
    await page.waitForTimeout(30);
    const comboHasBoth = (await page.locator('input[name="costAmount"]').count()) === 1 && (await page.locator('input[name="pointsAmount"]').count()) === 1;
    console.log('12. Combo shows both Cash and Points fields:', comboHasBoth);

    // ---- Back to Free clears the slate visually again. ----
    await page.selectOption('select[name="paymentType"]', 'Free');
    await page.waitForTimeout(30);
    console.log('13. Switching back to Free hides everything again:', (await page.locator('input[name="costAmount"], input[name="pointsAmount"]').count()) === 0);

    // ---- End-to-end save: a Cash leg with a rate override actually
    // persists paymentType/cost/rate, and leaves points fields blank. ----
    await page.selectOption('select[name="paymentType"]', 'Cash');
    await page.waitForTimeout(30);
    await page.fill('input[name="fromLocation"]', 'LHR');
    await page.fill('input[name="toLocation"]', 'JFK');
    await page.fill('input[name="departDate"]', '2027-09-02');
    await page.fill('input[name="arriveDate"]', '2027-09-02');
    await page.fill('input[name="costCurrency"]', 'USD');
    await page.fill('input[name="costAmount"]', '450');
    await page.check('input[name="costRateOverrideEnabled"]');
    await page.waitForTimeout(30);
    await page.fill('input[name="costRate"]', '0.79');
    await page.click('#entity-form button[type="submit"]');
    await page.waitForTimeout(100);
    const savedCash = await page.evaluate(() => currentTrip().transport[0]);
    console.log('14. Saved Cash leg has paymentType/currency/amount/rate:',
      savedCash.paymentType === 'Cash' && savedCash.costCurrency === 'USD' && savedCash.costAmount === '450' && savedCash.costRate === '0.79',
      JSON.stringify({ paymentType: savedCash.paymentType, costCurrency: savedCash.costCurrency, costAmount: savedCash.costAmount, costRate: savedCash.costRate }));
    console.log('    ...and points fields stayed blank:', savedCash.pointsProgram === '' && savedCash.pointsAmount === '');

    // ---- End-to-end save: a Points leg persists program/count, and
    // leaves cash fields blank even though a currency default exists. ----
    await page.click('[data-action="new-transport"]');
    await page.fill('input[name="fromLocation"]', 'SIN');
    await page.fill('input[name="toLocation"]', 'NRT');
    await page.fill('input[name="departDate"]', '2027-09-05');
    await page.fill('input[name="arriveDate"]', '2027-09-05');
    await page.selectOption('select[name="paymentType"]', 'Points');
    await page.waitForTimeout(30);
    await page.fill('input[name="pointsProgram"]', 'KrisFlyer');
    await page.fill('input[name="pointsAmount"]', '35000');
    await page.click('#entity-form button[type="submit"]');
    await page.waitForTimeout(100);
    const savedPoints = await page.evaluate(() => currentTrip().transport[1]);
    console.log('15. Saved Points leg has program/amount, blank cost fields:',
      savedPoints.paymentType === 'Points' && savedPoints.pointsProgram === 'KrisFlyer' && savedPoints.pointsAmount === '35000' &&
      savedPoints.costAmount === '' && savedPoints.costCurrency === '',
      JSON.stringify({ paymentType: savedPoints.paymentType, pointsProgram: savedPoints.pointsProgram, pointsAmount: savedPoints.pointsAmount, costAmount: savedPoints.costAmount }));

    // ---- Editing a LEGACY leg (no paymentType, but a costAmount) —
    // simulating a trip saved before this feature existed — should
    // infer "Cash" and show the existing cost data, not hide it. ----
    await page.evaluate(() => {
      const trip = currentTrip();
      trip.transport.push({
        transportId: 'legacy1', mode: 'Flight', carrier: 'Legacy Air', flightNumber: '', licensePlate: '',
        fromLocation: 'CDG', toLocation: 'FCO', fromLat: '', fromLng: '', toLat: '', toLng: '',
        departDateTime: '2027-09-08T09:00', arriveDateTime: '2027-09-08T11:00',
        bookingRef: '', contactId: '', costAmount: '210', costCurrency: 'EUR', costRate: '0.85',
        receiptRef: '', notes: ''
      });
      render();
    });
    await page.click('[data-action="switch-tab"][data-tab="transport"]');
    const legacyRow = page.locator('.item-row', { hasText: 'CDG' });
    await legacyRow.locator('[data-action="edit-transport"]').click();
    await page.waitForTimeout(50);
    const legacyPaymentType = await page.locator('select[name="paymentType"]').inputValue();
    const legacyAmountValue = await page.locator('input[name="costAmount"]').inputValue();
    const legacyRateChecked = await page.locator('input[name="costRateOverrideEnabled"]').isChecked();
    const legacyRateValue = await page.locator('input[name="costRate"]').inputValue();
    console.log('16. Editing a legacy Cash leg infers "Cash" and keeps its data visible:',
      legacyPaymentType === 'Cash' && legacyAmountValue === '210' && legacyRateChecked === true && legacyRateValue === '0.85',
      JSON.stringify({ legacyPaymentType, legacyAmountValue, legacyRateChecked, legacyRateValue }));
    await page.click('.modal-head [data-action="close-modal"]');

    console.log('\nPage errors:', errors.length ? errors : 'NONE');
    await browser.close();
  } finally {
    server.kill();
  }
})();
