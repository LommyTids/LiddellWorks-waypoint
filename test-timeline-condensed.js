// Regression checks for the Timeline tab: the condensed event card, the day
// disclosure, and the day-level context added on top of them.
//
// "Condensed" still means what it did in September — a Timeline card carries a
// headline and its own context, never the metadata pill row that belongs on the
// Plan lists. What changed is that the *day heading* now carries area, spend and
// a today/outside-trip flag, which the original condensing had removed
// wholesale. Those two assertions are inverted here deliberately, not lost.
const { loadAppSources } = require('./test-source');
const assert = require('assert');
const vm = require('vm');

const { source, style } = loadAppSources();

const eventStart = source.indexOf('function eventRowHtml');
const eventEnd = source.indexOf('function timelineSpendByDay', eventStart);
const timelineStart = source.indexOf('function renderTimelineTab');
const timelineEnd = source.indexOf('/* ---------- 21.', timelineStart);
assert(eventStart !== -1 && eventEnd !== -1, 'Could not locate the Timeline event renderer');
assert(timelineStart !== -1 && timelineEnd !== -1, 'Could not locate the Timeline tab renderer');
const eventRenderer = source.slice(eventStart, eventEnd);
const timelineRenderer = source.slice(timelineStart, timelineEnd);

/* ---- the condensed card ------------------------------------------------ */

assert(eventRenderer.includes('model.metadata = {};'), 'Timeline rows still expose ItemRow metadata tags');
assert(eventRenderer.includes('return itemRowHtml('), 'Timeline event cards bypass the shared ItemRow');
assert(!timelineRenderer.includes('day-areas'), 'Timeline day headings still render destination chips');

// The Timeline's own share of the card contract. The stacked structure and
// the category stripes are now generic to every context and are covered by
// test-card-system.js; what stays here is what only the Timeline does.
assert(/\.item-row--timeline \.item-supporting\s*\{[^}]*line-clamp:\s*2/.test(style), 'Timeline detail is not clamped to two lines');
// Pressing a clamped card opens the rest in place, and pressing again closes it.
assert(/\.item-row--timeline\.is-expanded \.item-supporting\s*\{[^}]*line-clamp:\s*none/.test(style), 'An expanded card still clamps its note');
assert(source.includes("action === 'toggle-card-text'"), 'Pressing a card does not open its note');
assert(source.includes("e.target.closest('.item-people, .item-meta-more, .copy-btn, a')"), 'Pressing the people scroller or a copy button would open the note');
assert(source.includes('function markTruncatedNotes()'), 'Nothing measures which notes are actually cut off');
// The shared card must not learn about the Timeline to do this: the Timeline
// declares the capability on its model, the card only honours it.
assert(eventRenderer.includes('model.expandableNote = true;'), 'The Timeline no longer opts its notes into expanding');
assert(/\.item-row--timeline\[data-truncated="true"\] \.item-more/.test(style), 'The open control shows on cards whose note is not truncated');
const coarseNote = (style.match(/@media \(pointer: coarse\)\s*\{([\s\S]*?)\n\}/) || [])[1] || '';
assert(coarseNote.includes('.item-more'), 'The note control is below the coarse-pointer minimum');

const layouts = (source.match(/var ITEM_CARD_LAYOUTS = \{([\s\S]*?)\n\};/) || [])[1] || '';
const timelineLayout = (layouts.match(/timeline:\s*(\[.*\])/) || [])[1] || '';
assert(timelineLayout, 'The Timeline has no entry in the card layout table');
assert(!timelineLayout.includes("'metadata'"), 'Timeline cards took the metadata run back');
assert(!timelineLayout.includes("'people'"), 'Timeline cards took a people line');
assert(timelineLayout.includes("'cost'"), 'Timeline cards lost their converted cost');

/* ---- the day disclosure ------------------------------------------------ */

assert(timelineRenderer.includes('data-action="toggle-timeline-day"'), 'The day disclosure action is missing');
assert(/class="day-head"[^>]*data-action="toggle-timeline-day"/.test(timelineRenderer), 'The whole day heading is not the disclosure control');
assert(/class="day-num" aria-hidden="true"/.test(timelineRenderer), 'The date badge should be decorative now the heading is the control');
assert(source.includes("day >= (today || timelineLocalTodayStr())"), 'Past-day default is missing');
assert(source.includes("action === 'toggle-timeline-day' && trip"), 'Timeline disclosure is not wired');
assert(source.includes('timelineContent.hidden = !nextExpanded'), 'Timeline disclosure does not hide its controlled content');
assert(source.includes('syncTimelineToolbar(trip)'), 'Toggling one day leaves the Expand/Collapse-all control stale');

