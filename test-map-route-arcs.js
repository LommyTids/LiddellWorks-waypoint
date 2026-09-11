// Focused no-browser regression checks for the pure map-route helpers.
// The broader Map tab test uses Playwright, but these assertions should still
// run in a minimal local checkout where a browser binary is unavailable.
const assert = require('assert');
const fs = require('fs');

const html = fs.readFileSync('public/WayPoint/index.html', 'utf8');
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
const mapSource = require('fs').readFileSync('public/WayPoint/index.html', 'utf8');
const mapStyle = (mapSource.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || '';

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

console.log('map range and route-arc regression checks passed');
