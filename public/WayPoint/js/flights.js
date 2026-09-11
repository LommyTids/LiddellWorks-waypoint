// Handles the "Look up" button next to Flight number (see fieldHtml's
// 'flight-lookup' case and the 'lookup-flight' click-delegation branch
// below). Talks to /WayPoint/api/flight-lookup, which proxies
// AeroDataBox server-side (see handleFlightLookup() in src/worker.js).
// AeroDataBox looks flights up by number and date.
//
// The date used to come only from "Depart date" further down the form --
// awkward, since that field isn't visible yet when someone's just typed
// a flight number. Now there's a dedicated date input next to the flight
// number (fieldHtml's 'flight-lookup' case); this prefers that one and
// falls back to "Depart date" if blank. Once a lookup succeeds, the date
// used is written back into "Depart date" too, so they can't disagree.
//
// On success this fills in Airline/From/To/times directly in the
// still-open form (not through updateState()/render(), which would
// discard other typed fields and reset focus/scroll).
//
// AeroDataBox returns extra details (aircraft type, terminal, gate) that
// used to just flash in the status line and vanish. mergeFlightLookupNotes()
// below folds those into Notes instead, in a clearly-delimited block so
// re-running "Look up" replaces it rather than piling up duplicates.
var FLIGHT_LOOKUP_NOTES_START = '--- Flight lookup details (auto-filled by "Look up") ---';
var FLIGHT_LOOKUP_NOTES_END = '--- end flight lookup details ---';

function mergeFlightLookupNotes(existingNotes, detailLines) {
  var notes = (existingNotes || '').trim();
  var startIdx = notes.indexOf(FLIGHT_LOOKUP_NOTES_START);
  if (startIdx !== -1) {
    var endIdx = notes.indexOf(FLIGHT_LOOKUP_NOTES_END, startIdx);
    var afterEnd = endIdx !== -1 ? endIdx + FLIGHT_LOOKUP_NOTES_END.length : notes.length;
    notes = (notes.slice(0, startIdx) + notes.slice(afterEnd)).trim();
  }
  if (!detailLines.length) return notes;
  var block = FLIGHT_LOOKUP_NOTES_START + '\n' + detailLines.join('\n') + '\n' + FLIGHT_LOOKUP_NOTES_END;
  return notes ? (notes + '\n\n' + block) : block;
}

// Preserve a reviewed pin for the same airport; changed airports must update
// the label and hidden coordinates together, never retain the previous pin.
function applyFlightAirport(input, airport) {
  var wrapper = input.closest('[data-location-picker]');
  if (!wrapper) { input.value = airportDisplay(airport); return; }
  var prefix = wrapper.dataset.locationPrefix;
  var priorCode = /^([A-Z]{3})\b/i.exec(input.value.trim());
  var priorLat = (pickerInput(wrapper, prefix + 'Lat') || {}).value;
  var priorLng = (pickerInput(wrapper, prefix + 'Lng') || {}).value;
  var stale = (pickerInput(wrapper, prefix + 'LocationStale') || {}).value === 'true';
  if (!stale && priorCode && priorCode[1].toUpperCase() === airport.code && priorLat !== '' && priorLat != null && priorLng !== '' && priorLng != null) return;
  var coords = airportCoordsForCode(airport.code) || airport.location;
  selectLocationResult(wrapper, {
    name: airportDisplay(airport), lat: coords ? coords.lat : '', lng: coords ? coords.lng : '',
    locationRef: /^[A-Z]{3}$/.test(airport.code || '') && coords ? 'local:airport:' + airport.code : '',
    granularity: coords ? 'airport' : 'unknown', kindLabel: coords ? 'Airport' : ''
  });
  if (!coords) {
    var summary = wrapper.querySelector('[data-location-summary]');
    if (summary) summary.hidden = true;
    pickerHint(wrapper, 'Airport details updated. Find the location or set a pin to map it.');
  }
}

