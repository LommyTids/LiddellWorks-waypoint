/* ---------- 24. Event delegation ------------------------------------------------
   One click listener and one submit listener handle every interaction
   in the app, keyed off `data-action` attributes. This means we never
   have to re-attach listeners after re-rendering a panel's HTML. */

document.addEventListener('click', function (e) {
  // The anchored account menu behaves like a transient popover: clicking
  // anywhere outside closes it without consuming the underlying action.
  if (accountMenuOpen && !e.target.closest('.account-menu')) {
    accountMenuOpen = false;
    applyAuthUI();
  }
  // Same treatment for a day's add menu, except that choosing one of its own
  // items closes it too -- that item opens a modal, and the menu must not be
  // left sitting open behind the dialog.
  if (e.target.closest) {
    var chosenAddItem = e.target.closest('.day-add-item');
    closeDayAddMenus(chosenAddItem ? null : e.target.closest('.day-add'));
  }
  var el = e.target.closest('[data-action]');
  if (!el) return;
  var action = el.dataset.action;
  var trip = currentTripId ? currentTrip() : null;

  if (action === 'retry-connection') { retryConnection(); return; }
  if (isMutationAction(action) && !editingAvailable()) {
    setSaveStatus('readonly', connectionState === 'offline' ? 'Offline' : 'Editing locked');
    updateSystemFeedback();
    return;
  }

  if (action === 'close-modal') {
    // The backdrop has data-action="close-modal" too (click outside to
    // dismiss) -- but a click starting inside the modal with no more
    // specific data-action ancestor would otherwise bubble up and close
    // it by accident. Only treat it as "clicked the backdrop" when the
    // click's actual target IS the backdrop, not a descendant of it.
    if (el.classList.contains('modal-backdrop') && e.target !== el) return;
    closeModal();
    return;
  }
  if (action === 'confirm-yes') { var fn = pendingConfirm; closeModal(); if (fn) fn(); return; }
  if (action === 'copy-text') {
    var value = el.dataset.value;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(function () {
        var originalLabel = el.getAttribute('aria-label') || 'Copy';
        el.classList.add('is-confirmed');
        el.setAttribute('aria-label', 'Copied');
        el.innerHTML = icon('saved');
        announceStatus('Copied to clipboard');
        setTimeout(function () {
          if (!el.isConnected) return;
          el.classList.remove('is-confirmed');
          el.setAttribute('aria-label', originalLabel);
          el.innerHTML = icon('copy');
        }, 1800);
      }).catch(function () { showToast('Could not copy to the clipboard.', 'error'); });
    }
    return;
  }
  if (action === 'open-trip') { currentView = 'trip'; currentTripId = el.dataset.id; currentTab = 'timeline'; rememberMobileChild(currentTab); saveNavigationState(); pendingRenderFocus = '[data-page-heading]'; render(); return; }
  if (action === 'back-to-dashboard') { currentView = 'dashboard'; currentTripId = null; saveNavigationState(); pendingRenderFocus = '[data-page-heading]'; render(); return; }
  if (action === 'switch-tab') { currentTab = el.dataset.tab; rememberMobileChild(currentTab); saveNavigationState(); pendingRenderFocus = '#trip-panel'; render(); return; }
  // The viewing lens (Settings > What you see, the header chip, and the
  // way out offered by an emptied tab). Purely a redraw: nothing is sent
  // to the server, and nobody else's view of this trip changes.
  if (action === 'set-item-scope') {
    if (!trip) return;
    itemScopePreference[trip.tripId] = el.dataset.scope === 'mine' ? 'mine' : 'everything';
    saveNavigationState();
    render();
    return;
  }
  if (action === 'toggle-card-text') {
    // Scrolling the people line, opening the metadata disclosure, copying a
    // reference or following a link are their own gestures -- none of them is
    // a request to open the note.
    if (e.target.closest('.item-people, .item-meta-more, .copy-btn, a')) return;
    var noteCard = el.closest('.item-row');
    if (!noteCard) return;
    var noteOpen = !noteCard.classList.contains('is-expanded');
    noteCard.classList.toggle('is-expanded', noteOpen);
    var noteToggle = noteCard.querySelector('.item-more');
    if (noteToggle) {
      noteToggle.setAttribute('aria-expanded', String(noteOpen));
      noteToggle.textContent = noteOpen ? 'Less' : 'More';
    }
    // A collapsed note may no longer overflow at this width, so re-measure
    // rather than leaving a control that now does nothing.
    if (!noteOpen) markTruncatedNotes();
    return;
  }
  if (action === 'toggle-timeline-day' && trip) {
    var timelineDay = el.dataset.day;
    var nextExpanded = el.getAttribute('aria-expanded') !== 'true';
    timelineDayExpansion[timelineDayKey(trip.tripId, timelineDay)] = nextExpanded;
    // Updated in place rather than re-rendered: a full render would lose the
    // reader's scroll position on what can be a very long page. The button's
    // accessible name comes from its own content, so only the state changes.
    el.setAttribute('aria-expanded', String(nextExpanded));
    var timelineCard = el.closest('.day-card');
    var timelineContent = document.getElementById(el.getAttribute('aria-controls'));
    if (timelineCard) timelineCard.classList.toggle('is-collapsed', !nextExpanded);
    if (timelineContent) timelineContent.hidden = !nextExpanded;
    syncTimelineToolbar(trip);
    return;
  }
  if (action === 'timeline-toggle-all' && trip) {
    var expandAll = el.dataset.expand === 'true';
    tripDayList(trip).forEach(function (day) {
      timelineDayExpansion[timelineDayKey(trip.tripId, day)] = expandAll;
    });
    render();
    return;
  }
  if (action === 'timeline-jump-today' && trip) {
    var todayKey = timelineLocalTodayStr();
    timelineDayExpansion[timelineDayKey(trip.tripId, todayKey)] = true;
    render();
    requestAnimationFrame(function () {
      var todayCard = document.querySelector('[data-timeline-day="' + todayKey + '"]');
      if (!todayCard) return;
      // The reduced-motion media query governs CSS scrolling, not this
      // option, so the preference is honoured explicitly.
      var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      todayCard.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
      var todayHead = todayCard.querySelector('.day-head');
      if (todayHead) todayHead.focus({ preventScroll: true });
    });
    return;
  }
  if (action === 'switch-mobile-destination') {
    currentTab = mobileDestinationTarget(el.dataset.destination, trip);
    rememberMobileChild(currentTab);
    saveNavigationState();
    pendingRenderFocus = '#trip-panel';
    render();
    return;
  }
  if (action === 'toggle-map-layer') {
    var layerKey = el.dataset.layer;
    if (!Object.prototype.hasOwnProperty.call(mapState.visibility, layerKey)) return;
    // A filter is purely local view state. Flip its existing Leaflet layer
    // rather than rerendering the page or disturbing the map viewport.
    mapState.visibility[layerKey] = !mapState.visibility[layerKey];
    if (mapState.instance && mapState.layers && mapState.layers[layerKey]) {
      if (mapState.visibility[layerKey]) mapState.layers[layerKey].addTo(mapState.instance);
      else mapState.instance.removeLayer(mapState.layers[layerKey]);
    }
    el.classList.toggle('is-active', mapState.visibility[layerKey]);
    el.setAttribute('aria-pressed', String(mapState.visibility[layerKey]));
    updateMapRangeUi(trip);
    return;
  }
  if (action === 'reset-map-view' && trip) { resetMapView(trip); return; }
  if (action === 'map-fit-selection') { fitMapToSelection(); return; }
  if (action === 'map-toggle-fullscreen') {
    var mapShell = document.getElementById('map-shell');
    if (!mapShell) return;
    if (document.fullscreenElement === mapShell) {
      document.exitFullscreen();
    } else if (mapShell.requestFullscreen) {
      mapShell.requestFullscreen().catch(function () { showToast('Full screen is not available in this browser'); });
    } else {
      showToast('Full screen is not available in this browser');
    }
    return;
  }
  if (action === 'lookup-flight') { performFlightLookup(el); return; }
  if (action === 'toggle-account-menu') {
    accountMenuOpen = !accountMenuOpen;
    applyAuthUI();
    if (accountMenuOpen) {
      requestAnimationFrame(function () {
        var firstItem = document.querySelector('.account-popover [role="menuitem"]');
        if (firstItem) firstItem.focus();
      });
    }
    return;
  }
  if (action === 'logout') { accountMenuOpen = false; doLogout(); return; }
  if (action === 'open-avatar-picker') {
    accountMenuOpen = false;
    applyAuthUI();
    // When opened from the mobile menu, keep the durable avatar toggle as
    // the modal's return-focus target rather than the menu item just removed.
    var avatarToggle = document.querySelector('.account-menu-toggle');
    if (avatarToggle && window.matchMedia('(max-width: 768px)').matches) avatarToggle.focus();
    openAvatarPicker();
    return;
  }
  if (action === 'pick-avatar-swatch') {
    // Client-side only until Save -- swap which swatch has .is-selected
    // within THIS kind's grid (colour and animal each track their own
    // selection independently), update that kind's hidden input, then
    // refresh the shared preview so it always shows both picks together.
    var swatchForm = el.closest('form');
    if (!swatchForm) return;
    var hiddenInput = swatchForm.querySelector('input[name="' + el.dataset.kind + '"]');
    if (hiddenInput) hiddenInput.value = el.dataset.value;
    var swatchGrid = el.closest('.avatar-swatch-grid');
    if (swatchGrid) {
      Array.prototype.forEach.call(swatchGrid.querySelectorAll('.avatar-swatch-btn'), function (btn) { btn.classList.remove('is-selected'); btn.setAttribute('aria-pressed', 'false'); });
    }
    el.classList.add('is-selected');
    el.setAttribute('aria-pressed', 'true');
    updateAvatarPickerPreview(swatchForm);
    return;
  }
  if (action === 'open-manage-users') { accountMenuOpen = false; applyAuthUI(); loadAndRenderManageUsers(); return; }
  if (action === 'open-site-settings') { accountMenuOpen = false; applyAuthUI(); loadAndRenderSiteSettings(); return; }
  if (action === 'new-user') { openUserForm(); return; }
  if (action === 'edit-user') { openUserForm(managedUsers.find(function (u) { return u.id === el.dataset.id; })); return; }
  if (action === 'delete-user') { deleteUserAccount(el.dataset.id); return; }
  if (action === 'new-trip') { openTripForm(); return; }
  if (action === 'edit-trip') { openTripForm(byId(state.trips, el.dataset.id, 'tripId')); return; }
  if (action === 'delete-trip') { deleteTrip(el.dataset.id); return; }
  if (action === 'export-csv') { exportCsv(trip); return; }

  if (action === 'search-location') {
    var searchPicker = el.closest('[data-location-picker]');
    if (searchPicker) searchLocationPicker(searchPicker);
    return;
  }
  if (action === 'select-location-result') {
    var resultPicker = el.closest('[data-location-picker]');
    var resultIndex = Number(el.dataset.locationIndex);
    var candidate = resultPicker && locationPickerResults[resultPicker.dataset.locationPrefix] && locationPickerResults[resultPicker.dataset.locationPrefix][resultIndex];
    if (resultPicker && candidate) selectLocationResult(resultPicker, candidate);
    return;
  }
  if (action === 'use-typed-location') {
    var typedPicker = el.closest('[data-location-picker]');
    if (typedPicker) {
      abortLocationSearch(typedPicker);
      invalidatePickerBoundary(typedPicker, true);
      clearPickerMap(typedPicker);
      var previewButton = typedPicker.querySelector('[data-action="preview-location"]');
      if (previewButton) previewButton.remove();
      var typedResults = typedPicker.querySelector('[data-location-results]');
      if (typedResults) { typedResults.hidden = true; typedResults.innerHTML = ''; }
      var typedPrefix = typedPicker.dataset.locationPrefix;
      ['Lat', 'Lng', 'LocationRef', 'LocationMethod', 'LocationGranularity', 'LocationKindLabel'].forEach(function (suffix) { pickerSet(typedPicker, typedPrefix + suffix, ''); });
      pickerSet(typedPicker, typedPrefix + 'LocationStale', 'false');
      if (typedPicker.dataset.boundaryPrefix) {
        var boundaryPrefix = typedPicker.dataset.boundaryPrefix;
        pickerSet(typedPicker, boundaryPrefix + 'Ref', ''); pickerSet(typedPicker, boundaryPrefix + 'Quality', 'none'); pickerSet(typedPicker, boundaryPrefix + 'Bbox', '');
      }
      var typedSummary = typedPicker.querySelector('[data-location-summary]');
      if (typedSummary) typedSummary.hidden = true;
      pickerHint(typedPicker, 'Saved as text only — it will remain unmapped until you search or set a pin.');
    }
    return;
  }
  if (action === 'set-location-pin') {
    var pinPicker = el.closest('[data-location-picker]');
    if (pinPicker) openLocationPickerMap(pinPicker, true);
    return;
  }
  if (action === 'preview-location') {
    var previewPicker = el.closest('[data-location-picker]');
    if (previewPicker) openLocationPickerMap(previewPicker, false);
    return;
  }

  if (!trip) return;
  if (action === 'timeline-add-activity') {
    openActivityForm(trip, null, Object.assign({ date: el.dataset.day }, timelineDaySeed(trip, el.dataset.day)));
    return;
  }
  if (action === 'timeline-add-accommodation') {
    openAccommodationForm(trip, null, Object.assign({ checkInDate: el.dataset.day, checkOutDate: addDays(el.dataset.day, 1) }, timelineDaySeed(trip, el.dataset.day)));
    return;
  }
  if (action === 'timeline-add-transport') {
    openTransportForm(trip, null, Object.assign({ departDate: el.dataset.day, arriveDate: el.dataset.day }, timelineDaySeed(trip, el.dataset.day)));
    return;
  }
  if (action === 'new-destination') { openDestinationForm(trip); return; }
  if (action === 'edit-destination') { openDestinationForm(trip, byId(trip.destinations, el.dataset.id, 'destinationId')); return; }
  if (action === 'delete-destination') { deleteEntity(trip, 'destinations', el.dataset.id, 'destination'); return; }
  if (action === 'new-activity') { openActivityForm(trip); return; }
  if (action === 'edit-activity') { openActivityForm(trip, byId(trip.activities, el.dataset.id, 'activityId')); return; }
  if (action === 'delete-activity') { deleteEntity(trip, 'activities', el.dataset.id, 'activity'); return; }
  if (action === 'new-transport') { openTransportForm(trip); return; }
  if (action === 'edit-transport') { openTransportForm(trip, byId(trip.transport, el.dataset.id, 'transportId')); return; }
  if (action === 'delete-transport') { deleteEntity(trip, 'transport', el.dataset.id, 'transport leg'); return; }
  if (action === 'new-accommodation') { openAccommodationForm(trip); return; }
  if (action === 'edit-accommodation') { openAccommodationForm(trip, byId(trip.accommodation, el.dataset.id, 'accommodationId')); return; }
  if (action === 'delete-accommodation') { deleteEntity(trip, 'accommodation', el.dataset.id, 'accommodation'); return; }
  if (action === 'new-contact') { openContactForm(trip); return; }
  if (action === 'edit-contact') { openContactForm(trip, byId(trip.contacts, el.dataset.id, 'contactId')); return; }
  if (action === 'delete-contact') { deleteEntity(trip, 'contacts', el.dataset.id, 'contact'); return; }
  if (action === 'new-companion') { openCompanionForm(trip); return; }
  if (action === 'edit-companion') { openCompanionForm(trip, byId(trip.companions, el.dataset.id, 'companionId')); return; }
  if (action === 'delete-companion') { deleteEntity(trip, 'companions', el.dataset.id, 'companion'); return; }
  if (action === 'link-companion') { openCompanionLinkForm(trip, byId(trip.companions, el.dataset.id, 'companionId')); return; }
  if (action === 'new-linked-companion') { openAddLinkedCompanionForm(trip); return; }
  if (action === 'new-expense') { openExpenseForm(trip); return; }
  if (action === 'edit-expense') { openExpenseForm(trip, byId(trip.expenses, el.dataset.id, 'expenseId')); return; }
  if (action === 'delete-expense') { deleteEntity(trip, 'expenses', el.dataset.id, 'expense'); return; }
  if (action === 'review-map-location' && trip) {
    var section = el.dataset.section;
    var collectionName = { destination: 'destinations', activity: 'activities', transport: 'transport', accommodation: 'accommodation' }[section];
    var item = collectionName ? byId(trip[collectionName], el.dataset.id, ENTITY_ID_FIELDS[section]) : null;
    if (!item) return;
    if (section === 'destination') openDestinationForm(trip, item);
    else if (section === 'activity') openActivityForm(trip, item);
    else if (section === 'transport') openTransportForm(trip, item);
    else if (section === 'accommodation') openAccommodationForm(trip, item);
    return;
  }
});

