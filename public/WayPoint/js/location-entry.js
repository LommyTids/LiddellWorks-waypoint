/* Offline location entry. Draft previews never change the form's saved point. */

function clearLocationInputPreview(wrapper) {
  wrapper._locationCandidate = null;
  var region = wrapper.querySelector('[data-location-candidate]');
  if (region) region.hidden = true;
  var holder = wrapper.querySelector('[data-location-candidate-map]');
  if (holder) {
    if (holder._waypointMap) holder._waypointMap.remove();
    holder._waypointMap = null;
    holder.classList.remove('is-open');
  }
}

function locationInputHint(wrapper, message, error) {
  var hint = wrapper.querySelector('[data-location-input-hint]');
  if (hint) {
    hint.textContent = message || '';
    hint.style.color = error ? 'var(--wp-state-danger)' : '';
  }
  var input = wrapper.querySelector('[data-location-input]');
  if (input) input.setAttribute('aria-invalid', error ? 'true' : 'false');
}

function locationInputDestination(wrapper) {
  var form = wrapper.closest('form');
  var field = form && form.querySelector('[name="destinationId"]');
  var trip = currentTrip();
  var destination = field && field.value && trip && byId(trip.destinations, field.value, 'destinationId');
  if (!destination || destination.locationStale || !Number.isFinite(destination.lat) ||
      !Number.isFinite(destination.lng) || Math.abs(destination.lat) > 90 || Math.abs(destination.lng) > 180) return null;
  return destination;
}

function refreshLocationInputReference(wrapper) {
  var destination = locationInputDestination(wrapper);
  var row = wrapper.querySelector('[data-location-reference-row]');
  var checkbox = wrapper.querySelector('[data-location-reference]');
  var label = wrapper.querySelector('[data-location-reference-label]');
  if (row) row.hidden = !destination;
  if (checkbox) checkbox.checked = false;
  if (label) label.textContent = destination
    ? 'Use ' + (destination.name || 'the selected destination') + ' as the nearby area for a short Plus Code' : '';
}

function toggleLocationInput(wrapper) {
  var panel = wrapper.querySelector('[data-location-input-panel]');
  var button = wrapper.querySelector('[data-action="toggle-location-input"]');
  if (!panel || !button) return;
  panel.hidden = !panel.hidden;
  button.setAttribute('aria-expanded', String(!panel.hidden));
  clearLocationInputPreview(wrapper);
  locationInputHint(wrapper, '');
  if (!panel.hidden) {
    refreshLocationInputReference(wrapper);
    var input = wrapper.querySelector('[data-location-input]');
    if (input) {
      var prefix = wrapper.dataset.locationPrefix;
      var lat = (pickerInput(wrapper, prefix + 'Lat') || {}).value;
      var lng = (pickerInput(wrapper, prefix + 'Lng') || {}).value;
      if (!input.value.trim() && lat !== '' && lat != null && lng !== '' && lng != null &&
          validLocationInputPoint(Number(lat), Number(lng))) input.value = lat + ', ' + lng;
      input.focus();
    }
  }
}

function locationInputSnapshot(wrapper) {
  var prefix = wrapper.dataset.locationPrefix;
  var input = wrapper.querySelector('[data-location-input]');
  var reference = wrapper.querySelector('[data-location-reference]');
  var destination = locationInputDestination(wrapper);
  var query = wrapper.querySelector('[data-location-query]');
  return JSON.stringify([
    input && input.value, !!(reference && reference.checked),
    destination && [destination.destinationId, destination.lat, destination.lng],
    query && query.value,
    (pickerInput(wrapper, prefix + 'Lat') || {}).value,
    (pickerInput(wrapper, prefix + 'Lng') || {}).value,
    (pickerInput(wrapper, prefix + 'LocationMethod') || {}).value
  ]);
}

