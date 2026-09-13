// Offline input regressions: no API keys, browser, network or trip data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const context = vm.createContext({ URL });
for (const file of ['public/WayPoint/vendor/open-location-code/openlocationcode.js', 'public/WayPoint/js/location-input.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, file), 'utf8'), context, { filename: file });
}
const parse = context.parseLocationInput;
let checks = 0;
function point(input, lat, lng, kind = 'coordinates', reference) {
  const result = parse(input, reference);
  assert.equal(result.error, undefined, `${input}: ${result.error}`);
  assert.equal(result.kind, kind, input);
  assert(Math.abs(result.lat - lat) < 1e-9, `${input}: latitude ${result.lat}`);
  assert(Math.abs(result.lng - lng) < 1e-9, `${input}: longitude ${result.lng}`);
  checks++;
  return result;
}
function invalid(input, reference) {
  const result = parse(input, reference);
  assert.equal(typeof result.error, 'string', `${input}: expected error`);
  assert.equal(result.lat, undefined, `${input}: failed input must not move a pin`);
  checks++;
  return result;
}

point('51.5074, -0.1278', 51.5074, -0.1278);
point('  -33.8688 151.2093  ', -33.8688, 151.2093);
point('+51.5, -.12', 51.5, -0.12);
point('0, 0', 0, 0);
point('90, 180', 90, 180);
point('-90 -180', -90, -180);
for (const input of ['', ' ', null, undefined, 0, {}, '51,', ',0', '51.5', '91, 0', '0,181',
  '151.2093,-33.8688', '51,5,-0,1', 'Infinity,0', 'NaN,0', '1e2,0', '51.5 -0.1 extra']) invalid(input);

point('51°30′26″N 0°7′39″W', 51 + 30 / 60 + 26 / 3600, -(7 / 60 + 39 / 3600));
point('33°51\'54"S, 151°12\'34"E', -(33 + 51 / 60 + 54 / 3600), 151 + 12 / 60 + 34 / 3600);
point('N 51 30 26 W 0 7 39', 51 + 30 / 60 + 26 / 3600, -(7 / 60 + 39 / 3600));
point('51.5 N, 0.12 W', 51.5, -0.12);
point('-33.8 S 151.2 E', -33.8, 151.2);
point('90°0′0″S, 180°0′0″W', -90, -180);
for (const input of ['-51 N 0 E', '+51 S 0 E', '51 N -1 E', '90°0′1″N 0 E',
  '51°60′N 0 E', '51°1′60″N 0 E', '51.5°1′N 0 E', '51°1.5′1″N 0 E', '0 E 51 N',
  '51 N S 0 E', '51N 0N', '51°N 181°E', '51°30″N 0E', '51°3026″N 0E']) invalid(input);

point('geo:51.5,-0.12', 51.5, -0.12);
point('geo:-33.8,151.2,20;crs=wgs84;u=10', -33.8, 151.2);
for (const input of ['geo:0,0?q=51.5,-0.12', 'geo:51.5,-0.12;crs=other', 'geo:91,0', 'geo:51,']) invalid(input);

// Published upstream fixtures at revision 83986da0156bbf51fba33d0327d8ca4b7f955c89:
// https://github.com/google/open-location-code/blob/83986da0156bbf51fba33d0327d8ca4b7f955c89/test_data/encoding.csv
for (const [lat, lng, code] of [[20.3700625, 2.7821875, '7FG49QCJ+2V'],
  [47.0000625, 8.0000625, '8FVC2222+22'], [-41.2730625, 174.7859375, '4VCPPQGP+Q9'],
  [-89.9999375, -179.9999375, '22222222+22']]) {
  assert.equal(context.encodeLocationPlusCode(lat, lng), code);
  assert.equal(point(code.toLowerCase(), lat, lng, 'plus-code').code, code);
}
point('7FG49QCJ+2VX', 20.3701125, 2.782234375, 'plus-code');
// https://github.com/google/open-location-code/blob/83986da0156bbf51fba33d0327d8ca4b7f955c89/test_data/shortCodeTests.csv
assert.equal(point('CJ+2VX', 51.3701125, -1.217765625, 'plus-code',
  { lat: 51.3708675, lng: -1.217765625 }).code, '9C3W9QCJ+2VX');
assert.equal(parse('CJ+2VX', { lat: 51.3708675, lng: -1.217765625 }).usedReference, true);
assert.equal(parse('9C3W9QCJ+2VX').usedReference, undefined);
assert.equal(invalid('CJ+2VX').needsReference, true);
assert.equal(invalid('CJ+2VX', { lat: '', lng: '' }).needsReference, true);
assert.equal(invalid('CJ+2VX', { lat: 91, lng: 0 }).needsReference, true);
for (const code of ['CJ+2VX London', '8FVC9G8F+6', '8FVC9G8F+6!', 'ZZZZZZZZ+ZZ']) invalid(code);
for (const [lat, lng] of [[90, 180], [-90, -180]]) {
  const code = context.encodeLocationPlusCode(lat, lng);
  assert.equal(parse(code).error, undefined);
  checks++;
}
for (const [lat, lng] of [['', ''], ['51', '0'], [91, 0], [0, 181], [NaN, 0]]) {
  assert.equal(context.encodeLocationPlusCode(lat, lng), '');
  checks++;
}

point('https://www.google.com/maps/search/?api=1&query=51.5%2C-0.12', 51.5, -0.12, 'maps-link');
point('https://maps.google.com/?q=-33.8,151.2', -33.8, 151.2, 'maps-link');
point('https://www.google.co.uk/maps?q=51.5,-0.12', 51.5, -0.12, 'maps-link');
point('https://www.google.com/maps/@20,30,12z?q=51.5,-0.12', 51.5, -0.12, 'maps-link');
for (const url of ['https://www.google.com/maps/@51.5,-0.12,13z',
  'https://www.google.com/maps/place/Station/@51.5,-0.12,13z/data=!3d52!4d1',
  'https://www.google.com/maps?q=51.5,-0.12&query=20,30',
  'https://www.google.com/maps?q=51.5,-0.12&q=20,30',
  'https://www.google.com/maps/search/?query=51.5,-0.12&query_place_id=other',
  'https://www.google.com/maps/dir/?query=51.5,-0.12',
  'https://www.google.com/maps?q=51.5,-0.12&destination=other',
  'https://maps.google.com/?q=London', 'https://maps.google.com/?q=91,0',
  'https://maps.app.goo.gl/abc', 'https://goo.gl/maps/abc',
  'https://maps.google.com.evil.test/?q=51.5,-0.12',
  'https://google.evil.com/maps?q=51.5,-0.12',
  'https://www.google.com/search?q=51.5,-0.12',
  'https://user@maps.google.com/?q=51.5,-0.12',
  'javascript:alert(1)', 'https://example.com/?query=51.5,-0.12']) invalid(url);

for (const input of ['///filled.count.soap', 'filled.count.soap', 'https://what3words.com/filled.count.soap',
  'https://w3w.co/filled.count.soap', 'https://www.what3words.com/filled.count.soap']) {
  assert.match(invalid(input).error, /what3words/);
}
invalid('x'.repeat(2049));
const missingVendor = vm.createContext({ URL });
vm.runInContext(fs.readFileSync(path.join(__dirname, 'public/WayPoint/js/location-input.js'), 'utf8'), missingVendor);
assert.equal(missingVendor.parseLocationInput('51,0').lat, 51);
assert.match(missingVendor.parseLocationInput('8FVC9G8F+6X').error, /not loaded/);
assert.equal(missingVendor.encodeLocationPlusCode(51, 0), '');
console.log(`Location input: ${checks} offline parsing and validation cases passed.`);