// The two native range inputs are deliberately handled outside the generic
// click dispatcher: `input` fires continuously while a handle is dragged,
// which lets the map respond immediately without a full application render.
document.addEventListener('input', function (e) {
  var handle = e.target && e.target.dataset && e.target.dataset.mapRangeHandle;
  if (!handle || currentView !== 'trip' || currentTab !== 'map') return;
  var trip = currentTrip();
  if (!trip) return;
  var days = ensureMapRange(trip);
  var value = Math.max(0, Math.min(days.length - 1, Number(e.target.value)));
  var startIndex = days.indexOf(mapState.rangeStart);
  var endIndex = days.indexOf(mapState.rangeEnd);
  if (handle === 'start') mapState.rangeStart = days[Math.min(value, endIndex)];
  else mapState.rangeEnd = days[Math.max(value, startIndex)];
  updateMapRangeUi(trip);
  scheduleMapRefresh(trip);
});

document.addEventListener('fullscreenchange', function () {
  if (!mapState.instance) return;
  // Leaflet measures its container only at construction time. Give the
  // browser one frame to complete the fullscreen layout, then remeasure.
  requestAnimationFrame(function () {
    if (!mapState.instance) return;
    mapState.instance.invalidateSize();
    updateMapMinimumWorldZoom();
    updateMapRouteArrows();
  });
});

