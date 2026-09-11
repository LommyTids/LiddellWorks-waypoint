/* ---------- 19b. Map tab ---------------------------------------------------
   Plots saved locations on one interactive map, using Leaflet (vendored
   under vendor/leaflet/) and OpenStreetMap tiles. Coordinates are
   selected in the shared location picker and stored with each entry; the
   map doesn't silently geocode free text in the browser.

   The tricky part: this app normally redraws #app from scratch (see
   render()) on every change, but a map needs to be built once with
   L.map(...) and updated in place, not rebuilt constantly (it would
   flicker and lose zoom/pan). So this section keeps its own state
   (`mapState` below) outside the normal render() pipeline, mounts
   Leaflet imperatively (initMap()) whenever the Map tab's HTML is drawn,
   and updates it directly (see "toggle-map-layer") for anything that
   doesn't need a full re-render.
   ---------------------------------------------------------------------- */

// One layer group per category, so checkboxes can show/hide each kind of
// pin independently. `color` is used for markers and the checkbox dot.
//
// Destinations keep a muted "anchor point" shade, while activities/
// transport/accommodation get bright, distinct hues so they pop against
// the OpenStreetMap tiles.
var MAP_LAYER_META = [
  { key: 'destinations', label: 'Destinations', color: cssToken('--wp-map-destination'), soft: 'var(--wp-map-destination-subtle)' },
  { key: 'transport', label: 'Transport', color: cssToken('--wp-map-transport'), soft: 'var(--wp-map-transport-subtle)' },
  { key: 'accommodation', label: 'Accommodation', color: cssToken('--wp-map-accommodation'), soft: 'var(--wp-map-accommodation-subtle)' },
  { key: 'activities', label: 'Activities', color: cssToken('--wp-map-activity'), soft: 'var(--wp-map-activity-subtle)' }
];

// Everything the Map tab needs to remember between renders that isn't
// part of the saved trip data -- which Leaflet map/layers are mounted,
// which are checked, and a `generation` counter (see initMap()). None of
// this is saved or shared, resets to these defaults on a fresh load.
var mapState = {
  instance: null,
  layers: null,
  generation: 0,
  tripId: '',
  rangeStart: '',
  rangeEnd: '',
  visibility: { destinations: true, activities: true, transport: true, accommodation: true },
  boundaries: {},
  boundaryRequests: {},
  routeArrows: [],
  visibleBounds: null,
  refreshFrame: null,
  currentTrip: null,
  worldCenter: 0,
  worldBoundsKey: '',
  minimumZoom: 0
};

// Both the Timeline and the Map open on today while a trip is under way, and
// at its start otherwise -- the day you most likely want is the one you are on.
function tripFocusDay(days, today) {
  if (!days || !days.length) return '';
  // `today` is injectable for the same reason timelineDayExpanded() takes it:
  // a date-dependent default is only testable if the date can be supplied.
  var day = today || timelineLocalTodayStr();
  return days.indexOf(day) !== -1 ? day : days[0];
}

function ensureMapRange(trip) {
  var days = tripDayList(trip);
  if (!days.length) {
    mapState.tripId = trip.tripId;
    mapState.rangeStart = '';
    mapState.rangeEnd = '';
    return days;
  }
  // A range belongs to one rendered trip only. A newly opened trip, or a
  // trip whose dates changed, sensibly starts as the whole trip rather than
  // inheriting a stale date from whatever was viewed before it.
  if (mapState.tripId !== trip.tripId || days.indexOf(mapState.rangeStart) === -1 || days.indexOf(mapState.rangeEnd) === -1) {
    mapState.tripId = trip.tripId;
    mapState.rangeStart = tripFocusDay(days);
    mapState.rangeEnd = days[days.length - 1];
  }
  return days;
}

function mapRangeVisible(start, end) {
  if (!mapState.rangeStart || !mapState.rangeEnd) return true;
  // Inclusive overlap: a multi-day stay, destination or overnight route is
  // retained whenever any part of it falls inside the selected range.
  return (!start || start <= mapState.rangeEnd) && (!end || end >= mapState.rangeStart);
}

function savedCoords(item, latKey, lngKey) {
  return (typeof item[latKey] === 'number' && typeof item[lngKey] === 'number') ? { lat: item[latKey], lng: item[lngKey] } : null;
}

