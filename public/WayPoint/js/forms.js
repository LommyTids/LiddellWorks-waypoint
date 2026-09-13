/* ---------- 6. Generic form-field schemas & modal builder ----------
   Rather than hand-writing six near-identical forms, every entity
   (trip, destination, activity, transport, accommodation, contact,
   expense) describes its fields as a small array. fieldHtml() turns
   one field description into the right input, and openForm() wires
   the whole array up into a modal with Cancel/Save buttons. */

// Shared markup for every field with app-rendered suggestions (currency,
// country, city, timezone, airport) — see "Generic suggestion dropdown"
// further down for the JS. `suggestType` names a SUGGEST_SOURCES key,
// written as `data-suggest-type` so generic listeners know which
// search/display functions to use. `extraAttrs` is a raw attribute
// string for whatever a field needs beyond the basics; `placeholderFallback`
// is used only when the field didn't specify its own.
// The names the FORM gives its start-date input, in the order to try them.
// These are the journey widget's own keys (the `startDateKey` in each
// section's journey config), not the fields the record is finally stored
// under: accommodation's input is `checkInDate` but it saves as `checkIn`,
// and transport's is `departDate` saving as `departDateTime`. This
// function reads a live form, so the form's names are the right ones.
// `date` covers any plain date field not wrapped in a journey.
var TAG_PICKER_DATE_KEYS = ['date', 'startDate', 'arriveDate', 'checkInDate', 'departDate'];

function formPrimaryDate(form) {
  for (var i = 0; i < TAG_PICKER_DATE_KEYS.length; i++) {
    var input = form && form.elements[TAG_PICKER_DATE_KEYS[i]];
    var value = input && input.value;
    if (value) return String(value).slice(0, 10);
  }
  return '';
}

// Warns when somebody ticked in the People picker isn't on the trip on the
// day this item happens -- see the "Part-trip participants" comment by
// companionStayLabel(). Deliberately a hint and not an error: they may
// genuinely be joining for one dinner, so this informs rather than blocks,
// and the save goes through either way.
function syncTagPickerAwayWarning(form) {
  var slot = form && form.querySelector('[data-tag-away]');
  if (!slot) return;
  var cfg = window.__formConfig;
  var trip = cfg && cfg.trip;
  var day = formPrimaryDate(form);
  var ticked = Array.prototype.filter.call(form.querySelectorAll('[data-tag-person-id]'), function (box) { return box.checked; })
    .map(function (box) { return box.dataset.tagPersonId; });
  var away = trip ? companionsAwayFor(trip, ticked, day) : [];
  if (!away.length) { slot.hidden = true; slot.textContent = ''; return; }
  var names = away.map(function (person) { return person.name + ' (' + companionStayLabel(person) + ')'; });
  slot.hidden = false;
  slot.textContent = (names.length === 1 ? names[0] + ' is' : names.join(', ') + ' are') +
    ' not on the trip on ' + formatDateShort(day) + '. You can still tag them.';
}

// Reads a 'tag-picker' field's selections back out of a submitted form's
// values object. A tag-picker renders one checkbox per companion, each
// with its own unique name ("<field.key>__<companionId>") rather than
// several sharing one name (see the 'tag-picker' case in fieldHtml()
// below for why). This scans every key in `values` for that "<key>__"
// prefix and pulls the companion id from whichever were checked.
function readTagPicker(values, key) {
  var prefix = key + '__';
  var ids = [];
  for (var k in values) {
    if (Object.prototype.hasOwnProperty.call(values, k) && k.indexOf(prefix) === 0 && values[k]) {
      ids.push(k.slice(prefix.length));
    }
  }
  return ids;
}

// Returns a shallow copy of `fields` with its 'tag-picker' field (if any)
// marked `locked: true` (see fieldHtml()'s 'tag-picker' case: disables
// checkboxes, adds a hint). Used when a "user" grant edits one of its own
// tagged items -- they can change other fields but never retag; the
// Worker's mergeUserScopedList() keeps stored tags regardless, so this
// just makes the UI honest about a control that wouldn't do anything.
// `fields` may be a function (e.g. Transport's mode-dependent list).
function fieldsWithTagPickerLock(fields, locked) {
  if (!locked) return fields;
  var lockOne = function (list) {
    return list.map(function (f) { return f.type === 'tag-picker' ? Object.assign({}, f, { locked: true }) : f; });
  };
  return (typeof fields === 'function') ? function (values) { return lockOne(fields(values)); } : lockOne(fields);
}