// Powers "reactive" forms: when a field named by the open form's
// `reactiveKey` changes, recompute the field list from the form's
// current values and re-render only #modal-fields, so switching Flight
// → Car swaps in the right fields without discarding From/To, dates,
// cost, etc. `reactiveKey` can be one name or an array -- Transport
// watches three: "Mode", "Paid with", and the exchange-rate checkbox
// (see openTransportForm()).
function journeyConfigFromElement(journey) {
  return {
    startDateKey: journey.dataset.startDate,
    endDateKey: journey.dataset.endDate,
    startTimeKey: journey.dataset.startTime,
    endTimeKey: journey.dataset.endTime,
    allDayKey: journey.dataset.allDay,
    timezoneKey: journey.dataset.timezoneKey,
    destinationKey: journey.dataset.destinationKey,
    startLocalLabel: journey.dataset.startLocalLabel,
    endLocalLabel: journey.dataset.endLocalLabel,
    dateOnly: journey.dataset.dateOnly === 'true',
    inclusive: journey.dataset.inclusive !== 'false',
    durationKind: journey.dataset.durationKind,
    defaultEndOffsetDays: Number(journey.dataset.defaultEndOffset || 0)
  };
}

function journeyValuesFromForm(form, config) {
  var values = {};
  [config.startDateKey, config.endDateKey, config.startTimeKey, config.endTimeKey, config.timezoneKey, config.destinationKey].forEach(function (key) {
    if (key && form.elements[key]) values[key] = form.elements[key].value;
  });
  if (config.allDayKey && form.elements[config.allDayKey]) values[config.allDayKey] = form.elements[config.allDayKey].checked;
  return values;
}

