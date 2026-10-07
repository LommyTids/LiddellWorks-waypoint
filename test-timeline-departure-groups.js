// Behavioural tests for grouping separate bookings in a scoped itinerary.
// All fixtures are synthetic; this suite makes no network or server calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const read = name => fs.readFileSync(path.join(__dirname, 'public/WayPoint/js', name), 'utf8');
const forms = read('forms.js');
const start = forms.indexOf('function journeyUtcMinutes(');
const end = forms.indexOf('\nfunction ', start + 1);
const context = {
  Intl, Date,
  dateOnly: text => String(text || '').split('T')[0],
  timeOnly: text => (String(text || '').split('T')[1] || '').slice(0, 5),
  esc: text => String(text ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[char])),
  slug: text => String(text).replace(/[^a-zA-Z0-9_-]/g, '-'),
  icon: name => '<svg data-icon="' + name + '"></svg>',
  taggablePersonById: (trip, id) => trip.companions.find(person => person.companionId === id),
  recordItemRowModel: (trip, section, item) => ({section, item, cost: null, title: item.flightNumber}),
  itemRowHtml: (trip, model) => '<article><button data-action="edit-transport" data-id="' + model.item.transportId + '">Edit</button><span>' + model.item.bookingRef + '</span></article>',
  formatDateShort: date => date,
  money: amount => String(amount)
};
vm.createContext(context);
vm.runInContext(forms.slice(start, end), context);
vm.runInContext(read('timezones.js'), context);
vm.runInContext(read('timeline.js'), context);

function leg(id, time, overrides = {}) {
  return Object.assign({
    transportId: id, mode: 'Flight', flightNumber: 'AF' + id,
    fromLocation: 'CDG — Paris Charles de Gaulle', toLocation: 'Destination ' + id,
    departDateTime: '2026-10-07T' + time, arriveDateTime: '2026-10-07T18:00',
    departTimezone: 'Europe/Paris', bookingRef: 'BOOKING-' + id,
    companions: [id], notes: ''
  }, overrides);
}
const event = data => ({kind: 'depart', time: context.timeOnly(data.departDateTime), data});
const records = ['09:00', '09:10', '09:20', '09:30', '09:40', '09:50'].map((time, i) => leg('p' + i, time));
const six = records.map(event);
const trip = {tripId: 'six-cdg', homeCurrency: 'GBP', companions: records.map((record, i) => ({companionId: record.transportId, name: 'Traveller ' + i})), accommodation: [], transport: records};
const before = JSON.stringify(six);
const groups = context.timelineEventGroups(six);
assert.equal(groups.length, 1);
assert.equal(groups[0].kind, 'departures');
assert.equal(groups[0].events.length, 6);
assert.equal(groups[0].origin, 'CDG');
groups[0].events.forEach((entry, i) => assert.equal(entry, six[i], 'Grouping must retain each original event and record identity'));
assert.equal(JSON.stringify(six), before, 'Grouping must not mutate or merge bookings');
const html = context.timelineEventsHtml(trip, six);
assert.match(html, /6 departures from CDG/);
assert.equal((html.match(/<details class="timeline-journey-leg"/g) || []).length, 6);
records.forEach((record, i) => {
  assert.equal((html.match(new RegExp('data-id="' + record.transportId + '"', 'g')) || []).length, 1, 'Every leg keeps exactly one source edit action');
  assert(html.includes(record.bookingRef), 'Separate booking references must survive grouping');
  assert(html.includes('Traveller ' + i), 'Every collapsed journey names its traveller');
});
context.timelineJourneyExpansion[context.timelineJourneyKey(trip.tripId, 'p0')] = true;
const reopened = context.timelineEventsHtml(trip, six);
assert.match(reopened, /data-timeline-journey="p0" data-timeline-trip="six-cdg" open/);
assert(!/data-timeline-journey="p1"[^>]* open/.test(reopened), 'Other bookings remain independently collapsed');
assert(!context.timelineEventsHtml(Object.assign({}, trip, {tripId: 'other-trip'}), six).includes('" open>'), 'Disclosure state must be trip-specific');

// Counts are based only on the supplied events, never a global/full trip.
const scoped = six.slice(0, 2);
const scopedHtml = context.timelineEventsHtml(trip, scoped);
assert.match(scopedHtml, /2 departures from CDG/);
assert(!scopedHtml.includes('BOOKING-p2'));
assert(!scopedHtml.includes('Traveller 2'));
assert.equal(context.timelineEventGroups([six[0]])[0].kind, 'event', 'A single departure is not a group');

// Similar names, other origins, other days and other event kinds stay distinct.
const separate = [six[0], event(leg('other-airport', '09:15', {fromLocation: 'LHR — Heathrow'})), event(leg('next-day', '09:15', {departDateTime: '2026-10-08T09:15'})), {kind: 'arrive', time: '09:20', data: records[1]}];
assert.equal(context.timelineEventGroups(separate).length, 4);
assert(context.timelineEventGroups(separate).every(group => group.kind === 'event'));
const missingOrigin = event(leg('no-origin', '09:15', {fromLocation: ''}));
assert.equal(context.timelineEventGroups([six[0], missingOrigin]).length, 2);