function performFlightLookup(button) {
  var form = document.getElementById('entity-form');
  if (!form) return;
  var flightInput = form.querySelector('[name="flightNumber"]');
  var quickDateInput = document.getElementById('flight-lookup-date');
  var departDateInput = form.querySelector('[name="departDate"]');
  var statusEl = document.getElementById('flight-lookup-status');
  var flightNumber = (flightInput && flightInput.value || '').trim();
  var quickDate = (quickDateInput && quickDateInput.value || '').trim();
  var departDate = quickDate || (departDateInput && departDateInput.value || '').trim();

  if (!flightNumber) {
    if (statusEl) { statusEl.textContent = 'Type a flight number first.'; statusEl.className = 'flight-lookup-status is-error'; }
    return;
  }
  if (!departDate) {
    if (statusEl) { statusEl.textContent = 'Pick a date first (either right here, or in "Depart date" below) — flight schedules are looked up per date.'; statusEl.className = 'flight-lookup-status is-error'; }
    return;
  }

  button.disabled = true;
  if (statusEl) { statusEl.textContent = 'Looking up ' + flightNumber + ' on ' + departDate + '…'; statusEl.className = 'flight-lookup-status'; }

  fetch('/WayPoint/api/flight-lookup?flightNumber=' + encodeURIComponent(flightNumber) + '&date=' + encodeURIComponent(departDate), { credentials: 'same-origin' })
    .then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        return { ok: res.ok, body: body };
      });
    })
    .then(function (result) {
      // The form may have been closed (or switched away from Flight
      // mode) while the request was in flight — re-check both before
      // touching anything.
      var currentForm = document.getElementById('entity-form');
      if (!currentForm || currentForm !== form) return;
      var liveFlight = currentForm.querySelector('[name="flightNumber"]');
      var liveLookupDate = document.getElementById('flight-lookup-date');
      var liveDepartDate = currentForm.querySelector('[name="departDate"]');
      if (!liveFlight || liveFlight.value.trim() !== flightNumber || ((liveLookupDate && liveLookupDate.value) || (liveDepartDate && liveDepartDate.value) || '') !== departDate) return;
      var currentStatusEl = document.getElementById('flight-lookup-status');

      if (!result.ok) {
        if (currentStatusEl) {
          currentStatusEl.textContent = (result.body && result.body.error) || 'Flight lookup failed.';
          currentStatusEl.className = 'flight-lookup-status is-error';
        }
        return;
      }

      var data = result.body;
      var carrierInput = currentForm.querySelector('[name="carrier"]');
      var fromInput = currentForm.querySelector('[name="fromLocation"]');
      var toInput = currentForm.querySelector('[name="toLocation"]');
      var notesInput = currentForm.querySelector('[name="notes"]');
      var departDateField = currentForm.querySelector('[name="departDate"]');
      var departTimeField = currentForm.querySelector('[name="departTime"]');
      var arriveDateField = currentForm.querySelector('[name="arriveDate"]');
      var arriveTimeField = currentForm.querySelector('[name="arriveTime"]');
      if (carrierInput && data.airline) carrierInput.value = data.airline;
      if (fromInput && data.origin) applyFlightAirport(fromInput, data.origin);
      if (toInput && data.destination) applyFlightAirport(toInput, data.destination);
      // See lastFlightLookupCoords' own comment -- this is the fallback
      // coordinate source for an airport too minor for COMMON_AIRPORTS,
      // consulted at save time in openTransportForm()'s onSubmit.
      lastFlightLookupCoords = {
        from: (data.origin && data.origin.location) ? data.origin.location : null,
        to: (data.destination && data.destination.location) ? data.destination.location : null
      };
      // The date searched with is written into "Depart date" here, even
      // if typed only into the quick date input. Arrival date gets
      // filled in fresh too: a flight can land the next calendar day,
      // and AeroDataBox gives the real date rather than us guessing.
      if (departDateField) departDateField.value = departDate;
      if (departTimeField && data.departure && data.departure.time) departTimeField.value = data.departure.time;
      if (arriveDateField && data.arrival && data.arrival.date) arriveDateField.value = data.arrival.date;
      if (arriveTimeField && data.arrival && data.arrival.time) arriveTimeField.value = data.arrival.time;
      var transportJourney = currentForm.querySelector('[data-journey]');
      if (transportJourney) {
        var transportJourneyAuto = currentForm.elements[transportJourney.dataset.autoKey];
        if (transportJourneyAuto) transportJourneyAuto.value = 'false';
        updateJourneyPresentation(currentForm, transportJourney);
      }

      // This used to only flash in the status line, then vanish --
      // mergeFlightLookupNotes() now saves it into Notes so it's still
      // there next time this leg is opened.
      var noteLines = [];
      noteLines.push(flightNumber + ' on ' + departDate + (data.airline ? ' (' + data.airline + ')' : ''));
      if (data.aircraft) noteLines.push('Aircraft: ' + data.aircraft);
      if (data.departure && (data.departure.terminal || data.departure.gate)) {
        noteLines.push('Departs' + (data.departure.terminal ? ' terminal ' + data.departure.terminal : '') + (data.departure.gate ? ', gate ' + data.departure.gate : ''));
      }
      if (data.arrival && (data.arrival.terminal || data.arrival.gate)) {
        noteLines.push('Arrives' + (data.arrival.terminal ? ' terminal ' + data.arrival.terminal : '') + (data.arrival.gate ? ', gate ' + data.arrival.gate : ''));
      }
      if (data.matchCount > 1) noteLines.push(data.matchCount + ' flights matched that number/date — this is the first match, double-check it\'s the right one.');
      if (notesInput) notesInput.value = mergeFlightLookupNotes(notesInput.value, noteLines);

      var extras = [];
      if (data.departure && data.departure.terminal) extras.push('departs terminal ' + data.departure.terminal);
      if (data.departure && data.departure.gate) extras.push('gate ' + data.departure.gate);
      if (data.arrival && data.arrival.terminal) extras.push('arrives terminal ' + data.arrival.terminal);
      var extrasText = extras.length ? ' (' + extras.join(', ') + ' — saved to Notes)' : '';
      var matchNote = data.matchCount > 1 ? ' Note: ' + data.matchCount + ' flights matched that number/date — this is the first match, double-check it\'s the right one.' : '';

      if (currentStatusEl) {
        currentStatusEl.textContent = 'Filled in from AeroDataBox' + extrasText + '.' + matchNote;
        currentStatusEl.className = 'flight-lookup-status is-ok';
      }
    })
    .catch(function () {
      if (document.getElementById('entity-form') !== form || !button.isConnected) return;
      var currentStatusEl = document.getElementById('flight-lookup-status');
      if (currentStatusEl) {
        currentStatusEl.textContent = 'Couldn\'t reach the flight lookup service — check your connection and try again.';
        currentStatusEl.className = 'flight-lookup-status is-error';
      }
    })
    .finally(function () {
      if (button.isConnected) button.disabled = false;
    });
}

