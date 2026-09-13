/* ---- Shared location-picker behaviour -------------------------------- */

var locationPickerResults = {};

function pickerInput(wrapper, name) {
  return wrapper.querySelector('input[name="' + name + '"]');
}

function pickerSet(wrapper, name, value) {
  var input = pickerInput(wrapper, name);
  if (input) input.value = value === undefined || value === null ? '' : value;
}

function pickerSummary(wrapper, label, stale) {
  var summary = wrapper.querySelector('[data-location-summary]');
  if (!summary) return;
  summary.hidden = false;
  summary.classList.toggle('is-stale', !!stale);
  var status = summary.querySelector('.location-selected-status');
  var detail = summary.querySelector('span:last-child');
  if (status) status.textContent = stale ? 'Location may not match' : label;
  if (detail) detail.textContent = stale ? 'Search again to confirm this location' : '';
}

function pickerHint(wrapper, message, isError) {
  var hint = wrapper.querySelector('[data-location-hint]');
  if (!hint) return;
  hint.textContent = message || '';
  hint.style.color = isError ? 'var(--wp-state-danger)' : '';
}

function abortLocationSearch(wrapper) {
  if (wrapper._locationSearchController) {
    wrapper._locationSearchController.abort();
    wrapper._locationSearchController = null;
  }
  // An aborted request no longer owns its finally block. Restore the controls
  // here as well, otherwise typing during a request leaves Find disabled.
  var button = wrapper.querySelector('[data-action="search-location"]');
  if (button) button.disabled = false;
  var region = wrapper.querySelector('[data-location-results]');
  if (region) region.setAttribute('aria-busy', 'false');
}

function clearPickerMap(wrapper) {
  var holder = wrapper.querySelector('[data-location-pin-map]');
  if (!holder) return;
  if (holder._waypointMap) holder._waypointMap.remove();
  holder._waypointMap = null;
  holder.classList.remove('is-open');
}

function invalidatePickerBoundary(wrapper, clearStored) {
  if (wrapper._boundaryController) wrapper._boundaryController.abort();
  wrapper._boundaryController = null;
  wrapper._boundary = null;
  var prefix = wrapper.dataset.boundaryPrefix;
  if (prefix && clearStored) {
    pickerSet(wrapper, prefix + 'Ref', '');
    pickerSet(wrapper, prefix + 'Quality', 'none');
    pickerSet(wrapper, prefix + 'Bbox', '');
  }
}

function disposeLocationPickers(scope) {
  if (!scope) return;
  Array.prototype.forEach.call(scope.querySelectorAll('[data-location-picker]'), function (wrapper) {
    clearLocationInputPreview(wrapper);
    abortLocationSearch(wrapper);
    invalidatePickerBoundary(wrapper, false);
    clearPickerMap(wrapper);
  });
}

function localAirportLocationResults(query) {
  var q = (query || '').trim();
  if (q.length < 2) return [];
  return searchAirports(q).slice(0, 6).map(function (airport) {
    var coords = airportCoordsForCode(airport.code);
    return {
      locationRef: 'local:airport:' + airport.code,
      name: airportDisplay(airport),
      formattedAddress: [airport.city, airport.country].filter(Boolean).join(', '),
      kindLabel: 'Airport', lat: coords && coords.lat, lng: coords && coords.lng,
      granularity: 'airport', bbox: null, boundaryRef: ''
    };
  }).filter(function (candidate) { return Number.isFinite(candidate.lat) && Number.isFinite(candidate.lng); });
}

function renderLocationResults(wrapper, results) {
  var el = wrapper.querySelector('[data-location-results]');
  if (!el) return;
  var prefix = wrapper.dataset.locationPrefix;
  locationPickerResults[prefix] = results;
  if (!results.length) {
    el.innerHTML = '<div class="suggest-empty">No matching places found. You can keep the text or set a pin manually.</div>';
  } else {
    el.innerHTML = results.map(function (result, i) {
      return '<button type="button" class="location-result" data-action="select-location-result" data-location-index="' + i + '">' +
        '<span class="location-result-title"><span>' + esc(result.name) + '</span><span class="location-result-kind">' + esc(result.kindLabel || 'Place') + '</span></span>' +
        '<span class="location-result-address">' + esc(result.formattedAddress || '') + '</span></button>';
    }).join('');
  }
  el.setAttribute('aria-busy', 'false');
  el.hidden = false;
}

