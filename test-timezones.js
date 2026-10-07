const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const context = vm.createContext({ console, document: { getElementById() { return {}; } } });
for (const file of ['data/airports.js', 'data/airports-full.js', 'vendor/tz-lookup/tz.js', 'js/core.js', 'js/timezones.js', 'js/date-controls.js', 'js/forms.js', 'js/flights.js']) {
  vm.runInContext(fs.readFileSync('public/WayPoint/' + file, 'utf8'), context);
}
const flight = { mode: 'Flight', fromLocation: 'ICN', toLocation: 'SFO', departDate: '2026-10-07', departTime: '18:00', arriveDate: '2026-10-07', arriveTime: '11:00' };
const config = { transport: true, startDateKey: 'departDate', endDateKey: 'arriveDate', startTimeKey: 'departTime', endTimeKey: 'arriveTime' };
assert.equal(context.resolveTransportTimezone(flight, false), 'Asia/Seoul');
assert.equal(context.resolveTransportTimezone(flight, true), 'America/Los_Angeles');
assert.equal(context.transportElapsed(flight).minutes, 540);
assert.equal(context.journeyDurationModel(config, flight).label, '9 hours');
assert.equal(context.transportElapsed({ ...flight, departDate: '2026-12-07', arriveDate: '2026-12-07' }).minutes, 600);
assert.match(context.transportLocalLabel(flight, true), /UTC−07:00/);
assert.match(context.transportLocalLabel({ ...flight, arriveDate: '2026-12-07' }, true), /UTC−08:00/);
// Arrival on the previous local calendar date is valid.
assert.equal(context.transportElapsed({ ...flight, departTime: '01:00', arriveDate: '2026-10-06', arriveTime: '19:00' }).minutes, 600);
assert.match(context.transportElapsed({ ...flight, arriveTime: '00:00' }).error, /before departure/);
assert.match(context.transportElapsed({ ...flight, fromLocation: 'Unknown' }).error, /Select timezone/);
assert.equal(context.resolveTransportTimezone({ mode: 'Train', fromLat: 51.5, fromLng: -0.12 }, false), 'Europe/London');
assert.equal(context.resolveTransportTimezone({ mode: 'Train', fromLat: 51.5, fromLng: -0.12, fromLocationStale: 'true' }, false), '');
assert.equal(context.resolveTransportTimezone({ ...flight, departTimezoneOverride: 'Pacific/Honolulu' }, false), 'Pacific/Honolulu');
assert.match(context.zonedInstant('2026-03-08', '02:30', 'America/Los_Angeles').error, /does not exist/);
assert.match(context.zonedInstant('2026-11-01', '01:30', 'America/Los_Angeles').error, /occurs twice/);
assert.equal(context.zonedInstant('2026-11-01', '01:30', 'America/Los_Angeles', 'later').minutes - context.zonedInstant('2026-11-01', '01:30', 'America/Los_Angeles', 'earlier').minutes, 60);
assert.equal(context.zonedInstant('2026-10-07', '12:00', 'Asia/Kathmandu').minutes, Date.UTC(2026, 9, 7, 6, 15) / 60000);
assert.equal(context.formatDateShort('2026-10-07'), '07/Oct/2026');
assert.equal(context.parseDisplayDate('07/oct/2026'), '2026-10-07');
assert.equal(context.parseDisplayDate('31/Feb/2026'), '');
assert.equal(context.parseDisplayDate('29/Feb/2028'), '2028-02-29');
assert.equal(context.parseDisplayDate('2026-10-07'), '');
// Date-only stays keep calendar-night semantics across DST.
assert.equal(context.journeyDurationModel({ ...config, transport: false, durationKind: 'nights' }, { ...flight, departDate: '2026-03-07', arriveDate: '2026-03-09' }).label, '2 nights');
(async () => {
  const source = fs.readFileSync('src/worker.js', 'utf8');
  const { sanitizeItem } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  const record = { transportId: 'tz-test', departDateTime: '2026-10-07T18:00', arriveDateTime: '2026-10-07T11:00', departTimezone: 'Asia/Seoul', arriveTimezone: 'America/Los_Angeles', departTimezoneOverride: '', arriveTimezoneOverride: '', departOccurrence: '', arriveOccurrence: 'later' };
  assert.deepEqual(sanitizeItem('transport', record), record);
  assert.throws(() => sanitizeItem('transport', { ...record, departTimezone: 'Bogus/Zone' }), /Invalid transport timezone/);
  assert.throws(() => sanitizeItem('transport', { ...record, arriveOccurrence: 'guess' }), /Invalid clock occurrence/);
  console.log('Timezone calculations, DST, dates and server round-trip checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
