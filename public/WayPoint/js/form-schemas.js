/* ---------- 7. Entity field schemas --------------------------------- */

// Fresh fields keep per-form labels and access adjustments independent.
function bookingContactSection(hint) {
  return { title: 'Booking and contact', hint: hint, collapsible: true, fields: [
    { key: 'bookingRef', label: 'Booking reference', type: 'text' },
    { key: 'contactId', label: 'Contact', type: 'select-contact' }
  ] };
}

function peopleNotesSection(label, hint) {
  var people = { key: 'companions', label: label, type: 'tag-picker', wide: true };
  if (hint) people.hint = hint;
  return { title: 'People and notes', collapsible: true, fields: [
    people, { key: 'notes', label: 'Notes', type: 'textarea', wide: true }
  ] };
}

var TRIP_FIELDS = [
  { key: 'name', label: 'Trip name', type: 'text', required: true, placeholder: 'e.g. Southeast Asia loop', wide: true },
  { key: 'startDate', label: 'Start date', type: 'date' },
  { key: 'endDate', label: 'End date', type: 'date' },
  { key: 'homeCurrency', label: 'Home currency (for totals)', type: 'currency', required: true },
  { key: 'notes', label: 'Notes', type: 'textarea', wide: true }
];

// Same as TRIP_FIELDS above, plus one extra box -- only used when
// creating a brand-new trip (openTripForm()), never when editing one.
// A one-shot "quick add" convenience; re-showing it on edit would be
// misleading (typing a name would create ANOTHER companion, not edit
// one). Adding/renaming/removing companions after creation is done from
// the Companions tab instead (openCompanionForm(),
// openAddLinkedCompanionForm()), which has the full picture this quick
// box deliberately leaves out.
//
// A plain multiline textarea, parsed into new Guest companion records
// at submit time (openTripForm()'s onSubmit) -- not the 'tag-picker'
// type used elsewhere, since tag-picker can only pick from EXISTING
// companions, and a trip being created has none yet.
var TRIP_FIELDS_NEW = TRIP_FIELDS.concat([
  { key: 'companionNames', label: 'Who\'s coming with you? (optional)', type: 'textarea', wide: true,
    placeholder: 'One name per line -- e.g.\nAlex\nSam',
    hint: 'Each name becomes a guest on this trip (no login) -- you can link any of them to a Waypoint username, or add more people, from the Companions tab afterwards.' }
]);

var DESTINATION_FORM_SECTIONS = [
  { title: 'Essentials', hint: 'Set the area and the dates you will be based there.', fields: [
    { key: 'country', label: 'Country', type: 'country', placeholder: 'e.g. Thailand' },
    { key: 'name', label: 'Place / area', type: 'location-picker', required: true, wide: true, placeholder: 'e.g. Chiang Mai or Dartmoor National Park', locationPrefix: 'destination', boundaryPrefix: 'boundary', locationContext: 'destination', locationKind: 'area', countryKey: 'country', summaryLabel: 'Destination area' },
    { key: 'destinationJourney', label: 'Dates', type: 'journey', wide: true, journey: { startDateKey: 'arriveDate', endDateKey: 'departDate', startLabel: 'Arrive', endLabel: 'Leave', dateOnly: true, inclusive: true, timezoneKey: 'timezone', defaultEndOffsetDays: 0 } }
  ] },
  { title: 'Local details', hint: 'Optional timezone information for local itinerary labels.', collapsible: true, fields: [
    { key: 'timezone', label: 'Local timezone', type: 'timezone', placeholder: 'e.g. Asia/Bangkok', hint: 'Used as a reference when a trip crosses several timezones.', wide: true }
  ] },
  peopleNotesSection('People', 'People tagged here are preselected when you add an activity in this destination.')
];

var ACTIVITY_CATEGORIES = ['Other', 'Dining & drinks', 'Tour / experience', 'Show / performance', 'Culture & sights', 'Outdoor / active', 'Shopping', 'Wellness', 'Nightlife'];