function sectionsWithTagPickerLock(sections, locked) {
  if (!locked) return sections;
  var lockSections = function (list) {
    return list.map(function (section) {
      return Object.assign({}, section, { fields: fieldsWithTagPickerLock(section.fields, true) });
    });
  };
  return typeof sections === 'function' ? function (values) { return lockSections(sections(values)); } : lockSections(sections);
}

function suggestInputHtml(field, val, req, suggestType, extraAttrs, placeholderFallback) {
  var placeholder = field.placeholder || placeholderFallback || '';
  var listId = field.key + '-suggest';
  return '<div class="suggest-input-wrap">' +
    '<input type="text" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="' + listId + '" data-suggest-type="' + suggestType + '" ' + (extraAttrs || '') +
    ' name="' + field.key + '" value="' + esc(val) + '" ' + req +
    ' placeholder="' + esc(placeholder) + '">' +
    '<div class="suggest-list" id="' + listId + '" role="listbox"></div>' +
    '<span class="sr-only" id="' + listId + '-status" role="status" aria-live="polite"></span>' +
    '</div>';
}

// One shared location control used by destinations, activities, stays and
// both transport endpoints. The parent form chooses its query field and a
// prefix for the normalized hidden values; the interaction itself stays the
// same everywhere, including local airport and manual-pin paths.
function locationPickerHtml(field, val, req, trip, allValues) {
  var prefix = field.locationPrefix;
  var values = allValues || {};
  var lat = values[prefix + 'Lat'];
  var lng = values[prefix + 'Lng'];
  var method = values[prefix + 'LocationMethod'] || '';
  var stale = values[prefix + 'LocationStale'] === true || values[prefix + 'LocationStale'] === 'true';
  var mapped = lat !== '' && lat !== undefined && lat !== null && lng !== '' && lng !== undefined && lng !== null;
  var summary = mapped
    ? '<div class="location-selected' + (stale ? ' is-stale' : '') + '" data-location-summary>' +
        '<span class="location-selected-status">' + (stale ? 'Location may not match' : (method === 'manual' ? 'Manual pin' : 'Mapped')) + '</span>' +
        '<span>' + esc(field.summaryLabel || '') + '</span></div>'
    : '<div class="location-selected" data-location-summary hidden><span class="location-selected-status"></span><span></span></div>';
  var hidden = [
    [prefix + 'Lat', lat], [prefix + 'Lng', lng], [prefix + 'LocationRef', values[prefix + 'LocationRef'] || ''],
    [prefix + 'LocationMethod', method], [prefix + 'LocationGranularity', values[prefix + 'LocationGranularity'] || ''],
    [prefix + 'LocationStale', stale ? 'true' : 'false'], [prefix + 'LocationKindLabel', values[prefix + 'LocationKindLabel'] || '']
  ];
  if (field.boundaryPrefix) {
    hidden.push([field.boundaryPrefix + 'Ref', values[field.boundaryPrefix + 'Ref'] || '']);
    hidden.push([field.boundaryPrefix + 'Quality', values[field.boundaryPrefix + 'Quality'] || '']);
    var boundaryBbox = values[field.boundaryPrefix + 'Bbox'];
    hidden.push([field.boundaryPrefix + 'Bbox', boundaryBbox ? (typeof boundaryBbox === 'string' ? boundaryBbox : JSON.stringify(boundaryBbox)) : '']);
  }
  if (field.addressKey) hidden.push([field.addressKey, values[field.addressKey] || '']);
  var hiddenHtml = hidden.map(function (pair) { return '<input type="hidden" name="' + esc(pair[0]) + '" value="' + esc(pair[1]) + '">'; }).join('');
  var inputId = 'location-input-' + prefix;
  var locationInputHtml = '<div class="location-input-panel" data-location-input-panel id="' + esc(inputId + '-panel') + '" hidden>' +
    '<label for="' + esc(inputId) + '">Coordinates, Plus Code or map link</label>' +
    '<input type="text" id="' + esc(inputId) + '" data-location-input maxlength="2048" autocomplete="off" spellcheck="false" autocapitalize="off" aria-describedby="' + esc(inputId + '-help') + ' ' + esc(inputId + '-hint') + '" placeholder="51.5074, -0.1278 or 9C3XGV4C+XV">' +
    '<p class="field-hint" id="' + esc(inputId + '-help') + '">Latitude first, longitude second. Use decimal coordinates, degrees/minutes/seconds, a full Plus Code, or a Google Maps link containing coordinates.</p>' +
    '<div class="location-reference-row" data-location-reference-row hidden><label class="checkbox-field"><input type="checkbox" data-location-reference><span data-location-reference-label>Use the selected destination as the nearby reference for a short Plus Code</span></label></div>' +
    '<button type="button" class="btn location-input-preview" data-action="preview-location-input">Preview location</button>' +
    '<div class="field-hint" id="' + esc(inputId + '-hint') + '" data-location-input-hint role="status" aria-live="polite" aria-atomic="true"></div>' +
    '<div class="location-input-candidate" data-location-candidate hidden><p class="location-input-candidate-label" data-location-candidate-label></p>' +
    '<div class="location-pin-map" data-location-candidate-map aria-label="Location preview"></div>' +
    '<button type="button" class="btn btn-primary" data-action="apply-location-input">Use this location</button></div></div>';
  return '<div class="location-picker" data-location-picker data-location-prefix="' + esc(prefix) + '" data-location-context="' + esc(field.locationContext) + '" data-location-kind="' + esc(field.locationKind || 'point') + '"' +
    (field.addressKey ? ' data-location-address-key="' + esc(field.addressKey) + '"' : '') +
    (field.locationValue ? ' data-location-value="' + esc(field.locationValue) + '"' : '') +
    (field.countryKey ? ' data-location-country-key="' + esc(field.countryKey) + '"' : '') +
    (field.boundaryPrefix ? ' data-boundary-prefix="' + esc(field.boundaryPrefix) + '"' : '') + '>' +
    '<div class="location-picker-row"><input type="text" autocomplete="off" name="' + field.key + '" value="' + esc(val) + '" ' + req + ' placeholder="' + esc(field.placeholder || '') + '" data-location-query>' +
    '<button type="button" class="btn" data-action="search-location">Find location</button></div>' +
    hiddenHtml + '<div class="location-results" data-location-results hidden role="region" aria-label="Location search results" aria-live="polite" aria-atomic="true"></div>' + summary +
    '<div class="location-picker-actions"><button type="button" class="btn btn-ghost" data-action="use-typed-location">Use typed location</button>' +
    '<button type="button" class="btn btn-ghost" data-action="toggle-location-input" aria-expanded="false" aria-controls="' + esc(inputId + '-panel') + '">Coordinates or code</button>' +
    '<button type="button" class="btn btn-ghost" data-action="set-location-pin">Set pin manually</button>' +
    (mapped ? '<button type="button" class="btn btn-ghost" data-action="preview-location">View on map</button>' : '') + '</div>' + locationInputHtml +
    '<div class="location-pin-map" data-location-pin-map></div><div class="field-hint" data-location-hint role="status" aria-live="polite" aria-atomic="true"></div></div>';
}

