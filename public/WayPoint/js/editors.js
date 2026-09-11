/* ---------- 8. Open-form helpers per entity -------------------------
   Each of these prepares the right initial values (splitting combined
   date+times back into separate fields for editing) and defines what
   happens on submit (recombining them, and pushing/updating the
   record inside `updateState`). */

function currentTrip() { return byId(state.trips, currentTripId, 'tripId'); }

function pickerInitial(record, prefix) {
  var out = {};
  out[prefix + 'Lat'] = record.lat === undefined ? '' : record.lat;
  out[prefix + 'Lng'] = record.lng === undefined ? '' : record.lng;
  out[prefix + 'LocationRef'] = record.locationRef || '';
  out[prefix + 'LocationMethod'] = record.locationMethod || '';
  out[prefix + 'LocationGranularity'] = record.locationGranularity || '';
  out[prefix + 'LocationStale'] = !!record.locationStale;
  out[prefix + 'LocationKindLabel'] = record.locationKindLabel || '';
  return out;
}

function activityAddressPickerInitial(record) {
  var out = {};
  out.addressLat = record.addressLat === undefined ? '' : record.addressLat;
  out.addressLng = record.addressLng === undefined ? '' : record.addressLng;
  out.addressLocationRef = record.addressLocationRef || '';
  out.addressLocationMethod = record.addressLocationMethod || '';
  out.addressLocationGranularity = record.addressLocationGranularity || '';
  out.addressLocationStale = !!record.addressLocationStale;
  out.addressLocationKindLabel = record.addressLocationKindLabel || '';
  return out;
}

function transportPickerInitial(record, prefix) {
  var out = {};
  out[prefix + 'Lat'] = record[prefix + 'Lat'] === undefined ? '' : record[prefix + 'Lat'];
  out[prefix + 'Lng'] = record[prefix + 'Lng'] === undefined ? '' : record[prefix + 'Lng'];
  out[prefix + 'LocationRef'] = record[prefix + 'LocationRef'] || '';
  out[prefix + 'LocationMethod'] = record[prefix + 'LocationMethod'] || '';
  out[prefix + 'LocationGranularity'] = record[prefix + 'LocationGranularity'] || '';
  out[prefix + 'LocationStale'] = !!record[prefix + 'LocationStale'];
  out[prefix + 'LocationKindLabel'] = record[prefix + 'LocationKindLabel'] || '';
  return out;
}

function readPickerLocation(values, prefix) {
  var lat = values[prefix + 'Lat'];
  var lng = values[prefix + 'Lng'];
  return {
    lat: lat === '' || lat === undefined ? '' : Number(lat),
    lng: lng === '' || lng === undefined ? '' : Number(lng),
    locationRef: values[prefix + 'LocationRef'] || '',
    locationMethod: values[prefix + 'LocationMethod'] || '',
    locationGranularity: values[prefix + 'LocationGranularity'] || '',
    locationStale: values[prefix + 'LocationStale'] === true || values[prefix + 'LocationStale'] === 'true',
    locationKindLabel: values[prefix + 'LocationKindLabel'] || ''
  };
}

function readPickerBbox(value) {
  if (!value) return [];
  try {
    var bbox = JSON.parse(value);
    return Array.isArray(bbox) && bbox.length === 4 && bbox.every(function (n) { return Number.isFinite(Number(n)); }) ? bbox.map(Number) : [];
  } catch (e) { return []; }
}

/* ---- Per-trip permissions ---------------------------------------------
   Every trip carries a `myGrant` field (buildResponseState() in
   src/worker.js) saying what this account may do with it, right now --
   no single global role. `myGrant` is always one of:
     { role: 'superuser' }                  -- owner, or the uber-user.
     { role: 'admin' }                      -- full read/write, no sharing.
     { role: 'user',   companionId: '...' } -- read/write, own tagged items.
     { role: 'viewer', companionId: '...' } -- read-only, own tagged items.
   These functions are the only place the app asks "am I allowed to ___
   on this trip/item?" — every render below goes through them. ------- */

// Full read/write on the trip -- true for Superuser or "admin". False
// for a scoped "user"/"viewer" grant.
function canFullyEditTrip(trip) {
  var g = trip && trip.myGrant;
  return !!g && (g.role === 'superuser' || g.role === 'admin');
}

