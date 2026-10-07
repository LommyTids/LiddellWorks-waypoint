// Local wall-clock values remain unchanged in storage. Only elapsed-time
// calculations use UTC; the device's timezone is never involved.
var TRANSPORT_TIME_FIELDS = ['mode', 'fromLocation', 'toLocation', 'fromLat', 'fromLng', 'toLat', 'toLng', 'fromLocationStale', 'toLocationStale', 'departTimezoneOverride', 'arriveTimezoneOverride', 'departOccurrence', 'arriveOccurrence'];
var zoneFormatters = Object.create(null);
function zoneFormatter(zone) {
  if (!zoneFormatters[zone]) zoneFormatters[zone] = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  });
  return zoneFormatters[zone];
}
function zoneWallMinutes(instant, zone) {
  var parts = {};
  zoneFormatter(zone).formatToParts(new Date(instant * 60000)).forEach(function (p) { parts[p.type] = p.value; });
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute) / 60000;
}
function resolveTransportTimezone(values, end) {
  var side = end ? 'arrive' : 'depart', prefix = end ? 'to' : 'from';
  var override = (values[side + 'TimezoneOverride'] || '').trim();
  if (override) return override;
  var lat = values[prefix + 'Lat'], lng = values[prefix + 'Lng'];
  var stale = values[prefix + 'LocationStale'] === true || values[prefix + 'LocationStale'] === 'true';
  var point = !stale && lat !== '' && lat != null && lng !== '' && lng != null ? { lat: Number(lat), lng: Number(lng) } : null;
  if (!point && values.mode === 'Flight' && typeof airportCoordsFromText === 'function') point = airportCoordsFromText(values[prefix + 'Location']);
  if (!point || typeof tzlookup !== 'function') return '';
  try { return tzlookup(point.lat, point.lng); } catch (_) { return ''; }
}
function zonedInstant(date, time, zone, occurrence) {
  if (!zone) return { error: 'Select timezone to calculate duration' };
  if (!date || !time) return { error: 'Add both times' };
  var wall = journeyUtcMinutes(date, time);
  // Sample offsets on both sides of a transition, then round-trip every
  // candidate. This detects nonexistent and repeated local times, including
  // half-hour transitions and date-line jumps, without silently moving them.
  var candidates = [], offsets = {};
  try {
    for (var h = -48; h <= 48; h += 6) {
      var sample = wall + h * 60;
      offsets[zoneWallMinutes(sample, zone) - sample] = true;
    }
    Object.keys(offsets).forEach(function (offset) {
      var instant = wall - Number(offset);
      if (zoneWallMinutes(instant, zone) === wall) candidates.push(instant);
    });
  } catch (_) { return { error: 'Choose a recognised timezone' }; }
  candidates.sort(function (a, b) { return a - b; });
  if (!candidates.length) return { error: 'This local time does not exist because the clocks change. Check the time.' };
  if (candidates.length > 1 && occurrence !== 'earlier' && occurrence !== 'later') return { error: 'This local time occurs twice. Choose earlier or later under Timezones.' };
  return { minutes: candidates[occurrence === 'later' ? candidates.length - 1 : 0] };
}
function transportElapsed(values) {
  var start = zonedInstant(values.departDate, values.departTime, resolveTransportTimezone(values, false), values.departOccurrence);
  var end = zonedInstant(values.arriveDate, values.arriveTime, resolveTransportTimezone(values, true), values.arriveOccurrence);
  if (start.error || end.error) return { error: start.error || end.error };
  var minutes = end.minutes - start.minutes;
  return minutes < 0 ? { error: 'Arrival is before departure after timezone conversion. Check the dates and times.' } : { minutes: minutes };
}
function transportLocalLabel(values, end) {
  var side = end ? 'arrive' : 'depart', zone = resolveTransportTimezone(values, end);
  if (!zone) return (end ? 'Arrival' : 'Departure') + ' local time · timezone unknown';
  var instant = zonedInstant(values[side + 'Date'], values[side + 'Time'], zone, values[side + 'Occurrence']);
  var offset = '';
  if (!instant.error) {
    var minutes = zoneWallMinutes(instant.minutes, zone) - instant.minutes;
    offset = ' · UTC' + (minutes >= 0 ? '+' : '−') + String(Math.floor(Math.abs(minutes) / 60)).padStart(2, '0') + ':' + String(Math.abs(minutes) % 60).padStart(2, '0');
  }
  return zone + offset;
}
function transportDisplayValues(transport) {
  return Object.assign({}, transport, { departTimezoneOverride: transport.departTimezoneOverride || transport.departTimezone || '', arriveTimezoneOverride: transport.arriveTimezoneOverride || transport.arriveTimezone || '', departDate: dateOnly(transport.departDateTime), departTime: timeOnly(transport.departDateTime), arriveDate: dateOnly(transport.arriveDateTime), arriveTime: timeOnly(transport.arriveDateTime) });
}
