/* ---------- 20. Render: Timeline tab ---------------------------------------
   One card per day: the date heading, every event in time order,
   and — when relevant — a note about where the night is spent (a
   booked stay, or travelling overnight through to the next day). */

// A record's cost belongs to exactly one day, matching allCostLines(): the
// departure day for a leg, the check-in day for a stay, the start day for an
// activity. Without that, a return leg or a checkout would show the same money
// a second time and stop reconciling with the day total in the heading.
// "LHR — London Heathrow" -> "LHR". The Timeline is a scan, and a flight's
// full airport names spent most of a phone's line width saying twice what the
// code says once. Only flights: a rail or ferry endpoint is a place name, and
// the pattern deliberately matches nothing that is not a leading IATA code.
function transportEndpointLabel(transport, text) {
  if (!transport || transport.mode !== 'Flight') return text || '';
  var code = /^\s*([A-Z]{3})\b/.exec(String(text || ''));
  return code ? code[1] : (text || '');
}

function timelineTransportTitle(transport) {
  return (transport.mode || 'Transport') + (transport.flightNumber ? ' ' + transport.flightNumber : '') +
    ': ' + transportEndpointLabel(transport, transport.fromLocation) + ' → ' + transportEndpointLabel(transport, transport.toLocation);
}

function timelineArrivalTitle(transport) {
  return 'Arrive: ' + transportEndpointLabel(transport, transport.toLocation) +
    ' (from ' + transportEndpointLabel(transport, transport.fromLocation) + ')';
}

function timelineEventCarriesCost(ev) {
  return ev.kind === 'depart' || ev.kind === 'checkin' || (ev.kind === 'activity' && !ev.continues);
}

// Row three of a Timeline card: the event's own context line, then whatever
// was typed into the record's notes. Empty parts drop out.
function timelineDetail(context, notes) {
  return [context, notes].filter(function (part) { return part; }).join(' · ');
}

function eventRowHtml(trip, ev) {
  var section = ev.kind === 'activity' ? 'activity' : ((ev.kind === 'checkin' || ev.kind === 'checkout') ? 'accommodation' : 'transport');
  var model = recordItemRowModel(trip, section, ev.data, 'timeline');
  model.leadingTime = ev.displayTime || ev.time;
  // People are part of the itinerary scan, including for split journeys.
  // Keep the other metadata in the detailed Plan/Map representations.
  model.metadata = { people: ev.data.companions || [] };
  model.expandableNote = true;
  // Shown only on the day that owns it, so nothing bills twice.
  if (!timelineEventCarriesCost(ev)) model.cost = null;
  if (ev.kind === 'activity' && ev.continues) { model.title = 'Continues: ' + ev.data.title; model.icon = 'continues'; }
  else if (ev.kind === 'checkin') { model.title = 'Check in: ' + ev.data.name; model.icon = 'checkIn'; }
  else if (ev.kind === 'checkout') { model.title = 'Check out: ' + ev.data.name; model.icon = 'checkOut'; }
  else if (ev.kind === 'depart') {
    model.title = timelineTransportTitle(ev.data);
    var overnight = dateOnly(ev.data.departDateTime) !== dateOnly(ev.data.arriveDateTime);
    model.supporting = timelineDetail(overnight ? 'Arrives ' + formatDateShort(dateOnly(ev.data.arriveDateTime)) + ' at ' + timeOnly(ev.data.arriveDateTime) : 'Arrives ' + timeOnly(ev.data.arriveDateTime), ev.data.notes);
  } else if (ev.kind === 'arrive') {
    model.title = timelineArrivalTitle(ev.data);
    model.supporting = timelineDetail('Journey by ' + (ev.data.mode || 'travel') + (ev.data.flightNumber ? ' ' + ev.data.flightNumber : '') + ' from ' + formatDateShort(dateOnly(ev.data.departDateTime)), ev.data.notes);
  }
  return itemRowHtml(trip, model);
}

// A visual group is never a combined booking: the members remain the exact
// event objects supplied by eventsForDay(), and all editing uses their own ids.
var TIMELINE_DEPARTURE_WINDOW_MINUTES = 60;
var timelineJourneyExpansion = {};
var timelineJumpDates = {};

function timelineJourneyKey(tripId, transportId) {
  return JSON.stringify([tripId, transportId]);
}

function timelinePeopleLabel(trip, events) {
  var ids = [], unassigned = false;
  events.forEach(function (ev) {
    var tagged = ev.data.companions || [];
    if (!tagged.length) unassigned = true;
    tagged.forEach(function (id) { if (ids.indexOf(id) === -1) ids.push(id); });
  });
  var names = ids.map(function (id) {
    var person = taggablePersonById(trip, id);
    return person ? person.name : 'Unknown traveller';
  });
  if (unassigned) names.push('No people assigned');
  return names.join(', ');
}