var ACTIVITY_FORM_SECTIONS = [
  { title: 'Essentials', hint: 'Start with what it is, where it is, and when it happens.', fields: [
    { key: 'title', label: 'Activity', type: 'text', required: true, wide: true },
    { key: 'category', label: 'Category', type: 'select', options: ACTIVITY_CATEGORIES },
    { key: 'destinationId', label: 'Area', type: 'select-destination' },
    { key: 'activityJourney', label: 'When', type: 'journey', wide: true, journey: { startDateKey: 'startDate', startTimeKey: 'startTime', endDateKey: 'endDate', endTimeKey: 'endTime', startLabel: 'Start', endLabel: 'End', allDayKey: 'allDay', destinationKey: 'destinationId', defaultEndOffsetDays: 0 } },
    { key: 'location', label: 'Venue (optional)', type: 'text', wide: true, placeholder: 'e.g. Hawksmoor Steakhouse' },
    { key: 'address', label: 'Address', type: 'location-picker', wide: true, placeholder: 'e.g. street address, neighbourhood or nearby landmark', locationPrefix: 'address', locationContext: 'activity', locationKind: 'point', locationValue: 'address', summaryLabel: 'Map location' }
  ] },
  bookingContactSection('Optional confirmation details and the person or provider to contact.'),
  { title: 'Cost and receipt', hint: 'Optional — activity costs also appear automatically in Expenses.', collapsible: true, fields: [
    { key: 'costAmount', label: 'Cost amount', type: 'number' },
    { key: 'costCurrency', label: 'Cost currency', type: 'currency' },
    { key: 'costRate', label: 'Exchange rate override', type: 'number', hint: 'Home-currency value of 1 unit of this currency. Leave blank to use the trip\'s fixed rate.', wide: true },
    { key: 'receiptRef', label: 'Receipt reference', type: 'text', placeholder: 'e.g. email confirmation, photo filename', wide: true }
  ] },
  peopleNotesSection('People', 'Defaults from the selected destination. You can adjust the people on this activity.')
];

// Transport fields depend on the chosen mode: a flight needs a flight
// number, a car rental wants a rental company and plate instead, etc.
// transportSectionsForMode() builds the right field list for whichever
// mode/payment-type is selected; "Mode", "Paid with", and the
// exchange-rate checkbox are wired up as the form's `reactiveKey` (see
// openForm/openTransportForm below) so changing any re-renders the
// field list live without losing what was typed.
var TRANSPORT_MODE_FIELDS = {
  Flight: [
    { key: 'carrier', label: 'Airline', type: 'text', placeholder: 'e.g. British Airways' },
    { key: 'flightNumber', label: 'Flight number', type: 'flight-lookup', placeholder: 'e.g. BA15', wide: true }
  ],
  Train: [
    { key: 'carrier', label: 'Operator', type: 'text' }
  ],
  Bus: [
    { key: 'carrier', label: 'Operator', type: 'text' }
  ],
  Ferry: [
    { key: 'carrier', label: 'Operator', type: 'text' }
  ],
  Car: [
    { key: 'carrier', label: 'Rental company', type: 'text' },
    { key: 'licensePlate', label: 'License plate', type: 'text' }
  ],
  Other: [
    { key: 'carrier', label: 'Operator / provider', type: 'text' }
  ]
};

// Builds the cost/points portion for whichever "Paid with" option is
// selected. Cash and Points are each a self-contained pair of fields;
// Combo is both one after another; Free contributes nothing. Every
// field is either part of an even pair (fieldsHtml() auto-pairs them
// onto one row) or marked `wide` -- that's what keeps layout correct
// however the branches combine.
function transportPaymentFields(values) {
  var paymentType = values.paymentType || 'Free';
  var showCash = paymentType === 'Cash' || paymentType === 'Combo';
  var showPoints = paymentType === 'Points' || paymentType === 'Combo';
  // Unchecked checkboxes are simply absent from form data (see
  // currentFormValues()/FormData), so "on"/true both mean checked and
  // anything else — including undefined — means not checked.
  var rateOverrideOn = values.costRateOverrideEnabled === 'on' || values.costRateOverrideEnabled === true;

  var fields = [{ key: 'paymentType', label: 'Paid with', type: 'select', options: TRANSPORT_PAYMENT_TYPES, wide: true, disclosureNeutral: 'Free' }];
  if (showCash) {
    fields = fields.concat([
      { key: 'costCurrency', label: 'Cost currency', type: 'currency' },
      { key: 'costAmount', label: 'Cost amount', type: 'number' },
      { key: 'costRateOverrideEnabled', label: 'Use a different exchange rate for this leg', type: 'checkbox', wide: true }
    ]);
    if (rateOverrideOn) {
      fields.push({ key: 'costRate', label: 'Exchange rate override', type: 'number', wide: true, hint: 'Home-currency value of 1 unit of this currency.' });
    }
  }
  if (showPoints) {
    fields = fields.concat([
      { key: 'pointsProgram', label: 'Points program', type: 'text', placeholder: 'e.g. Avios, United MileagePlus' },
      { key: 'pointsAmount', label: 'Points used', type: 'number' }
    ]);
  }
  return fields;
}