function previewLocationInput(wrapper) {
  clearLocationInputPreview(wrapper);
  var input = wrapper.querySelector('[data-location-input]');
  if (!input) return;
  var checkbox = wrapper.querySelector('[data-location-reference]');
  var destination = locationInputDestination(wrapper);
  var reference = checkbox && checkbox.checked && destination ? { lat: destination.lat, lng: destination.lng } : undefined;
  var point = parseLocationInput(input.value, reference);
  if (point.error) { locationInputHint(wrapper, point.error, true); return; }
  abortLocationSearch(wrapper);
  clearPickerMap(wrapper);
  var results = wrapper.querySelector('[data-location-results]');
  if (results) { results.hidden = true; results.innerHTML = ''; }
  var coordinates = point.lat.toFixed(6) + ', ' + point.lng.toFixed(6);
  var code = point.code || encodeLocationPlusCode(point.lat, point.lng);
  var label = wrapper.querySelector('[data-location-candidate-label]');
  if (label) label.textContent = coordinates + (code ? ' · Plus Code ' + code : '') +
    (point.usedReference ? ' · Resolved near ' + (destination.name || 'the selected destination') : '') +
    (point.kind === 'plus-code' ? ' · Pin shows the centre of the code’s area.' : '');
  var region = wrapper.querySelector('[data-location-candidate]');
  if (region) region.hidden = false;
  wrapper._locationCandidate = { point: point, snapshot: locationInputSnapshot(wrapper) };
  locationInputHint(wrapper, 'Check the point, then choose Use this location. Your place name and address will be kept.');
  var holder = wrapper.querySelector('[data-location-candidate-map]');
  if (!holder || typeof L === 'undefined') {
    locationInputHint(wrapper, 'Map preview is unavailable. Check the coordinates above before using this location.');
  } else {
    try {
      holder.classList.add('is-open');
      var map = L.map(holder, { scrollWheelZoom: false }).setView([point.lat, point.lng], 16);
      holder._waypointMap = map;
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors' }).addTo(map);
      L.marker([point.lat, point.lng]).addTo(map);
      setTimeout(function () { if (holder._waypointMap === map) map.invalidateSize(); }, 0);
    } catch (err) {
      if (holder._waypointMap) holder._waypointMap.remove();
      holder._waypointMap = null;
      holder.classList.remove('is-open');
      locationInputHint(wrapper, 'Map preview is unavailable. Check the coordinates above before using this location.');
    }
  }
}

function applyLocationInput(wrapper) {
  if (!editingAvailable()) return;
  var candidate = wrapper._locationCandidate;
  if (!candidate || candidate.snapshot !== locationInputSnapshot(wrapper)) {
    clearLocationInputPreview(wrapper);
    locationInputHint(wrapper, 'The input or location changed. Preview it again before applying.', true);
    return;
  }
  var point = candidate.point;
  abortLocationSearch(wrapper);
  invalidatePickerBoundary(wrapper, true);
  clearPickerMap(wrapper);
  var prefix = wrapper.dataset.locationPrefix;
  pickerSet(wrapper, prefix + 'Lat', point.lat);
  pickerSet(wrapper, prefix + 'Lng', point.lng);
  pickerSet(wrapper, prefix + 'LocationRef', '');
  pickerSet(wrapper, prefix + 'LocationMethod', 'manual');
  pickerSet(wrapper, prefix + 'LocationGranularity', 'unknown');
  pickerSet(wrapper, prefix + 'LocationStale', 'false');
  pickerSet(wrapper, prefix + 'LocationKindLabel', '');
  var query = wrapper.querySelector('[data-location-query]');
  if (query && !query.value.trim()) query.value = point.lat.toFixed(6) + ', ' + point.lng.toFixed(6);
  pickerSummary(wrapper, 'Mapped from ' + (point.kind === 'plus-code' ? 'Plus Code' : 'coordinates'), false);
  var actions = wrapper.querySelector('.location-picker-actions');
  if (actions && !actions.querySelector('[data-action="preview-location"]')) {
    actions.insertAdjacentHTML('beforeend', '<button type="button" class="btn btn-ghost" data-action="preview-location">View on map</button>');
  }
  clearLocationInputPreview(wrapper);
  var panel = wrapper.querySelector('[data-location-input-panel]');
  var button = wrapper.querySelector('[data-action="toggle-location-input"]');
  if (panel) panel.hidden = true;
  if (button) { button.setAttribute('aria-expanded', 'false'); button.focus(); }
  pickerHint(wrapper, 'Point applied. Save the form to keep this location.');
  if (query) query.dispatchEvent(new Event('change', { bubbles: true }));
}

document.addEventListener('input', function (event) {
  if (!event.target.matches('[data-location-input]')) return;
  var wrapper = event.target.closest('[data-location-picker]');
  if (wrapper) { clearLocationInputPreview(wrapper); locationInputHint(wrapper, ''); }
});

document.addEventListener('change', function (event) {
  if (event.target.matches('[data-location-reference]')) {
    var wrapper = event.target.closest('[data-location-picker]');
    if (wrapper) { clearLocationInputPreview(wrapper); locationInputHint(wrapper, ''); }
  }
  if (event.target.matches('[name="destinationId"]')) {
    var form = event.target.closest('form');
    if (form) Array.prototype.forEach.call(form.querySelectorAll('[data-location-picker]'), function (picker) {
      clearLocationInputPreview(picker);
      refreshLocationInputReference(picker);
    });
  }
});

document.addEventListener('keydown', function (event) {
  if (event.key !== 'Enter' || !event.target.matches('[data-location-input]')) return;
  event.preventDefault();
  var wrapper = event.target.closest('[data-location-picker]');
  if (wrapper) previewLocationInput(wrapper);
});