// The Map tab is deliberately a view of saved locations only. Text-only
// records remain visible in their own tabs, but are not guessed at by an
// external service when a person opens the map.
function mapPointsForTrip(trip) {
  var points = [];
  (trip.destinations || []).forEach(function (d) {
    if (!mapRangeVisible(d.arriveDate, d.departDate)) return;
    points.push({ category: 'destinations', section: 'destination', item: d, coords: savedCoords(d, 'lat', 'lng'), label: d.name, sub: d.country, boundaryRef: d.boundaryRef || '', boundaryQuality: d.boundaryQuality || '', stale: d.locationStale });
  });
  (trip.activities || []).forEach(function (a) {
    if (!mapRangeVisible(activityStartDate(a), activityEndDate(a))) return;
    var addressCoords = savedCoords(a, 'addressLat', 'addressLng');
    // The venue is a note, not a geocoded place. Activity pins are always
    // driven by their separately selected or manually pinned street address.
    if (addressCoords) points.push({ category: 'activities', section: 'activity', item: a, coords: addressCoords, label: a.title, sub: (a.location ? 'Venue: ' + a.location + ' · ' : '') + 'Address: ' + (a.address || 'Saved address'), stale: a.addressLocationStale });
  });
  (trip.accommodation || []).forEach(function (ac) {
    // Checkout day is included: a place is still useful map context until
    // the traveller actually leaves it.
    if (!mapRangeVisible(dateOnly(ac.checkIn), dateOnly(ac.checkOut))) return;
    points.push({ category: 'accommodation', section: 'accommodation', item: ac, coords: savedCoords(ac, 'lat', 'lng'), label: ac.name, sub: ac.address, stale: ac.locationStale });
  });
  return points;
}

// Transport legs become lines rather than pins — one per leg with both a
// from- and a to-location filled in. There's no fallback for a missing
// location here (unlike activities above) since a transport leg with only
// one end known can't usefully be drawn as a line.
//
// fromCoords/toCoords carry through whatever real coordinate was
// resolved and saved at the time this leg was created/edited — null when
// an endpoint still needs a selected location or manual pin.
function mapLegsForTrip(trip) {
  return (trip.transport || []).filter(function (t) {
    return t.fromLocation && t.toLocation && mapRangeVisible(dateOnly(t.departDateTime), dateOnly(t.arriveDateTime));
  }).map(function (t) {
    return {
      label: transportLabel(t), mode: t.mode,
      section: 'transport', item: t,
      fromCoords: savedCoords(t, 'fromLat', 'fromLng'), toCoords: savedCoords(t, 'toLat', 'toLng'),
      fromStale: t.fromLocationStale, toStale: t.toLocationStale,
      from: t.fromLocation, to: t.toLocation,
      departDateTime: t.departDateTime, arriveDateTime: t.arriveDateTime
    };
  });
}

function mapRangeDateLabel(day) {
  if (!day) return '';
  var parts = day.split('-').map(Number);
  return parts[2] + ' ' + MONTHS[parts[1] - 1];
}

function mapRangeDayCount(trip) {
  var days = ensureMapRange(trip);
  var start = days.indexOf(mapState.rangeStart), end = days.indexOf(mapState.rangeEnd);
  return start >= 0 && end >= start ? end - start + 1 : days.length;
}

function mapViewIsDefault(trip) {
  var days = ensureMapRange(trip);
  // "Default" is the range the Map opens on, which is today onward during a
  // trip -- so Reset returns you there rather than to the whole trip.
  var fullRange = !days.length || (mapState.rangeStart === tripFocusDay(days) && mapState.rangeEnd === days[days.length - 1]);
  var allLayers = MAP_LAYER_META.every(function (meta) { return mapState.visibility[meta.key]; });
  return fullRange && allLayers;
}

function mapVisibleCounts(trip) {
  var counts = { destinations: 0, activities: 0, transport: 0, accommodation: 0 };
  mapPointsForTrip(trip).forEach(function (point) { counts[point.category]++; });
  counts.transport = mapLegsForTrip(trip).length;
  return counts;
}

function mapLayerIconName(layer) {
  if (layer === 'destinations') return 'destination';
  if (layer === 'activities') return 'activity';
  if (layer === 'accommodation') return 'stay';
  return 'flight';
}

function mapRangeControlsHtml(trip) {
  var days = ensureMapRange(trip);
  if (!days.length) return '';
  var max = days.length - 1;
  var startIndex = days.indexOf(mapState.rangeStart);
  var endIndex = days.indexOf(mapState.rangeEnd);
  var startPercent = max ? (startIndex / max * 100) : 0;
  var endPercent = max ? (endIndex / max * 100) : 100;
  return '<div class="map-range-controls">' +
    '<div class="map-range-summary">' +
      '<strong data-map-range-summary>' + esc(mapRangeDateLabel(mapState.rangeStart)) + ' — ' + esc(mapRangeDateLabel(mapState.rangeEnd)) + '</strong>' +
      '<span class="map-range-summary-actions"><span class="map-range-days" data-map-range-days>' + mapRangeDayCount(trip) + ' day' + (mapRangeDayCount(trip) === 1 ? '' : 's') + '</span>' +
      '<button type="button" class="btn btn-ghost map-reset" data-action="reset-map-view"' + (mapViewIsDefault(trip) ? ' disabled' : '') + '>' + icon('reset') + ' Reset</button></span>' +
    '</div>' +
    '<div class="map-range-slider' + (endPercent - startPercent < 20 ? ' labels-overlap' : '') + '" data-map-range-slider style="--range-start:' + startPercent + '%;--range-end:' + endPercent + '%" aria-label="Map date range">' +
      '<div class="map-range-rail"></div><div class="map-range-fill"></div>' +
      '<input class="map-range-input" data-map-range-handle="start" type="range" min="0" max="' + max + '" step="1" value="' + startIndex + '" aria-label="Map range start: ' + esc(formatDateHeading(mapState.rangeStart)) + '">' +
      '<input class="map-range-input" data-map-range-handle="end" type="range" min="0" max="' + max + '" step="1" value="' + endIndex + '" aria-label="Map range end: ' + esc(formatDateHeading(mapState.rangeEnd)) + '">' +
      '<span class="map-range-handle-label is-start" data-map-range-start-label>' + esc(mapRangeDateLabel(mapState.rangeStart)) + '</span>' +
      '<span class="map-range-handle-label is-end" data-map-range-end-label>' + esc(mapRangeDateLabel(mapState.rangeEnd)) + '</span>' +
    '</div>' +
  '</div>';
}