function timelineDepartureOrigin(transport) {
  var mode = String(transport.mode || 'Transport');
  var label = String(transport.fromLocation || '').trim();
  if (!label) return null;
  var code = mode === 'Flight' && /^([A-Z]{3})\b/.exec(label);
  return {
    key: mode + '|' + (code ? 'airport:' + code[1] : (transport.fromLocationRef ? 'ref:' + transport.fromLocationRef : 'text:' + label.toLowerCase().replace(/\s+/g, ' '))),
    label: code ? code[1] : label
  };
}

function timelineDepartureMoment(transport) {
  var values = transportDisplayValues(transport);
  if (!values.departDate || !/^\d{2}:\d{2}$/.test(values.departTime)) return null;
  var zone = resolveTransportTimezone(values, false);
  if (zone) {
    var resolved = zonedInstant(values.departDate, values.departTime, zone, values.departOccurrence);
    // A repeated or nonexistent local time is not guessed into a group.
    return resolved.error ? null : { minutes: resolved.minutes, basis: 'instant', zone: zone };
  }
  var wall = journeyUtcMinutes(values.departDate, values.departTime);
  return wall === null ? null : { minutes: wall, basis: 'local', zone: '' };
}

function timelineEventGroups(events) {
  var departures = events.map(function (ev, index) {
    if (ev.kind !== 'depart') return null;
    var origin = timelineDepartureOrigin(ev.data), moment = timelineDepartureMoment(ev.data);
    return origin && moment ? { ev: ev, index: index, origin: origin, moment: moment, day: dateOnly(ev.data.departDateTime) } : null;
  }).filter(Boolean).sort(function (a, b) {
    return a.moment.minutes - b.moment.minutes || a.index - b.index;
  });
  var clusters = [];
  departures.forEach(function (departure) {
    var cluster = clusters.find(function (candidate) {
      return candidate.origin.key === departure.origin.key && candidate.day === departure.day &&
        candidate.basis === departure.moment.basis &&
        departure.moment.minutes - candidate.start <= TIMELINE_DEPARTURE_WINDOW_MINUTES;
    });
    if (cluster) cluster.members.push(departure);
    else clusters.push({ origin: departure.origin, day: departure.day, basis: departure.moment.basis, start: departure.moment.minutes, members: [departure] });
  });
  var byIndex = {};
  clusters.filter(function (cluster) { return cluster.members.length > 1; }).forEach(function (cluster) {
    cluster.firstIndex = Math.min.apply(null, cluster.members.map(function (member) { return member.index; }));
    cluster.members.forEach(function (member) { byIndex[member.index] = cluster; });
  });
  return events.reduce(function (groups, ev, index) {
    var cluster = byIndex[index];
    if (!cluster) groups.push({ kind: 'event', event: ev });
    else if (cluster.firstIndex === index) groups.push({
      kind: 'departures', origin: cluster.origin.label, basis: cluster.basis,
      events: cluster.members.map(function (member) { return member.ev; }),
      zones: cluster.members.map(function (member) { return member.moment.zone; }).filter(function (zone, i, all) { return zone && all.indexOf(zone) === i; })
    });
    return groups;
  }, []);
}

function timelineDepartureGroupHtml(trip, group) {
  var events = group.events;
  var first = events[0], last = events[events.length - 1];
  var headingId = 'departures-' + slug(trip.tripId) + '-' + slug(first.data.transportId);
  var firstTime = timeOnly(first.data.departDateTime), lastTime = timeOnly(last.data.departDateTime);
  var timeRange = group.zones.length > 1 ? '' : firstTime + (firstTime !== lastTime ? '–' + lastTime : '') + ' · ';
  var context = group.basis === 'local' ? 'Local departure times · timezone unknown' :
    (group.zones.length === 1 ? group.zones[0] + ' · local departure times' : 'Each journey uses its departure timezone');
  return '<section class="timeline-journey-group" aria-labelledby="' + headingId + '">' +
    '<div class="timeline-journey-group-head"><h4 id="' + headingId + '">' + events.length + ' departures from ' + esc(group.origin) + '</h4>' +
      '<p>' + esc(timeRange + context) + '</p></div>' +
    '<div class="timeline-journey-group-list">' + events.map(function (ev) {
      return '<details class="timeline-journey-leg" data-timeline-journey="' + esc(ev.data.transportId) + '" data-timeline-trip="' + esc(trip.tripId) + '"' +
        (timelineJourneyExpansion[timelineJourneyKey(trip.tripId, ev.data.transportId)] ? ' open' : '') + '>' +
        '<summary class="timeline-journey-summary"><span class="timeline-journey-moment">' + esc(ev.displayTime || ev.time) +
          (group.zones.length > 1 ? '<span class="timeline-journey-zone">' + esc(resolveTransportTimezone(transportDisplayValues(ev.data), false)) + '</span>' : '') + '</span>' +
          '<span class="timeline-journey-place">' + esc(timelineTransportTitle(ev.data)) + '</span>' +
          '<span class="timeline-journey-people">' + esc(timelinePeopleLabel(trip, [ev])) + '</span>' + icon('collapse', 'timeline-journey-chevron') + '</summary>' +
        '<div class="timeline-journey-detail">' + eventRowHtml(trip, ev) + '</div></details>';
    }).join('') + '</div></section>';
}

