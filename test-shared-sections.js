// Behavioral coverage for shared form sections and the four Plan lists.
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { loadAppSources } = require('./test-source');

const source = loadAppSources().scripts
  .filter(({ filename }) => filename.startsWith('public/WayPoint/js/'))
  .map(({ code }) => code).join('\n');
function evaluateBetween(start, end, context) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert(from >= 0 && to > from, 'Missing production block: ' + start);
  vm.runInNewContext(source.slice(from, to), context);
}
const plain = (value) => JSON.parse(JSON.stringify(value));
const forms = {
  TRANSPORT_MODES: ['Flight', 'Train', 'Bus', 'Car', 'Ferry', 'Other'],
  TRANSPORT_PAYMENT_TYPES: ['Cash', 'Points', 'Combo', 'Free']
};
evaluateBetween('function bookingContactSection(', 'var CONTACT_FIELDS =', forms);

const section = (sections, title) => sections.find((item) => item.title === title);
const formCases = [
  [forms.DESTINATION_FORM_SECTIONS, 'People', 'People tagged here are preselected when you add an activity in this destination.'],
  [forms.ACTIVITY_FORM_SECTIONS, 'People', 'Defaults from the selected destination. You can adjust the people on this activity.', 'Optional confirmation details and the person or provider to contact.'],
  [forms.transportSectionsForMode({}), 'Companions', undefined, 'Optional confirmation details and the operator contact.'],
  [forms.ACCOMMODATION_FORM_SECTIONS, 'Companions', undefined, 'Optional confirmation details and a property or host contact.']
];
for (const [sections, label, hint, bookingHint] of formCases) {
  const people = { key: 'companions', label, type: 'tag-picker', wide: true };
  if (hint) people.hint = hint;
  assert.deepEqual(plain(section(sections, 'People and notes')), {
    title: 'People and notes', collapsible: true, fields: [
      people, { key: 'notes', label: 'Notes', type: 'textarea', wide: true }
    ]
  });
  if (bookingHint) assert.deepEqual(plain(section(sections, 'Booking and contact')), {
    title: 'Booking and contact', hint: bookingHint, collapsible: true, fields: [
      { key: 'bookingRef', label: 'Booking reference', type: 'text' },
      { key: 'contactId', label: 'Contact', type: 'select-contact' }
    ]
  });
}

// Mutating one form's access flags or labels must not leak into another form.
for (const [factory, args] of [
  [forms.bookingContactSection, ['Hint']], [forms.peopleNotesSection, ['People', 'Hint']]
]) {
  const first = factory(...args);
  const second = factory(...args);
  const expected = plain(second);
  assert.notEqual(first, second);
  assert.notEqual(first.fields, second.fields);
  first.fields.forEach((field, i) => {
    assert.notEqual(field, second.fields[i]);
    field.label = 'Changed';
    field.disabled = true;
  });
  first.fields.push({ key: 'extra' });
  assert.deepEqual(plain(second), expected);
  assert.deepEqual(plain(factory(...args)), expected);
}
for (const title of ['People and notes', 'Booking and contact']) {
  const sections = formCases.map(([schema]) => section(schema, title)).filter(Boolean);
  assert.equal(new Set(sections.flatMap((entry) => entry.fields)).size,
    sections.reduce((count, entry) => count + entry.fields.length, 0), title + ' shares mutable fields');
}
const transport = forms.transportSectionsForMode({});
const payment = section(transport, 'Payment and receipt').fields;
assert.deepEqual(Array.from(payment, (field) => field.key), ['paymentType', 'receiptRef']);
assert.equal(payment[0].disclosureNeutral, 'Free');
assert.equal(section(transport, 'Essentials').fields.find((field) => field.key === 'transportJourney').journey.defaultEndOffsetDays, 0);
assert.equal(section(forms.ACCOMMODATION_FORM_SECTIONS, 'Essentials').fields.find((field) => field.key === 'stayJourney').journey.defaultEndOffsetDays, 1);