function updateJourneyPresentation(form, oneJourney) {
  var journeys = oneJourney ? [oneJourney] : Array.prototype.slice.call(form.querySelectorAll('[data-journey]'));
  journeys.forEach(function (journey) {
    var config = journeyConfigFromElement(journey);
    var allDayInput = config.allDayKey && form.elements[config.allDayKey];
    var allDay = !!(allDayInput && allDayInput.checked);
    journey.classList.toggle('is-all-day', allDay);
    Array.prototype.forEach.call(journey.querySelectorAll('input[type="time"]'), function (input) { input.disabled = allDay; });
    var values = journeyValuesFromForm(form, config);
    var endDate = form.elements[config.endDateKey];
    if (endDate) endDate.min = values[config.startDateKey] || '';
    var duration = journeyDurationModel(config, values);
    var label = journey.querySelector('[data-journey-duration]');
    var strip = journey.querySelector('[data-journey-strip]');
    if (label) label.textContent = duration.label;
    if (strip) strip.innerHTML = journeyStripHtml(duration);
    Array.prototype.forEach.call(journey.querySelectorAll('[data-journey-local]'), function (local) {
      local.textContent = journeyLocalLabel(config, values, window.__formConfig && window.__formConfig.trip, local.dataset.journeyLocal === 'end');
    });
  });
}