function mapFiltersHtml(trip) {
  var counts = mapVisibleCounts(trip);
  return '<div class="map-filter-bar" role="group" aria-label="Map layers">' + MAP_LAYER_META.map(function (meta) {
    var active = !!mapState.visibility[meta.key];
    return '<button type="button" class="map-filter-chip' + (active ? ' is-active' : '') + '" data-action="toggle-map-layer" data-layer="' + meta.key + '" aria-pressed="' + active + '" style="--map-color:' + meta.color + ';--map-soft:' + meta.soft + '">' +
      icon(mapLayerIconName(meta.key)) + '<span>' + esc(meta.label) + '</span><span class="map-filter-count">' + counts[meta.key] + '</span></button>';
  }).join('') + '</div>';
}

function mapUnmappedRecords(trip) {
  var records = [];
  (trip.destinations || []).forEach(function (item) {
    if (!mapRangeVisible(item.arriveDate, item.departDate)) return;
    if (!savedCoords(item, 'lat', 'lng') && !item.boundaryRef) records.push({ section: 'destination', item: item, title: item.name || 'Destination', reason: 'No map location saved' });
    else if (item.locationStale) records.push({ section: 'destination', item: item, title: item.name || 'Destination', reason: 'Saved location needs review' });
  });
  (trip.activities || []).forEach(function (item) {
    if (!mapRangeVisible(activityStartDate(item), activityEndDate(item))) return;
    if (!savedCoords(item, 'addressLat', 'addressLng')) records.push({ section: 'activity', item: item, title: item.title || 'Activity', reason: 'No address pin saved' });
    else if (item.addressLocationStale) records.push({ section: 'activity', item: item, title: item.title || 'Activity', reason: 'Saved address needs review' });
  });
  (trip.accommodation || []).forEach(function (item) {
    if (!mapRangeVisible(dateOnly(item.checkIn), dateOnly(item.checkOut))) return;
    if (!savedCoords(item, 'lat', 'lng')) records.push({ section: 'accommodation', item: item, title: item.name || 'Accommodation', reason: 'No address pin saved' });
    else if (item.locationStale) records.push({ section: 'accommodation', item: item, title: item.name || 'Accommodation', reason: 'Saved location needs review' });
  });
  (trip.transport || []).forEach(function (item) {
    if (!mapRangeVisible(dateOnly(item.departDateTime), dateOnly(item.arriveDateTime))) return;
    var missingFrom = !savedCoords(item, 'fromLat', 'fromLng');
    var missingTo = !savedCoords(item, 'toLat', 'toLng');
    if (missingFrom || missingTo) records.push({ section: 'transport', item: item, title: transportLabel(item), reason: missingFrom && missingTo ? 'Both route endpoints need locations' : (missingFrom ? 'Departure location needs a pin' : 'Arrival location needs a pin') });
    else if (item.fromLocationStale || item.toLocationStale) records.push({ section: 'transport', item: item, title: transportLabel(item), reason: 'One or more route locations need review' });
  });
  return records;
}

function mapUnmappedHtml(trip) {
  var records = mapUnmappedRecords(trip);
  if (!records.length) return '';
  var rows = records.map(function (record) {
    var itemId = record.item[ENTITY_ID_FIELDS[record.section]];
    var canRepair = canEditItem(trip, record.item);
    return '<div class="map-unmapped-row"><span class="item-icon k-' + esc(record.section) + '">' + icon(mapLayerIconName(record.section === 'destination' ? 'destinations' : record.section === 'accommodation' ? 'accommodation' : record.section === 'activity' ? 'activities' : 'transport')) + '</span>' +
      '<span class="map-unmapped-copy"><span class="map-unmapped-title">' + esc(record.title) + '</span><span class="map-unmapped-reason">' + esc(record.reason) + '</span></span>' +
      (canRepair ? '<button type="button" class="btn btn-ghost" data-action="review-map-location" data-section="' + esc(record.section) + '" data-id="' + esc(itemId) + '">Find location / Set pin</button>' : '<span class="status-badge is-readonly">' + icon('readonly') + ' Ask an editor</span>') + '</div>';
  }).join('');
  // Keep the warning visible without letting a potentially long repair list
  // dominate the map. Native <details> supplies keyboard and screen-reader
  // disclosure behaviour, and omitting `open` makes it collapsed each time
  // the Map tab is mounted, as requested.
  return '<aside class="map-unmapped" aria-labelledby="map-unmapped-title"><details><summary class="map-unmapped-head">' + icon('warning') + '<div><h3 id="map-unmapped-title">Locations needing attention</h3><p>These records stay in the itinerary but cannot be shown reliably on the map.</p></div><span class="map-unmapped-summary">' + records.length + ' record' + (records.length === 1 ? '' : 's') + icon('collapse') + '</span></summary><div class="map-unmapped-list">' + rows + '</div></details></aside>';
}