const calls = [];
const lists = {
  esc: String,
  icon: (name) => '[' + name + ']',
  canFullyEditTrip: (trip) => trip.editable,
  itemScopeHiddenCount: (trip) => trip.hidden || 0,
  emptyStateHtml: (...args) => JSON.stringify(args),
  activityStartDate: (item) => item.startDate || item.date || '',
  itemRowHtml: (trip, model) => {
    calls.push({ trip, model });
    return '<row>' + model.section + ':' + model.item.id + '</row>';
  }
};
for (const name of ['destination', 'activity', 'transport', 'accommodation']) {
  lists[name + 'ItemRowModel'] = (trip, item, context) => ({ trip, item, context, section: name });
}
evaluateBetween('function emptyTab(', 'function renderContactsTab(', lists);
const cases = [
  ['destinations', 'Destination', 'Destinations', 'destination', 'Add destination', 'No destinations yet', "Add the places or areas you'll be based in — activities and accommodation can then be tagged to them.", 'arriveDate'],
  ['activities', 'Activity', 'Activities', 'activity', 'Add activity', 'No activities yet', 'Tours, museum visits, dinner reservations — anything with a date and time.', 'startDate'],
  ['transport', 'Transport', 'Transport', 'flight', 'Add transport leg', 'No transport legs yet', 'Flights, trains, buses, ferries or drives — each leg can span overnight, and will show up on both days in the Timeline.', 'departDateTime'],
  ['accommodation', 'Accommodation', 'Accommodation', 'stay', 'Add accommodation', 'No accommodation yet', 'Hotels, hostels, apartments — check-in and check-out can each carry their own time.', 'checkIn']
];
for (const [key, entity, title, icon, addLabel, emptyTitle, emptyBody, dateKey] of cases) {
  const singular = entity.toLowerCase();
  const render = lists['render' + title + 'Tab'];
  const trip = { [key]: [], editable: true };
  const button = '<button class="btn btn-accent" data-action="new-' + singular + '">[add] ' + addLabel + '</button>';
  assert.deepEqual(JSON.parse(render(trip)), ['empty', icon, emptyTitle, emptyBody, button]);
  trip.editable = false;
  assert.deepEqual(JSON.parse(render(trip)), ['empty', icon, emptyTitle, emptyBody, '']);
  trip.hidden = 2;
  const hiddenState = JSON.parse(render(trip));
  assert.equal(hiddenState[2], 'Nothing here tagged to you');
  assert.match(hiddenState[4], /data-action="set-item-scope"/);
  assert(!hiddenState[4].includes('new-'), 'Restricted empty state exposes create action');
  trip.hidden = 0;

  const records = [
    { id: 'late', [dateKey]: '2028-04-03', startTime: '18:00' },
    { id: 'early', [dateKey]: '2028-04-01', startTime: '09:00' },
    { id: 'undated' },
    { id: 'middle', [dateKey]: '2028-04-02', startTime: '10:00' }
  ];
  if (key === 'activities') {
    records[3].startDate = '2028-04-01'; // Time breaks a same-day tie.
    records[1].date = records[1].startDate; // Legacy dates use the existing adapter.
    delete records[1].startDate;
  }
  trip[key] = Object.freeze(records.map(Object.freeze));
  const unchanged = JSON.stringify(trip[key]);
  for (const editable of [true, false]) {
    trip.editable = editable;
    calls.length = 0;
    const result = render(trip);
    const expectedIds = ['undated', 'early', 'middle', 'late'];
    const expectedRows = expectedIds.map((id) => '<row>' + singular + ':' + id + '</row>').join('');
    assert.equal(result, '<div class="tab-panel-head"><h2>' + title + '</h2>' +
      (editable ? button : '') + '</div><div class="item-list">' + expectedRows + '</div>');
    assert.deepEqual(calls.map(({ model }) => model.item.id), expectedIds);
    for (const call of calls) {
      assert.equal(call.trip, trip);
      assert.equal(call.model.trip, trip);
      assert.equal(call.model.context, 'plan');
      assert(trip[key].includes(call.model.item), 'List adapter lost the original record');
    }
    assert.equal(JSON.stringify(trip[key]), unchanged, 'Rendering mutated persisted records');
  }
}

console.log('Shared form sections and Plan list behavior checks passed');
