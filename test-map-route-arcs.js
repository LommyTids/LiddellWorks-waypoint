// Focused no-browser regression checks for the pure map-route helpers.
// The broader Map tab test uses Playwright, but these assertions should still
// run in a minimal local checkout where a browser binary is unavailable.
const assert = require('assert');
const fs = require('fs');

const html = fs.readFileSync('public/WayPoint/index.html', 'utf8');
const start = html.indexOf('function normalizeLongitude');
const end = html.indexOf('function routeStyleForMode');
if (start < 0 || end < 0) throw new Error('Could not locate map route helpers in index.html');

const routes = new Function(html.slice(start, end) + '\nreturn { greatCircleRoute: greatCircleRoute };')();

function everyRenderedSegmentStaysLocal(route) {
  route.segments.forEach(function (segment) {
    for (let i = 1; i < segment.length; i++) {
      assert(
        Math.abs(segment[i][1] - segment[i - 1][1]) <= 180.001,
        'a rendered segment must not cut across the full map at the date line'
      );
    }
  });
}

// Tokyo → Los Angeles crosses the date line. It must render as two local
// segments rather than a misleading line spanning almost the whole world.
const pacific = routes.greatCircleRoute({ lat: 35.6762, lng: 139.6503 }, { lat: 34.0522, lng: -118.2437 });
assert.strictEqual(pacific.segments.length, 2, 'Pacific route should split at the date line');
assert(pacific.points.length > 12, 'long routes should be sampled into a visible arc');
everyRenderedSegmentStaysLocal(pacific);

// A normal Atlantic route remains a continuous great-circle arc.
const atlantic = routes.greatCircleRoute({ lat: 40.7128, lng: -74.006 }, { lat: 51.5072, lng: -0.1276 });
assert.strictEqual(atlantic.segments.length, 1, 'Atlantic route should not be unnecessarily split');
assert(Math.abs(atlantic.points[0].lat - 40.7128) < 0.001, 'origin latitude should be preserved');
assert(Math.abs(atlantic.points[atlantic.points.length - 1].lng + 0.1276) < 0.001, 'destination longitude should be preserved');

assert(html.includes('data-map-range-handle="start"'), 'map should expose a draggable start handle');
assert(html.includes('data-map-range-handle="end"'), 'map should expose a draggable end handle');
assert(html.includes('data-action="map-fit-selection"'), 'map should expose a fit-selection action');

console.log('map range and route-arc regression checks passed');
