const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('file://' + path.resolve(__dirname, '../../public/WayPoint/index.html'));

  // Build the same trip quickly via direct state manipulation for speed
  await page.evaluate(() => {
    updateState(next => {
      next.trips.push({
        id: 't1', name: 'Japan Trip', startDate: '2026-11-01', endDate: '2026-11-05', homeCurrency: 'GBP', notes: '',
        currencyRates: { JPY: 0.0053 },
        destinations: [{ id: 'd1', name: 'Tokyo', country: 'Japan', arriveDate: '2026-11-01', departDate: '2026-11-05', notes: '' }],
        activities: [{ id: 'a1', title: 'teamLab Museum', destinationId: 'd1', date: '2026-11-02', startTime: '14:00', endTime: '', location: '', address: '', bookingRef: 'TL-123', contactId: '', costAmount: 3200, costCurrency: 'JPY', costRate: '', receiptRef: 'email', notes: '' }],
        transport: [{ id: 'tr1', mode: 'Flight', carrier: 'ANA', fromLocation: 'LHR', toLocation: 'HND', departDateTime: '2026-11-01T11:00', arriveDateTime: '2026-11-02T07:00', seat: '22A', bookingRef: 'ANA-999', contactId: '', costAmount: 650, costCurrency: 'GBP', costRate: '', receiptRef: '', notes: '' }],
        accommodation: [], contacts: [{id:'c1', name:'Tokyo Hotel Desk', role:'Front desk', phone:'+81-3-1234', email:'', address:'', notes:''}], expenses: []
      });
    });
    currentView = 'trip'; currentTripId = 't1'; currentTab = 'expenses'; render();
  });

  const csv = await page.evaluate(() => buildCsv(currentTrip()));
  console.log('--- CSV OUTPUT ---');
  console.log(csv);

  // Test edit: change activity cost
  await page.evaluate(() => {
    updateState(next => {
      const trip = next.trips.find(t => t.id === 't1');
      trip.activities[0].costAmount = 5000;
    });
  });
  const spend1 = await page.evaluate(() => tripSpend(currentTrip()).known.toFixed(2));
  console.log('Spend after edit (GBP):', spend1);

  // Test delete
  await page.evaluate(() => {
    updateState(next => {
      const trip = next.trips.find(t => t.id === 't1');
      trip.activities = trip.activities.filter(a => a.id !== 'a1');
    });
  });
  const spend2 = await page.evaluate(() => tripSpend(currentTrip()).known.toFixed(2));
  console.log('Spend after delete (GBP, should be flight only 650.00):', spend2);

  // Test overnight flight crossing midnight appears correctly in timeline
  await page.evaluate(() => { currentTab = 'timeline'; render(); });
  const timelineText = await page.locator('#app').innerText();
  console.log('Timeline mentions overnight flight arrival continuation:', timelineText.includes('Arrive: HND'));
  console.log('Timeline mentions "No accommodation logged for tonight" (no accommodation added):', timelineText.includes('No accommodation logged for tonight'));

  console.log('\nErrors:', errors.length ? errors : 'NONE');
  await browser.close();
})();
