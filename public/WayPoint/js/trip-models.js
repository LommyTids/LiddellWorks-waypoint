/* ---------- 9. Cost / expense aggregation --------------------------
   Every bookable item (activity, transport leg, accommodation stay)
   can carry its own cost; on top of that a trip can have standalone
   expenses (meals, taxis, souvenirs...). allCostLines() flattens all
   of it into one list so the Expenses tab and the CSV export both
   work from a single, consistent ledger. */

function allCostLines(trip) {
  var lines = [];
  trip.activities.forEach(function (a) {
    if (a.costAmount) lines.push({ date: activityStartDate(a), type: 'Activity', section: 'activity', item: a, desc: a.title, amount: a.costAmount, currency: a.costCurrency, rateOverride: a.costRate, receiptRef: a.receiptRef, bookingRef: a.bookingRef, category: 'Activities' });
  });
  trip.transport.forEach(function (t) {
    if (t.costAmount) lines.push({ date: dateOnly(t.departDateTime), type: 'Transport', section: 'transport', item: t, desc: transportLabel(t), amount: t.costAmount, currency: t.costCurrency, rateOverride: t.costRate, receiptRef: t.receiptRef, bookingRef: t.bookingRef, category: 'Transport' });
  });
  trip.accommodation.forEach(function (ac) {
    if (ac.costAmount) lines.push({ date: dateOnly(ac.checkIn), type: 'Accommodation', section: 'accommodation', item: ac, desc: ac.name, amount: ac.costAmount, currency: ac.costCurrency, rateOverride: ac.costRate, receiptRef: ac.receiptRef, bookingRef: ac.bookingRef, category: 'Accommodation' });
  });
  trip.expenses.forEach(function (e) {
    lines.push({ date: e.date, type: 'Expense', section: 'expense', item: e, desc: e.description, amount: e.amount, currency: e.currency, rateOverride: e.rateOverride, receiptRef: e.receiptRef, bookingRef: '', category: e.category || 'Other' });
  });
  lines.sort(function (a, b) { return (a.date || '').localeCompare(b.date || ''); });
  return lines;
}

function usedCurrencies(trip) {
  var set = {};
  allCostLines(trip).forEach(function (l) { if (l.currency && l.currency !== trip.homeCurrency) set[l.currency] = true; });
  return Object.keys(set).sort();
}