function renderMapTab(trip) {
  ensureMapRange(trip);
  var points = mapPointsForTrip(trip);
  var legs = mapLegsForTrip(trip);

  if (!points.length && !legs.length && !(trip.destinations || []).length && !(trip.activities || []).length && !(trip.transport || []).length && !(trip.accommodation || []).length) {
    return '<div class="tab-panel-head"><h2>Map</h2></div>' + emptyStateHtml('empty', 'map', 'Nothing to show yet', 'Add a destination, activity, transport leg or place of accommodation, then use Find location or Set pin to place it on the map.');
  }

  return (
    '<div class="map-workspace">' +
      '<div class="map-toolbar">' +
        '<div class="map-actions">' + mapFiltersHtml(trip) +
          '<button type="button" class="btn btn-ghost" data-action="map-fit-selection">Fit selection</button>' +
          '<button type="button" class="btn btn-icon" data-action="map-toggle-fullscreen" aria-label="Expand map" title="Expand map">' + icon('expand') + '</button>' +
        '</div>' +
        mapRangeControlsHtml(trip) +
      '</div>' +
      '<div id="map-shell" class="map-shell">' +
        '<div id="map-canvas" class="map-canvas"></div>' +
        '<div id="map-status" class="map-status">Loading map…</div>' +
      '</div>' + mapUnmappedHtml(trip) +
    '</div>'
  );
}

function mapLayerMeta(key) {
  return MAP_LAYER_META.filter(function (meta) { return meta.key === key; })[0];
}

function normalizeLongitude(lng) {
  while (lng > 180) lng -= 360;
  while (lng < -180) lng += 360;
  return lng;
}

// Leaflet accepts longitudes outside the conventional -180°…+180° range.
// Keeping every vector in one deliberately chosen 360° window lets a
// Pacific trip use 139°…242° while still showing only one visible Earth.
function longitudeNear(lng, referenceLongitude) {
  return lng + 360 * Math.round((referenceLongitude - lng) / 360);
}

function mapWorldCenterForCoordinates(coords) {
  if (!coords.length) return 0;
  var anchor = coords[0].lng;
  var minLongitude = Infinity, maxLongitude = -Infinity;
  coords.forEach(function (coord) {
    var longitude = longitudeNear(coord.lng, anchor);
    minLongitude = Math.min(minLongitude, longitude);
    maxLongitude = Math.max(maxLongitude, longitude);
  });
  return (minLongitude + maxLongitude) / 2;
}

function mapWorldWindow(centerLongitude) {
  return { west: centerLongitude - 180, east: centerLongitude + 180 };
}

// At this zoom a 256px Leaflet world is at least as wide as the map canvas,
// so the furthest-out view cannot reveal a second horizontal copy.
function mapMinimumWorldZoom(canvasWidth) {
  var safeWidth = Math.max(256, Number(canvasWidth) || 256);
  return Math.log(safeWidth / 256) / Math.LN2;
}

function toRadians(value) { return value * Math.PI / 180; }
function toDegrees(value) { return value * 180 / Math.PI; }