function journeyUtcMinutes(date, time) {
  if (!date) return null;
  var dateParts = String(date).split('-').map(Number);
  var timeParts = String(time || '00:00').split(':').map(Number);
  if (dateParts.length !== 3 || dateParts.some(function (part) { return !isFinite(part); })) return null;
  return Date.UTC(dateParts[0], dateParts[1] - 1, dateParts[2], timeParts[0] || 0, timeParts[1] || 0) / 60000;
}

function journeyDurationModel(config, values) {
  var startDate = values[config.startDateKey] || '';
  var endDate = values[config.endDateKey] || '';
  if (!startDate || !endDate) return { label: 'Duration', filled: 0, total: 12 };
  var startDay = journeyUtcMinutes(startDate, '00:00');
  var endDay = journeyUtcMinutes(endDate, '00:00');
  if (startDay === null || endDay === null || endDay < startDay) return { label: 'Check dates', filled: 0, total: 12 };
  var dayDifference = Math.round((endDay - startDay) / 1440);
  if (config.durationKind === 'nights') {
    var nights = Math.max(0, dayDifference);
    if (nights === 0) return { label: 'Same-day stay', filled: 1, total: 1 };
    return { label: nights + ' night' + (nights === 1 ? '' : 's'), filled: Math.min(12, Math.max(1, nights)), total: Math.min(12, Math.max(1, nights)) };
  }
  if (config.dateOnly) {
    var days = dayDifference + (config.inclusive === false ? 0 : 1);
    return { label: days + ' day' + (days === 1 ? '' : 's'), filled: Math.min(12, Math.max(1, days)), total: Math.min(12, Math.max(1, days)) };
  }
  var startTime = values[config.startTimeKey] || '';
  var endTime = values[config.endTimeKey] || '';
  var allDay = config.allDayKey && (values[config.allDayKey] === true || values[config.allDayKey] === 'true' || values[config.allDayKey] === 'on');
  if (allDay || !startTime || !endTime) {
    var calendarDays = dayDifference + 1;
    return { label: allDay ? calendarDays + ' day' + (calendarDays === 1 ? '' : 's') : 'Add both times', filled: Math.min(12, Math.max(1, calendarDays)), total: Math.min(12, Math.max(1, calendarDays)) };
  }
  var minutes = journeyUtcMinutes(endDate, endTime) - journeyUtcMinutes(startDate, startTime);
  if (!isFinite(minutes) || minutes < 0) return { label: 'Check times', filled: 0, total: 12 };
  var hours = Math.floor(minutes / 60), remainder = minutes % 60;
  var label = (hours ? hours + ' hour' + (hours === 1 ? '' : 's') : '') + (hours && remainder ? ' ' : '') + (remainder ? remainder + ' min' : (!hours ? '0 min' : ''));
  var units = Math.max(1, Math.ceil(minutes / 120));
  return { label: label, filled: Math.min(12, units), total: Math.min(12, Math.max(6, units)) };
}