async function searchLocationPicker(wrapper) {
  abortLocationSearch(wrapper);
  var query = wrapper.querySelector('[data-location-query]');
  if (!query) return;
  var text = query.value.trim();
  if (text.length < 2) { pickerHint(wrapper, 'Enter at least two characters to search.', true); return; }
  var context = wrapper.dataset.locationContext || 'transport';
  var kind = wrapper.dataset.locationKind || 'point';
  var local = context === 'airport' ? localAirportLocationResults(text) : [];
  if (local.length) { renderLocationResults(wrapper, local); pickerHint(wrapper, 'Airport results are from Waypoint’s local airport data.'); return; }
  var controller = new AbortController();
  wrapper._locationSearchController = controller;
  var resultsRegion = wrapper.querySelector('[data-location-results]');
  if (resultsRegion) resultsRegion.setAttribute('aria-busy', 'true');
  var searchButton = wrapper.querySelector('[data-action="search-location"]');
  if (searchButton) searchButton.disabled = true;
  var params = new URLSearchParams({ q: text, context: context, kind: kind });
  var form = wrapper.closest('form');
  var destinationId = form && form.querySelector('[name="destinationId"]');
  var trip = currentTrip();
  if (destinationId && destinationId.value && trip) {
    var destination = byId(trip.destinations, destinationId.value, 'destinationId');
    if (destination && Number.isFinite(destination.lat) && Number.isFinite(destination.lng)) {
      params.set('lat', destination.lat); params.set('lng', destination.lng);
    }
  }
  var countryKey = wrapper.dataset.locationCountryKey;
  var countryInput = countryKey && form && form.querySelector('[name="' + countryKey + '"]');
  if (countryInput && /^[A-Za-z]{2}$/.test(countryInput.value.trim())) params.set('country', countryInput.value.trim());
  pickerHint(wrapper, 'Searching…');
  try {
    var response = await fetch('/WayPoint/api/location-search?' + params.toString(), { signal: controller.signal });
    var data = await response.json();
    if (wrapper._locationSearchController !== controller) return;
    if (!response.ok) throw new Error(data.error || 'Location search failed.');
    renderLocationResults(wrapper, data.results || []);
    pickerHint(wrapper, data.attribution ? data.attribution.label : '');
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    if (wrapper._locationSearchController !== controller) return;
    renderLocationResults(wrapper, []);
    pickerHint(wrapper, err.message || 'Location search failed. You can still use typed text or set a pin manually.', true);
  } finally {
    if (wrapper._locationSearchController === controller) {
      wrapper._locationSearchController = null;
      if (searchButton) searchButton.disabled = false;
      if (resultsRegion) resultsRegion.setAttribute('aria-busy', 'false');
    }
  }
}

function selectLocationResult(wrapper, result) {
  clearLocationInputPreview(wrapper);
  abortLocationSearch(wrapper);
  invalidatePickerBoundary(wrapper, true);
  clearPickerMap(wrapper);
  var prefix = wrapper.dataset.locationPrefix;
  var query = wrapper.querySelector('[data-location-query]');
  if (query) query.value = wrapper.dataset.locationValue === 'address' ? (result.formattedAddress || result.name || '') : (result.name || result.formattedAddress || '');
  var addressKey = wrapper.dataset.locationAddressKey;
  if (addressKey) pickerSet(wrapper, addressKey, result.formattedAddress || '');
  pickerSet(wrapper, prefix + 'Lat', result.lat);
  pickerSet(wrapper, prefix + 'Lng', result.lng);
  pickerSet(wrapper, prefix + 'LocationRef', result.locationRef || '');
  pickerSet(wrapper, prefix + 'LocationMethod', 'selected');
  pickerSet(wrapper, prefix + 'LocationGranularity', result.granularity || 'unknown');
  pickerSet(wrapper, prefix + 'LocationStale', 'false');
  pickerSet(wrapper, prefix + 'LocationKindLabel', result.kindLabel || '');
  var results = wrapper.querySelector('[data-location-results]');
  if (results) { results.hidden = true; results.innerHTML = ''; }
  pickerSummary(wrapper, 'Mapped', false);
  var actions = wrapper.querySelector('.location-picker-actions');
  if (actions && !actions.querySelector('[data-action="preview-location"]')) {
    actions.insertAdjacentHTML('beforeend', '<button type="button" class="btn btn-ghost" data-action="preview-location">View on map</button>');
  }
  pickerHint(wrapper, 'Location selected.');
  if (query) { query.dispatchEvent(new Event('change', { bubbles: true })); query.focus(); }
  if (wrapper.dataset.boundaryPrefix && result.boundaryRef) loadLocationBoundary(wrapper, result.boundaryRef);
}