// A transport leg is a schematic connection, not a road or rail route.
// For long-haul trips, though, drawing the shortest path over the globe is
// both more honest and much easier to read than a flat diagonal across a
// Mercator map. The route is sampled along a great circle and its longitude
// stays *unwrapped*: Tokyo → Los Angeles, for example, becomes 139° → 242°
// rather than 139° → -118°. That lets Leaflet draw one continuous vector
// across the Pacific instead of two pieces that appear broken at map edges.
function greatCircleRoute(from, to) {
  var lat1 = toRadians(from.lat), lng1 = toRadians(from.lng);
  var lat2 = toRadians(to.lat), lng2 = toRadians(to.lng);
  var cosAngle = Math.sin(lat1) * Math.sin(lat2) + Math.cos(lat1) * Math.cos(lat2) * Math.cos(lng2 - lng1);
  var angle = Math.acos(Math.max(-1, Math.min(1, cosAngle)));
  var segmentCount = Math.max(12, Math.min(96, Math.ceil(toDegrees(angle) / 2)));
  var points = [];

  for (var i = 0; i <= segmentCount; i++) {
    var fraction = i / segmentCount;
    var weightA, weightB;
    if (angle < 0.000001 || Math.abs(Math.sin(angle)) < 0.000001) {
      weightA = 1 - fraction; weightB = fraction;
    } else {
      var sinAngle = Math.sin(angle);
      weightA = Math.sin((1 - fraction) * angle) / sinAngle;
      weightB = Math.sin(fraction * angle) / sinAngle;
    }
    var x = weightA * Math.cos(lat1) * Math.cos(lng1) + weightB * Math.cos(lat2) * Math.cos(lng2);
    var y = weightA * Math.cos(lat1) * Math.sin(lng1) + weightB * Math.cos(lat2) * Math.sin(lng2);
    var z = weightA * Math.sin(lat1) + weightB * Math.sin(lat2);
    var longitude = normalizeLongitude(toDegrees(Math.atan2(y, x)));
    if (points.length) {
      var previousLongitude = points[points.length - 1].lng;
      while (longitude - previousLongitude > 180) longitude -= 360;
      while (longitude - previousLongitude < -180) longitude += 360;
    }
    points.push({ lat: toDegrees(Math.atan2(z, Math.sqrt(x * x + y * y))), lng: longitude });
  }

  var arrowIndex = Math.max(1, Math.min(points.length - 1, Math.round((points.length - 1) * 0.58)));
  return { points: points, arrowBefore: points[arrowIndex - 1], arrowAfter: points[arrowIndex] };
}

// Reposition the entire unwrapped route into the map's selected world window.
// Keeping one shared offset preserves both the short route and arrow direction.
function routeForMapView(route, centerLongitude) {
  var first = route.points[0].lng;
  var last = route.points[route.points.length - 1].lng;
  var routeMidpoint = (first + last) / 2;
  var offset = 360 * Math.round((centerLongitude - routeMidpoint) / 360);
  function copyPoint(point) { return { lat: point.lat, lng: point.lng + offset }; }
  return {
    points: route.points.map(copyPoint),
    arrowBefore: copyPoint(route.arrowBefore),
    arrowAfter: copyPoint(route.arrowAfter)
  };
}

function prepareMapGeometry(points, legs) {
  var worldCoordinates = [];
  var preparedLegs = [];
  var missingLegs = 0;

  // Routes are added first so a date-line crossing establishes the useful
  // unwrapped longitude sequence before ordinary markers are folded near it.
  legs.forEach(function (leg) {
    if (!leg.fromCoords || !leg.toCoords) { missingLegs++; return; }
    var route = greatCircleRoute(leg.fromCoords, leg.toCoords);
    preparedLegs.push({ leg: leg, route: route });
    route.points.forEach(function (point) { worldCoordinates.push(point); });
  });
  points.forEach(function (point) {
    if (point.coords) worldCoordinates.push(point.coords);
  });

  return {
    preparedLegs: preparedLegs,
    missingLegs: missingLegs,
    worldCenter: mapWorldCenterForCoordinates(worldCoordinates)
  };
}

function applyMapWorldWindow(map, centerLongitude) {
  var world = mapWorldWindow(centerLongitude);
  var boundsKey = world.west.toFixed(5) + '|' + world.east.toFixed(5);
  mapState.worldCenter = centerLongitude;
  if (mapState.worldBoundsKey !== boundsKey) {
    mapState.worldBoundsKey = boundsKey;
    map.setMaxBounds([[-85.05112878, world.west], [85.05112878, world.east]]);
  }
  return world;
}

function routeStyleForMode(mode) {
  var normalized = String(mode || '').toLowerCase();
  return {
    color: mapLayerMeta('transport').color,
    weight: normalized === 'flight' ? 4.5 : 4,
    opacity: normalized === 'car' || normalized === 'bus' ? 0.76 : 0.9,
    dashArray: normalized === 'flight' ? '10 8' : (normalized === 'ferry' ? '3 8' : null)
  };
}

function routePopupHtml(leg, trip) {
  var model = transportItemRowModel(trip, leg.item, 'map');
  model.supporting = 'Route shown as a direct travel arc.';
  return itemRowHtml(trip, model);
}

function mapMarkerIcon(category, stale, count) {
  var meta = mapLayerMeta(category);
  return L.divIcon({
    className: 'map-marker-icon',
    html: '<div class="map-marker' + (stale ? ' is-stale' : '') + '" style="--map-color:' + meta.color + '">' + icon(mapLayerIconName(category)) + (count > 1 ? '<span class="map-marker-count">' + count + '</span>' : '') + '</div>',
    iconSize: [30, 30], iconAnchor: [15, 30], popupAnchor: [0, -28]
  });
}

function pointPopupHtml(points, trip) {
  return '<div class="map-marker-popup">' + points.map(function (point) {
    var model = recordItemRowModel(trip, point.section, point.item, 'map');
    if (point.stale) model.status = { text: 'Location needs review' };
    return itemRowHtml(trip, model);
  }).join('') + '</div>';
}