function timelineEventsHtml(trip, events) {
  return timelineEventGroups(events).map(function (group) {
    return group.kind === 'departures' ? timelineDepartureGroupHtml(trip, group) : eventRowHtml(trip, group.event);
  }).join('');
}

function timelineOvernightRecords(trip, day) {
  // A split trip can have several stays and an overnight journey on the same
  // night. Draw only records in the supplied (already scoped) trip; never pick
  // one traveller's accommodation as the answer for everybody.
  var stays = (trip.accommodation || []).filter(function (stay) {
    return dateOnly(stay.checkIn) <= day && day < dateOnly(stay.checkOut);
  });
  var journeys = (trip.transport || []).filter(function (journey) {
    return dateOnly(journey.departDateTime) <= day && day < dateOnly(journey.arriveDateTime);
  });
  return stays.map(function (stay) {
    return { data: stay, label: 'Sleeping at ' + stay.name };
  }).concat(journeys.map(function (journey) {
    return { data: journey, label: 'Overnight ' + (journey.mode || 'travel').toLowerCase() + ' to ' + journey.toLocation };
  }));
}

function timelineOvernightHtml(trip, day) {
  var rows = timelineOvernightRecords(trip, day);
  if (!rows.length) return '<div class="overnight-note is-unbooked">' + icon('overnight') + 'No accommodation logged for tonight</div>';
  return rows.map(function (row) {
    return '<div class="overnight-note">' + icon('overnight') + '<span>' + esc(row.label) + '</span>' +
      '<span class="overnight-people">' + esc(timelinePeopleLabel(trip, [row])) + '</span></div>';
  }).join('');
}

function timelineDaySeed(trip, day) {
  var areas = areasForDay(trip, day);
  // A single active area is the unambiguous useful default. On transfer
  // days with multiple areas, leave the choice blank rather than guessing.
  return areas.length === 1 ? { destinationId: areas[0].destinationId } : {};
}

// Built once per render: summing allCostLines() inside the day loop would
// rebuild the whole list for every date. These are the same lines the Expenses
// ledger and the trip total use, so a day's figure always reconciles with the
// header -- and a multi-night stay counts once, on its check-in day.
function timelineSpendByDay(trip) {
  var byDay = {};
  allCostLines(trip).forEach(function (line) {
    if (!line.date) return;
    var entry = byDay[line.date] || (byDay[line.date] = { known: 0, unknown: 0 });
    var converted = homeValue(trip, line.amount, line.currency, line.rateOverride);
    if (converted.known) entry.known += converted.value; else entry.unknown++;
  });
  return byDay;
}

// One quiet area name per day. A day spanning two areas names both, in arrival
// order, rather than going blank -- a transfer day is exactly when the reader
// most needs to know where they are.
function timelineDayAreaLabel(trip, day) {
  var areas = areasForDay(trip, day);
  if (!areas.length) return '';
  return areas.slice().sort(function (a, b) {
    return String(a.arriveDate || '').localeCompare(String(b.arriveDate || ''));
  }).map(function (area) { return area.name; }).join(' → ');
}

// tripDayList() spans every record, so an outbound leg the day before the
// trip's own start date pulls a day into the Timeline that the trip header's
// range does not cover. Mark it rather than letting it pass as an ordinary day.
function timelineDayFlag(trip, day, today) {
  if (day === today) return { label: 'Today', quiet: false };
  if (trip.startDate && day < trip.startDate) return { label: 'Before trip', quiet: true };
  if (trip.endDate && day > trip.endDate) return { label: 'After trip', quiet: true };
  return null;
}