/* ---- day-level context (the reversal) ---------------------------------- */

assert(timelineRenderer.includes('timelineDayAreaLabel(trip, day)'), 'Day headings no longer name their area');
assert(timelineRenderer.includes('timelineDaySummaryHtml('), 'Collapsed days carry no summary');
assert(timelineRenderer.includes('timelineDayFlag(trip, day, today)'), 'Today and outside-trip days are not flagged');
assert(/\.day-card\.is-today \.day-num/.test(style), 'Today has no marker on the date badge');
assert(/\.day-card\.is-outside \.day-num/.test(style), 'Days outside the trip window have no marker');

/* ---- one add control per day ------------------------------------------- */

assert(!style.includes('.timeline-add-btn'), 'The three per-day add buttons remain');
assert(!timelineRenderer.includes('timeline-add-activity'), 'Add actions should live in the day add menu, not the day card');
assert(source.includes('<details class="day-add">'), 'The day add menu is not a native disclosure');
['timeline-add-activity', 'timeline-add-accommodation', 'timeline-add-transport'].forEach(function (action) {
  assert(source.includes('data-action="' + action + '"'), 'Add menu lost ' + action);
});
assert(source.includes('closeDayAddMenus('), 'The add menu is never closed, so it can sit behind a modal');

/* ---- navigation for long trips ----------------------------------------- */

assert(source.includes("action === 'timeline-jump-today' && trip"), 'Jump to today is not wired');
assert(source.includes("action === 'timeline-toggle-all' && trip"), 'Expand/collapse all is not wired');
assert(/prefers-reduced-motion: reduce/.test(source.slice(source.indexOf("action === 'timeline-jump-today'"), source.indexOf("action === 'timeline-jump-today'") + 1200)), 'Jump to today ignores the reduced-motion preference');

/* ---- the spine and touch targets --------------------------------------- */

// As a flex child the spine took its height from the day body and measured
// 0px on every collapsed day, breaking the line exactly where it mattered.
assert(/\.day-rail::before\s*\{[^}]*position:\s*absolute/.test(style), 'The day spine can still collapse to zero height');
assert(!/\.day-line\s*\{[^}]*flex:\s*1/.test(style), 'The collapsing flex spine remains');