// A trip's Superuser can decide who else has access -- and so can an
// "admin" grant, but only as far as User/Viewer (see canGrantAdminRole()
// below). Mirrored server-side by handleTripGrantsUpsert()/
// handleTripGrantsRevoke() in src/worker.js.
function canShareTrip(trip) {
  var g = trip && trip.myGrant;
  return !!g && (g.role === 'superuser' || g.role === 'admin');
}

// Only the trip's actual Superuser may grant someone else Admin access --
// an Admin grant can share as User/Viewer only, so creating another
// Admin stays the owner's call alone.
function canGrantAdminRole(trip) {
  var g = trip && trip.myGrant;
  return !!g && g.role === 'superuser';
}

// Can this account link a companion to an account -- upgrading an
// existing Guest into a Companion, or adding a new one already linked?
// Superuser/Admin only, same bar as sharing -- see canShareTrip() above.
// A lower bar than canAddCompanion() below covers: a "user" grant may add
// a plain Guest but never link one to an account (see
// mergeUserScopedCompanions() in src/worker.js).
function canLinkCompanion(trip) {
  return canShareTrip(trip);
}
// Can this account add a brand-new Guest (name + smiley colour, no
// login)? True for Superuser/Admin (who can also add a linked Companion,
// see canLinkCompanion() above) plus a "user" grant, who may only ever
// append a Guest, never a Companion.
function canAddCompanion(trip) {
  if (canFullyEditTrip(trip)) return true;
  var g = trip && trip.myGrant;
  return !!g && g.role === 'user';
}

// The companion id a "user"/"viewer" grant is scoped to. Empty string
// for a full-scope role (Superuser/admin), which isn't tied to any one
// companion.
function myCompanionId(trip) {
  var g = trip && trip.myGrant;
  return (g && (g.role === 'user' || g.role === 'viewer')) ? (g.companionId || '') : '';
}

// Can this one item be edited? True wherever canFullyEditTrip() is, plus
// for a "user" grant when `item` is tagged with their companion -- never
// true for "viewer". Only meaningful for the four taggable item types;
// companions/contacts/expenses use canFullyEditTrip() directly.
function canEditItem(trip, item) {
  if (canFullyEditTrip(trip)) return true;
  var g = trip && trip.myGrant;
  if (!g || g.role !== 'user') return false;
  return !!(item && item.companions && item.companions.indexOf(g.companionId) !== -1);
}

/* ---- Visibility: WHICH items a viewer wants to look at ----------------
   Everything above this point answers "am I ALLOWED to ___". Everything
   below answers a different and much weaker question: "of the things I am
   already allowed to see, which do I want on screen right now?"

   Keep the two apart. This is a decluttering lens, NOT a security
   boundary. A Trip Owner and an Admin are both sent the whole trip by the
   Worker (buildVisibleTrip() in src/worker.js), and nothing here changes
   that -- flipping the lens off shows everything again, instantly, with no
   round trip. The real boundary for a scoped "user"/"viewer" grant is the
   Worker's, and it has already happened before any of this runs.

   The default differs by role because the jobs differ: a Trip Owner is
   looking after the whole trip, so they start on 'everything'; an Admin is
   usually running their own leg of it, so they start on 'mine'. Either can
   flip it in Settings (renderSettingsTab()). ------------------------- */

// The participant ids that mean "me" on this trip. Returns an ARRAY
// because the trip owner can be tagged two different ways: as the virtual
// owner participant, and (if someone also made them an ordinary companion
// record) as that companion.
//
// How each role finds itself:
//   Trip Owner -- the reserved SUPERUSER_PARTICIPANT_ID, plus any
//     companion record linked to their account.
//   Admin      -- the companion whose accountId matches this login.
//     `accountId` survives on companions for full-scope roles only; the
//     Worker strips it for scoped ones (buildVisibleTrip()), which is
//     fine, because scoped roles never need this function.
//   user/viewer -- their grant already names the companion they are
//     scoped to, so reuse myCompanionId() above rather than searching.
//
// May legitimately return an empty array -- an Admin nobody has linked to
// a companion record has no identity on this trip yet. Callers must treat
// that as "cannot filter", never as "matches nothing"; see itemScopeFor().
function myParticipantIds(trip) {
  var g = trip && trip.myGrant;
  if (!g) return [];
  if (g.role === 'user' || g.role === 'viewer') {
    var scopedId = myCompanionId(trip);
    return scopedId ? [scopedId] : [];
  }
  var ids = [];
  if (g.role === 'superuser') ids.push(SUPERUSER_PARTICIPANT_ID);
  // Match this login against the companion records. The owner may also
  // appear as an ordinary companion; an Admin usually only appears that
  // way, which is the only handle they have on "their own" items.
  var myAccountId = currentUser && currentUser.id;
  if (myAccountId) {
    (trip.companions || []).forEach(function (c) {
      if (c.accountId && c.accountId === myAccountId && ids.indexOf(c.companionId) === -1) ids.push(c.companionId);
    });
  }
  return ids;
}

