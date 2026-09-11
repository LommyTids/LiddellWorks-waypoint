// Regression checks for the viewing lens — the per-viewer "everything" vs
// "just my items" filter (Settings > What you see).
//
// The contract this protects is a safety one. The browser POSTs the WHOLE
// trip on every save, and a trip's items are deleted by omission, so a
// filtered trip object that ever reached a save path would silently delete
// every record it had filtered out. scopedTripForRender() is allowed to
// return a filtered COPY, but it must return the ORIGINAL OBJECT ITSELF
// whenever the lens is off, and nothing it returns may share mutated state
// with what is stored. The first test below is the one that matters.
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('public/WayPoint/index.html', 'utf8');
const style = (source.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || '';

/* ---- executable: the real helpers against stubs ------------------------- */

const start = source.indexOf('function canFullyEditTrip');
const end = source.indexOf('function itemScopeIndicatorHtml');
assert(start !== -1 && end !== -1, 'Could not locate the permission/visibility block');

const SUPERUSER_PARTICIPANT_ID = '__trip_superuser__';
const ctx = {
  SUPERUSER_PARTICIPANT_ID,
  currentUser: null,
  itemScopePreference: {},
  state: { trips: [] },
  byId: (list, id, field) => (list || []).find((x) => x[field] === id),
  icon: (n) => '<svg data-icon="' + n + '"></svg>'
};
vm.createContext(ctx);
vm.runInContext(source.slice(start, end), ctx);

// A trip with a mix of tagging: one item for the owner, one for an admin's
// companion record, one for somebody else, and one tagged to nobody.
function makeTrip(role, over) {
  const trip = Object.assign({
    tripId: 't1',
    myGrant: role === 'superuser' ? { role: 'superuser' } : { role: role },
    companions: [
      { companionId: 'c-admin', name: 'Admin Person', accountId: 'acct-admin' },
      { companionId: 'c-other', name: 'Someone Else', accountId: 'acct-other' }
    ],
    destinations: [{ destinationId: 'd1', companions: [SUPERUSER_PARTICIPANT_ID] }],
    activities: [
      { activityId: 'a1', companions: ['c-admin'] },
      { activityId: 'a2', companions: ['c-other'] },
      { activityId: 'a3', companions: [] }
    ],
    accommodation: [{ accommodationId: 'h1', companions: ['c-other'] }],
    transport: [{ transportId: 'x1', companions: ['c-admin', 'c-other'] }],
    contacts: [{ contactId: 'k1' }],
    expenses: [{ expenseId: 'e1' }]
  }, over || {});
  ctx.state.trips = [trip];
  return trip;
}

function reset() { ctx.itemScopePreference = {}; ctx.currentUser = null; }

/* ---- 1. the safety invariant -------------------------------------------- */

reset();
ctx.currentUser = { id: 'acct-owner' };
let trip = makeTrip('superuser');
assert.strictEqual(ctx.scopedTripForRender(trip), trip,
  'With the lens off, scopedTripForRender MUST return the same object — a copy here could reach a save and delete the filtered-out items');

// ...and still the same object when a stored preference says 'everything'.
ctx.itemScopePreference.t1 = 'everything';
assert.strictEqual(ctx.scopedTripForRender(trip), trip, 'An explicit "everything" must also return the original object');

// A viewer with no identity to filter by cannot be filtered — returning a
// blank copy would be worse than useless, it would look like data loss.
reset();
ctx.currentUser = { id: 'acct-nobody' };
trip = makeTrip('admin');
ctx.itemScopePreference.t1 = 'mine';
assert.strictEqual(ctx.scopedTripForRender(trip), trip,
  'An admin linked to nobody must get the whole trip back, not an empty one');
assert.strictEqual(ctx.canScopeToOwnItems(trip), false, 'The lens must not be offered when there is no identity to filter by');
assert.strictEqual(ctx.itemScopeFor(trip), 'everything', 'An unusable lens must resolve to "everything"');

// Filtering must never mutate what is stored.
reset();
ctx.currentUser = { id: 'acct-admin' };
trip = makeTrip('admin');
const before = JSON.stringify(trip);
ctx.scopedTripForRender(trip);
assert.strictEqual(JSON.stringify(trip), before, 'scopedTripForRender mutated the trip it was given');

/* ---- 2. defaults by role ------------------------------------------------ */

reset();
ctx.currentUser = { id: 'acct-owner' };
assert.strictEqual(ctx.defaultItemScope(makeTrip('superuser')), 'everything', 'The Trip Owner should start on "everything"');
assert.strictEqual(ctx.defaultItemScope(makeTrip('admin')), 'mine', 'An Admin should start on "mine"');
assert.strictEqual(ctx.defaultItemScope(makeTrip('user')), 'everything', 'A scoped grant has nothing to narrow');

// A scoped user/viewer is never offered the lens: the Worker already
// filtered their copy, so a lens over it would filter nothing.
reset();
ctx.currentUser = { id: 'acct-other' };
['user', 'viewer'].forEach(function (role) {
  const scoped = makeTrip(role, { myGrant: { role: role, companionId: 'c-other' } });
  assert.strictEqual(ctx.canScopeToOwnItems(scoped), false, 'The lens must not be offered to a ' + role + ' grant');
});

/* ---- 3. what "mine" actually selects ------------------------------------ */

reset();
ctx.currentUser = { id: 'acct-admin' };
trip = makeTrip('admin');
// Joined rather than deepStrictEqual: these arrays are built inside the vm
// context, so they carry its Array.prototype and fail a prototype-strict
// comparison despite identical contents.
assert.strictEqual(ctx.myParticipantIds(trip).join(','), 'c-admin', 'An admin should resolve to their linked companion record');

let shown = ctx.scopedTripForRender(trip);
assert.notStrictEqual(shown, trip, 'The default admin lens should have produced a filtered copy');
const activityIds = shown.activities.map((a) => a.activityId);
assert(activityIds.indexOf('a1') !== -1, 'An item tagged to me was dropped');
assert(activityIds.indexOf('a2') === -1, 'An item tagged only to someone else survived the filter');
assert(activityIds.indexOf('a3') !== -1, 'An UNTAGGED item was hidden — it would then be invisible to everyone using the lens');
assert.strictEqual(shown.transport.length, 1, 'An item tagged to me among others was dropped');
assert.strictEqual(shown.accommodation.length, 0, 'Someone else\'s accommodation survived the filter');

// The owner matches the virtual participant id, and also any companion
// record linked to their account.
reset();
ctx.currentUser = { id: 'acct-admin' };
trip = makeTrip('superuser');
assert.strictEqual(ctx.myParticipantIds(trip).join(','), SUPERUSER_PARTICIPANT_ID + ',c-admin',
  'The owner should match both the virtual participant and their own companion record');
ctx.itemScopePreference.t1 = 'mine';
shown = ctx.scopedTripForRender(trip);
assert.strictEqual(shown.destinations.length, 1, 'The owner lens dropped an item tagged to the virtual owner participant');

/* ---- 4. only the taggable lists are touched ----------------------------- */

reset();
ctx.currentUser = { id: 'acct-admin' };
trip = makeTrip('admin');
shown = ctx.scopedTripForRender(trip);
assert.strictEqual(shown.contacts, trip.contacts, 'contacts must pass through — items reference them by id');
assert.strictEqual(shown.companions, trip.companions, 'companions must pass through — the tag picker and People line need everyone');
assert.strictEqual(shown.expenses, trip.expenses, 'expenses must pass through — that tab is full-scope only anyway');
assert.strictEqual(shown.myGrant, trip.myGrant, 'myGrant must survive, or every permission check downstream breaks');
assert.strictEqual(shown.tripId, trip.tripId, 'tripId must survive');

/* ---- 5. the hidden count, from any copy --------------------------------- */

reset();
ctx.currentUser = { id: 'acct-admin' };
trip = makeTrip('admin');
// Hidden from the admin: d1 (tagged to the owner participant), a2 and h1
// (tagged only to someone else). Visible: a1 and x1 (tagged to them) and
// a3 (tagged to nobody).
assert.strictEqual(ctx.itemScopeHiddenCount(trip), 3, 'The hidden count is wrong');
// Handed the already-filtered copy, it must still report against the live
// trip — every render helper that calls it has the filtered one.
assert.strictEqual(ctx.itemScopeHiddenCount(ctx.scopedTripForRender(trip)), 3,
  'The hidden count must resolve the live trip, not count a filtered copy against itself');
ctx.itemScopePreference.t1 = 'everything';
assert.strictEqual(ctx.itemScopeHiddenCount(trip), 0, 'Nothing is hidden with the lens off');

/* ---- 6. the lens is render-only ----------------------------------------- */

// Every data-action handler must re-read the live trip rather than closing
// over a rendered one. If this ever changes, a filtered trip could reach a
// save -- see the file header.
const handlerRegion = source.slice(source.indexOf("document.addEventListener('click'"));
assert(!/scopedTripForRender/.test(handlerRegion.slice(0, handlerRegion.indexOf("if (action === 'set-item-scope'"))),
  'A click handler resolves a scoped trip — handlers must use the live currentTrip()');

// The three render paths that must agree with each other.
assert(/var viewTrip = scopedTripForRender\(trip\);/.test(source), 'renderTripView no longer builds a lensed trip');
assert(/var timelineTrip = scopedTripForRender\(currentTrip\(\)\);/.test(source), 'The Timeline opening-day scroll bypasses the lens');
assert(/var trip = scopedTripForRender\(currentTrip\(\)\);\n    if \(trip\) initMap\(trip\);/.test(source),
  'The Leaflet mount bypasses the lens — the map would show pins the list hides');

// The panels draw from the lens, not the live trip.
['renderDestinationsTab', 'renderActivitiesTab', 'renderTransportTab', 'renderAccommodationTab', 'renderTimelineTab', 'renderMapTab'].forEach(function (fn) {
  assert(new RegExp(fn + '\\(viewTrip\\)').test(source), fn + ' is still rendered from the unfiltered trip');
});

/* ---- 7. the control and its CSS ----------------------------------------- */

assert(/data-action="set-item-scope"/.test(source), 'Nothing can set the scope');
assert(/aria-pressed="true"/.test(source) && /aria-pressed="false"/.test(source), 'The segmented control carries no pressed state for a screen reader');
assert(/role="group" aria-label="Which items to show"/.test(source), 'The scope switch is not named for a screen reader');
assert(/\.scope-switch\s*\{[^}]*flex-wrap:\s*wrap/.test(style), 'The scope switch cannot wrap on a narrow screen');
assert(/\.scope-option\.is-active\s*\{[^}]*font-weight/.test(style), 'The active option is marked by colour alone');
assert(/\.status-badge\.is-scoped\s*\{[^}]*cursor:\s*pointer/.test(style), 'The header lens chip does not look clickable');

// The lens must never be described as a permission boundary.
const settingsCopy = source.slice(source.indexOf('<h3>What you see</h3>'), source.indexOf('<h3>What you see</h3>') + 1200);
assert(/does not change what anyone can open or edit/.test(settingsCopy),
  'The Settings copy no longer says the lens is a view filter rather than a permission');

console.log('visibility lens checks passed');