const coarse = (style.match(/@media \(pointer: coarse\)\s*\{([\s\S]*?)\n\}/) || [])[1] || '';
['.day-head', '.day-add-btn', '.day-add-item', '.timeline-tool'].forEach(function (selector) {
  assert(coarse.includes(selector), 'Coarse-pointer target missing for ' + selector);
});
// The control recedes by losing its outline, never by going invisible: an
// opacity-0 or pointer-events-none control is a target a pointer can land on
// without seeing, and it cannot be exercised by the browser gate either.
assert(!/\.day-add[^{]*\{[^}]*opacity:\s*0/.test(style), 'The add control is hidden by opacity, making it an invisible target');
assert(!/\.day-add[^{]*\{[^}]*pointer-events:\s*none/.test(style), 'The add control is not hittable at rest');
assert(/\.day-card:hover \.day-add-btn[^{]*\{[^}]*border-color/.test(style), 'The add control does not surface on hover');

/* ---- executable: disclosure defaults ----------------------------------- */

const stateStart = source.indexOf('var timelineDayExpansion = {}');
const stateEnd = source.indexOf('// ---- Accounts / login', stateStart);
assert(stateStart !== -1 && stateEnd !== -1, 'Could not locate Timeline disclosure state');
const context = {};
vm.createContext(context);
vm.runInContext(source.slice(stateStart, stateEnd), context);

assert.strictEqual(context.timelineDayExpanded('trip-1', '2026-09-01', '2026-09-02'), false, 'A day before today should default closed');
assert.strictEqual(context.timelineDayExpanded('trip-1', '2026-09-02', '2026-09-02'), true, 'Today should default open');
assert.strictEqual(context.timelineDayExpanded('trip-1', '2026-09-03', '2026-09-02'), true, 'A future day should default open');
context.timelineDayExpansion[context.timelineDayKey('trip-1', '2026-09-01')] = true;
assert.strictEqual(context.timelineDayExpanded('trip-1', '2026-09-01', '2026-09-02'), true, 'Manual expansion should override the date default');

/* ---- executable: the new day and card helpers -------------------------- */

// Pull each helper's real source rather than reimplementing it, so these
// assertions fail when the shipped behaviour changes.
function fnSource(name) {
  const start = source.indexOf('function ' + name + '(');
  assert(start !== -1, 'Could not find function ' + name);
  const end = source.indexOf('\nfunction ', start + 1);
  return source.slice(start, end === -1 ? undefined : end);
}

const helpers = {
  // Stubbed collaborators: these have their own coverage elsewhere, and
  // stubbing them keeps this suite on the Timeline's own logic.
  money: (amount, currency) => currency + ' ' + Number(amount).toFixed(2),
  homeValue: (trip, amount, currency) => currency === trip.homeCurrency
    ? { value: Number(amount), known: true }
    : (trip.currencyRates[currency] === undefined
      ? { value: 0, known: false }
      : { value: Number(amount) * trip.currencyRates[currency], known: true }),
  allCostLines: (trip) => trip.costLines
};
vm.createContext(helpers);
['daysBetween', 'timelineDayFlag', 'areasForDay', 'timelineDayAreaLabel', 'timelineDetail', 'timelineEventCarriesCost', 'recordCostLabel', 'timelineSpendByDay',
 'transportEndpointLabel', 'timelineTransportTitle', 'timelineArrivalTitle', 'tripFocusDay']
  .forEach((name) => vm.runInContext(fnSource(name), helpers));

assert.strictEqual(helpers.daysBetween('2026-09-07', '2026-09-19'), 12, 'daysBetween is off');
assert.strictEqual(helpers.daysBetween('2026-09-07', '2026-09-07'), 0, 'daysBetween should be zero for one date');

const trip = {
  startDate: '2026-09-07',
  endDate: '2026-09-19',
  homeCurrency: 'GBP',
  currencyRates: { JPY: 0.005 },
  destinations: [
    { name: 'Kyoto', arriveDate: '2026-09-12', departDate: '2026-09-15' },
    { name: 'Tokyo', arriveDate: '2026-09-07', departDate: '2026-09-12' }
  ]
};

assert.strictEqual(helpers.timelineDayFlag(trip, '2026-09-10', '2026-09-10').label, 'Today', 'Today is not flagged');
assert.strictEqual(helpers.timelineDayFlag(trip, '2026-09-06', '2026-09-10').label, 'Before trip', 'A day before the trip start is not flagged');
assert.strictEqual(helpers.timelineDayFlag(trip, '2026-09-20', '2026-09-10').label, 'After trip', 'A day after the trip end is not flagged');
assert.strictEqual(helpers.timelineDayFlag(trip, '2026-09-11', '2026-09-10'), null, 'An ordinary day should carry no flag');
assert.strictEqual(helpers.timelineDayFlag(trip, '2026-09-06', '2026-09-10').quiet, true, 'Outside-trip flags should be quiet, not accented');

assert.strictEqual(helpers.timelineDayAreaLabel(trip, '2026-09-09'), 'Tokyo', 'A single-area day should name its area');
assert.strictEqual(helpers.timelineDayAreaLabel(trip, '2026-09-12'), 'Tokyo → Kyoto', 'A transfer day should name both areas in arrival order');
assert.strictEqual(helpers.timelineDayAreaLabel(trip, '2026-09-06'), '', 'A day with no destination should stay unlabelled');

assert.strictEqual(helpers.timelineDetail('Arrives 12:45', 'Car 7'), 'Arrives 12:45 · Car 7', 'Detail parts should join');
assert.strictEqual(helpers.timelineDetail('Arrives 12:45', ''), 'Arrives 12:45', 'Empty detail parts should drop out');

// Which day owns a record's cost. The card always carries the figure; the
// Timeline suppresses it on the days that would bill it a second time, so the
// day totals keep reconciling with the trip total.
assert.strictEqual(helpers.timelineEventCarriesCost({ kind: 'depart' }), true, 'A departure should carry the leg cost');
assert.strictEqual(helpers.timelineEventCarriesCost({ kind: 'arrive' }), false, 'An arrival must not repeat the leg cost');
assert.strictEqual(helpers.timelineEventCarriesCost({ kind: 'checkin' }), true, 'Check-in should carry the stay cost');
assert.strictEqual(helpers.timelineEventCarriesCost({ kind: 'checkout' }), false, 'Check-out must not repeat the stay cost');
assert.strictEqual(helpers.timelineEventCarriesCost({ kind: 'activity' }), true, 'An activity should carry its own cost');
assert.strictEqual(helpers.timelineEventCarriesCost({ kind: 'activity', continues: true }), false, 'A continuing activity must not repeat its cost');
assert(source.includes('if (!timelineEventCarriesCost(ev)) model.cost = null;'), 'The Timeline no longer suppresses a repeated cost');

// The figure itself: home currency when convertible, flagged when not.
assert.strictEqual(helpers.recordCostLabel(trip, {}), null, 'A free record should show no cost');
assert.strictEqual(helpers.recordCostLabel(trip, { costAmount: 90, costCurrency: 'GBP' }).text, 'GBP 90.00', 'A home-currency cost is wrong');
const converted = helpers.recordCostLabel(trip, { costAmount: 2000, costCurrency: 'JPY' });
assert.strictEqual(converted.text, 'GBP 10.00', 'A foreign cost should report in the home currency');
assert.strictEqual(converted.known, true, 'A convertible cost should be marked known');
const unrated = helpers.recordCostLabel(trip, { costAmount: 5000, costCurrency: 'KRW' });
assert.strictEqual(unrated.known, false, 'A cost with no rate should be marked unknown');
assert(unrated.text.includes('rate needed'), 'A cost with no rate should say so');

// Flights read as codes on the Timeline; anything that is not a leading IATA
// code, and any mode that is not a flight, is left exactly as typed.
const flight = { mode: 'Flight', flightNumber: 'BA005', fromLocation: 'LHR — London Heathrow', toLocation: 'HND — Tokyo Haneda' };
assert.strictEqual(helpers.transportEndpointLabel(flight, flight.fromLocation), 'LHR', 'A flight endpoint should shorten to its code');
assert.strictEqual(helpers.timelineTransportTitle(flight), 'Flight BA005: LHR → HND', 'The flight title is wrong');
assert.strictEqual(helpers.timelineArrivalTitle(flight), 'Arrive: HND (from LHR)', 'The arrival title is wrong');
const rail = { mode: 'Rail', fromLocation: 'Tokyo Station', toLocation: 'Kyoto Station' };
assert.strictEqual(helpers.transportEndpointLabel(rail, rail.fromLocation), 'Tokyo Station', 'A rail endpoint must not be shortened');
assert.strictEqual(helpers.timelineTransportTitle(rail), 'Rail: Tokyo Station → Kyoto Station', 'The rail title changed');
assert.strictEqual(helpers.transportEndpointLabel({ mode: 'Flight', fromLocation: 'Luton' }, 'Luton'), 'Luton', 'A flight endpoint with no code should be left alone');

// Both the Timeline and the Map open on today while a trip is under way.
const tripDays = ['2026-09-07', '2026-09-08', '2026-09-09'];
assert.strictEqual(helpers.tripFocusDay(tripDays, '2026-09-08'), '2026-09-08', 'A trip under way should open on today');
assert.strictEqual(helpers.tripFocusDay([]), '', 'An empty trip has no opening day');
assert(source.includes('mapState.rangeStart = tripFocusDay(days)'), 'The Map no longer opens on today');
assert(source.includes('function focusTimelineOpeningDay(trip)'), 'The Timeline does not open on a chosen day');
assert(/if \(target === days\[0\]\) \{ window\.scrollTo\(0, 0\); return; \}/.test(source),
  'A trip that is not under way should open at the top, not wherever the last tab was scrolled to');

const spend = helpers.timelineSpendByDay({
  homeCurrency: 'GBP',
  currencyRates: { JPY: 0.005 },
  costLines: [
    { date: '2026-09-08', amount: 100, currency: 'GBP' },
    { date: '2026-09-08', amount: 2000, currency: 'JPY' },
    { date: '2026-09-09', amount: 5000, currency: 'KRW' },
    { date: '', amount: 10, currency: 'GBP' }
  ]
});
assert.strictEqual(spend['2026-09-08'].known, 110, 'Day spend should sum converted costs');
assert.strictEqual(spend['2026-09-09'].known, 0, 'An unconvertible cost should not be counted');
assert.strictEqual(spend['2026-09-09'].unknown, 1, 'An unconvertible cost should be reported');
assert.strictEqual(spend[''], undefined, 'A dateless cost line should not create a day');

console.log('Timeline card, day disclosure and day-context checks passed');