// What this viewer's lens should be BEFORE they express a preference.
function defaultItemScope(trip) {
  var g = trip && trip.myGrant;
  return (g && g.role === 'admin') ? 'mine' : 'everything';
}

// Can this viewer use the lens at all? Two ways the answer is no:
//   - a scoped "user"/"viewer" grant: the Worker already filtered their
//     copy of the trip, so a lens over it would filter nothing and imply
//     they are seeing more than they are.
//   - nobody has linked them to a person on this trip, so "mine" has no
//     meaning yet. Offering a control that cannot work would be the kind
//     of dishonest UI this codebase avoids elsewhere (see the tag-picker
//     lock and COMPANION_FIELDS_LIMITED).
function canScopeToOwnItems(trip) {
  if (!canFullyEditTrip(trip)) return false;
  return myParticipantIds(trip).length > 0;
}

// The lens actually in force: the viewer's stored choice if they made one
// and can still act on it, otherwise their role's default. Falls back to
// 'everything' whenever filtering is impossible, so a viewer can never
// end up staring at a blank trip they have no way to un-blank.
function itemScopeFor(trip) {
  if (!canScopeToOwnItems(trip)) return 'everything';
  var stored = trip && itemScopePreference[trip.tripId];
  return (stored === 'mine' || stored === 'everything') ? stored : defaultItemScope(trip);
}

// The trip object to RENDER from.
//
// Returns the SAME OBJECT it was given whenever the lens is off. That is a
// contract, not an accident, and it is what makes this safe: the browser
// POSTs the whole trip on every save, and a trip's items are deleted by
// omission (see stateIsTrustworthy()). A filtered copy that reached a save
// would silently delete everything it had filtered out.
//
// Two things keep that from happening. First, only render paths call this
// -- renderTripView(), the Timeline's opening-day scroll, and the Leaflet
// mount. Second, every data-action handler re-reads the live trip through
// currentTrip() rather than closing over whatever was last rendered. If
// you add a caller, make sure it only ever draws.
//
// Only the four taggable lists are filtered. `contacts` stay because items
// reference them by id; `companions` stay because the People line and the
// tag picker need everyone; `expenses` stay because that tab is full-scope
// only anyway.
function scopedTripForRender(trip) {
  if (!trip || itemScopeFor(trip) !== 'mine') return trip;
  var mine = myParticipantIds(trip);
  if (!mine.length) return trip; // No identity -- nothing sensible to filter by.
  // An item with NO tags stays visible to everyone. Otherwise an item
  // nobody thought to tag would vanish for every person using the lens,
  // which is how a booking gets forgotten.
  var isMine = function (item) {
    var tags = (item && item.companions) || [];
    if (!tags.length) return true;
    return mine.some(function (id) { return tags.indexOf(id) !== -1; });
  };
  return Object.assign({}, trip, {
    destinations: (trip.destinations || []).filter(isMine),
    activities: (trip.activities || []).filter(isMine),
    accommodation: (trip.accommodation || []).filter(isMine),
    transport: (trip.transport || []).filter(isMine)
  });
}

// How many records the lens is currently holding back, so the trip header
// and the empty states can say so rather than leaving the viewer to wonder
// where their itinerary went.
//
// Deliberately re-resolves the LIVE trip from state by id instead of
// trusting the object it was handed. Most callers here are render helpers,
// and a render helper has usually been given the already-filtered copy --
// counting that against itself would always answer 0. Looking the original
// up removes the question of which copy the caller happened to hold.
function itemScopeHiddenCount(trip) {
  var live = trip && byId(state.trips, trip.tripId, 'tripId');
  if (!live || itemScopeFor(live) !== 'mine') return 0;
  var shown = scopedTripForRender(live);
  if (shown === live) return 0;
  return ['destinations', 'activities', 'accommodation', 'transport'].reduce(function (total, key) {
    return total + ((live[key] || []).length - (shown[key] || []).length);
  }, 0);
}