// What a day says about itself while collapsed -- previously a collapsed day
// was 38px of nothing, so an empty day and a packed one looked identical. The
// area is deliberately not repeated here; it already sits beside the date.
function timelineDaySummaryHtml(trip, eventCount, spend, events) {
  var parts = [eventCount ? eventCount + (eventCount === 1 ? ' event' : ' events') : 'Nothing planned'];
  if (spend && spend.known > 0) parts.push('<span class="day-summary-spend">' + money(spend.known, trip.homeCurrency) + '</span>');
  if (spend && spend.unknown) parts.push('<span class="rate-missing">' + spend.unknown + ' need rate</span>');
  if (events && events.length) parts.push('<span class="day-summary-people">' + esc(timelinePeopleLabel(trip, events)) + '</span>');
  return '<span class="day-summary">' + parts.join('<span class="day-summary-dot"></span>') + '</span>';
}

function timelineDayActionsHtml(trip, day) {
  if (!canFullyEditTrip(trip)) return '';
  var heading = esc(formatDateHeading(day));
  // One control per day instead of three: a fortnight previously carried 42
  // permanently visible add buttons against the itinerary. A native <details>
  // keeps the menu keyboard-operable without a bespoke popover, the same way
  // the Map's locations-needing-attention panel does.
  return '<details class="day-add"><summary class="day-add-btn" aria-label="Add to ' + heading + '" title="Add to ' + heading + '">' +
      icon('add') + '<span class="day-add-label">Add</span></summary>' +
    '<div class="day-add-menu">' +
      '<button type="button" class="day-add-item" data-action="timeline-add-activity" data-day="' + esc(day) + '">' + icon('activity') + ' Activity</button>' +
      '<button type="button" class="day-add-item" data-action="timeline-add-accommodation" data-day="' + esc(day) + '">' + icon('stay') + ' Stay</button>' +
      '<button type="button" class="day-add-item" data-action="timeline-add-transport" data-day="' + esc(day) + '">' + icon('route') + ' Travel</button>' +
    '</div></details>';
}

// Where you are in the trip, and how to move through it: a fortnight rendered
// roughly 3,500px of page with no way to get anywhere in it.
function timelineToolbarHtml(trip, days, today) {
  var anyCollapsed = days.some(function (day) { return !timelineDayExpanded(trip.tripId, day, today); });
  var progress = '';
  if (trip.startDate && trip.endDate && today >= trip.startDate && today <= trip.endDate) {
    var total = daysBetween(trip.startDate, trip.endDate) + 1;
    var current = daysBetween(trip.startDate, today) + 1;
    // A live percentage computed from real dates, so it reaches CSS as a custom
    // property -- the same documented exception the Map's range slider uses.
    progress = '<span class="timeline-progress"><span><strong>Day ' + current + '</strong> of ' + total + '</span>' +
      '<span class="timeline-progress-track"><span class="timeline-progress-fill" style="--wp-timeline-progress: ' + Math.round((current / total) * 100) + '%"></span></span></span>';
  }
  return '<div class="timeline-toolbar">' + progress +
    '<label class="timeline-date-jump">Jump to date <input type="date" data-timeline-jump-date min="' + esc(days[0]) + '" max="' + esc(days[days.length - 1]) + '" value="' + esc(days.indexOf(timelineJumpDates[trip.tripId]) !== -1 ? timelineJumpDates[trip.tripId] : tripFocusDay(days, today)) + '"></label>' +
    (days.indexOf(today) !== -1 ? '<button type="button" class="timeline-tool is-today" data-action="timeline-jump-today">' + icon('date') + ' Jump to today</button>' : '') +
    '<button type="button" class="timeline-tool" data-action="timeline-toggle-all" data-expand="' + String(anyCollapsed) + '">' +
      icon(anyCollapsed ? 'expand' : 'collapse') + (anyCollapsed ? ' Expand all' : ' Collapse all') + '</button>' +
  '</div>';
}

// The Expand/Collapse-all control describes the current state, so a single
// day's disclosure has to keep it honest. Done in place rather than by
// re-rendering, which would throw away the reader's scroll position.
function syncTimelineToolbar(trip) {
  var control = document.querySelector('[data-action="timeline-toggle-all"]');
  if (!control) return;
  var today = timelineLocalTodayStr();
  var anyCollapsed = tripDayList(trip).some(function (day) { return !timelineDayExpanded(trip.tripId, day, today); });
  control.dataset.expand = String(anyCollapsed);
  control.innerHTML = icon(anyCollapsed ? 'expand' : 'collapse') + (anyCollapsed ? ' Expand all' : ' Collapse all');
}