function addRouteArrow(map, layer, before, after, color) {
  var icon = L.divIcon({
    className: 'transport-arrow-icon',
    html: '<div class="transport-arrow" style="border-left-color:' + color + '"></div>',
    iconSize: [16, 16], iconAnchor: [8, 8]
  });
  var marker = L.marker([after.lat, after.lng], { icon: icon, interactive: false, keyboard: false }).addTo(layer);
  mapState.routeArrows.push({ marker: marker, before: before, after: after });
}

function updateMapRouteArrows() {
  var map = mapState.instance;
  if (!map) return;
  mapState.routeArrows.forEach(function (routeArrow) {
    var fromPoint = map.latLngToLayerPoint([routeArrow.before.lat, routeArrow.before.lng]);
    var toPoint = map.latLngToLayerPoint([routeArrow.after.lat, routeArrow.after.lng]);
    var angle = Math.atan2(toPoint.y - fromPoint.y, toPoint.x - fromPoint.x) * 180 / Math.PI;
    var markerEl = routeArrow.marker.getElement();
    var arrowEl = markerEl && markerEl.querySelector('.transport-arrow');
    if (arrowEl) arrowEl.style.transform = 'rotate(' + angle + 'deg)';
  });
}

function updateMapStatus(placed, missing) {
  var statusEl = document.getElementById('map-status');
  if (!statusEl) return;
  if (missing > 0) {
    statusEl.textContent = placed + ' mapped item' + (placed === 1 ? '' : 's') + ' in range · ' + missing + ' ' + (missing === 1 ? 'entry needs' : 'entries need') + ' a location.';
    statusEl.classList.add('has-warning');
  } else if (placed) {
    statusEl.textContent = placed + ' mapped item' + (placed === 1 ? '' : 's') + ' in range.';
    statusEl.classList.remove('has-warning');
  } else {
    statusEl.textContent = 'No mapped items in this date range yet.';
    statusEl.classList.remove('has-warning');
  }
}

function refreshMapLayers(trip, fitToSelection) {
  if (!mapState.instance || !mapState.layers) return;
  var map = mapState.instance;
  mapState.currentTrip = trip;
  var layers = mapState.layers;
  Object.keys(layers).forEach(function (key) { layers[key].clearLayers(); });
  mapState.routeArrows = [];

  var points = mapPointsForTrip(trip);
  var legs = mapLegsForTrip(trip);
  var geometry = prepareMapGeometry(points, legs);
  var worldCenter = geometry.worldCenter;
  applyMapWorldWindow(map, worldCenter);
  var pointGroups = {};
  var bounds = L.latLngBounds([]);
  var placed = 0, missing = geometry.missingLegs;

  function trackPoint(lat, lng) {
    bounds.extend([lat, lng]);
  }

  function addDestinationArea(point) {
    var boundary = mapState.boundaries[point.boundaryRef];
    if (!boundary || !boundary.geometry) return false;
    var meta = mapLayerMeta('destinations');
    var area = L.geoJSON(boundary.geometry, {
      style: { color: meta.color, weight: 2, opacity: point.stale ? 0.45 : 0.8, fillColor: meta.color, fillOpacity: point.stale ? 0.08 : 0.18, dashArray: point.stale ? '4 4' : null },
      coordsToLatLng: function (coords) {
        return L.latLng(coords[1], longitudeNear(coords[0], worldCenter), coords[2]);
      }
    }).bindPopup(pointPopupHtml([point], trip), mapPopupOptions());
    area.addTo(layers.destinations);
    if (area.getBounds && area.getBounds().isValid()) {
      var areaBounds = area.getBounds();
      bounds.extend(areaBounds);
    }
    return true;
  }

  points.forEach(function (point) {
    var areaDrawn = point.category === 'destinations' && addDestinationArea(point);
    if (!point.coords) {
      if (areaDrawn) placed++;
      else missing++;
      return;
    }
    var coordinateKey = point.category + '|' + point.coords.lat.toFixed(5) + '|' + point.coords.lng.toFixed(5);
    if (!pointGroups[coordinateKey]) pointGroups[coordinateKey] = [];
    pointGroups[coordinateKey].push(point);
  });

  Object.keys(pointGroups).forEach(function (key) {
    var groupedPoints = pointGroups[key];
    var first = groupedPoints[0];
    var needsReview = groupedPoints.some(function (point) { return !!point.stale; });
    var renderedLongitude = longitudeNear(first.coords.lng, worldCenter);
    L.marker([first.coords.lat, renderedLongitude], { icon: mapMarkerIcon(first.category, needsReview, groupedPoints.length) })
      .bindPopup(pointPopupHtml(groupedPoints, trip), mapPopupOptions()).addTo(layers[first.category]);
    trackPoint(first.coords.lat, renderedLongitude);
    placed += groupedPoints.length;
  });

  geometry.preparedLegs.forEach(function (prepared) {
    var style = routeStyleForMode(prepared.leg.mode);
    var renderedRoute = routeForMapView(prepared.route, worldCenter);
    L.polyline(renderedRoute.points.map(function (point) { return [point.lat, point.lng]; }), style)
      .bindPopup(routePopupHtml(prepared.leg, trip), mapPopupOptions()).addTo(layers.transport);
    addRouteArrow(map, layers.transport, renderedRoute.arrowBefore, renderedRoute.arrowAfter, style.color);
    renderedRoute.points.forEach(function (point) { trackPoint(point.lat, point.lng); });
    placed++;
  });

  mapState.visibleBounds = bounds.isValid() ? bounds : null;
  updateMapStatus(placed, missing);
  requestAnimationFrame(updateMapRouteArrows);
  if (fitToSelection && mapState.visibleBounds) map.fitBounds(mapState.visibleBounds, { padding: [34, 34], maxZoom: 12 });
}