// A filter you can't see is how people lose confidence in their own data.
// Whenever the lens is hiding something, say so in the trip header and
// make the chip itself the way back out -- one click, no hunting through
// Settings for the control that caused it.
function itemScopeIndicatorHtml(trip) {
  var hidden = itemScopeHiddenCount(trip);
  if (!hidden) return '';
  return '<button class="status-badge is-scoped" data-action="set-item-scope" data-scope="everything" ' +
    'title="Showing only items tagged to you — click to show everything">' +
    icon('person') + ' Just my items <span class="scope-badge-count">' + hidden + ' hidden</span></button>';
}

function tripAccessBadgeHtml(trip) {
  var role = trip && trip.myGrant && trip.myGrant.role;
  if (role === 'viewer') return '<span class="status-badge is-readonly">' + icon('readonly') + ' Read-only</span>';
  if (role === 'user') return '<span class="status-badge is-limited">' + icon('person') + ' Limited access</span>';
  return '';
}

function defaultHomeCurrency() {
  var last = state.trips[state.trips.length - 1];
  return (last && last.homeCurrency) || 'GBP';
}

// Splits the "Who's coming with you?" textarea into trimmed, non-empty
// names -- one per line, or comma-separated. Duplicates aren't filtered:
// two guests may share a name anyway (matched by id, never by name).
function parseCompanionNamesBox(text) {
  return (text || '').split(/[\n,]/).map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 0; });
}

function openTripForm(existing) {
  openForm({
    title: existing ? 'Edit trip' : 'New trip',
    // The extra "Who's coming with you?" box only makes sense while
    // FIRST setting a trip up -- see TRIP_FIELDS_NEW's own comment for
    // why it's deliberately left off the Edit form.
    fields: existing ? TRIP_FIELDS : TRIP_FIELDS_NEW,
    initial: existing || { homeCurrency: defaultHomeCurrency() },
    submitLabel: existing ? 'Save changes' : 'Create trip',
    onSubmit: function (v) {
      updateState(function (next) {
        if (existing) {
          var t = byId(next.trips, existing.tripId, 'tripId');
          t.name = v.name; t.startDate = v.startDate || ''; t.endDate = v.endDate || '';
          t.homeCurrency = (v.homeCurrency || 'GBP').toUpperCase(); t.notes = v.notes || '';
          // ownerId/grants/myGrant aren't touched -- they carried over
          // from `existing` via byId() above, and the Worker only trusts
          // its own stored copy anyway (see "SAVING SAFELY" in src/worker.js).
        } else {
          // Turn the "Who's coming with you?" box into brand-new Guest
          // companion records (name only, no login/colour yet). Each
          // needs its own fresh id, same as any other companion.
          var newCompanions = parseCompanionNamesBox(v.companionNames).map(function (name) {
            return { companionId: newId(), name: name, notes: '' };
          });
          next.trips.push({
            tripId: newId(), name: v.name, startDate: v.startDate || '', endDate: v.endDate || '',
            homeCurrency: (v.homeCurrency || 'GBP').toUpperCase(), notes: v.notes || '',
            currencyRates: {}, destinations: [], activities: [], transport: [], accommodation: [], contacts: [], companions: newCompanions, expenses: [],
            // Kept for backwards compatibility with existing trip records.
            // New map locations are saved directly on their entries.
            geocodeCache: {},
            // Creating a trip makes you its permanent Superuser -- the
            // Worker enforces this for real (handlePost()'s new-trip-id
            // branch), but setting it here too shows the right controls
            // immediately rather than only after the next reload.
            ownerId: currentUser.id, ownerUsername: currentUser.username, grants: [],
            myGrant: { role: 'superuser' },
            // Server-computed on future loads; included optimistically so
            // the owner is immediately available in People pickers before
            // the just-created trip has been fetched back from the Worker.
            superuserParticipant: {
              participantId: SUPERUSER_PARTICIPANT_ID,
              name: currentUser.username,
              avatar: currentUser.avatar ? { type: 'account', color: currentUser.avatar.color, animal: currentUser.avatar.animal } : null
            }
          });
          currentTripId = next.trips[next.trips.length - 1].tripId;
          currentView = 'trip'; currentTab = 'timeline';
        }
      });
    }
  });
}