// Builds the display/saved string for one airport, from either shape
// this app deals with: a COMMON_AIRPORTS entry ({ code, name, city,
// country }), or handleFlightLookup()'s reshaped airportSummary()
// ({ code, name, municipality, country }). Both feed a transport leg's
// "From"/"To" field the same way, so a looked-up value reads consistently
// with one picked from the suggestion dropdown.
//
// Result looks like "LHR — London Heathrow, London, United Kingdom" --
// fuller than "CODE — Name" alone, giving enough context to choose
// between similarly named airports; the map coordinate is stored
// separately. City is skipped from the "place" part when already
// embedded in the airport name, to avoid "...London Heathrow, London,
// United Kingdom" reading with London twice.
function airportDisplay(airport) {
  if (!airport) return '';
  var codeName = (airport.code && airport.name) ? (airport.code + ' — ' + airport.name)
    : (airport.code || airport.name || '');
  var city = airport.city || airport.municipality || '';
  var cityIsRedundant = city && airport.name && airport.name.toLowerCase().indexOf(city.toLowerCase()) !== -1;
  var placeParts = [];
  if (city && !cityIsRedundant) placeParts.push(city);
  if (airport.country) placeParts.push(airport.country);
  var place = placeParts.join(', ');
  if (!codeName) return place;
  return place ? (codeName + ', ' + place) : codeName;
}

// Looks up a real, known coordinate for an IATA-style airport code.
// Tries two sources, in order:
//   1. COMMON_AIRPORTS (data/airports.js) — curated ~126 major hubs,
//      tiny and always already loaded.
//   2. AIRPORT_DB (data/airports-full.js) — ~7,900 airports worldwide,
//      loaded with `defer`, so guarded with `typeof AIRPORT_DB !==
//      'undefined'` in case it hasn't loaded yet (or fails to load).
// Returns null if neither has it -- the caller (openTransportForm()'s
// onSubmit) then leaves the end unmapped.
function airportCoordsForCode(code) {
  var found = COMMON_AIRPORTS.filter(function (a) { return a.code === code; })[0];
  if (found && typeof found.lat === 'number' && typeof found.lng === 'number') return { lat: found.lat, lng: found.lng };
  if (typeof AIRPORT_DB !== 'undefined' && AIRPORT_DB[code]) {
    var entry = AIRPORT_DB[code]; // [name, city, countryCode, lat, lng]
    return { lat: entry[3], lng: entry[4] };
  }
  return null;
}