function journeyStripHtml(model) {
  var segments = '';
  for (var i = 0; i < model.total; i += 1) segments += '<span class="journey-duration-segment' + (i < model.filled ? ' is-filled' : '') + '"></span>';
  return segments;
}

function journeyLocalLabel(config, values, trip, end) {
  if (end && config.endLocalLabel) return config.endLocalLabel;
  if (!end && config.startLocalLabel) return config.startLocalLabel;
  var timezone = config.timezoneKey ? values[config.timezoneKey] : '';
  if (!timezone && config.destinationKey && values[config.destinationKey] && trip) {
    var destination = byId(trip.destinations || [], values[config.destinationKey], 'destinationId');
    timezone = destination && destination.timezone;
  }
  return timezone ? timezone + (tzOffsetLabel(timezone) ? ' · ' + tzOffsetLabel(timezone) : '') : 'Local time';
}

// Journey is a view-model adapter: each record keeps its existing field names
// and storage shape, while every form receives the same semantic rail, separate
// date/time cards, summary and segmented duration strip.
function journeyTimingHtml(field, values, trip) {
  var config = field.journey;
  var startDate = values[config.startDateKey] || '';
  var defaultEnd = startDate ? addDays(startDate, config.defaultEndOffsetDays || 0) : '';
  var endDate = values[config.endDateKey] || defaultEnd;
  var autoKey = '__journeyAuto_' + field.key;
  var autoEnd = values[autoKey] === undefined ? (!values[config.endDateKey] || values[config.endDateKey] === defaultEnd) : values[autoKey] !== 'false';
  var allDay = !!(config.allDayKey && (values[config.allDayKey] === true || values[config.allDayKey] === 'true' || values[config.allDayKey] === 'on'));
  var modelValues = Object.assign({}, values); modelValues[config.startDateKey] = startDate; modelValues[config.endDateKey] = endDate;
  var duration = journeyDurationModel(config, modelValues);
  var configAttrs = ' data-journey data-start-date="' + config.startDateKey + '" data-end-date="' + config.endDateKey + '" data-start-time="' + (config.startTimeKey || '') + '" data-end-time="' + (config.endTimeKey || '') + '" data-auto-key="' + autoKey + '" data-default-end-offset="' + (config.defaultEndOffsetDays || 0) + '" data-duration-kind="' + esc(config.durationKind || 'elapsed') + '" data-inclusive="' + String(config.inclusive !== false) + '" data-timezone-key="' + esc(config.timezoneKey || '') + '" data-destination-key="' + esc(config.destinationKey || '') + '" data-start-local-label="' + esc(config.startLocalLabel || '') + '" data-end-local-label="' + esc(config.endLocalLabel || '') + '"' + (config.dateOnly ? ' data-date-only="true"' : '') + (config.allDayKey ? ' data-all-day="' + config.allDayKey + '"' : '');
  function momentHtml(prefix, dateKey, timeKey, dateValue, timeValue, localLabel, endMoment) {
    return '<div class="journey-moment"><div class="journey-moment-head"><strong>' + esc(prefix) + '</strong><span class="journey-local-label" data-journey-local="' + (endMoment ? 'end' : 'start') + '">' + esc(localLabel) + '</span></div><div class="journey-date-time-row">' +
      '<div class="field journey-date-field">' + icon('date') + '<label>' + esc(prefix) + ' date</label><input type="date" name="' + dateKey + '" value="' + esc(dateValue) + '"' + (endMoment ? ' min="' + esc(startDate) + '"' : '') + ' required></div>' +
      (config.dateOnly ? '' : '<div class="field journey-time-field">' + icon('time') + '<label>' + esc(prefix) + ' time</label><input type="time" name="' + timeKey + '" value="' + esc(timeValue || '') + '"' + (allDay ? ' disabled' : '') + '></div>') +
    '</div></div>';
  }
  return '<fieldset class="field journey' + (allDay ? ' is-all-day' : '') + (config.dateOnly ? ' is-date-only' : '') + ' field-wide"' + configAttrs + '>' +
    '<legend>' + esc(field.label || 'When') + '</legend>' +
    '<input type="hidden" name="' + autoKey + '" value="' + String(autoEnd) + '" data-journey-auto>' +
    (config.allDayKey ? '<label class="checkbox-field journey-all-day"><input type="checkbox" name="' + config.allDayKey + '"' + (allDay ? ' checked' : '') + '> All day</label>' : '') +
    '<div class="journey-grid"><div class="journey-rail" aria-hidden="true"><span class="journey-dot"></span><span class="journey-dot"></span></div><div class="journey-moments">' +
      momentHtml(config.startLabel, config.startDateKey, config.startTimeKey, startDate, values[config.startTimeKey], journeyLocalLabel(config, values, trip, false), false) +
      '<div class="journey-duration"><span class="journey-duration-label" data-journey-duration role="status" aria-live="polite" aria-atomic="true">' + esc(duration.label) + '</span><span class="journey-duration-strip" data-journey-strip aria-hidden="true">' + journeyStripHtml(duration) + '</span></div>' +
      momentHtml(config.endLabel, config.endDateKey, config.endTimeKey, endDate, values[config.endTimeKey], journeyLocalLabel(config, values, trip, true), true) +
    '</div></div></fieldset>';
}