async function loadLocationBoundary(wrapper, ref) {
  var prefix = wrapper.dataset.boundaryPrefix;
  invalidatePickerBoundary(wrapper, false);
  var controller = new AbortController();
  wrapper._boundaryController = controller;
  pickerHint(wrapper, 'Loading destination area…');
  try {
    var response = await fetch('/WayPoint/api/location-boundary?ref=' + encodeURIComponent(ref), { signal: controller.signal });
    var data = await response.json();
    if (wrapper._boundaryController !== controller || !wrapper.isConnected) return;
    if (!response.ok) throw new Error(data.error || 'No destination boundary available.');
    wrapper._boundary = data;
    pickerSet(wrapper, prefix + 'Ref', ref);
    pickerSet(wrapper, prefix + 'Quality', data.geometryQuality || 'none');
    pickerSet(wrapper, prefix + 'Bbox', JSON.stringify(data.bbox || []));
    pickerHint(wrapper, data.geometry ? 'Destination area ready — view it on the map to check it.' : 'Destination saved as a point.');
  } catch (err) {
    if (wrapper._boundaryController !== controller || !wrapper.isConnected || err.name === 'AbortError') return;
    pickerSet(wrapper, prefix + 'Ref', ''); pickerSet(wrapper, prefix + 'Quality', 'none'); pickerSet(wrapper, prefix + 'Bbox', '');
    pickerHint(wrapper, err.message || 'No area boundary is available; this destination will use a point.', false);
  }
}

function openLocationPickerMap(wrapper, allowPlacement) {
  clearLocationInputPreview(wrapper);
  var holder = wrapper.querySelector('[data-location-pin-map]');
  if (!holder) return;
  if (holder._waypointMap && holder._allowPlacement === allowPlacement) { holder._waypointMap.invalidateSize(); return; }
  // Rebuild when switching between preview and editing: the old event closure
  // intentionally did not allow placement, so reusing it would do nothing.
  clearPickerMap(wrapper);
  holder.classList.add('is-open');
  holder._allowPlacement = allowPlacement;
  var prefix = wrapper.dataset.locationPrefix;
  var rawLat = (pickerInput(wrapper, prefix + 'Lat') || {}).value;
  var rawLng = (pickerInput(wrapper, prefix + 'Lng') || {}).value;
  var lat = rawLat === '' || rawLat == null ? NaN : Number(rawLat);
  var lng = rawLng === '' || rawLng == null ? NaN : Number(rawLng);
  var mapped = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  var map = L.map(holder, { scrollWheelZoom: true }).setView(mapped ? [lat, lng] : [20, 0], mapped ? 13 : 2);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors' }).addTo(map);
  holder._waypointMap = map;
  var marker = null;
  var setMarker = function (point, manual) {
    if (marker) marker.setLatLng(point); else {
      marker = L.marker(point, { draggable: allowPlacement }).addTo(map);
      if (allowPlacement) marker.on('dragend', function () { setMarker(marker.getLatLng(), true); });
    }
    if (allowPlacement && manual && editingAvailable()) {
      clearLocationInputPreview(wrapper);
      abortLocationSearch(wrapper);
      invalidatePickerBoundary(wrapper, true);
      pickerSet(wrapper, prefix + 'Lat', point.lat); pickerSet(wrapper, prefix + 'Lng', point.lng);
      pickerSet(wrapper, prefix + 'LocationRef', ''); pickerSet(wrapper, prefix + 'LocationMethod', 'manual');
      pickerSet(wrapper, prefix + 'LocationGranularity', 'unknown'); pickerSet(wrapper, prefix + 'LocationKindLabel', ''); pickerSet(wrapper, prefix + 'LocationStale', 'false');
      if (wrapper.dataset.boundaryPrefix) {
        var boundaryPrefix = wrapper.dataset.boundaryPrefix;
        pickerSet(wrapper, boundaryPrefix + 'Ref', ''); pickerSet(wrapper, boundaryPrefix + 'Quality', 'none'); pickerSet(wrapper, boundaryPrefix + 'Bbox', '');
      }
      pickerSummary(wrapper, 'Manual pin', false); pickerHint(wrapper, 'Pin set. Drag it or click the map to adjust.');
    }
  };
  if (mapped) setMarker(L.latLng(lat, lng), false);
  if (allowPlacement) pickerHint(wrapper, 'Click the map or drag the pin to choose a location. Opening the map does not change your saved location.');
  var boundary = wrapper._boundary;
  if (boundary && boundary.geometry) {
    var destinationColor = cssToken('--wp-map-destination');
    var layer = L.geoJSON(boundary.geometry, { style: { color: destinationColor, weight: 2, fillColor: destinationColor, fillOpacity: 0.18 } }).addTo(map);
    map.fitBounds(layer.getBounds(), { padding: [16, 16] });
  }
  if (allowPlacement) {
    map.on('click', function (event) { setMarker(event.latlng, true); });
  }
  setTimeout(function () { if (holder._waypointMap === map) map.invalidateSize(); }, 0);
}