function transportSectionsForMode(values) {
  var mode = values.mode || 'Flight';
  var modeFields = TRANSPORT_MODE_FIELDS[mode] || TRANSPORT_MODE_FIELDS.Other;
  var locationContext = mode === 'Flight' ? 'airport' : (mode === 'Train' ? 'rail' : (mode === 'Bus' ? 'bus' : (mode === 'Ferry' ? 'port' : 'transport')));
  return [
    { title: 'Essentials', hint: 'Set the mode, route and local departure and arrival times.', fields: [{ key: 'mode', label: 'Mode', type: 'select', options: TRANSPORT_MODES }]
      .concat(modeFields, [
      { key: 'fromLocation', label: 'From', type: 'location-picker', wide: true, required: true, placeholder: mode === 'Flight' ? 'e.g. LHR or Heathrow' : 'e.g. station, port or address', locationPrefix: 'from', locationContext: locationContext, locationKind: 'point', summaryLabel: 'Departure location' },
      { key: 'toLocation', label: 'To', type: 'location-picker', wide: true, required: true, placeholder: mode === 'Flight' ? 'e.g. JFK or JFK Airport' : 'e.g. station, port or address', locationPrefix: 'to', locationContext: locationContext, locationKind: 'point', summaryLabel: 'Arrival location' },
      { key: 'transportJourney', label: 'Journey', type: 'journey', wide: true, journey: { startDateKey: 'departDate', startTimeKey: 'departTime', endDateKey: 'arriveDate', endTimeKey: 'arriveTime', startLabel: 'Depart', endLabel: 'Arrive', startLocalLabel: 'Departure local time', endLocalLabel: 'Arrival local time', defaultEndOffsetDays: 0 } }
    ]) },
    bookingContactSection('Optional confirmation details and the operator contact.'),
    { title: 'Payment and receipt', hint: 'Optional cash, points and receipt details.', collapsible: true, fields: transportPaymentFields(values).concat([
      { key: 'receiptRef', label: 'Receipt reference', type: 'text', wide: true },
    ]) },
    peopleNotesSection('Companions')
  ];
}

var ACCOMMODATION_TYPES = ['Other', 'Hotel / hostel', 'Apartment / holiday rental', 'Guesthouse / B&B', 'Resort', 'Camping / glamping', 'Friends / family', 'Cruise ship'];

var ACCOMMODATION_FORM_SECTIONS = [
  { title: 'Essentials', hint: 'Record the property, its type, and the stay dates first.', fields: [
    { key: 'name', label: 'Property', type: 'text', required: true, wide: true },
    { key: 'type', label: 'Accommodation type', type: 'select', options: ACCOMMODATION_TYPES },
    { key: 'destinationId', label: 'Area', type: 'select-destination' },
    { key: 'address', label: 'Property location', type: 'location-picker', wide: true, placeholder: 'e.g. hotel, campsite or street address', locationPrefix: 'location', locationContext: 'accommodation', locationKind: 'point', locationValue: 'address', summaryLabel: 'Property location' },
    { key: 'stayJourney', label: 'Stay', type: 'journey', wide: true, journey: { startDateKey: 'checkInDate', startTimeKey: 'checkInTime', endDateKey: 'checkOutDate', endTimeKey: 'checkOutTime', startLabel: 'Check in', endLabel: 'Check out', destinationKey: 'destinationId', durationKind: 'nights', defaultEndOffsetDays: 1 } }
  ] },
  bookingContactSection('Optional confirmation details and a property or host contact.'),
  { title: 'Cost and receipt', hint: 'Optional — accommodation costs also appear automatically in Expenses.', collapsible: true, fields: [
    { key: 'costAmount', label: 'Total cost amount', type: 'number' },
    { key: 'costCurrency', label: 'Cost currency', type: 'currency' },
    { key: 'costRate', label: 'Exchange rate override', type: 'number', wide: true },
    { key: 'receiptRef', label: 'Receipt reference', type: 'text', wide: true }
  ] },
  peopleNotesSection('Companions')
];