function fieldHtml(field, value, trip, allValues) {
  // allValues (optional): every value currently in the form (initial or
  // live on a reactive re-render, see fieldsHtml() below), so a field
  // can peek at a sibling's value. Only 'flight-lookup' uses this today.
  var val = (value === undefined || value === null) ? '' : value;
  var req = field.required ? 'required' : '';
  var fullClass = field.wide ? ' field-wide' : '';

  // Rendered separately: a checkbox reads naturally with its label next
  // to it on one line, not a block label above the input. Always
  // full-width (callers mark every checkbox `wide: true`) so it's never
  // paired into a two-column row.
  if (field.type === 'checkbox') {
    return '<div class="field' + fullClass + '"><label class="checkbox-field">' +
      '<input type="checkbox" name="' + field.key + '"' + (val ? ' checked' : '') + '> ' + esc(field.label) + '</label>' +
      (field.hint ? '<div class="field-hint">' + esc(field.hint) + '</div>' : '') + '</div>';
  }

  // Also rendered separately, like 'checkbox': a multi-select (several
  // companions tagged to one item) doesn't fit the "one <input>, one
  // value" shape the switch below assumes. See readTagPicker() above for
  // the read-back side and why each checkbox gets its own unique name.
  if (field.type === 'tag-picker') {
    var companions = taggablePeople(trip);
    if (companions.length === 0) {
      return '<div class="field' + fullClass + '"><label>' + esc(field.label) + '</label>' +
        '<div class="field-hint">No companions added yet — add some on the Companions tab to tag them here.</div></div>';
    }
    var pickerItems = companions.slice().sort(function (a, b) {
      if (!!a.isSuperuser !== !!b.isSuperuser) return a.isSuperuser ? -1 : 1;
      return a.name.localeCompare(b.name);
    }).map(function (c) {
      // Checked if `val` is the record's saved array of companion ids, OR
      // (on a reactive re-render, where `val` is blank) the uniquely-named
      // checkbox shows up checked in `allValues` instead.
      var checked = (Array.isArray(val) && val.indexOf(c.companionId) !== -1) || (allValues && allValues[field.key + '__' + c.companionId]);
      // `field.locked` (fieldsWithTagPickerLock()) disables every checkbox
      // -- a disabled checkbox is left out of FormData entirely, matching
      // what the Worker enforces server-side.
      return '<label class="tag-picker-item"><input type="checkbox" name="' + field.key + '__' + c.companionId + '" data-tag-picker-key="' + field.key + '" data-tag-person-id="' + c.companionId + '"' + (checked ? ' checked' : '') + (field.locked ? ' disabled' : '') + '> ' + companionAvatarHtml(trip, c.companionId, c.name) + esc(c.name) + (c.isSuperuser ? '<span class="tag-picker-role">Trip Owner</span>' : '') + '</label>';
    }).join('');
    return '<div class="field' + fullClass + '"><label>' + esc(field.label) + '</label><div class="tag-picker">' + pickerItems + '</div>' +
      // Filled in by syncTagPickerAwayWarning() as the form is used --
      // empty, and hidden, until somebody is tagged into a day they are
      // not on the trip for. Advisory: it never blocks the save.
      '<div class="field-hint tag-picker-away" data-tag-away hidden></div>' +
      (field.locked ? '<div class="field-hint">Who this is tagged to isn\'t something you can change.</div>' : (field.hint ? '<div class="field-hint">' + esc(field.hint) + '</div>' : '')) +
      '</div>';
  }

  if (field.type === 'journey') return journeyTimingHtml(field, allValues || {}, trip);

  var inputHtml;
  switch (field.type) {
    case 'location-picker':
      inputHtml = locationPickerHtml(field, val, req, trip, allValues);
      break;
    case 'text':
      inputHtml = '<input type="text" name="' + field.key + '" value="' + esc(val) + '" ' + req +
        ' placeholder="' + esc(field.placeholder || '') + '">';
      break;
    case 'number':
      // FX rates need more precision than currency amounts (JPY → GBP, for
      // example, is often less than 0.01). Validate positivity on submission.
      var rateField = field.key === 'costRate' || field.key === 'rateOverride';
      inputHtml = '<input type="number" step="' + (rateField ? 'any' : '0.01') + '" name="' + field.key + '" value="' + esc(val) + '" ' + req + '>';
      break;
    case 'date':
      inputHtml = '<input type="date" name="' + field.key + '" value="' + esc(val) + '" ' + req + '>';
      break;
    case 'time':
      inputHtml = '<input type="time" name="' + field.key + '" value="' + esc(val) + '">';
      break;
    case 'textarea':
      inputHtml = '<textarea name="' + field.key + '" rows="3" placeholder="' + esc(field.placeholder || '') + '">' + esc(val) + '</textarea>';
      break;
    case 'select':
      inputHtml = '<select name="' + field.key + '">' + field.options.map(function (o) {
        return '<option value="' + esc(o) + '" ' + (o === val ? 'selected' : '') + '>' + esc(o) + '</option>';
      }).join('') + '</select>';
      break;
    case 'currency':
      inputHtml = suggestInputHtml(field, val, req, 'currency', 'maxlength="6" class="settings-uppercase"', 'GBP');
      break;
    case 'country':
      inputHtml = suggestInputHtml(field, val, req, 'country', 'maxlength="60"');
      break;
    case 'city':
      // Same idea as 'country' — a suggestion list of common cities,
      // but the input still happily accepts anything typed (a smaller
      // town that isn't in the shortlist, a neighbourhood name, etc).
      inputHtml = suggestInputHtml(field, val, req, 'city', 'maxlength="80"');
      break;
    case 'airport':
      // Suggestions show as "CODE — Name" but nothing forces that shape
      // -- a 3-letter code or a city name is equally valid. Uses the
      // same suggestInputHtml() dropdown as currency/country/city/
      // timezone (see "Generic suggestion dropdown" below).
      //
      // The hint underneath is airport-specific: a live signal of
      // whether the typed text resolves to a real coordinate, checked
      // against the same two sources (COMMON_AIRPORTS, then AIRPORT_DB)
      // openTransportForm()'s onSubmit uses when saved, via
      // airportCoordsFromText(). Computed once here, then kept live by
      // the shared 'input' listener's airport-specific branch.
      var airportResolved = airportCoordsFromText(val);
      var airportHintText = !val ? ''
        : (airportResolved ? '✓ Mapped precisely for the Map tab' : 'No exact airport match yet — the map will try to search by name instead.');
      var airportHintClass = 'field-hint airport-resolve-hint' + (val ? (airportResolved ? ' is-ok' : ' is-unresolved') : '');
      inputHtml = suggestInputHtml(field, val, req, 'airport', 'maxlength="80"', 'e.g. LHR or Heathrow') +
        '<div class="' + airportHintClass + '" id="' + field.key + '-resolve-hint">' + esc(airportHintText) + '</div>';
      break;
    case 'flight-lookup':
      // A text input, a date input, and a "Look up" button — calls
      // /WayPoint/api/flight-lookup (see the click delegation handler's
      // 'lookup-flight' branch) and fills in Airline/From/To/times on
      // success. AeroDataBox needs a date too; the date input here is
      // deliberately not a named form field (no `name`, not submitted)
      // -- just a place to confirm the lookup date. performFlightLookup()
      // falls back to "Depart date" if this is blank, and copies
      // whichever date was used back into "Depart date" on success, so
      // the two never disagree. Pre-filled from "Depart date" via the
      // `allValues` argument. The status line reports what happened.
      var lookupDateDefault = (allValues && allValues.departDate) || '';
      inputHtml = '<div class="flight-lookup-row">' +
        '<input class="flight-lookup-code" type="text" maxlength="10" ' +
        'name="' + field.key + '" value="' + esc(val) + '" ' + req +
        ' placeholder="' + esc(field.placeholder || '') + '">' +
        '<input class="flight-lookup-date" type="date" id="flight-lookup-date" aria-label="Flight lookup date" value="' + esc(lookupDateDefault) + '">' +
        '<button type="button" class="btn" data-action="lookup-flight">Look up</button>' +
        '</div>' +
        '<div class="field-hint">Pick the date to look up right here — defaults to "Depart date" below once that\'s filled in, and fills it back in for you either way.</div>' +
        '<div class="flight-lookup-status" id="flight-lookup-status" role="status" aria-live="polite" aria-atomic="true"></div>';
      break;
    case 'timezone':
      inputHtml = suggestInputHtml(field, val, req, 'timezone', 'maxlength="40"') +
        (val ? '<div class="field-hint">Currently ' + esc(tzOffsetLabel(val) || 'unrecognised') + '</div>' : '');
      break;
    case 'select-destination':
      inputHtml = '<select name="' + field.key + '"><option value="">—</option>' + (trip.destinations || []).map(function (d) {
        return '<option value="' + d.destinationId + '" ' + (d.destinationId === val ? 'selected' : '') + '>' + esc(d.name) + '</option>';
      }).join('') + '</select>';
      break;
    case 'select-contact':
      inputHtml = '<select name="' + field.key + '"><option value="">—</option>' + (trip.contacts || []).map(function (c) {
        return '<option value="' + c.contactId + '" ' + (c.contactId === val ? 'selected' : '') + '>' + esc(c.name) + '</option>';
      }).join('') + '</select>';
      break;
    // A row of colour swatches over visually-hidden native radio buttons
    // (.avatar-swatch-radio), needing no custom click-handling JS. Used
    // for a companion's smiley colour (COMPANION_FIELDS/
    // COMPANION_FIELDS_LIMITED, openCompanionForm()) -- the account-holder
    // picker is its own modal, openAvatarPicker(). `c.hex` comes straight
    // from AVATAR_COLORS, a fixed local constant, not a stored/network
    // value, so this isn't the risk avatarColorHex() guards against
    // elsewhere (see avatarMarkerHtml()).
    case 'avatar-color':
      inputHtml = '<div class="avatar-swatch-grid">' + AVATAR_COLORS.map(function (c) {
        return '<label class="avatar-swatch-label" title="' + esc(c.token) + '">' +
          '<input type="radio" class="avatar-swatch-radio" name="' + field.key + '" value="' + c.token + '"' + (val === c.token ? ' checked' : '') + '>' +
          '<span class="avatar-swatch-btn" style="background:' + c.hex + '"></span>' +
          '</label>';
      }).join('') + '</div>';
      break;
    default:
      inputHtml = '';
  }
  return '<div class="field' + fullClass + '"><label>' + esc(field.label) + '</label>' + inputHtml +
    (field.hint ? '<div class="field-hint">' + esc(field.hint) + '</div>' : '') + '</div>';
}