function syncJourneyEndDate(form, journey) {
  var config = journeyConfigFromElement(journey);
  var startInput = form.elements[config.startDateKey];
  var endInput = form.elements[config.endDateKey];
  var autoInput = form.elements[journey.dataset.autoKey];
  if (!startInput || !endInput) return;
  endInput.min = startInput.value || '';
  if (startInput.value && (!endInput.value || !autoInput || autoInput.value !== 'false')) {
    endInput.value = addDays(startInput.value, config.defaultEndOffsetDays || 0);
    if (autoInput) autoInput.value = 'true';
  }
}

function validateJourneyFields(form) {
  var journeys = Array.prototype.slice.call(form.querySelectorAll('[data-journey]'));
  for (var i = 0; i < journeys.length; i += 1) {
    var journey = journeys[i];
    var config = journeyConfigFromElement(journey);
    var values = journeyValuesFromForm(form, config);
    var startDate = values[config.startDateKey];
    var endDate = values[config.endDateKey];
    var endDateInput = form.elements[config.endDateKey];
    if (!startDate || !endDate) {
      showFormError(form, 'Add both dates for this journey.', form.elements[config.startDateKey] || endDateInput);
      return false;
    }
    if (endDate < startDate) {
      showFormError(form, 'The end date cannot be before the start date.', endDateInput);
      return false;
    }
    var allDay = config.allDayKey && values[config.allDayKey];
    var startTime = config.startTimeKey && values[config.startTimeKey];
    var endTime = config.endTimeKey && values[config.endTimeKey];
    if (!allDay && startDate === endDate && startTime && endTime && endTime < startTime) {
      showFormError(form, 'For a same-day journey, the end time cannot be before the start time.', form.elements[config.endTimeKey]);
      return false;
    }
  }
  return true;
}

