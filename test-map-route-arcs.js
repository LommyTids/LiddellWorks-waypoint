// Focused no-browser regression checks for the pure map-route helpers.
// The broader Map tab test uses Playwright, but these assertions should still
// run in a minimal local checkout where a browser binary is unavailable.
const { loadAppSources } = require('./test-source');
const assert = require('assert');
const vm = require('vm');

const { source: html, style: mapStyle } = loadAppSources();
const start = html.indexOf('function normalizeLongitude');
const end = html.indexOf('function routeStyleForMode');
if (start < 0 || end < 0) throw new Error('Could not locate map route helpers in index.html');

const routes = new Function(html.slice(start, end) + '\nreturn { greatCircleRoute: greatCircleRoute, routeForMapView: routeForMapView };')();

function everyRenderedStepStaysLocal(points) {
  for (let i = 1; i < points.length; i++) {
    assert(
      Math.abs(points[i].lng - points[i - 1].lng) <= 180.001,
      'an unwrapped route must never jump across the world'
    );
  }
}

// Tokyo → Los Angeles crosses the date line. It must remain one continuous,
// unwrapped arc so it can be drawn in the closest repeated map world.
const pacific = routes.greatCircleRoute({ lat: 35.6762, lng: 139.6503 }, { lat: 34.0522, lng: -118.2437 });
assert(pacific.points.length > 12, 'long routes should be sampled into a visible arc');
everyRenderedStepStaysLocal(pacific.points);
assert(pacific.points[pacific.points.length - 1].lng > 180, 'Pacific route should retain its unwrapped destination longitude');
const pacificView = routes.routeForMapView(pacific, 180);
assert(pacificView.points[0].lng > 0 && pacificView.points[pacificView.points.length - 1].lng > 180, 'Pacific-centred view should use the eastward world copy');
const atlanticView = routes.routeForMapView(pacific, -180);
assert(atlanticView.points[0].lng < 0 && atlanticView.points[atlanticView.points.length - 1].lng < 0, 'opposite view should use the adjacent westward world copy');
// A normal Atlantic route remains a continuous great-circle arc.
const atlantic = routes.greatCircleRoute({ lat: 40.7128, lng: -74.006 }, { lat: 51.5072, lng: -0.1276 });
assert(Math.abs(atlantic.points[0].lat - 40.7128) < 0.001, 'origin latitude should be preserved');
assert(Math.abs(atlantic.points[atlantic.points.length - 1].lng + 0.1276) < 0.001, 'destination longitude should be preserved');

assert(html.includes('data-map-range-handle="start"'), 'map should expose a draggable start handle');
assert(html.includes('data-map-range-handle="end"'), 'map should expose a draggable end handle');
assert(html.includes('data-action="map-fit-selection"'), 'map should expose a fit-selection action');
assert(html.indexOf("{ key: 'destinations'") < html.indexOf("{ key: 'transport'"), 'destination filter should come before transport');
assert(html.indexOf("{ key: 'transport'") < html.indexOf("{ key: 'accommodation'"), 'transport filter should come before accommodation');
assert(html.indexOf("{ key: 'accommodation'") < html.indexOf("{ key: 'activities'"), 'accommodation filter should come before activities');
assert(html.indexOf("'<div class=\"map-actions\">' + mapFiltersHtml(trip)") < html.indexOf('mapRangeControlsHtml(trip) +'), 'filter controls should appear above the date slider');


/* ---- the Map opens on today, and its popups scroll ---------------------- */
// Added with the "open on today" change: the Map used to open on the trip's
// first day even mid-trip, and a popup grew to fit a long note with no scroll
// region at all, which on a phone left nothing to reach the rest of the text.
const mapSource = html;