// Groups adjacent short fields into two-column rows so the form doesn't
// feel like one long column; textareas and fields marked `wide` always
// take full width. A blacklist rather than a whitelist, so a new
// short-input field type doesn't need this list updated too.
function isPairableField(f) {
  return f.type !== 'textarea' && !f.wide;
}

function fieldsHtml(fields, initial, trip) {
  var out = '';
  var i = 0;
  while (i < fields.length) {
    var f = fields[i];
    var pairable = isPairableField(f);
    var next = fields[i + 1];
    var nextPairable = next && isPairableField(next);
    if (pairable && nextPairable) {
      out += '<div class="field-row">' + fieldHtml(f, initial[f.key], trip, initial) + fieldHtml(next, initial[next.key], trip, initial) + '</div>';
      i += 2;
    } else {
      out += fieldHtml(f, initial[f.key], trip, initial);
      i += 1;
    }
  }
  return out;
}

function sectionHasSavedValues(section, initial) {
  var fields = typeof section.fields === 'function' ? section.fields(initial) : section.fields;
  return fields.some(function (field) {
    var value = initial[field.key];
    if (field.disclosureNeutral !== undefined && value === field.disclosureNeutral) return false;
    return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null && value !== '' && value !== false;
  });
}

// Activity and accommodation forms have enough optional booking/cost data
// that one undivided field list feels like work before someone has even
// recorded the core plan. Essentials stay visible; optional sections are
// progressive disclosure, and reopen automatically when editing data they
// already contain so nothing saved appears to have vanished.
function formSectionsHtml(sections, initial, trip) {
  return sections.map(function (section) {
    var heading = '<div class="form-section-head"><h3>' + esc(section.title) + '</h3>' +
      (section.hint ? '<p>' + esc(section.hint) + '</p>' : '') + '</div>';
    var resolvedSectionFields = typeof section.fields === 'function' ? section.fields(initial) : section.fields;
    var fields = fieldsHtml(resolvedSectionFields, initial, trip);
    if (section.collapsible) {
      var open = section.open || sectionHasSavedValues(section, initial);
      return '<details class="form-details"' + (open ? ' open' : '') + '><summary>' + esc(section.title) + icon('collapse', 'form-details-chevron') + '</summary>' +
        '<div class="form-details-body">' + (section.hint ? '<p class="field-hint form-details-hint">' + esc(section.hint) + '</p>' : '') + fields + '</div></details>';
    }
    return '<section class="form-section">' + heading + fields + '</section>';
  }).join('');
}

