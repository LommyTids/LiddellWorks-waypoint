// Exercise the shipped picker/parser functions without network or browser dependencies.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const cases = [];
function test(name, run) { cases.push({ name, run }); }

function element(values = {}) {
  const classes = new Set();
  return {
    value: '', hidden: false, textContent: '', innerHTML: '', style: {}, attributes: {},
    classList: {
      add(name) { classes.add(name); }, remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); },
      toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); }
    },
    setAttribute(name, value) { this.attributes[name] = value; },
    focus() { this.focused = true; },
    querySelector() { return null; },
    ...values
  };
}

function environment(options = {}) {
  const listeners = {}, maps = [], markers = [], references = [];
  const trip = { destinations: [
    { destinationId: 'london', name: 'London', lat: 51.5074, lng: -0.1278 },
    { destinationId: 'paris', name: 'Paris', lat: 48.8566, lng: 2.3522 }
  ] };
  const context = vm.createContext({
    AbortController, URL, URLSearchParams, Event, Number,
    currentTrip: () => trip, byId: (items, id, key) => items.find(item => item[key] === id),
    editingAvailable: () => options.editable !== false,
    document: { addEventListener(type, fn) { (listeners[type] ||= []).push(fn); } },
    setTimeout(fn) { fn(); },
    L: {
      map() {
        if (options.mapFailure === 'create') throw new Error('Map unavailable');
        const map = {
          setView(point, zoom) { this.point = point; this.zoom = zoom; return this; },
          invalidateSize() { this.invalidated = true; }, remove() { this.removed = true; }
        };
        maps.push(map); return map;
      },
      tileLayer() { return { addTo() { if (options.mapFailure === 'tiles') throw new Error('Tiles unavailable'); } }; },
      marker(point) { markers.push(point); return { addTo() {} }; }
    }
  });
  for (const file of ['vendor/open-location-code/openlocationcode.js', 'js/location-input.js', 'js/locations.js', 'js/location-entry.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'public/WayPoint', file), 'utf8'), context, { filename: file });
  }
  const parse = context.parseLocationInput;
  context.parseLocationInput = (input, reference) => { references.push(reference); return parse(input, reference); };
  function dispatch(type, target, extra = {}) {
    const event = { target, preventDefault() { this.defaultPrevented = true; }, ...extra };
    (listeners[type] || []).forEach(listener => listener(event));
    return event;
  }
  function picker() {
    const fields = Object.fromEntries(Object.entries({
      locationLat: '40', locationLng: '3', locationLocationRef: 'old:point',
      locationLocationMethod: 'selected', locationLocationGranularity: 'city',
      locationLocationStale: 'false', locationLocationKindLabel: 'City',
      boundaryRef: 'old:boundary', boundaryQuality: 'exact_simplified', boundaryBbox: '[1,2,3,4]',
      address: 'Original venue address'
    }).map(([key, value]) => [key, element({ value })]));
    const nodes = {};
    for (const selector of [
      '[data-location-input]', '[data-location-reference]', '[data-location-reference-row]',
      '[data-location-reference-label]', '[data-location-input-panel]', '[data-location-candidate]',
      '[data-location-candidate-label]', '[data-location-candidate-map]', '[data-location-input-hint]',
      '[data-location-pin-map]', '[data-location-query]', '[data-location-results]',
      '[data-location-summary]', '[data-location-hint]', '.location-picker-actions',
      '[data-action="toggle-location-input"]', '[data-action="search-location"]'
    ]) nodes[selector] = element();
    nodes['[data-location-query]'].value = 'Family meeting place';
    nodes['[data-location-input]'].value = '51.5074, -0.1278';
    nodes['[data-location-reference]'].checked = false;
    nodes['[data-location-input-panel]'].hidden = true;
    nodes['[data-location-candidate]'].hidden = true;
    const status = element(), detail = element();
    nodes['[data-location-summary]'].querySelector = selector => selector === '.location-selected-status' ? status : detail;
    nodes['.location-picker-actions'].insertAdjacentHTML = function (_position, html) { this.innerHTML += html; };
    const destination = element({ value: 'london' });
    const form = { querySelector: selector => selector === '[name="destinationId"]' ? destination : null,
      querySelectorAll: selector => selector === '[data-location-picker]' ? [wrapper] : [] };
    const wrapper = {
      dataset: { locationPrefix: 'location', boundaryPrefix: 'boundary', locationAddressKey: 'address' },
      closest: selector => selector === 'form' ? form : null,
      querySelector(selector) {
        const match = selector.match(/^input\[name="(.+)"\]$/);
        return match ? fields[match[1]] || null : nodes[selector] || null;
      }
    };
    Object.entries(nodes).forEach(([selector, node]) => {
      node.matches = query => query === selector;
      node.closest = query => query === '[data-location-picker]' ? wrapper : query === 'form' ? form : null;
      node.dispatchEvent = event => { dispatch(event.type, node); };
    });
    destination.matches = selector => selector === '[name="destinationId"]';
    destination.closest = selector => selector === 'form' ? form : null;
    const savedValues = () => Object.fromEntries(Object.entries(fields).map(([key, input]) => [key, input.value]));
    return { wrapper, fields, nodes, destination, form, savedValues, status,
      input: nodes['[data-location-input]'], reference: nodes['[data-location-reference]'],
      holder: nodes['[data-location-candidate-map]'], hint: nodes['[data-location-input-hint]'] };
  }
  return { api: context, maps, markers, references, trip, dispatch, picker };
}

test('preview leaves stored point and identity untouched until confirmation', () => {
  const env = environment(), p = env.picker(), before = p.savedValues();
  env.api.previewLocationInput(p.wrapper);
  assert.deepEqual(p.savedValues(), before);
  assert.equal(p.nodes['[data-location-query]'].value, 'Family meeting place');
  assert.equal(p.nodes['[data-location-candidate]'].hidden, false);
  assert.equal(env.maps.length, 1);
  assert.equal(env.markers[0][0], 51.5074);
});

test('confirmation keeps venue/address while replacing obsolete point and boundary identity', () => {
  const env = environment(), p = env.picker();
  const boundaryRequest = new AbortController();
  p.wrapper._boundaryController = boundaryRequest;
  env.api.previewLocationInput(p.wrapper);
  env.api.applyLocationInput(p.wrapper);
  assert.equal(Number(p.fields.locationLat.value), 51.5074);
  assert.equal(Number(p.fields.locationLng.value), -0.1278);
  assert.equal(p.fields.locationLocationMethod.value, 'manual');
  assert.equal(p.fields.locationLocationRef.value, '');
  assert.equal(p.fields.locationLocationStale.value, 'false');
  assert.equal(p.fields.boundaryRef.value, '');
  assert.equal(p.fields.boundaryQuality.value, 'none');
  assert.equal(p.fields.boundaryBbox.value, '');
  assert.equal(p.fields.address.value, 'Original venue address');
  assert.equal(p.nodes['[data-location-query]'].value, 'Family meeting place');
  assert(boundaryRequest.signal.aborted);
  assert(env.maps[0].removed);
  assert.equal(p.wrapper._locationCandidate, null);
  assert.equal(p.nodes['[data-location-input-panel]'].hidden, true);
});

test('invalid input replaces a prior preview without changing the saved point', () => {
  const env = environment(), p = env.picker(), before = p.savedValues();
  env.api.previewLocationInput(p.wrapper);
  p.input.value = '91, 0';
  env.api.previewLocationInput(p.wrapper);
  env.api.applyLocationInput(p.wrapper);
  assert.deepEqual(p.savedValues(), before);
  assert.equal(p.wrapper._locationCandidate, null);
  assert.equal(p.input.attributes['aria-invalid'], 'true');
  assert(env.maps[0].removed);
});

test('input events discard the old candidate and its map', () => {
  const env = environment(), p = env.picker();
  env.api.previewLocationInput(p.wrapper);
  p.input.value = '48.8566, 2.3522';
  env.dispatch('input', p.input);
  assert.equal(p.wrapper._locationCandidate, null);
  assert.equal(p.holder._waypointMap, null);
  assert.equal(p.holder.classList.contains('is-open'), false);
  assert(env.maps[0].removed);
});

test('snapshot blocks changed input, destination, reference, venue and stored coordinates without events', () => {
  const mutations = [
    p => { p.input.value = '48.8566, 2.3522'; },
    p => { p.destination.value = 'paris'; },
    p => { p.reference.checked = true; },
    p => { p.nodes['[data-location-query]'].value = 'Another venue'; },
    p => { p.fields.locationLat.value = '20'; }
  ];
  mutations.forEach(mutate => {
    const env = environment(), p = env.picker();
    env.api.previewLocationInput(p.wrapper);
    mutate(p);
    const before = p.savedValues();
    env.api.applyLocationInput(p.wrapper);
    assert.deepEqual(p.savedValues(), before);
    assert.equal(p.wrapper._locationCandidate, null);
    assert.match(p.hint.textContent, /Preview it again/);
  });
});

test('a nearby destination never supplies short-code context without opt-in', () => {
  const env = environment(), p = env.picker();
  p.input.value = 'GV4C+XV';
  env.api.previewLocationInput(p.wrapper);
  assert.equal(env.references[0], undefined);
  assert.equal(p.wrapper._locationCandidate, null);
  assert.equal(p.input.attributes['aria-invalid'], 'true');
});

test('short Plus Codes resolve only with checked destination context and show that reference', () => {
  const env = environment(), p = env.picker();
  p.input.value = 'GV4C+XV'; p.reference.checked = true;
  env.api.previewLocationInput(p.wrapper);
  assert.equal(env.references[0].lat, 51.5074);
  assert.equal(env.references[0].lng, -0.1278);
  assert(p.wrapper._locationCandidate.point.usedReference);
  assert.match(p.nodes['[data-location-candidate-label]'].textContent, /Resolved near London/);
  assert.match(p.nodes['[data-location-candidate-label]'].textContent, /centre/);
});

test('changing destination invalidates preview and resets reference consent', () => {
  const env = environment(), p = env.picker();
  p.reference.checked = true;
  env.api.previewLocationInput(p.wrapper);
  p.destination.value = 'paris';
  env.dispatch('change', p.destination);
  assert.equal(p.wrapper._locationCandidate, null);
  assert.equal(p.reference.checked, false);
  assert.match(p.nodes['[data-location-reference-label]'].textContent, /Paris/);
  assert(env.maps[0].removed);
});

test('changing reference consent invalidates an existing preview', () => {
  const env = environment(), p = env.picker();
  env.api.previewLocationInput(p.wrapper);
  p.reference.checked = true;
  env.dispatch('change', p.reference);
  assert.equal(p.wrapper._locationCandidate, null);
  assert(env.maps[0].removed);
});

test('stale or unmapped destinations are not offered as nearby references', () => {
  const env = environment(), p = env.picker();
  for (const change of [{ locationStale: true }, { locationStale: false, lat: null }]) {
    Object.assign(env.trip.destinations[0], change);
    p.reference.checked = true;
    env.api.refreshLocationInputReference(p.wrapper);
    assert.equal(p.nodes['[data-location-reference-row]'].hidden, true);
    assert.equal(p.reference.checked, false);
  }
});

test('disposal removes candidate and manual maps and aborts outstanding requests', () => {
  const env = environment(), p = env.picker();
  env.api.previewLocationInput(p.wrapper);
  const manualMap = { remove() { this.removed = true; } };
  p.nodes['[data-location-pin-map]']._waypointMap = manualMap;
  const search = new AbortController(), boundary = new AbortController();
  p.wrapper._locationSearchController = search; p.wrapper._boundaryController = boundary;
  env.api.disposeLocationPickers(p.form);
  assert(env.maps[0].removed); assert(manualMap.removed);
  assert(search.signal.aborted); assert(boundary.signal.aborted);
  assert.equal(p.holder._waypointMap, null);
  assert.equal(p.wrapper._locationCandidate, null);
});

test('an unavailable editor cannot apply a valid preview', () => {
  const env = environment({ editable: false }), p = env.picker(), before = p.savedValues();
  env.api.previewLocationInput(p.wrapper);
  env.api.applyLocationInput(p.wrapper);
  assert.deepEqual(p.savedValues(), before);
});

test('map creation or tile failure still permits reviewed coordinates to be applied', () => {
  for (const mapFailure of ['create', 'tiles']) {
    const env = environment({ mapFailure }), p = env.picker();
    env.api.previewLocationInput(p.wrapper);
    assert.match(p.hint.textContent, /Map preview is unavailable/);
    assert.equal(p.holder._waypointMap, null);
    assert.equal(p.holder.classList.contains('is-open'), false);
    if (env.maps.length) assert(env.maps[0].removed);
    env.api.applyLocationInput(p.wrapper);
    assert.equal(Number(p.fields.locationLat.value), 51.5074);
  }
});

test('Enter in the auxiliary input previews without submitting the form', () => {
  const env = environment(), p = env.picker(), before = p.savedValues();
  const event = env.dispatch('keydown', p.input, { key: 'Enter' });
  assert.equal(event.defaultPrevented, true);
  assert(p.wrapper._locationCandidate);
  assert.deepEqual(p.savedValues(), before);
});

let failed = 0;
for (const { name, run } of cases) {
  try { run(); console.log('PASS ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.stack); }
}
console.log(`${cases.length - failed}/${cases.length} location entry regressions passed`);
if (failed) process.exitCode = 1;