function showMapLoadError(error) {
  var statusEl = document.getElementById('map-status');
  if (statusEl) {
    statusEl.textContent = 'Map could not load. Refresh the page or try another date range.';
    statusEl.classList.add('has-warning');
  }
  console.error('Map rendering failed:', error);
}

function safelyRefreshMapLayers(trip, fitToSelection) {
  try {
    refreshMapLayers(trip, fitToSelection);
    return true;
  } catch (error) {
    showMapLoadError(error);
    return false;
  }
}

function loadMapBoundaries(trip, generation) {
  var refs = mapPointsForTrip(trip)
    .filter(function (point) { return point.category === 'destinations' && point.boundaryRef && !mapState.boundaries[point.boundaryRef] && !mapState.boundaryRequests[point.boundaryRef]; })
    .map(function (point) { return point.boundaryRef; })
    .filter(function (ref, index, all) { return all.indexOf(ref) === index; })
    .slice(0, 20);
  if (!refs.length) return Promise.resolve();
  refs.forEach(function (ref) { mapState.boundaryRequests[ref] = true; });
  return fetch('/WayPoint/api/location-boundaries', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refs: refs })
  }).then(function (response) {
    return response.ok ? response.json() : null;
  }).then(function (data) {
    if (!data || mapState.generation !== generation) return;
    Object.assign(mapState.boundaries, data.boundaries || {});
    safelyRefreshMapLayers(trip, false);
  }).catch(function () {
    // A boundary is a visual enhancement. A transient failure must never stop
    // pins or routes rendering, and retries remain possible on a later range.
  }).finally(function () {
    refs.forEach(function (ref) { delete mapState.boundaryRequests[ref]; });
  });
}

function fitMapToSelection() {
  if (mapState.instance && mapState.visibleBounds) mapState.instance.fitBounds(mapState.visibleBounds, { padding: [34, 34], maxZoom: 12 });
}

function updateMapRangeUi(trip) {
  var days = ensureMapRange(trip);
  if (!days.length) return;
  var startIndex = days.indexOf(mapState.rangeStart), endIndex = days.indexOf(mapState.rangeEnd), max = days.length - 1;
  var startPercent = max ? startIndex / max * 100 : 0;
  var endPercent = max ? endIndex / max * 100 : 100;
  var slider = document.querySelector('[data-map-range-slider]');
  if (slider) {
    slider.style.setProperty('--range-start', startPercent + '%');
    slider.style.setProperty('--range-end', endPercent + '%');
    slider.classList.toggle('labels-overlap', endPercent - startPercent < 20);
    var startInput = slider.querySelector('[data-map-range-handle="start"]');
    var endInput = slider.querySelector('[data-map-range-handle="end"]');
    if (startInput) { startInput.value = startIndex; startInput.setAttribute('aria-label', 'Map range start: ' + formatDateHeading(mapState.rangeStart)); }
    if (endInput) { endInput.value = endIndex; endInput.setAttribute('aria-label', 'Map range end: ' + formatDateHeading(mapState.rangeEnd)); }
  }
  var summary = document.querySelector('[data-map-range-summary]');
  var dayCount = mapRangeDayCount(trip);
  var count = document.querySelector('[data-map-range-days]');
  var startLabel = document.querySelector('[data-map-range-start-label]');
  var endLabel = document.querySelector('[data-map-range-end-label]');
  if (summary) summary.textContent = mapRangeDateLabel(mapState.rangeStart) + ' — ' + mapRangeDateLabel(mapState.rangeEnd);
  if (count) count.textContent = dayCount + ' day' + (dayCount === 1 ? '' : 's');
  if (startLabel) startLabel.textContent = mapRangeDateLabel(mapState.rangeStart);
  if (endLabel) endLabel.textContent = mapRangeDateLabel(mapState.rangeEnd);
  var layerCounts = mapVisibleCounts(trip);
  MAP_LAYER_META.forEach(function (meta) {
    var chip = document.querySelector('[data-action="toggle-map-layer"][data-layer="' + meta.key + '"]');
    var chipCount = chip && chip.querySelector('.map-filter-count');
    if (chipCount) chipCount.textContent = layerCounts[meta.key];
  });
  var reset = document.querySelector('[data-action="reset-map-view"]');
  if (reset) reset.disabled = mapViewIsDefault(trip);
}