// Catch invalid values before the optimistic save. A malformed currency or
// whitespace-only name otherwise reaches the server and locks the whole app
// as a failed save instead of keeping a correctable error beside the field.
function validateEditableFields(form) {
  var controls = Array.prototype.slice.call(form.querySelectorAll('input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled])'));
  for (var i = 0; i < controls.length; i += 1) {
    var control = controls[i], value = control.value.trim(), message = '';
    if (control.required && !value) message = 'Enter a value — spaces alone cannot be saved.';
    else if (/^(homeCurrency|costCurrency|currency)$/.test(control.name) && value && !/^[A-Za-z]{3}$/.test(value)) message = 'Use a three-letter currency code, for example GBP, USD or JPY.';
    else if ((/^(costRate|rateOverride)$/.test(control.name) || /^rate_/.test(control.name)) && value && (!Number.isFinite(Number(value)) || Number(value) <= 0)) message = 'Enter an exchange rate greater than zero, or leave it blank.';
    else if (control.dataset.suggestType === 'timezone' && value && !tzOffsetLabel(value)) message = 'Choose a recognised timezone, for example Asia/Tokyo.';
    if (message) { showFormError(form, message, control); return false; }
    if (/^(homeCurrency|costCurrency|currency)$/.test(control.name)) control.value = value.toUpperCase();
  }
  return true;
}