function openDestinationForm(trip, existing) {
  var initial = existing ? Object.assign({}, existing, pickerInitial(existing, 'destination'), {
    boundaryRef: existing.boundaryRef || '', boundaryQuality: existing.boundaryQuality || '', boundaryBbox: existing.bbox || []
  }) : {};
  openForm({
    title: existing ? 'Edit destination' : 'Add destination',
    sections: sectionsWithTagPickerLock(DESTINATION_FORM_SECTIONS, !!existing && !canFullyEditTrip(trip)),
    initial: initial, trip: trip, submitLabel: 'Save',
    onSubmit: function (v) {
      updateState(function (next) {
        var t = byId(next.trips, trip.tripId, 'tripId');
        var location = readPickerLocation(v, 'destination');
        var rec = { destinationId: existing ? existing.destinationId : newId(), name: v.name, country: v.country || '', arriveDate: v.arriveDate, departDate: v.departDate, timezone: (v.timezone || '').trim(), companions: readTagPicker(v, 'companions'), notes: v.notes || '',
          lat: location.lat, lng: location.lng, locationRef: location.locationRef, locationMethod: location.locationMethod, locationGranularity: location.locationGranularity, locationStale: location.locationStale, locationKindLabel: location.locationKindLabel,
          bbox: readPickerBbox(v.boundaryBbox), boundaryRef: v.boundaryRef || '', boundaryQuality: v.boundaryQuality || '' };
        if (existing) t.destinations[t.destinations.findIndex(function (x) { return x.destinationId === existing.destinationId; })] = rec;
        else t.destinations.push(rec);
      });
    }
  });
}

function activityFormInitial(record) {
  var values = record || {};
  var startDate = values.startDate || values.date || '';
  var endDate = values.endDate || startDate;
  // Older records did not have an all-day flag; no saved times is the
  // unambiguous legacy equivalent of an all-day activity.
  var allDay = values.allDay === undefined
    ? !(values.startTime || values.endTime)
    : (values.allDay === true || values.allDay === 'true' || values.allDay === 'on');
  return Object.assign({}, values, { startDate: startDate, endDate: endDate, allDay: allDay });
}

function destinationPeople(trip, destinationId) {
  var destination = destinationId ? byId(trip.destinations, destinationId, 'destinationId') : null;
  return destination && Array.isArray(destination.companions) ? destination.companions.slice() : [];
}

// Applies destination tags as a starting point in a new Activity form.
// These are real checked boxes, not implicit inheritance, so the person
// adding the activity can still adjust the selection before saving.
function applyDestinationPeopleDefaults(form, trip, destinationId) {
  var defaults = destinationPeople(trip, destinationId);
  var checkboxes = form.querySelectorAll('input[data-tag-picker-key="companions"]');
  Array.prototype.forEach.call(checkboxes, function (checkbox) {
    checkbox.checked = defaults.indexOf(checkbox.dataset.tagPersonId) !== -1;
  });
  // Make the inherited choices visible instead of silently checking boxes
  // inside the collapsed optional section.
  if (defaults.length && checkboxes.length) {
    var details = checkboxes[0].closest('details');
    if (details) details.open = true;
  }
}

