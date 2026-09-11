// Regression checks for the shared card — the one component every list in
// the app renders through: the four Plan tabs, the Timeline, the Map
// popovers, and the three People lists (Contacts, Companions, accounts).
//
// The contract this protects is that a context is *configuration*. Adding or
// rearranging one is an entry in ITEM_CARD_LAYOUTS; it is never a branch in
// the renderer, and it is never hand-built markup, which is what Contacts,
// Companions and Manage accounts had each drifted into.
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('public/WayPoint/index.html', 'utf8');
const style = (source.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || '';

/* ---- nothing hand-builds a card any more -------------------------------- */

assert(!source.includes('\'<div class="item-row">'), 'A list still hand-builds .item-row markup instead of using the shared card');
assert(!/<div class="item-title-row">/.test(source), 'The superseded single-row title structure remains');

// Every list resolves through the one entry point. Sliced to each function's
// actual end rather than a fixed window: renderCompanionsTab carries a long
// comment preamble, and a character budget would only measure that.
function functionSource(name) {
  const begin = source.indexOf('function ' + name);
  assert(begin !== -1, 'Could not find ' + name);
  const next = source.indexOf('\nfunction ', begin + 1);
  return source.slice(begin, next === -1 ? undefined : next);
}
['renderDestinationsTab', 'renderActivitiesTab', 'renderTransportTab', 'renderAccommodationTab',
 'renderContactsTab', 'renderCompanionsTab', 'renderManageUsersView'].forEach(function (name) {
  assert(functionSource(name).includes('itemRowHtml('), name + ' bypasses the shared card');
});

/* ---- the layout table is the configuration surface ---------------------- */

const layoutBlock = (source.match(/var ITEM_CARD_LAYOUTS = \{([\s\S]*?)\n\};/) || [])[1] || '';
assert(layoutBlock, 'ITEM_CARD_LAYOUTS is missing');
['plan', 'timeline', 'map', 'person'].forEach(function (context) {
  assert(new RegExp('\\n\\s*' + context + ':').test(layoutBlock), 'No layout for the ' + context + ' context');
});

// The renderer must stay free of per-context branching: that is the whole
// point of the table, and the regression this suite exists to catch.
const renderer = functionSource('itemRowHtml');
['timeline', 'plan', 'map', 'person'].forEach(function (context) {
  assert(!new RegExp("context === '" + context + "'").test(renderer),
    'itemRowHtml branches on the ' + context + ' context instead of reading the layout table');
});

/* ---- the card's own CSS contract ---------------------------------------- */

assert(/\.item-row\s*\{[^}]*flex-direction:\s*column/.test(style), 'Cards are not stacked lines');
assert(/\.item-row-spacer\s*\{[^}]*flex:\s*1/.test(style), 'The spacer slot cannot push a trailing group right');
// Every context gets the stripe now, not just the Timeline.
['activity', 'accommodation', 'transport', 'destination'].forEach(function (section) {
  assert(new RegExp('\\.item-row\\[data-item-section="' + section + '"\\]\\s*\\{[^}]*border-left-color').test(style),
    'No category stripe for ' + section);
});
assert(/\.item-row\[data-item-section="transport"\] \.item-title\s*\{[^}]*font-weight/.test(style), 'Transport titles carry no extra weight');

// Metadata flows rather than stacking one group per row.
assert(/\.item-metadata\s*\{[^}]*flex-wrap:\s*wrap/.test(style), 'Metadata no longer flows as one wrapping run');
assert(/\.item-meta-group\s*\{\s*display:\s*contents/.test(style), 'Metadata groups still each occupy their own row');

// The people line scrolls instead of growing the card.
assert(/\.item-people\s*\{[^}]*flex-wrap:\s*nowrap/.test(style), 'The people line wraps instead of scrolling');
assert(/\.item-people\s*\{[^}]*overflow-x:\s*auto/.test(style), 'The people line does not scroll');
assert(/\.item-people\s*\{[^}]*overscroll-behavior-x:\s*contain/.test(style), 'Scrolling the people line can drag the page behind it');
assert(source.includes('tabindex="0" role="group" aria-label="People on this record"'), 'The people scroller cannot be reached or named from the keyboard');

const coarse = (style.match(/@media \(pointer: coarse\)\s*\{([\s\S]*?)\n\}/) || [])[1] || '';
assert(coarse.includes('.item-meta-more-btn'), 'The "+N more" disclosure is below the coarse-pointer minimum');

/* ---- executable: the renderer itself ------------------------------------ */

// Run the real card source against stubs, so these assertions fail when the
// shipped behaviour changes rather than when a comment moves.
const start = source.indexOf("var ITEM_META_ORDER = ");
const end = source.indexOf("function recordCostLabel");
assert(start !== -1 && end !== -1, 'Could not locate the card renderer');

const ctx = {
  ENTITY_ID_FIELDS: { activity: 'activityId', contact: 'contactId' },
  icon: (name) => '<svg data-icon="' + name + '"></svg>',
  esc: (v) => String(v),
  mapsLink: () => '<a>map</a>',
  copyBtn: (v) => '<button data-copy="' + v + '"></button>',
  companionTags: (_trip, people) => (people || []).map((p) => '<span class="tag">' + p + '</span>').join(''),
  rowActions: () => '<div class="item-actions">ACTIONS</div>'
};
vm.createContext(ctx);
vm.runInContext(source.slice(start, end), ctx);

const meta = (over) => Object.assign({ datetime: [], location: [], category: [], people: [], commerce: [] }, over || {});

// An empty slot renders nothing, and a line whose slots are all empty does
// not render — so one layout serves a bare record and a populated one.
const bare = ctx.itemRowHtml({}, { context: 'plan', section: 'activity', item: {}, icon: 'activity', title: 'Just a title', metadata: meta() });
assert(bare.includes('Just a title'), 'The title did not render');
assert(!bare.includes('item-metadata'), 'An empty metadata slot still rendered a wrapper');
assert(!bare.includes('item-people'), 'An empty people slot still rendered a scroller');
assert(!bare.includes('item-supporting'), 'An empty supporting slot still rendered');
assert((bare.match(/item-row-line/g) || []).length === 2, 'A bare record should render exactly the control strip and the title line');

// A spacer alone must not keep a line alive. The map layout's first line is
// ['icon','spacer','actions'], so a record with no icon and no permitted
// actions leaves only the spacer — and that line must vanish entirely.
const spacerOnly = ctx.itemRowHtml({}, {
  context: 'map', section: 'activity', item: {}, title: 'T',
  showRecordActions: false, metadata: meta()
});
assert(!spacerOnly.includes('item-row-spacer'), 'A line holding only a spacer still rendered');
assert(!spacerOnly.includes('data-item-line="icon"'), 'The empty control strip still rendered');
assert((spacerOnly.match(/item-row-line/g) || []).length === 1, 'Only the title line should survive');
// ...but the same line does render once anything real joins the spacer.
const withActions = ctx.itemRowHtml({}, {
  context: 'map', section: 'activity', item: {}, title: 'T', metadata: meta()
});
assert(withActions.includes('data-item-line="icon"'), 'The control strip vanished even though it has actions');
assert(withActions.includes('item-row-spacer'), 'The spacer is missing from a line that does render');

// People move to their own scrolling line and leave the capped run.
const populated = ctx.itemRowHtml({}, {
  context: 'plan', section: 'activity', item: { activityId: 'a1' }, icon: 'activity', title: 'Museum',
  metadata: meta({
    datetime: [{ text: 'D1' }], location: [{ text: 'L1' }],
    category: [{ text: 'C1' }, { text: 'C2' }],
    people: ['Tom', 'Alex'],
    commerce: [{ text: 'M1' }, { text: 'M2' }]
  })
});
assert(populated.includes('data-item-id="a1"'), 'The record id is not on the card');
assert(populated.includes('class="item-people"'), 'People did not get their own line');
assert(!/data-item-meta="people"/.test(populated), 'People were rendered in the metadata run as well as on their own line');
assert(populated.includes('>Tom<') && populated.includes('>Alex<'), 'People chips are missing');

// The cap hides the overflow behind a disclosure rather than dropping it.
const capMatch = source.match(/var ITEM_META_CAP = (\d+);/);
assert(capMatch, 'ITEM_META_CAP is missing');
const cap = Number(capMatch[1]);
const shown = (populated.match(/data-item-meta="/g) || []).length;
assert(shown > 0, 'No metadata rendered at all');
assert(populated.includes('item-meta-more'), 'A card past the cap has no "+N more" disclosure');
const hidden = populated.split('item-meta-more-rest')[1] || '';
['D1', 'L1', 'C1', 'C2', 'M1', 'M2'].forEach(function (chip) {
  assert(populated.includes('>' + chip + '<'), chip + ' was dropped rather than moved behind the disclosure');
});
assert(hidden.includes('M2'), 'The last chip should be behind the disclosure, not shown');
const visibleRun = populated.split('<details')[0];
assert((visibleRun.match(/class="tag/g) || []).length === cap, 'The visible run does not stop at ITEM_META_CAP');

// itemMetadataHtml keeps its own contract: everything, uncapped.
assert.strictEqual(ctx.itemMetadataHtml({}, {}), '', 'Empty metadata should not render a wrapper');
const uncapped = ctx.itemMetadataHtml({}, meta({
  datetime: [{ text: 'D1' }], location: [{ text: 'L1' }], category: [{ text: 'C1' }],
  people: ['Tom'], commerce: [{ text: 'M1' }]
}));
assert(!uncapped.includes('item-meta-more'), 'itemMetadataHtml should never cap');
assert(uncapped.includes('>Tom<'), 'itemMetadataHtml dropped its people group');

// A group named on its own line leaves the catch-all automatically, which is
// what lets `people` move without an exclusion list to keep in sync.
const mapCard = ctx.itemRowHtml({}, {
  context: 'map', section: 'activity', item: {}, icon: 'activity', title: 'T',
  metadata: meta({ datetime: [{ text: 'D1' }], location: [{ text: 'L1' }], commerce: [{ text: 'M1' }] })
});
assert(mapCard.includes('data-item-meta="datetime"'), 'The map layout lost its datetime group');
assert(!mapCard.includes('>M1<'), 'A group the map layout never places still rendered');

// Accounts are not a trip record: the card must not invent actions for them.
const account = ctx.itemRowHtml(null, {
  context: 'person', section: 'account', item: { id: 'u1' }, icon: 'person', title: 'tom',
  showRecordActions: false, extraActionsHtml: '<div class="item-actions">USER</div>', metadata: {}
});
assert(account.includes('USER'), 'The account row lost its own controls');
assert(!account.includes('ACTIONS'), 'rowActions() was called for a section it has no rule for');
assert(!account.includes('data-item-id'), 'An account is not a trip record and should carry no record id');

console.log('shared card system checks passed');
