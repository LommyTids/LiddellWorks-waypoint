const fs = require('fs');

const html = fs.readFileSync('public/WayPoint/index.html', 'utf8');
const icons = fs.readFileSync('public/WayPoint/ui/icons.js', 'utf8');

function requirePattern(pattern, message) {
  if (!pattern.test(html)) throw new Error(message);
}

// Journey adapts the existing record schemas instead of changing storage.
for (const field of ['destinationJourney', 'activityJourney', 'transportJourney', 'stayJourney']) {
  requirePattern(new RegExp("key: '" + field + "'[\\s\\S]{0,180}type: 'journey'"), 'Missing Journey field: ' + field);
}
for (const key of ['arriveDate', 'departDate', 'startDate', 'endDate', 'departTime', 'arriveTime', 'checkInDate', 'checkOutDate']) {
  requirePattern(new RegExp("(?:start|end)(?:Date|Time)Key: '" + key + "'"), 'Journey no longer maps persisted field: ' + key);
}
requirePattern(/class="journey-date-time-row"/, 'Journey date/time boxes are missing');
requirePattern(/class="journey-rail"/, 'Journey rail is missing');
requirePattern(/data-journey-duration role="status"/, 'Journey duration status is missing');
requirePattern(/data-journey-strip aria-hidden="true"/, 'Journey duration strip is missing');
requirePattern(/Same-day stay/, 'Same-day accommodation treatment is missing');
requirePattern(/For a same-day journey, the end time cannot be before the start time/, 'Inline chronology validation is missing');

// Forms share a visible Essentials step, optional disclosures and fixed actions.
requirePattern(/if \(!sections\) sections = \[\{ title: 'Essentials'/, 'Plain forms do not receive an Essentials section');
requirePattern(/title: 'Booking and contact'[\s\S]{0,120}collapsible: true/, 'Transport booking section is not collapsible');
requirePattern(/title: 'Payment and receipt'[\s\S]{0,120}collapsible: true/, 'Transport payment section is not collapsible');
requirePattern(/disclosureNeutral: 'Free'/, 'Transport Free default incorrectly opens payment details');
requirePattern(/\.modal-foot \{ position: sticky; bottom: 0;/, 'Form actions are not sticky');
requirePattern(/openSectionTitles[\s\S]*activeName[\s\S]*details\.open = true[\s\S]*\.focus\(\)/, 'Reactive forms do not preserve disclosure and focus state');

// Plan lists, Timeline and map popups all resolve through one ItemRow adapter.
requirePattern(/var ITEM_META_ORDER = \['datetime', 'location', 'category', 'people', 'commerce'\]/, 'ItemRow metadata order changed');
for (const renderer of ['renderDestinationsTab', 'renderActivitiesTab', 'renderTransportTab', 'renderAccommodationTab']) {
  requirePattern(new RegExp('function ' + renderer + '[\\s\\S]{0,900}itemRowHtml\\('), renderer + ' bypasses ItemRow');
}
requirePattern(/function eventRowHtml[\s\S]{0,1800}return itemRowHtml\(/, 'Timeline bypasses ItemRow');
requirePattern(/function routePopupHtml[\s\S]{0,500}itemRowHtml\(/, 'Route popup bypasses ItemRow');
requirePattern(/function pointPopupHtml[\s\S]{0,500}itemRowHtml\(/, 'Marker popup bypasses ItemRow');
requirePattern(/section: 'transport', item: t/, 'Map route model lost its source record');

for (const name of ['category', 'location', 'checkIn', 'checkOut', 'continues', 'allDay', 'warning']) {
  if (!new RegExp('\\n\\s*' + name + ": '").test(icons)) throw new Error('Missing record-state icon: ' + name);
}

if (/activity-timing|<div class="event-row"/.test(html)) throw new Error('Superseded timing or timeline markup remains');

console.log('Journey, form and ItemRow consolidation checks passed');
