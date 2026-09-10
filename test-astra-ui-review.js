// Executable regressions using the production functions with small DOM/Leaflet
// doubles. No credentials, real trip data, browser installation or network.
// --baseline verifies that these cases actually detect defects on base main.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const html = process.argv.includes('--baseline')
  ? execFileSync('git', ['show', 'd87eafd:public/WayPoint/index.html'], { encoding: 'utf8' })
  : fs.readFileSync('public/WayPoint/index.html', 'utf8');
const cases = [];
function test(name, fn) { cases.push({ name, fn }); }
function functions(names, context = {}) {
  const code = names.map(name => {
    const match = html.match(new RegExp('(?:async )?function ' + name + '\\([^]*?\\n}'));
    assert(match, 'Missing production function ' + name);
    return match[0];
  }).join('\n');
  return vm.runInNewContext(code + '\n({' + names.join(',') + '})', context);
}
function picker(values = {}) {
  const fields = Object.fromEntries(Object.entries({ locationLat: '', locationLng: '', boundaryRef: '', boundaryQuality: '', boundaryBbox: '', ...values }).map(([k,v]) => [k, { value: v }]));
  const button = { disabled: true };
  const region = { setAttribute(k, v) { this[k] = v; } };
  const holder = { classList: { add() {}, remove() {} } };
  const query = { value: 'Station', dispatchEvent() {}, focus() {} };
  const wrapper = {
    isConnected: true, dataset: { locationPrefix: 'location', boundaryPrefix: 'boundary' },
    closest() { return null; },
    querySelector(selector) {
      const field = selector.match(/^input\[name="(.+)"\]$/);
      if (field) return fields[field[1]] || (fields[field[1]] = { value: '' });
      return { '[data-action="search-location"]': button, '[data-location-results]': region, '[data-location-pin-map]': holder, '[data-location-query]': query }[selector] || null;
    }
  };
  return { wrapper, fields, button, region, holder, query };
}
function locationEnvironment(extra = {}) {
  const maps = [], markers = [];
  const context = {
    AbortController, URLSearchParams, Number, Event, locationPickerBoundaries: {}, locationPickerResults: {},
    pickerHint() {}, pickerSummary() {}, cssToken() { return 'teal'; }, editingAvailable() { return true; },
    setTimeout(fn) { fn(); },
    L: {
      map() { const map = { events: {}, setView(center, zoom) { this.center = center; this.zoom = zoom; return this; }, on(event, fn) { this.events[event] = fn; }, invalidateSize() {}, remove() { this.removed = true; }, fitBounds() {} }; maps.push(map); return map; },
      tileLayer() { return { addTo() {} }; },
      latLng(lat, lng) { return { lat, lng }; },
      marker(point) { const marker = { point, addTo() { return this; }, on() {}, setLatLng(p) { this.point = p; } }; markers.push(marker); return marker; },
      geoJSON() { return { addTo() { return this; }, getBounds() { return []; } }; }
    }, ...extra
  };
  const names = ['pickerInput', 'pickerSet', 'abortLocationSearch', 'selectLocationResult', 'loadLocationBoundary', 'openLocationPickerMap'];
  for (const name of ['clearPickerMap', 'invalidatePickerBoundary', 'disposeLocationPickers']) if (html.includes('function ' + name + '(')) names.push(name);
  return { ...functions(names, context), maps, markers, context };
}
test('all inline scripts parse', () => {
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([^]*?)<\/script>/g)) new vm.Script(match[1]);
});
test('aborting a search restores Find and aria-busy', () => {
  const env = locationEnvironment(), p = picker();
  p.wrapper._locationSearchController = new AbortController();
  env.abortLocationSearch(p.wrapper);
  assert.equal(p.button.disabled, false);
  assert.equal(p.region['aria-busy'], 'false');
});
test('empty coordinates do not manufacture a 0,0 pin', () => {
  const env = locationEnvironment(), p = picker();
  env.openLocationPickerMap(p.wrapper, true);
  assert.equal(p.fields.locationLat.value, '');
  assert.equal(env.markers.length, 0);
  assert.equal(env.maps[0].zoom, 2);
});
test('opening manual pin mode preserves the selected identity', () => {
  const env = locationEnvironment(), p = picker({ locationLat: 0, locationLng: 12, locationLocationMethod: 'selected', locationLocationRef: 'liq:N123', boundaryRef: 'liq:W1' });
  env.openLocationPickerMap(p.wrapper, true);
  assert.equal(p.fields.locationLocationMethod.value, 'selected');
  assert.equal(p.fields.locationLocationRef.value, 'liq:N123');
  assert.equal(p.fields.boundaryRef.value, 'liq:W1');
  assert.equal(env.markers.length, 1, 'zero latitude is a real coordinate');
});
test('preview can switch to placement and save the clicked coordinate', () => {
  const env = locationEnvironment(), p = picker({ locationLat: 35, locationLng: 139 });
  env.openLocationPickerMap(p.wrapper, false);
  env.openLocationPickerMap(p.wrapper, true);
  const map = env.maps.at(-1);
  assert.equal(typeof map.events.click, 'function');
  map.events.click({ latlng: { lat: 36, lng: 140 } });
  assert.equal(p.fields.locationLat.value, 36);
  assert.equal(p.fields.locationLocationMethod.value, 'manual');
});
test('selecting a point clears the previous destination boundary', () => {
  const env = locationEnvironment(), p = picker({ boundaryRef: 'liq:W1', boundaryQuality: 'exact_simplified', boundaryBbox: '[1,2,3,4]' });
  env.selectLocationResult(p.wrapper, { name: 'New point', lat: 40, lng: 3 });
  assert.equal(p.fields.boundaryRef.value, '');
  assert.equal(p.fields.boundaryBbox.value, '');
});
test('late boundary responses cannot overwrite a newer point selection', async () => {
  let resolve;
  const env = locationEnvironment({ fetch: () => new Promise(r => { resolve = r; }) }), p = picker();
  const request = env.loadLocationBoundary(p.wrapper, 'liq:W1');
  env.selectLocationResult(p.wrapper, { name: 'New point', lat: 40, lng: 3 });
  resolve({ ok: true, json: async () => ({ bbox: [1,2,3,4], geometry: {}, geometryQuality: 'exact_simplified' }) });
  await request;
  assert.equal(p.fields.boundaryRef.value, '');
});
test('picker disposal aborts requests and removes Leaflet instances', () => {
  const env = locationEnvironment(), p = picker();
  env.openLocationPickerMap(p.wrapper, false);
  const controller = new AbortController(); p.wrapper._locationSearchController = controller;
  env.disposeLocationPickers({ querySelectorAll: () => [p.wrapper] });
  assert(controller.signal.aborted);
  assert(env.maps[0].removed);
});
test('modal focus targets exclude CSS-hidden and collapsed fields', () => {
  const hidden = { hidden: false, closest: () => null, getAttribute: () => null, getClientRects: () => [] };
  const shown = { ...hidden, getClientRects: () => [{}] };
  const api = functions(['modalFocusableElements']);
  const targets = api.modalFocusableElements({ querySelectorAll: () => [hidden, shown] });
  assert.equal(targets.length, 1); assert.equal(targets[0], shown);
});
test('suggestion selection emits change for dependent UI', () => {
  const events = [];
  const api = functions(['selectSuggestion'], { suggestDropdownState: { source: { display: x => x } }, closeSuggestions() {}, Event });
  api.selectSuggestion({ getAttribute() {}, dispatchEvent(e) { events.push(e.type); } }, 'Asia/Tokyo');
  assert.deepEqual(events, ['change']);
});
test('field errors reveal collapsed optional sections before focus', () => {
  const element = () => ({ setAttribute() {}, focus() {}, textContent: '' });
  const summary = element(), error = element();
  const form = { querySelector: () => summary };
  const details = { tagName: 'DETAILS', open: false, parentElement: form };
  const parent = { parentElement: details, querySelector: () => error };
  const control = { parentElement: parent, setAttribute() {}, focus() { assert(details.open, 'error field remained collapsed'); } };
  functions(['showFormError'], { appendDescribedBy() {}, ensureElementId: () => 'error-id' }).showFormError(form, 'Invalid rate', control);
});
test('flight refresh preserves same-airport pins and updates changed airports', () => {
  const p = picker();
  p.wrapper.dataset.locationPrefix = 'from';
  p.fields.fromLat = { value: '51.5' }; p.fields.fromLng = { value: '-0.5' }; p.fields.fromLocationStale = { value: 'false' };
  const selected = [];
  const input = { value: 'LHR — Reviewed airport', closest: () => p.wrapper };
  const api = functions(['applyFlightAirport', 'pickerInput'], {
    airportCoordsForCode: code => code === 'JFK' ? { lat: 40.64, lng: -73.78 } : null,
    airportDisplay: airport => airport.code, selectLocationResult: (_w,result) => selected.push(result), pickerHint() {}
  });
  api.applyFlightAirport(input, { code: 'LHR', location: { lat: 51.4, lng: -0.4 } });
  assert.equal(selected.length, 0);
  api.applyFlightAirport(input, { code: 'JFK' });
  assert.equal(selected[0].lat, 40.64);
  assert.equal(selected[0].locationRef, 'local:airport:JFK');
});
test('offline submit locks preserve intentionally disabled buttons', () => {
  let available = false;
  const active = { disabled: false, dataset: {} }, pending = { disabled: true, dataset: {} };
  const api = functions(['updateSubmitAvailability'], { editingAvailable: () => available });
  const scope = { querySelectorAll: () => [active, pending] };
  api.updateSubmitAvailability(scope); assert(active.disabled);
  available = true; api.updateSubmitAvailability(scope);
  assert.equal(active.disabled, false); assert.equal(pending.disabled, true);
});
test('FX rates accept sub-penny precision; amounts retain money precision', () => {
  const api = functions(['fieldHtml'], { esc: String });
  assert.match(api.fieldHtml({ key: 'costRate', type: 'number' }, '0.0052'), /step="any"/);
  assert.match(api.fieldHtml({ key: 'costAmount', type: 'number' }, '15.50'), /step="0.01"/);
});
test('currency and rate validation stays local and accepts optional fields', () => {
  const errors = [];
  const api = functions(['validateEditableFields'], { showFormError: (_f,m) => errors.push(m), tzOffsetLabel: () => 'GMT' });
  const check = (name, value, required = false) => api.validateEditableFields({ querySelectorAll: () => [{ name, value, required, dataset: {} }] });
  assert.equal(check('name', '  ', true), false);
  assert.equal(check('homeCurrency', 'POUNDS'), false);
  assert.equal(check('rate_JPY', '0'), false);
  assert.equal(check('costRate', '0.0052'), true);
  assert.equal(check('costRateOverrideEnabled', 'on'), true);
  assert.equal(check('costCurrency', ''), true);
});
test('offline status honours the supplied message', () => {
  const node = { dataset: {}, setAttribute() {} };
  functions(['setSaveStatus'], { document: { getElementById: () => node } }).setSaveStatus('readonly', 'Offline');
  assert.equal(node.textContent, 'Offline');
});
test('sticky shell offsets track wrapped header and banner heights', () => {
  const values = {};
  const document = { querySelector: () => ({ getBoundingClientRect: () => ({ height: 72 }) }), getElementById: () => ({ getBoundingClientRect: () => ({ height: 96 }) }), documentElement: { style: { setProperty: (key,value) => { values[key] = value; } } } };
  functions(['updateStickyShellOffsets'], { document }).updateStickyShellOffsets();
  assert.equal(values['--wp-shell-bar-height'], '72px');
  assert.equal(values['--wp-shell-banner-height'], '96px');
});
test('expense actions distinguish standalone delete from linked edit', () => {
  const api = functions(['expenseActionsHtml'], { canFullyEditTrip: () => true, esc: String, icon: () => '', ENTITY_ID_FIELDS: { activity: 'activityId' }, rowActions: () => 'edit-expense delete-expense' });
  assert.match(api.expenseActionsHtml({}, { section: 'expense', item: {} }), /delete-expense/);
  const linked = api.expenseActionsHtml({}, { section: 'activity', type: 'Activity', item: { activityId: 'a1' } });
  assert.match(linked, /edit-activity/); assert.doesNotMatch(linked, /delete-/);
});
test('dependency inventory is a collapsed disclosure without credentials', () => {
  const result = functions(['renderDependencyDisclosure'], { esc: String }).renderDependencyDisclosure();
  assert.match(result, /<details class="settings-section settings-dependencies">/);
  assert.doesNotMatch(result, /<details[^>]*\sopen/);
  for (const name of ['Leaflet','LocationIQ','AeroDataBox','Playwright']) assert(result.includes(name));
});

(async () => {
  let failures = 0;
  for (const {name, fn} of cases) {
    try { await fn(); console.log('PASS ' + name); }
    catch (error) { failures++; console.error('FAIL ' + name + ': ' + error.message); }
  }
  console.log(`${cases.length - failures}/${cases.length} Astra UI regressions passed`);
  if (failures) process.exitCode = 1;
})();