// Use an anchored window, not a chain that grows across several hours.
const spaced = ['09:00', '09:50', '10:40'].map((time, i) => event(leg('gap' + i, time)));
const spacedGroups = context.timelineEventGroups(spaced);
assert.equal(spacedGroups.length, 2);
assert.equal(spacedGroups[0].events.length, 2);
assert.equal(spacedGroups[1].event, spaced[2]);

// Compare actual instants when zones are known, not equal wall-clock labels.
const tokyo = event(leg('tokyo-zone', '09:10', {departTimezone: 'Asia/Tokyo'}));
assert.equal(context.timelineEventGroups([six[0], tokyo]).length, 2, 'Nearby clock labels in different zones can be hours apart');
const london = event(leg('london-zone', '08:10', {departTimezone: 'Europe/London'}));
const instantGroup = context.timelineEventGroups([london, six[0]]);
assert.equal(instantGroup.length, 1, 'Nearby actual instants may have different clock labels');
assert.equal(instantGroup[0].events[0], six[0], 'Group members sort by instant with stable ties');
const mixedHtml = context.timelineDepartureGroupHtml(trip, instantGroup[0]);
assert(mixedHtml.includes('Europe/London'));
assert(mixedHtml.includes('Europe/Paris'));
assert(!mixedHtml.includes('09:00–08:10'), 'Do not present a backwards cross-zone wall-clock range');

// DST ambiguity and unknown/known combinations must not silently guess time.
const ambiguous = event(leg('ambiguous', '02:15', {departDateTime: '2026-10-25T02:15'}));
const valid = event(leg('valid', '02:20', {departDateTime: '2026-10-25T02:20', departOccurrence: 'earlier'}));
assert.equal(context.timelineEventGroups([ambiguous, valid]).length, 2);
const repeated = event(leg('repeated', '02:20', {departDateTime: '2026-10-25T02:20', departOccurrence: 'later'}));
assert.equal(context.timelineEventGroups([valid, repeated]).length, 1, 'Exact one-hour DST separation sits at the window boundary');
const unknown = event(leg('unknown', '09:10', {departTimezone: ''}));
assert.equal(context.timelineEventGroups([six[0], unknown]).length, 2, 'Do not compare an unresolved clock with a known instant');
const unknown2 = event(leg('unknown2', '09:20', {departTimezone: ''}));
const localGroup = context.timelineEventGroups([unknown, unknown2]);
assert.equal(localGroup.length, 1);
assert(context.timelineDepartureGroupHtml(trip, localGroup[0]).includes('timezone unknown'));

// Shared and unassigned tags are visible facts, not implied access to all.
const named = [{kind: 'activity', data: {companions: ['p0', 'p1']}}, {kind: 'activity', data: {companions: ['p0']}}, {kind: 'activity', data: {companions: []}}];
assert.equal(context.timelinePeopleLabel(trip, named), 'Traveller 0, Traveller 1, No people assigned');
const summary = context.timelineDaySummaryHtml(trip, named.length, null, named);
assert(summary.includes('3 events'));
assert(summary.includes('Traveller 0, Traveller 1, No people assigned'));

// Multiple travellers can sleep in different properties or travel overnight.
const overnightTrip = Object.assign({}, trip, {
  accommodation: [
    {name: 'Hotel A', checkIn: '2026-10-07T15:00', checkOut: '2026-10-08T11:00', companions: ['p0']},
    {name: 'Hotel B', checkIn: '2026-10-07T15:00', checkOut: '2026-10-09T11:00', companions: ['p1']}
  ],
  transport: [leg('overnight', '23:00', {arriveDateTime: '2026-10-09T08:00', toLocation: 'Tokyo', companions: ['p2']})]
});
const night = context.timelineOvernightHtml(overnightTrip, '2026-10-07');
['Hotel A', 'Hotel B', 'Overnight flight to Tokyo', 'Traveller 0', 'Traveller 1', 'Traveller 2'].forEach(text => assert(night.includes(text)));
const nextNight = context.timelineOvernightHtml(overnightTrip, '2026-10-08');
assert(!nextNight.includes('Hotel A'), 'A checked-out property is not tonight’s stay');
assert(nextNight.includes('Hotel B'));
assert(nextNight.includes('Overnight flight to Tokyo'), 'Multi-night journeys remain visible each applicable night');
const quietDaySummary = context.timelineDaySummaryHtml(overnightTrip, 0, null, context.timelineOvernightRecords(overnightTrip, '2026-10-08'));
assert(quietDaySummary.includes('Traveller 1, Traveller 2'), 'Collapsed days still identify people staying or travelling overnight without a new timed event');
assert(!quietDaySummary.includes('Traveller 0'), 'A departed traveller must not appear in the overnight day summary');
const filteredNight = context.timelineOvernightHtml(Object.assign({}, overnightTrip, {accommodation: overnightTrip.accommodation.slice(0, 1), transport: []}), '2026-10-07');
assert(!filteredNight.includes('Hotel B'));
assert(!filteredNight.includes('Traveller 2'));
assert(context.timelineOvernightHtml({accommodation: [], transport: []}, '2026-10-07').includes('No accommodation logged'));

console.log('Timeline departure identity, scoped counts, timezone grouping and split overnight checks passed');