document.addEventListener('change', function (e) {
  var form = e.target.closest('#entity-form');
  var journey = form && e.target.closest('[data-journey]');
  if (journey) {
    var journeyConfig = journeyConfigFromElement(journey);
    if (e.target.name === journeyConfig.endDateKey) {
      var journeyAuto = form.elements[journey.dataset.autoKey];
      if (journeyAuto) journeyAuto.value = 'false';
    }
    if (e.target.name === journeyConfig.startDateKey) syncJourneyEndDate(form, journey);
    updateJourneyPresentation(form, journey);
  }

  // Timezone and destination selectors sit outside the Journey fieldset,
  // but they determine the local-time captions shown inside it.
  if (form && !journey) {
    var relatedJourney = Array.prototype.some.call(form.querySelectorAll('[data-journey]'), function (candidate) {
      return e.target.name === candidate.dataset.timezoneKey || e.target.name === candidate.dataset.destinationKey;
    });
    if (relatedJourney) updateJourneyPresentation(form);
  }

  // Ticking somebody, or moving the item's date, can both change whether
  // anyone tagged here is away that day.
  if (form && (e.target.dataset.tagPersonId || TAG_PICKER_DATE_KEYS.indexOf(e.target.name) !== -1)) {
    syncTagPickerAwayWarning(form);
  }

  var cfg = window.__formConfig;
  if (cfg && cfg.inheritDestinationPeople && form && e.target.name === 'destinationId') {
    applyDestinationPeopleDefaults(form, cfg.trip, e.target.value);
  }
  if (!cfg || !cfg.reactiveKey) return;
  var keys = Array.isArray(cfg.reactiveKey) ? cfg.reactiveKey : [cfg.reactiveKey];
  if (!form || keys.indexOf(e.target.name) === -1) return;
  var values = currentFormValues(form);
  var openSectionTitles = Array.prototype.slice.call(form.querySelectorAll('details[open] > summary')).map(function (summary) { return summary.textContent.trim(); });
  var activeName = document.activeElement && document.activeElement.name;
  var container = document.getElementById('modal-fields');
  if (container) {
    disposeLocationPickers(container);
    container.innerHTML = formFieldsHtml(cfg, values);
    enhanceAccessibility(container);
    Array.prototype.forEach.call(container.querySelectorAll('details'), function (details) {
      var summary = details.querySelector(':scope > summary');
      if (summary && openSectionTitles.indexOf(summary.textContent.trim()) !== -1) details.open = true;
    });
    updateJourneyPresentation(form);
    if (activeName && form.elements[activeName]) form.elements[activeName].focus();
  }
});

