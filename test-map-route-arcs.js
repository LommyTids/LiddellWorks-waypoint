// Focused no-browser regression checks for the pure map-route helpers.
// The broader Map tab test uses Playwright, but these assertions should still
// run in a minimal local checkout where a browser binary is unavailable.
const assert = require('assert');
const fs = require('fs');

const html = fs.readFileSync('public/WayPoint/index.html', 'utf8');
const start = html.indexOf('function normalizeLongitude');
const end = html.indexOf('function routeStyleForMode');
if (start < 0 || end < 0) throw new Error('Could not locate map route helpers in index.html');

const routes = new Function(html.slice(start, end) + '\nreturn { greatCircleRoute: greatCircleRoute, routeForMapView: routeForMapView, routeForSingleWorldView: routeForSingleWorldView };')();

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
const singleWorld = routes.routeForSingleWorldView(pacific);
assert.strictEqual(singleWorld.segments.length, 2, 'single-world overview should split at its unavoidable edge');
singleWorld.segments.forEach(function (segment) {
  segment.forEach(function (point) {
    assert(point[1] >= -180 && point[1] <= 180, 'single-world overview must stay inside one Earth copy');
  });
});

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

console.log('map range and route-arc regression checks passed');