var CONTACT_FIELDS = [
  { key: 'name', label: 'Name', type: 'text', required: true },
  { key: 'role', label: 'Role / company', type: 'text', placeholder: 'e.g. hotel front desk, tour guide' },
  { key: 'phone', label: 'Phone', type: 'text' },
  { key: 'email', label: 'Email', type: 'text' },
  { key: 'address', label: 'Address', type: 'text', wide: true },
  { key: 'notes', label: 'Notes', type: 'textarea', wide: true }
];

// Companions are a different idea from Contacts above: a person actually
// on this trip, the thing every "Companions" tag-picker field points at
// (see the 'tag-picker' case in fieldHtml()).
//
// `smileyColor` (openCompanionForm() maps it to/from stored
// `avatar.smiley`) only shows up if the companion isn't linked to an
// account (resolveCompanionAvatars() in src/worker.js) -- a linked
// companion shows that account's own colour+animal instead, picked via
// openAvatarPicker(). `accountId` is real but never part of this form --
// see COMPANIONS & AVATARS in src/worker.js for why it's only ever set
// via the dedicated link/unlink action, openCompanionLinkForm().
var COMPANION_FIELDS = [
  { key: 'name', label: 'Name', type: 'text', required: true, placeholder: 'e.g. Sarah' },
  { key: 'smileyColor', label: 'Smiley colour', type: 'avatar-color', wide: true, hint: 'Shown on their marker unless they\'re linked to an account, which gives them their own colour + animal instead.' },
  // Both optional: blank means they are on the whole trip, which is what
  // every companion added before this existed says. Advisory only --
  // nothing is hidden or refused on the strength of these dates, they just
  // let the itinerary warn you when you tag someone into a day they are
  // not there for (see tagPickerAbsenceWarning()).
  { key: 'joinsOn', label: 'Joins the trip', type: 'date', hint: 'Leave blank if they are there from the start.' },
  { key: 'leavesOn', label: 'Leaves the trip', type: 'date', hint: 'Leave blank if they stay to the end.' },
  { key: 'notes', label: 'Notes', type: 'textarea', wide: true }
];

// The Phase-3 version of the form above: what a "user" grant may specify
// when appending a brand-new companion (mergeUserScopedCompanions() in
// src/worker.js) -- name and a smiley colour, nothing else. A separate,
// shorter list rather than hiding fields with CSS: a Notes field that
// silently gets dropped server-side would be misleading.
var COMPANION_FIELDS_LIMITED = [
  { key: 'name', label: 'Name', type: 'text', required: true, placeholder: 'e.g. Sarah' },
  { key: 'smileyColor', label: 'Smiley colour', type: 'avatar-color', wide: true }
];

var EXPENSE_FIELDS = [
  { key: 'description', label: 'Description', type: 'text', required: true, wide: true },
  { key: 'category', label: 'Category', type: 'select', options: EXPENSE_CATEGORIES },
  { key: 'date', label: 'Date', type: 'date', required: true },
  { key: 'amount', label: 'Amount', type: 'number', required: true },
  { key: 'currency', label: 'Currency', type: 'currency', required: true },
  { key: 'rateOverride', label: 'Exchange rate override', type: 'number', wide: true },
  { key: 'receiptRef', label: 'Receipt reference', type: 'text' },
  { key: 'contactId', label: 'Contact', type: 'select-contact' },
  { key: 'notes', label: 'Notes', type: 'textarea', wide: true }
];

