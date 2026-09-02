// Regression test for the production failure where opening any populated trip
// threw in itemMetadataHtml(), while empty trips appeared to work normally.
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('public/WayPoint/index.html', 'utf8');
const start = source.indexOf("var ITEM_META_ORDER =");
const end = source.indexOf("function costMetaDescriptor", start);
assert(start !== -1 && end !== -1, 'Could not locate ItemRow metadata helpers');

const context = {
  ENTITY_ID_FIELDS: { activity: 'activityId' },
  icon: (name) => `<svg data-icon="${name}"></svg>`,
  esc: (value) => String(value),
  mapsLink: () => '',
  copyBtn: () => '',
  companionTags: (_trip, people) => people.join(', '),
  rowActions: () => ''
};
vm.createContext(context);
vm.runInContext(source.slice(start, end), context);

const populated = context.itemMetadataHtml({}, {
  datetime: [{ icon: 'date', text: '12 Sep 2026' }],
  location: [{ icon: 'location', text: 'Lisbon' }],
  category: [],
  people: ['Alex'],
  commerce: []
});

assert(populated.includes('class="item-metadata"'), 'Populated metadata wrapper did not render');
assert(populated.includes('12 Sep 2026'), 'Date metadata did not render');
assert(populated.includes('Lisbon'), 'Location metadata did not render');
assert(populated.includes('Alex'), 'People metadata did not render');
assert.strictEqual(context.itemMetadataHtml({}, {}), '', 'Empty metadata should not render a wrapper');

console.log('populated trip ItemRow regression test passed');