function openActivityForm(trip, existing, seed) {
  var seedValues = seed || {};
  var initial = existing
    ? Object.assign({ category: 'Other' }, activityFormInitial(existing), activityAddressPickerInitial(existing))
    : Object.assign({ category: 'Other', allDay: true }, activityFormInitial(seedValues));
  if (!existing && seedValues.destinationId && !Array.isArray(seedValues.companions)) {
    initial.companions = destinationPeople(trip, seedValues.destinationId);
  }
  openForm({
    title: existing ? 'Edit activity' : 'Add activity',
    sections: sectionsWithTagPickerLock(ACTIVITY_FORM_SECTIONS, !!existing && !canFullyEditTrip(trip)),
    initial: initial, trip: trip, submitLabel: 'Save',
    inheritDestinationPeople: !existing,
    onSubmit: function (v) {
      var startDate = v.startDate || '';
      var endDate = v.endDate || startDate;
      var allDay = !!v.allDay;
      var form = document.getElementById('entity-form');
      if (!startDate || !endDate) {
        showFormError(form, 'Add a start and end date for this activity.', form && form.elements.startDate);
        return false;
      }
      if (endDate < startDate) {
        showFormError(form, 'The end date cannot be before the start date.', form && form.elements.endDate);
        return false;
      }
      if (!allDay && startDate === endDate && v.startTime && v.endTime && v.endTime < v.startTime) {
        showFormError(form, 'For a same-day activity, the end time must be after the start time.', form && form.elements.endTime);
        return false;
      }
      updateState(function (next) {
        var t = byId(next.trips, trip.tripId, 'tripId');
        var address = readPickerLocation(v, 'address');
        var rec = {
          activityId: existing ? existing.activityId : newId(), title: v.title, category: v.category || 'Other', destinationId: v.destinationId || '',
          // `date` stays in sync as a compatibility mirror for older saved
          // trips and browser copies. New date-aware views use start/end.
          date: startDate, startDate: startDate, endDate: endDate, allDay: allDay,
          startTime: allDay ? '' : (v.startTime || ''), endTime: allDay ? '' : (v.endTime || ''),
          location: v.location || '', address: v.address || '',
          addressLat: address.lat, addressLng: address.lng, addressLocationRef: address.locationRef, addressLocationMethod: address.locationMethod, addressLocationGranularity: address.locationGranularity, addressLocationStale: address.locationStale, addressLocationKindLabel: address.locationKindLabel,
          bookingRef: v.bookingRef || '',
          contactId: v.contactId || '', costAmount: v.costAmount || '', costCurrency: (v.costCurrency || '').toUpperCase(),
          costRate: v.costRate || '', receiptRef: v.receiptRef || '', companions: readTagPicker(v, 'companions'), notes: v.notes || ''
        };
        if (existing) t.activities[t.activities.findIndex(function (x) { return x.activityId === existing.activityId; })] = rec;
        else t.activities.push(rec);
      });
    }
  });
}

// Resolves the map coordinate to save for one end (From or To) of a
// Flight leg, in priority order: (1) a known match in COMMON_AIRPORTS
// for the typed/selected code; (2) the most recent "Look up" click's
// AeroDataBox location data for that end (see lastFlightLookupCoords),
// covering airports too minor for COMMON_AIRPORTS; (3) a coordinate
// already saved on this leg, reused only if the location text hasn't
// changed since. Anything else returns null and shows as unmapped.
function resolveLegCoords(text, lookupCoords, existing, textKey, latKey, lngKey) {
  var staticMatch = airportCoordsFromText(text);
  if (staticMatch) return staticMatch;
  if (lookupCoords) return lookupCoords;
  if (existing && existing[textKey] === text && typeof existing[latKey] === 'number' && typeof existing[lngKey] === 'number') {
    return { lat: existing[latKey], lng: existing[lngKey] };
  }
  return null;
}

function pickerCoords(values, prefix) {
  var lat = values[prefix + 'Lat'];
  var lng = values[prefix + 'Lng'];
  if (lat === '' || lat === undefined || lng === '' || lng === undefined) return null;
  var out = { lat: Number(lat), lng: Number(lng) };
  return Number.isFinite(out.lat) && Number.isFinite(out.lng) ? out : null;
}