// Pulls the leading 3-letter airport code off a "CODE — Name, City,
// Country" (or bare "CODE") string and resolves it via
// airportCoordsForCode() above. Returns null for anything that doesn't
// start with a plausible code (a city name for a non-Flight mode, say).
function airportCoordsFromText(text) {
  var m = /^([A-Za-z]{3})\b/.exec((text || '').trim());
  return m ? airportCoordsForCode(m[1].toUpperCase()) : null;
}

var MAX_AIRPORT_SUGGESTIONS = 30;
var MIN_AIRPORT_SEARCH_LENGTH = 2;

// A flattened, lowercased copy of AIRPORT_DB, built once on first use
// rather than every keystroke. AIRPORT_DB keeps original casing (for
// display); searching needs lowercase, and redoing that ~7,900-entry
// pass on every keystroke was measurably laggy on a slower device.
// Trades a few hundred KB of memory for a plain substring-compare loop.
var airportSearchIndex = null;
function airportSearchIndexReady() {
  if (airportSearchIndex || typeof AIRPORT_DB === 'undefined') return !!airportSearchIndex;
  airportSearchIndex = [];
  for (var code in AIRPORT_DB) {
    if (!Object.prototype.hasOwnProperty.call(AIRPORT_DB, code)) continue;
    var entry = AIRPORT_DB[code]; // [name, city, countryCode, lat, lng]
    airportSearchIndex.push({
      code: code, name: entry[0], city: entry[1],
      nameLower: (entry[0] || '').toLowerCase(), cityLower: (entry[1] || '').toLowerCase()
    });
  }
  return true;
}

// Searches airports typed into a Flight leg's "From"/"To" field against
// the full ~7,900-airport AIRPORT_DB, not just COMMON_AIRPORTS' curated
// ~126, so "birmingham" or "bhx" finds a secondary airport too. Returns
// { code, name, city } capped at MAX_AIRPORT_SUGGESTIONS -- under 2
// characters (or before AIRPORT_DB finishes loading) falls back to the
// curated list.
function searchAirports(query) {
  var q = (query || '').trim();
  if (q.length < MIN_AIRPORT_SEARCH_LENGTH || !airportSearchIndexReady()) return COMMON_AIRPORTS;

  var qUpper = q.toUpperCase();
  var qLower = q.toLowerCase();
  var matches = [];
  for (var i = 0; i < airportSearchIndex.length; i++) {
    var e = airportSearchIndex[i];
    var score = 0;
    // Ranked so an exact/prefix code match (what a frequent flyer types)
    // always beats a name/city text match (what someone browsing by
    // place typed) — both are useful, but shouldn't compete evenly.
    if (e.code === qUpper) score = 4;
    else if (e.code.indexOf(qUpper) === 0) score = 3;
    else if (e.cityLower.indexOf(qLower) === 0) score = 2;
    else if (e.nameLower.indexOf(qLower) !== -1 || e.cityLower.indexOf(qLower) !== -1) score = 1;
    if (score > 0) matches.push({ code: e.code, name: e.name, city: e.city, score: score });
  }
  matches.sort(function (a, b) { return (b.score - a.score) || a.code.localeCompare(b.code); });
  return matches.slice(0, MAX_AIRPORT_SUGGESTIONS);
}

// Updates the live "resolved to a real coordinate or not" hint under a
// Flight leg's "From"/"To" field (see fieldHtml's 'airport' case for
// the initial render of the same hint) as the viewer types.
function updateAirportResolveHint(input) {
  var hintEl = document.getElementById(input.name + '-resolve-hint');
  if (!hintEl) return;
  var val = input.value.trim();
  if (!val) { hintEl.textContent = ''; hintEl.className = 'field-hint airport-resolve-hint'; return; }
  var resolved = airportCoordsFromText(val);
  hintEl.textContent = resolved ? '✓ Mapped precisely for the Map tab' : 'No exact airport match yet — the map will try to search by name instead.';
  hintEl.className = 'field-hint airport-resolve-hint' + (resolved ? ' is-ok' : ' is-unresolved');
}