function resetMapView(trip) {
  var days = ensureMapRange(trip);
  if (days.length) {
    mapState.rangeStart = days[0];
    mapState.rangeEnd = days[days.length - 1];
  }
  MAP_LAYER_META.forEach(function (meta) {
    mapState.visibility[meta.key] = true;
    if (mapState.instance && mapState.layers && mapState.layers[meta.key] && !mapState.instance.hasLayer(mapState.layers[meta.key])) {
      mapState.layers[meta.key].addTo(mapState.instance);
    }
    var chip = document.querySelector('[data-action="toggle-map-layer"][data-layer="' + meta.key + '"]');
    if (chip) { chip.classList.add('is-active'); chip.setAttribute('aria-pressed', 'true'); }
  });
  updateMapRangeUi(trip);
  safelyRefreshMapLayers(trip, true);
  loadMapBoundaries(trip, mapState.generation);
  announceStatus('Map restored to the full trip and all layers');
}

function scheduleMapRefresh(trip) {
  if (mapState.refreshFrame) cancelAnimationFrame(mapState.refreshFrame);
  mapState.refreshFrame = requestAnimationFrame(function () {
    mapState.refreshFrame = null;
    safelyRefreshMapLayers(trip, false);
    loadMapBoundaries(trip, mapState.generation);
  });
}

function updateMapMinimumWorldZoom() {
  var map = mapState.instance;
  var canvas = document.getElementById('map-canvas');
  if (!map || !canvas) return;
  var width = canvas.clientWidth || canvas.getBoundingClientRect().width;
  var minimumZoom = mapMinimumWorldZoom(width);
  mapState.minimumZoom = minimumZoom;
  map.setMinZoom(minimumZoom);
  if (map.getZoom() < minimumZoom) map.setZoom(minimumZoom);
}

// Builds the Leaflet map only when the Map tab itself is mounted. Changing
// filters or either date handle below deliberately updates layers in place.
async function initMap(trip) {
  var canvas = document.getElementById('map-canvas');
  if (!canvas) return;
  try {
    ensureMapRange(trip);
    mapState.generation++;
    var myGeneration = mapState.generation;
    if (mapState.instance) { mapState.instance.remove(); mapState.instance = null; mapState.layers = null; }

    var initialGeometry = prepareMapGeometry(mapPointsForTrip(trip), mapLegsForTrip(trip));
    var initialWorldCenter = initialGeometry.worldCenter;
    var initialWorld = mapWorldWindow(initialWorldCenter);
    var canvasWidth = canvas.clientWidth || canvas.getBoundingClientRect().width;
    var minimumZoom = mapMinimumWorldZoom(canvasWidth);
    var map = L.map('map-canvas', {
      scrollWheelZoom: true,
      worldCopyJump: false,
      minZoom: minimumZoom,
      zoomSnap: 0,
      zoomDelta: 0.5,
      maxBounds: [[-85.05112878, initialWorld.west], [85.05112878, initialWorld.east]],
      maxBoundsViscosity: 1
    }).setView([20, initialWorldCenter], minimumZoom);
    // Tile addressing may wrap internally so a Pacific-centred window can use
    // longitudes above 180°, but maxBounds plus minZoom expose only one Earth.
    // These tile options are never toggled after startup.
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors'
    }).addTo(map);
    var layers = { destinations: L.layerGroup(), activities: L.layerGroup(), transport: L.layerGroup(), accommodation: L.layerGroup() };
    Object.keys(layers).forEach(function (key) { if (mapState.visibility[key]) layers[key].addTo(map); });
    mapState.instance = map;
    mapState.layers = layers;
    mapState.worldCenter = initialWorldCenter;
    mapState.worldBoundsKey = initialWorld.west.toFixed(5) + '|' + initialWorld.east.toFixed(5);
    mapState.minimumZoom = minimumZoom;
    map.on('zoomend', updateMapRouteArrows);
    map.on('resize', function () {
      updateMapMinimumWorldZoom();
      updateMapRouteArrows();
    });

    if (!safelyRefreshMapLayers(trip, true)) return;
    await loadMapBoundaries(trip, myGeneration);
  } catch (error) {
    showMapLoadError(error);
  }
}

// Leaflet grows a popup to fit its content, so a long note produced a popup
// taller than a phone with nothing to scroll. A bounded height gives it a real
// scroll region (Leaflet adds .leaflet-popup-scrolled), which the CSS then
// makes visible -- the affordance was the missing part, not the scrolling.
function mapPopupOptions() {
  var viewport = (typeof window !== 'undefined' && window.innerHeight) || 800;
  return { maxHeight: Math.max(160, Math.min(280, Math.round(viewport * 0.42))) };
}

