// Regression checks for part-trip participation — a companion who joins
// late or leaves early (joinsOn / leavesOn on the companion record).
//
// Two contracts here, and they matter more than the formatting:
//
//   1. These dates are ADVISORY. Nothing is filtered and no save is
//      refused because of them. Somebody may genuinely be tagged into one
//      dinner on a day they are otherwise not around, and an itinerary
//      that argued with its owner about that would be worse than one that
//      stayed quiet.
//   2. Blank means "the whole trip" at that end. Every companion record
//      written before this field existed has no dates at all, so absent
//      must read as present-throughout or existing trips would start
//      claiming everybody was away.
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('public/WayPoint/index.html', 'utf8');
const style = (source.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || '';
const worker = fs.readFileSync('src/worker.js', 'utf8');

/* ---- executable: the date helpers --------------------------------------- */

const start = source.indexOf('function companionStayLabel');
const end = source.indexOf('function companionTags');
assert(start !== -1 && end !== -1, 'Could not locate the part-trip helpers');

const ctx = { formatDateShort: (d) => d };
vm.createContext(ctx);
vm.runInContext(source.slice(start, end), ctx);

// 1. Blank at either end means "throughout".
assert.strictEqual(ctx.companionStayLabel({}), '', 'A companion with no dates should carry no stay label at all');
assert.strictEqual(ctx.companionAwayOn({}, '2028-06-02'), false, 'A companion with no dates is never away');
assert.strictEqual(ctx.companionAwayOn({ joinsOn: '2028-06-05' }, ''), false, 'With no day to test, nothing can be judged away');
assert.strictEqual(ctx.companionAwayOn(null, '2028-06-02'), false, 'A missing companion is not "away"');

// 2. One-ended windows.
assert.strictEqual(ctx.companionStayLabel({ joinsOn: '2028-06-05' }), 'from 2028-06-05');
assert.strictEqual(ctx.companionStayLabel({ leavesOn: '2028-06-07' }), 'until 2028-06-07');
assert.strictEqual(ctx.companionStayLabel({ joinsOn: '2028-06-05', leavesOn: '2028-06-07' }), '2028-06-05 – 2028-06-07');

const late = { joinsOn: '2028-06-05', leavesOn: '2028-06-07' };
assert.strictEqual(ctx.companionAwayOn(late, '2028-06-04'), true, 'The day before they join is away');
assert.strictEqual(ctx.companionAwayOn(late, '2028-06-05'), false, 'The day they join is NOT away — the window is inclusive');
assert.strictEqual(ctx.companionAwayOn(late, '2028-06-07'), false, 'The day they leave is NOT away — the window is inclusive');
assert.strictEqual(ctx.companionAwayOn(late, '2028-06-08'), true, 'The day after they leave is away');

// Open-ended at one side only.
assert.strictEqual(ctx.companionAwayOn({ joinsOn: '2028-06-05' }, '2028-06-30'), false, 'No leavesOn means they stay to the end');
assert.strictEqual(ctx.companionAwayOn({ leavesOn: '2028-06-07' }, '2028-06-01'), false, 'No joinsOn means they were there from the start');

// 3. Only the people actually tagged are reported, and only when away.
const trip = { companions: [late, { companionId: 'c-always', name: 'Always' }] };
late.companionId = 'c-late'; late.name = 'Latecomer';
assert.strictEqual(ctx.companionsAwayFor(trip, ['c-late', 'c-always'], '2028-06-02').length, 1, 'Only the away companion should be reported');
assert.strictEqual(ctx.companionsAwayFor(trip, ['c-late'], '2028-06-06').length, 0, 'Nobody is away inside the window');
assert.strictEqual(ctx.companionsAwayFor(trip, ['c-late'], '').length, 0, 'With no date, no warning can be made');
assert.strictEqual(ctx.companionsAwayFor(trip, ['no-such-id'], '2028-06-02').length, 0, 'A dangling tag id must not crash or warn');

/* ---- the form reads the right inputs ------------------------------------ */

// These are the journey widget's own input names, not the fields a record
// finally stores under. Getting this wrong silently disables the warning on
// three of the four forms, which is exactly the bug this guards.
const keys = (source.match(/var TAG_PICKER_DATE_KEYS = \[([^\]]+)\]/) || [])[1] || '';
['checkInDate', 'departDate', 'arriveDate', 'startDate'].forEach(function (key) {
  assert(keys.indexOf("'" + key + "'") !== -1, 'TAG_PICKER_DATE_KEYS is missing the ' + key + ' form input');
  assert(new RegExp("startDateKey: '" + key + "'").test(source),
    key + ' is not actually a journey startDateKey — TAG_PICKER_DATE_KEYS has drifted from the forms');
});

/* ---- the warning is advisory, never a block ----------------------------- */

const sync = source.slice(source.indexOf('function syncTagPickerAwayWarning'), source.indexOf('// Reads a \'tag-picker\' field'));
assert(/You can still tag them/.test(sync), 'The warning no longer says the tag is still allowed');
assert(!/preventDefault|required|setCustomValidity|disabled/.test(sync),
  'The part-trip warning blocks input — it must stay advisory');
assert(/slot\.hidden = true/.test(sync), 'The warning never hides itself again');

/* ---- fields, chip and styling ------------------------------------------- */

const companionFields = source.slice(source.indexOf('var COMPANION_FIELDS = ['), source.indexOf('var COMPANION_FIELDS_LIMITED'));
assert(/key: 'joinsOn'/.test(companionFields) && /key: 'leavesOn'/.test(companionFields), 'The companion form does not offer the dates');
const limited = source.slice(source.indexOf('var COMPANION_FIELDS_LIMITED'), source.indexOf('var COMPANION_FIELDS_LIMITED') + 400);
assert(!/joinsOn|leavesOn/.test(limited), 'A scoped "user" grant should not be setting who is on the trip when');
assert(/companionStayLabel\(c\)/.test(source), 'The companion row no longer shows a stay chip');
assert(/\.tag-stay\s*\{/.test(style), 'The stay chip has no styling');
assert(/\.tag-picker-away\s*\{/.test(style), 'The away warning has no styling');

/* ---- the server accepts and validates them ------------------------------ */

assert(/"joinsOn", "leavesOn"/.test(worker), 'The Worker whitelist drops the part-trip dates, so they would never persist');
assert(/Invalid companion date in trip data/.test(worker), 'The Worker does not validate the part-trip dates');
assert(/cannot leave the trip before they join it/.test(worker), 'The Worker accepts a leave date before the join date');
// SAFE_DATE_PATTERN must keep admitting the empty string, or every existing
// companion record becomes unsaveable the moment this field is read.
assert(/const SAFE_DATE_PATTERN = \/\^\$\|/.test(worker),
  'SAFE_DATE_PATTERN no longer admits "", so blank part-trip dates would be rejected');

console.log('part-trip date checks passed');