function csvEscape(v) {
  var s = String(v === undefined || v === null ? '' : v);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function buildCsv(trip) {
  var lines = allCostLines(trip);
  var header = ['Date', 'Type', 'Category', 'Description', 'Amount', 'Currency', 'Rate used', 'Converted (' + trip.homeCurrency + ')', 'Booking ref', 'Receipt ref'];
  var rows = lines.map(function (l) {
    var hv = homeValue(trip, l.amount, l.currency, l.rateOverride);
    return [l.date, l.type, l.category, l.desc, l.amount, l.currency, hv.rateUsed == null ? '' : hv.rateUsed, hv.known ? hv.value.toFixed(2) : 'unknown', l.bookingRef, l.receiptRef];
  });
  return [header].concat(rows).map(function (r) { return r.map(csvEscape).join(','); }).join('\r\n');
}

// Builds the CSV text (see buildCsv() above) and hands it to the
// browser as a normal file download. This is the standard vanilla-JS
// download trick: wrap the text in a Blob, make a temporary object URL
// for it, click a hidden link pointing at that URL, then clean both up
// straight away. No server round-trip needed for this one.
function exportCsv(trip) {
  var csv = buildCsv(trip);
  var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  var url = URL.createObjectURL(blob);
  var link = document.createElement('a');
  link.href = url;
  link.download = slug(trip.name) + '-expenses.csv';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  // Give the browser a moment to actually start the download before we
  // revoke the URL it's reading from.
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
}

/* ---------- 10. Timeline logic --------------------------------------
   This is the heart of the "multi-leg, overnight, several areas in a
   day" requirement: it builds one chronological agenda per trip that
   folds together destinations, activities, transport and
   accommodation, and makes overnight travel and multi-night stays
   visible instead of splitting them awkwardly across days. */

function tripDayList(trip) {
  var dates = {};
  function add(d) { if (d) dates[d] = true; }
  add(trip.startDate); add(trip.endDate);
  trip.destinations.forEach(function (d) { add(d.arriveDate); add(d.departDate); });
  trip.activities.forEach(function (a) { add(activityStartDate(a)); add(activityEndDate(a)); });
  trip.transport.forEach(function (t) { add(dateOnly(t.departDateTime)); add(dateOnly(t.arriveDateTime)); });
  trip.accommodation.forEach(function (a) { add(dateOnly(a.checkIn)); add(dateOnly(a.checkOut)); });
  var keys = Object.keys(dates).sort();
  if (keys.length === 0) return [];
  var out = []; var cur = keys[0]; var end = keys[keys.length - 1];
  while (cur <= end) { out.push(cur); cur = addDays(cur, 1); }
  return out;
}

function eventsForDay(trip, day) {
  var events = [];
  trip.activities.forEach(function (a) {
    if (!activityOccursOn(a, day)) return;
    var startsToday = activityStartDate(a) === day;
    events.push({
      time: activityIsAllDay(a) || !startsToday ? '00:00' : (a.startTime || '00:00'),
      displayTime: activityIsAllDay(a) ? 'All day' : (startsToday ? (a.startTime || 'Time TBD') : 'Continues'),
      kind: 'activity', data: a, continues: !startsToday
    });
  });
  trip.accommodation.forEach(function (ac) {
    if (dateOnly(ac.checkIn) === day) events.push({ time: timeOnly(ac.checkIn) || '15:00', kind: 'checkin', data: ac });
    if (dateOnly(ac.checkOut) === day) events.push({ time: timeOnly(ac.checkOut) || '11:00', kind: 'checkout', data: ac });
  });
  trip.transport.forEach(function (t) {
    if (dateOnly(t.departDateTime) === day) events.push({ time: timeOnly(t.departDateTime) || '00:00', kind: 'depart', data: t });
    if (dateOnly(t.arriveDateTime) === day && dateOnly(t.arriveDateTime) !== dateOnly(t.departDateTime)) {
      events.push({ time: timeOnly(t.arriveDateTime) || '00:00', kind: 'arrive', data: t });
    }
  });
  events.sort(function (a, b) { return a.time.localeCompare(b.time); });
  return events;
}

function overnightStay(trip, day) {
  var stay = trip.accommodation.find(function (ac) { return dateOnly(ac.checkIn) <= day && day < dateOnly(ac.checkOut); });
  if (stay) return { kind: 'stay', data: stay };
  var nextDay = addDays(day, 1);
  var leg = trip.transport.find(function (t) { return dateOnly(t.departDateTime) === day && dateOnly(t.arriveDateTime) === nextDay; });
  if (leg) return { kind: 'transit', data: leg };
  return null;
}

function areasForDay(trip, day) {
  return trip.destinations.filter(function (d) { return d.arriveDate <= day && day <= d.departDate; });
}

/* ---------- 11. Trip-level stats ------------------------------------ */

function tripStatus(trip) {
  var today = todayStr();
  if (trip.startDate && trip.endDate) {
    if (today < trip.startDate) return 'upcoming';
    if (today > trip.endDate) return 'past';
    return 'ongoing';
  }
  if (trip.startDate && today < trip.startDate) return 'upcoming';
  if (trip.endDate && today > trip.endDate) return 'past';
  return 'upcoming';
}

function tripSpend(trip) {
  var known = 0, unknownCount = 0;
  allCostLines(trip).forEach(function (l) {
    var hv = homeValue(trip, l.amount, l.currency, l.rateOverride);
    if (hv.known) known += hv.value; else unknownCount++;
  });
  return { known: known, unknownCount: unknownCount };
}

// One exceptional-state component serves empty data, recoverable failures and
// permission limits. The semantic icon changes by context; the quiet dotted
// route and tilted journal stamp keep every instance recognisably Waypoint.
function emptyStateHtml(kind, iconName, title, body, actionsHtml, compact) {
  return '<div class="empty-state is-' + esc(kind || 'empty') + (compact ? ' is-compact' : '') + '">' +
    '<span class="empty-state-mark">' + icon(iconName) + '</span><h3>' + esc(title) + '</h3><p>' + esc(body) + '</p>' +
    (actionsHtml ? '<div class="empty-state-actions">' + actionsHtml + '</div>' : '') + '</div>';
}