function formFieldsHtml(opts, values) {
  var sections = typeof opts.sections === 'function' ? opts.sections(values) : opts.sections;
  if (!sections) sections = [{ title: 'Essentials', fields: resolveFields(opts, values) }];
  return formSectionsHtml(sections, values, opts.trip || {});
}

// opts.fields is usually a plain array, but can instead be a function
// of the form's current values — that's how the transport form swaps
// in flight-only or car-only fields as soon as "Mode" changes. This
// always resolves it to a plain array.
function resolveFields(opts, values) {
  return (typeof opts.fields === 'function') ? opts.fields(values) : opts.fields;
}

// Reads every field currently in a live <form> into a plain object,
// so a reactive re-render (see openForm's `change` handling below)
// can carry over whatever the viewer already typed.
function currentFormValues(formEl) {
  var fd = new FormData(formEl);
  var values = {};
  fd.forEach(function (v, k) { values[k] = v; });
  return values;
}

function openForm(opts) {
  // opts: { title, fields|sections, initial, trip, submitLabel, onSubmit,
  //         reactiveKey } — reactiveKey names a field (e.g. "mode"), or
  // an array of them, that when changed should recompute a
  // function-valued `fields` and re-render just the field list,
  // keeping everything else typed.
  window.__formConfig = opts;
  var root = document.getElementById('modal-root');
  disposeLocationPickers(root);
  var initial = opts.initial || {};
  root.innerHTML =
    '<div class="modal-backdrop" data-action="close-modal">' +
      '<div class="modal">' +
        '<div class="modal-head"><h2>' + esc(opts.title) + '</h2>' +
          '<button class="btn btn-icon btn-ghost" data-action="close-modal" aria-label="Close dialog" title="Close">' + icon('close') + '</button></div>' +
        '<form id="entity-form">' +
          '<div class="modal-body" id="modal-fields">' + formFieldsHtml(opts, initial) + '</div>' +
          '<div class="modal-foot">' +
            '<button type="button" class="btn" data-action="close-modal">Cancel</button>' +
            '<button type="submit" class="btn btn-primary">' + esc(opts.submitLabel || 'Save') + '</button>' +
          '</div>' +
        '</form>' +
      '</div>' +
    '</div>';
  // No <datalist> elements to seed here — every suggestible field
  // renders its own app-managed dropdown via suggestInputHtml(), built
  // on demand. See "Generic suggestion dropdown" further down.

  // Evaluate the part-trip warning once on open, so editing a record that
  // already tags someone into a day they're away reports it straight away
  // rather than only after the next change.
  syncTagPickerAwayWarning(root.querySelector('#entity-form'));
}