// A Timeline note only gets an open/close control when it is really cut off.
// CSS cannot report whether a clamp bit, so this measures after layout.
function markTruncatedNotes() {
  Array.prototype.forEach.call(document.querySelectorAll('.item-row--timeline .item-supporting'), function (note) {
    var card = note.closest('.item-row');
    if (!card || card.classList.contains('is-expanded')) return;
    card.setAttribute('data-truncated', note.scrollHeight > note.clientHeight + 1 ? 'true' : 'false');
  });
}

// The Timeline opens on today while a trip is under way, at its start
// otherwise. Only on arrival at the tab: re-running this on every render
// would yank the page back after each edit. Instant rather than smooth --
// this is where the reader should already be, not somewhere to travel to.
var timelineOpenedOn = '';
function focusTimelineOpeningDay(trip) {
  var key = trip.tripId + '|' + currentTab;
  if (timelineOpenedOn === key) return;
  timelineOpenedOn = key;
  var days = tripDayList(trip);
  var target = tripFocusDay(days);
  if (!target) return;
  // Opening at the start means the top of the page, not the first day card:
  // arriving from a scrolled tab would otherwise leave the reader part-way
  // down, and scrolling the card itself into view hides the trip header.
  if (target === days[0]) { window.scrollTo(0, 0); return; }
  var card = document.querySelector('[data-timeline-day="' + target + '"]');
  if (card) card.scrollIntoView({ behavior: 'auto', block: 'center' });
}

// The day add menu is a transient popover. Closing it explicitly matters most
// when one of its items opens a modal: left open, it would still be behind the
// dialog and would swallow the first Escape.
function closeDayAddMenus(except) {
  Array.prototype.forEach.call(document.querySelectorAll('.day-add[open]'), function (menu) {
    if (menu !== except) menu.removeAttribute('open');
  });
}

function renderTimelineTab(trip) {
  var days = tripDayList(trip);
  if (days.length === 0) {
    return emptyStateHtml('empty', 'timeline', 'Nothing planned yet', 'Add a destination, activity, transport leg or place to stay and this timeline will lay your trip out day by day — including overnight travel and stays that span several days.');
  }
  var today = timelineLocalTodayStr();
  var spendByDay = timelineSpendByDay(trip);
  var cards = days.map(function (day, i) {
    var events = eventsForDay(trip, day);
    var isLast = i === days.length - 1;
    var expanded = timelineDayExpanded(trip.tripId, day, today);
    var dayHeading = formatDateHeading(day);
    var contentId = 'timeline-day-' + slug(trip.tripId) + '-' + day;
    var area = timelineDayAreaLabel(trip, day);
    var flag = timelineDayFlag(trip, day, today);
    var eventsHtml = events.length
      ? '<div class="day-events">' + timelineEventsHtml(trip, events) + '</div>'
      : '<div class="no-day-events">' + icon('date') + ' Nothing planned for this day.</div>';
    var overnightHtml = isLast ? '' : timelineOvernightHtml(trip, day);
    // The date badge is no longer the control: the heading row beside it is,
    // which gives the disclosure a 44px target instead of a 34px circle and
    // an accessible name carrying the date, area, flag and day summary.
    return '<div class="day-card' + (expanded ? '' : ' is-collapsed') + (day === today ? ' is-today' : '') + (flag && flag.quiet ? ' is-outside' : '') + '" data-timeline-day="' + esc(day) + '">' +
      '<div class="day-rail"><span class="day-num" aria-hidden="true">' + day.slice(8, 10) + '</span></div>' +
      '<div class="day-body"><div class="day-headrow">' +
        '<button type="button" class="day-head" data-action="toggle-timeline-day" data-day="' + esc(day) + '" aria-expanded="' + String(expanded) + '" aria-controls="' + contentId + '">' +
          '<span class="day-head-copy"><span class="day-date-line">' +
            '<span class="day-date">' + esc(dayHeading) + '</span>' +
            (area ? '<span class="day-area">' + esc(area) + '</span>' : '') +
            (flag ? '<span class="day-flag' + (flag.quiet ? ' is-quiet' : '') + '">' + esc(flag.label) + '</span>' : '') +
          '</span>' + timelineDaySummaryHtml(trip, events.length, spendByDay[day], events.concat(timelineOvernightRecords(trip, day))) + '</span>' +
          '<span class="day-chevron">' + icon('collapse') + '</span>' +
        '</button>' +
        timelineDayActionsHtml(trip, day) + '</div>' +
        '<div id="' + contentId + '" class="day-content"' + (expanded ? '' : ' hidden') + '>' + eventsHtml + overnightHtml + '</div></div></div>';
  }).join('');
  // A single-day trip has nothing to navigate, so the toolbar would be noise.
  return (days.length > 1 ? timelineToolbarHtml(trip, days, today) : '') + cards;
}