assert(mapSource.includes('mapState.rangeStart = tripFocusDay(days)'), 'The Map does not open on today');
assert(/var fullRange = !days\.length \|\| \(mapState\.rangeStart === tripFocusDay\(days\)/.test(mapSource),
  'Reset does not return the Map to the day it opens on');
assert(mapSource.includes('function mapPopupOptions()'), 'Map popups have no bounded height');
assert((mapSource.match(/mapPopupOptions\(\)/g) || []).length >= 4, 'Not every bindPopup call bounds its height');
assert(/\.leaflet-popup-content\.leaflet-popup-scrolled\s*\{[^}]*overscroll-behavior:\s*contain/.test(mapStyle),
  'Scrolling a popup can still pan the map underneath it');
assert(/\.leaflet-popup-content\.leaflet-popup-scrolled::-webkit-scrollbar-thumb/.test(mapStyle),
  'A scrolled popup shows no scrollbar on a pointer device');
// Touch platforms draw overlay scrollbars that are invisible at rest, so the
// scrollbar alone is not the affordance -- a persistent cue has to survive it.
assert(/\.leaflet-popup-content\.leaflet-popup-scrolled::after\s*\{[^}]*position:\s*sticky/.test(mapStyle),
  'A scrolled popup has no persistent cue that its text continues');
assert(/\.leaflet-popup-content\.leaflet-popup-scrolled::after\s*\{[^}]*linear-gradient/.test(mapStyle),
  'The scroll cue is not a fade');


// Render both handles on the final day, the previously overlapping case.
const controlsStart = html.indexOf('function mapRangeControlsHtml');
const controlsEnd = html.indexOf('function mapFiltersHtml', controlsStart);
const days = ['2026-10-01', '2026-10-02', '2026-10-03'];
const renderControls = new Function('ensureMapRange', 'mapState', 'esc', 'mapRangeDateLabel', 'mapRangeDayCount', 'mapViewIsDefault', 'icon', 'formatDateHeading', html.slice(controlsStart, controlsEnd) + ';return mapRangeControlsHtml({});');
const controls = renderControls(() => days, {rangeStart: days[2], rangeEnd: days[2]}, x => x, x => x, () => 1, () => false, () => '', x => x);
assert(controls.includes('handles-overlap'), 'Final-day handles must use separate rows');
assert.strictEqual((controls.match(/value="2"/g) || []).length, 2, 'Both handles should still point to the final day');
assert(controls.includes('data-action="map-show-all"'), 'The collapsed range needs Show all');
assert(/\.handles-overlap \.map-range-input\[data-map-range-handle="end"\]\s*\{\s*top: 44px/.test(mapStyle), 'The ending handle must be offset below the start');

// Moving the date range must update the optional location-repair disclosure
// without replacing the map, retaining an already-open disclosure. Records
// outside the range and viewer-only repair controls must never leak into it.
const repairTrip = {
  activities: [
    { activityId: 'unmapped-first', title: 'First day', startDate: days[0], endDate: days[0] },
    { activityId: 'unmapped-last', title: 'Final day', startDate: days[2], endDate: days[2] }
  ]
};
let disclosure = { open: true };
const recovery = {
  innerHTML: '',
  querySelector: () => disclosure
};
const repairContext = {
  mapState: { rangeStart: days[0], rangeEnd: days[0] },
  document: { getElementById: () => recovery },
  activityStartDate: item => item.startDate,
  activityEndDate: item => item.endDate,
  dateOnly: value => String(value || '').slice(0, 10),
  canEditItem: () => true,
  ENTITY_ID_FIELDS: { activity: 'activityId' },
  esc: value => String(value || ''),
  icon: () => '',
  mapLayerIconName: () => 'activity'
};
vm.createContext(repairContext);
vm.runInContext(
  html.slice(html.indexOf('function mapRangeVisible'), html.indexOf('function mapPointsForTrip')) +
  html.slice(html.indexOf('function mapUnmappedRecords'), html.indexOf('function renderMapTab')),
  repairContext
);
repairContext.updateMapRecoveryUi(repairTrip);
assert(recovery.innerHTML.includes('First day') && !recovery.innerHTML.includes('Final day'), 'Repair disclosure must use the selected map dates');
assert(recovery.innerHTML.includes('data-action="review-map-location"'), 'Editors need a repair action');
repairContext.mapState.rangeStart = repairContext.mapState.rangeEnd = days[2];
disclosure = { open: false };
const queryDisclosure = recovery.querySelector;
let reads = 0;
recovery.querySelector = () => ++reads === 1 ? { open: true } : queryDisclosure();
repairContext.updateMapRecoveryUi(repairTrip);
assert(!recovery.innerHTML.includes('First day') && recovery.innerHTML.includes('Final day'), 'Slider updates must replace stale repair records');
assert(disclosure.open, 'Range updates must retain an expanded repair disclosure');
repairContext.canEditItem = () => false;
repairContext.updateMapRecoveryUi(repairTrip);
assert(!recovery.innerHTML.includes('data-action="review-map-location"') && recovery.innerHTML.includes('Ask an editor'), 'Read-only users must not receive a repair mutation');
repairContext.mapState.rangeStart = repairContext.mapState.rangeEnd = days[1];
repairContext.updateMapRecoveryUi(repairTrip);
assert.strictEqual(recovery.innerHTML, '', 'No stale repair panel should remain in a clean range');
console.log('map range and route-arc regression checks passed');