document.addEventListener('input', function (e) {
  if (!e.target.matches('[data-location-query]')) return;
  var wrapper = e.target.closest('[data-location-picker]');
  if (!wrapper) return;
  clearLocationInputPreview(wrapper);
  abortLocationSearch(wrapper);
  invalidatePickerBoundary(wrapper, false);
  var oldResults = wrapper.querySelector('[data-location-results]');
  if (oldResults) { oldResults.hidden = true; oldResults.innerHTML = ''; }
  var prefix = wrapper.dataset.locationPrefix;
  var latInput = pickerInput(wrapper, prefix + 'Lat');
  if (latInput && latInput.value !== '') {
    pickerSet(wrapper, prefix + 'LocationStale', 'true');
    pickerSummary(wrapper, 'Location may not match', true);
  }
});

document.addEventListener('keydown', function (e) {
  if (e.key !== 'Enter' || !e.target.matches('[data-location-query]')) return;
  e.preventDefault();
  var wrapper = e.target.closest('[data-location-picker]');
  if (wrapper) searchLocationPicker(wrapper);
});

// Holds coordinates the most recent successful flight lookup (in the
// open transport form) returned for origin/destination -- set in
// performFlightLookup() from AeroDataBox's location data (see
// airportSummary() in src/worker.js). Fallback at save time
// (openTransportForm()'s onSubmit) for an airport not in COMMON_AIRPORTS.
// Reset every time the transport form is (re)opened so a stale lookup
// can't leak into a new leg.
var lastFlightLookupCoords = { from: null, to: null };

function openAccommodationForm(trip, existing, seed) {
  var initial = existing ? Object.assign({}, existing, {
    checkInDate: dateOnly(existing.checkIn), checkInTime: timeOnly(existing.checkIn),
    checkOutDate: dateOnly(existing.checkOut), checkOutTime: timeOnly(existing.checkOut)
  }, pickerInitial(existing, 'location')) : Object.assign({ type: 'Other' }, seed || {});
  if (existing && !initial.type) initial.type = 'Other';
  openForm({
    title: existing ? 'Edit accommodation' : 'Add accommodation',
    sections: sectionsWithTagPickerLock(ACCOMMODATION_FORM_SECTIONS, !!existing && !canFullyEditTrip(trip)),
    initial: initial, trip: trip, submitLabel: 'Save',
    onSubmit: function (v) {
      updateState(function (next) {
        var t = byId(next.trips, trip.tripId, 'tripId');
        var mapped = readPickerLocation(v, 'location');
        var rec = {
          accommodationId: existing ? existing.accommodationId : newId(), name: v.name, type: v.type || 'Other', destinationId: v.destinationId || '', address: v.address || '',
          lat: mapped.lat, lng: mapped.lng, locationRef: mapped.locationRef, locationMethod: mapped.locationMethod, locationGranularity: mapped.locationGranularity, locationStale: mapped.locationStale, locationKindLabel: mapped.locationKindLabel,
          checkIn: combineDateTime(v.checkInDate, v.checkInTime), checkOut: combineDateTime(v.checkOutDate, v.checkOutTime),
          bookingRef: v.bookingRef || '', contactId: v.contactId || '',
          costAmount: v.costAmount || '', costCurrency: (v.costCurrency || '').toUpperCase(), costRate: v.costRate || '',
          receiptRef: v.receiptRef || '', companions: readTagPicker(v, 'companions'), notes: v.notes || ''
        };
        if (existing) t.accommodation[t.accommodation.findIndex(function (x) { return x.accommodationId === existing.accommodationId; })] = rec;
        else t.accommodation.push(rec);
      });
    }
  });
}