document.addEventListener('submit', function (e) {
  if (e.target.id === 'login-form') {
    e.preventDefault();
    var fdLogin = new FormData(e.target);
    submitAuthForm('/WayPoint/api/login', { username: fdLogin.get('username'), password: fdLogin.get('password') });
    return;
  }
  if (e.target.id === 'setup-form') {
    e.preventDefault();
    var fdSetup = new FormData(e.target);
    submitAuthForm('/WayPoint/api/setup', { setupKey: fdSetup.get('setupKey'), username: fdSetup.get('username'), password: fdSetup.get('password') });
    return;
  }
  if (!editingAvailable()) {
    e.preventDefault();
    setSaveStatus('readonly', connectionState === 'offline' ? 'Offline' : 'Editing locked');
    updateSystemFeedback();
    return;
  }
  if (!validateEditableFields(e.target)) return;
  if (e.target.id === 'user-form') {
    e.preventDefault();
    var fdUser = new FormData(e.target);
    var existingId = e.target.dataset.existingId || '';
    var userPayload = { username: fdUser.get('username') || '' };
    var userPassword = fdUser.get('password') || '';
    if (userPassword) userPayload.password = userPassword;
    if (existingId) userPayload.id = existingId;
    saveUserAccount(userPayload);
    return;
  }
  if (e.target.id === 'companion-link-form') {
    e.preventDefault();
    var fdLink = new FormData(e.target);
    submitCompanionAccess({
      tripId: e.target.dataset.tripId,
      companionId: e.target.dataset.companionId,
      username: (fdLink.get('username') || '').trim(),
      // fd.has('role') is false when the privilege select was rendered
      // disabled (see openCompanionLinkForm()'s roleLocked case) -- a
      // disabled field is never included in a submitted FormData at
      // all, which is exactly how submitCompanionAccess() tells "leave
      // access untouched" apart from "'' was actually chosen" (see its
      // own comment on what each value of payload.role means).
      role: fdLink.has('role') ? (fdLink.get('role') || '') : undefined,
      priorAccountId: e.target.dataset.priorAccountId || null
    });
    return;
  }
  if (e.target.id === 'add-linked-companion-form') {
    e.preventDefault();
    var fdAddLinked = new FormData(e.target);
    submitAddLinkedCompanion({
      tripId: e.target.dataset.tripId,
      name: (fdAddLinked.get('name') || '').trim(),
      username: (fdAddLinked.get('username') || '').trim(),
      role: fdAddLinked.get('role') || 'user'
    });
    // No closeModal() here -- submitAddLinkedCompanion()'s final step,
    // submitCompanionAccess(), already closes it on success (and leaves
    // it open with an error toast on failure).
    return;
  }
  if (e.target.id === 'avatar-pick-form') {
    e.preventDefault();
    var fdAvatar = new FormData(e.target);
    submitAvatarPick({ color: fdAvatar.get('color'), animal: fdAvatar.get('animal') });
    return;
  }
  if (e.target.id === 'entity-form') {
    e.preventDefault();
    var cfg = window.__formConfig;
    if (!cfg) return;
    // Read every field actually present in the form right now — for a
    // reactive form (e.g. Transport) that's whichever mode-specific
    // fields are currently shown, not a fixed list.
    var values = currentFormValues(e.target);
    if (!validateJourneyFields(e.target)) return;
    // A form can reject its own values (for example an activity whose end
    // falls before its start) and keep the modal open with a helpful toast.
    if (cfg.onSubmit(values) === false) return;
    closeModal();
    return;
  }
  if (e.target.id === 'rates-form') {
    e.preventDefault();
    // Every input here is `disabled` for a scoped "user"/"viewer" grant
    // (renderSettingsTab()), so this check is just a belt-and-braces
    // guard against an unusual browser's implicit-submit behavior. The
    // Worker would reject the save either way (see "SAVING SAFELY" in
    // src/worker.js).
    if (!canFullyEditTrip(currentTrip())) return;
    var fd2 = new FormData(e.target);
    updateState(function (next) {
      var t = byId(next.trips, currentTripId, 'tripId');
      t.homeCurrency = (fd2.get('homeCurrency') || t.homeCurrency).toUpperCase();
      var rates = {};
      usedCurrencies(t).forEach(function (cur) {
        var v = fd2.get('rate_' + cur);
        if (v !== null && v !== '') rates[cur] = Number(v);
      });
      t.currencyRates = rates;
    });
  }
});

window.addEventListener('offline', function () {
  connectionState = 'offline';
  setSaveStatus('readonly', 'Offline');
  updateSystemFeedback();
});

window.addEventListener('online', function () {
  connectionState = 'online';
  // Browser "online" only means a network route exists. Re-fetch the server
  // state before unlocking edits so an unsent optimistic change is never
  // mistaken for confirmed data.
  retryConnection({ silent: false });
});