function openTransportForm(trip, existing, seed) {
  // A brand-new leg needs paymentType explicitly set to 'Free', not left
  // undefined -- a <select> with nothing `selected` shows its first
  // option ("Cash") even though transportPaymentFields() separately
  // defaults undefined to 'Free', which would render no cost fields.
  // Setting it here keeps the selection and shown fields in agreement.
  var initial = existing ? Object.assign({}, existing, splitDateTime(existing.departDateTime), transportPickerInitial(existing, 'from'), transportPickerInitial(existing, 'to'), {
    arriveDate: dateOnly(existing.arriveDateTime), arriveTime: timeOnly(existing.arriveDateTime)
  }) : Object.assign({ mode: 'Flight', paymentType: 'Free' }, seed || {});
  if (existing) { initial.departDate = dateOnly(existing.departDateTime); initial.departTime = timeOnly(existing.departDateTime); }
  if (existing) {
    // Older saved legs predate "Paid with" -- infer a starting value
    // (a cost amount means Cash, nothing means Free) rather than blank,
    // so editing doesn't hide existing cost data. costRateOverrideEnabled
    // is real boolean state, not a saved field, so the checkbox starts
    // checked when a rate override was already saved.
    if (!initial.paymentType) initial.paymentType = existing.costAmount ? 'Cash' : 'Free';
    initial.costRateOverrideEnabled = !!existing.costRate;
  }
  // A fresh form session shouldn't inherit a coordinate from whatever leg
  // was last looked up -- see lastFlightLookupCoords' own comment.
  lastFlightLookupCoords = { from: null, to: null };
  openForm({
    title: existing ? 'Edit transport leg' : 'Add transport leg',
    // Field list depends on mode and payment type (a flight shows a
    // flight-number field, Cash shows currency+amount, etc.) — see
    // transportSectionsForMode(). sectionsWithTagPickerLock() also locks
    // the Companions picker when a "user" grant edits their own leg.
    sections: sectionsWithTagPickerLock(function (values) { return transportSectionsForMode(values); }, !!existing && !canFullyEditTrip(trip)),
    // Switching "Paid with" swaps in the right cost/points fields, and
    // toggling the exchange-rate checkbox shows/hides the override input.
    reactiveKey: ['mode', 'paymentType', 'costRateOverrideEnabled'],
    initial: initial, trip: trip, submitLabel: 'Save',
    onSubmit: function (v) {
      updateState(function (next) {
        var t = byId(next.trips, trip.tripId, 'tripId');
        // Every mode can use a saved picker coordinate. Flights also get
        // a conservative airport-data fallback for a typed IATA code.
        var fromCoords = pickerCoords(v, 'from'), toCoords = pickerCoords(v, 'to');
        if (v.mode === 'Flight') {
          fromCoords = fromCoords || resolveLegCoords(v.fromLocation, lastFlightLookupCoords.from, existing, 'fromLocation', 'fromLat', 'fromLng');
          toCoords = toCoords || resolveLegCoords(v.toLocation, lastFlightLookupCoords.to, existing, 'toLocation', 'toLat', 'toLng');
        }
        // Only keep cost/points data for the section "Paid with"
        // currently shows -- switching an already-priced leg to Free
        // clears its cost rather than silently keeping it. Mirrors
        // exactly what transportPaymentFields() renders.
        var paymentType = v.paymentType || 'Free';
        var showCash = paymentType === 'Cash' || paymentType === 'Combo';
        var showPoints = paymentType === 'Points' || paymentType === 'Combo';
        var rateOverrideOn = v.costRateOverrideEnabled === 'on' || v.costRateOverrideEnabled === true;
        var rec = {
          transportId: existing ? existing.transportId : newId(), mode: v.mode || 'Other', carrier: v.carrier || '',
          flightNumber: v.flightNumber || '', licensePlate: v.licensePlate || '',
          fromLocation: v.fromLocation, toLocation: v.toLocation,
          fromLat: fromCoords ? fromCoords.lat : '', fromLng: fromCoords ? fromCoords.lng : '',
          toLat: toCoords ? toCoords.lat : '', toLng: toCoords ? toCoords.lng : '',
          fromLocationRef: v.fromLocationRef || '', toLocationRef: v.toLocationRef || '',
          fromLocationMethod: v.fromLocationMethod || (fromCoords ? 'selected' : ''), toLocationMethod: v.toLocationMethod || (toCoords ? 'selected' : ''),
          fromLocationGranularity: v.fromLocationGranularity || '', toLocationGranularity: v.toLocationGranularity || '',
          fromLocationStale: v.fromLocationStale === true || v.fromLocationStale === 'true', toLocationStale: v.toLocationStale === true || v.toLocationStale === 'true',
          fromLocationKindLabel: v.fromLocationKindLabel || '', toLocationKindLabel: v.toLocationKindLabel || '',
          departDateTime: combineDateTime(v.departDate, v.departTime), arriveDateTime: combineDateTime(v.arriveDate, v.arriveTime),
          bookingRef: v.bookingRef || '', contactId: v.contactId || '',
          paymentType: paymentType,
          costAmount: showCash ? (v.costAmount || '') : '',
          costCurrency: showCash ? (v.costCurrency || '').toUpperCase() : '',
          costRate: (showCash && rateOverrideOn) ? (v.costRate || '') : '',
          pointsProgram: showPoints ? (v.pointsProgram || '') : '',
          pointsAmount: showPoints ? (v.pointsAmount || '') : '',
          receiptRef: v.receiptRef || '', companions: readTagPicker(v, 'companions'), notes: v.notes || ''
        };
        if (existing) t.transport[t.transport.findIndex(function (x) { return x.transportId === existing.transportId; })] = rec;
        else t.transport.push(rec);
      });
    }
  });
}