function openContactForm(trip, existing) {
  openForm({
    title: existing ? 'Edit contact' : 'Add contact', fields: CONTACT_FIELDS,
    initial: existing || {}, trip: trip, submitLabel: 'Save',
    onSubmit: function (v) {
      updateState(function (next) {
        var t = byId(next.trips, trip.tripId, 'tripId');
        var rec = { contactId: existing ? existing.contactId : newId(), name: v.name, role: v.role || '', phone: v.phone || '', email: v.email || '', address: v.address || '', notes: v.notes || '' };
        if (existing) t.contacts[t.contacts.findIndex(function (x) { return x.contactId === existing.contactId; })] = rec;
        else t.contacts.push(rec);
      });
    }
  });
}

function openCompanionForm(trip, existing) {
  // A "user" grant only ever reaches this via "Add companion" (rowActions()
  // never shows Edit/Delete to anything less than full-scope), so
  // `existing` shouldn't be set for them, but the shorter field list is
  // chosen from the actual permission either way, so it can't silently
  // show a field that would just be dropped on save.
  var fields = canFullyEditTrip(trip) ? COMPANION_FIELDS : COMPANION_FIELDS_LIMITED;
  // `smileyColor` is a flat form field but lives nested in storage
  // (`avatar.smiley`) — flatten it here, fold it back in onSubmit below.
  var initial = existing ? Object.assign({}, existing, { smileyColor: (existing.avatar && existing.avatar.smiley) || '' }) : {};
  openForm({
    title: existing ? 'Edit companion' : 'Add companion', fields: fields,
    initial: initial, trip: trip, submitLabel: 'Save',
    onSubmit: function (v) {
      updateState(function (next) {
        var t = byId(next.trips, trip.tripId, 'tripId');
        var rec = { companionId: existing ? existing.companionId : newId(), name: v.name };
        // notes is only on the full COMPANION_FIELDS list -- v.notes is
        // undefined for a "user" grant's COMPANION_FIELDS_LIMITED, so
        // this naturally comes out as '' without an extra check.
        rec.notes = v.notes || '';
        // Same reasoning as notes above: absent from COMPANION_FIELDS_LIMITED,
        // so these come out '' for a "user" grant without a special case.
        rec.joinsOn = v.joinsOn || '';
        rec.leavesOn = v.leavesOn || '';
        if (v.smileyColor) rec.avatar = { smiley: v.smileyColor };
        // Deliberately no `accountId` here, ever -- the Worker reasserts
        // any existing link from its own stored truth regardless (see
        // reconcileCompanionAccountLinks() in src/worker.js).
        if (existing) t.companions[t.companions.findIndex(function (x) { return x.companionId === existing.companionId; })] = rec;
        else t.companions.push(rec);
        // No need to touch other records to rename a tag -- every tag is
        // stored as just the companion's id and looked up by name at
        // render time, so a rename is instantly reflected everywhere.

        // Keep the optimistic render's companionAvatars map in sync too --
        // persist() re-renders immediately from this locally-mutated
        // clone, before the server's recomputed map comes back. Without
        // this a just-added/recoloured companion's marker would render
        // blank until the next reload. Mirrors resolveCompanionAvatars()'s
        // "smiley" branch in src/worker.js. Never "account": linking is
        // its own action (openCompanionLinkForm()), and recolouring an
        // already-linked companion doesn't affect its marker at all.
        if (!existing || !existing.accountId) {
          t.companionAvatars = t.companionAvatars || {};
          var smileyToken = (v.smileyColor && avatarColorHex(v.smileyColor)) ? v.smileyColor : AVATAR_COLORS[deterministicAvatarIndex(rec.companionId, AVATAR_COLORS.length)].token;
          t.companionAvatars[rec.companionId] = { type: 'smiley', color: smileyToken };
        }
      });
    }
  });
}
