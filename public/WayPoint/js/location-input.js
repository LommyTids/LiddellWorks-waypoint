/* Offline location input. OpenLocationCode is the vendored Apache-2.0 implementation. */
function locationInputError(message, needsReference) {
  var result = { error: message };
  if (needsReference) result.needsReference = true;
  return result;
}

function validLocationInputPoint(lat, lng) {
  return typeof lat === 'number' && typeof lng === 'number' &&
    Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

function locationInputPoint(lat, lng, kind) {
  if (!validLocationInputPoint(lat, lng)) {
    return locationInputError('Enter latitude first (−90 to 90), then longitude (−180 to 180).');
  }
  return { lat: lat, lng: lng, kind: kind || 'coordinates', label: lat.toFixed(6) + ', ' + lng.toFixed(6) };
}

function parseLocationDecimalPair(text) {
  var number = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)';
  var match = text.match(new RegExp('^(' + number + ')(?:\\s*,\\s*|\\s+)(' + number + ')$'));
  return match ? locationInputPoint(Number(match[1]), Number(match[2])) : null;
}

function parseLocationCardinalPart(text, axis) {
  var cardinal = text.match(/^([NSEW])\s*(.*?)$|^(.*?)\s*([NSEW])$/i);
  if (!cardinal) return null;
  var direction = (cardinal[1] || cardinal[4]).toUpperCase();
  if (axis === 'lat' ? !/[NS]/.test(direction) : !/[EW]/.test(direction)) return null;
  var value = (cardinal[2] === undefined ? cardinal[3] : cardinal[2]).trim();
  // Accept decimal degrees, degrees/minutes, or degrees/minutes/seconds.
  var match = value.match(/^([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*°?$/) ||
    value.match(/^([+-]?\d+(?:\.\d+)?)(?:\s*°\s*|\s+)(\d+(?:\.\d+)?)\s*['′]?$/) ||
    value.match(/^([+-]?\d+(?:\.\d+)?)(?:\s*°\s*|\s+)(\d+(?:\.\d+)?)(?:\s*['′]\s*|\s+)(\d+(?:\.\d+)?)\s*["″]?$/);
  if (!match) return null;
  var degrees = Number(match[1]);
  var minutes = Number(match[2] || 0);
  var seconds = Number(match[3] || 0);
  if (minutes >= 60 || seconds >= 60 || (match[2] && !Number.isInteger(degrees)) ||
      (match[3] && !Number.isInteger(minutes))) return null;
  var negative = direction === 'S' || direction === 'W';
  if ((match[1][0] === '-' && !negative) || (match[1][0] === '+' && negative)) return null;
  var absolute = Math.abs(degrees) + minutes / 60 + seconds / 3600;
  return negative ? -absolute : absolute;
}

function parseLocationCardinalPair(text) {
  var pair = text.match(/^(.+?[NS])\s*[,;]?\s*(.+?[EW])$/i) ||
    text.match(/^([NS].+?)\s*[,;]?\s*([EW].+)$/i);
  if (!pair) return null;
  var lat = parseLocationCardinalPart(pair[1], 'lat');
  var lng = parseLocationCardinalPart(pair[2], 'lng');
  if (lat === null || lng === null) return locationInputError('Check the coordinate format, direction, minutes and seconds. Use latitude (N/S) first, then longitude (E/W).');
  return locationInputPoint(lat, lng);
}

function parseLocationMapsLink(text) {
  var url;
  try { url = new URL(text); } catch (error) { return locationInputError('Enter a complete Google Maps link, coordinates or a full Plus Code.'); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.port) {
    return locationInputError('Use a standard Google Maps link or paste its coordinates.');
  }
  var host = url.hostname.toLowerCase();
  if (host === 'maps.app.goo.gl' || (host === 'goo.gl' && /^\/maps(?:\/|$)/.test(url.pathname))) {
    return locationInputError('Open this short link in Google Maps, then copy the place’s coordinates or full Plus Code here.');
  }
  var domains = ['com', 'co.uk', 'com.au', 'co.nz', 'ca', 'de', 'fr', 'es', 'it', 'ie', 'nl', 'ch', 'at', 'be', 'jp', 'co.jp', 'in', 'co.in'];
  var trusted = domains.some(function(domain) {
    return host === 'maps.google.' + domain ||
      ((host === 'google.' + domain || host === 'www.google.' + domain) && /^\/maps(?:\/|$)/.test(url.pathname));
  });
  if (!trusted) return locationInputError('This link cannot be converted offline. Paste latitude, longitude or a full Plus Code instead.');
  if (/^\/maps\/dir(?:\/|$)/.test(url.pathname) || url.searchParams.has('query_place_id') ||
      url.searchParams.has('destination') || url.searchParams.has('origin')) {
    return locationInputError('This link contains a route or place ID. Copy the individual place’s coordinates or full Plus Code.');
  }
  var values = url.searchParams.getAll('query').concat(url.searchParams.getAll('q'));
  if (values.length !== 1) return locationInputError('This Google Maps link has no single coordinate target. Copy the place’s coordinates or full Plus Code; map-centre coordinates can point somewhere else.');
  var point = parseLocationDecimalPair(values[0].trim());
  if (!point) return locationInputError('This Google Maps link names a place instead of giving coordinates. Copy the place’s latitude, longitude or full Plus Code.');
  if (!point.error) point.kind = 'maps-link';
  return point;
}

function parseLocationInput(text, reference) {
  try {
    if (typeof text !== 'string' || !text.trim()) return locationInputError('Paste coordinates, a Plus Code or a Google Maps coordinate link.');
    text = text.trim();
    if (text.length > 2048) return locationInputError('This location is too long. Paste just the coordinates or Plus Code.');
    if (/^(?:\/{0,3})[\p{L}]+\.[\p{L}]+\.[\p{L}]+$/u.test(text) ||
        /^https?:\/\/(?:www\.)?(?:what3words\.com|w3w\.co)(?:\/|$)/i.test(text)) {
      return locationInputError('what3words conversion needs a separate API plan. Paste this place’s coordinates or a full Plus Code instead.');
    }
    if (/^https?:\/\//i.test(text)) return parseLocationMapsLink(text);
    if (/^geo:/i.test(text)) {
      var geo = text.match(/^geo:([+-]?(?:\d+(?:\.\d*)?|\.\d+)),([+-]?(?:\d+(?:\.\d*)?|\.\d+))(?:,[+-]?(?:\d+(?:\.\d*)?|\.\d+))?(?:;crs=wgs84)?(?:;u=\d+(?:\.\d+)?)?$/i);
      return geo ? locationInputPoint(Number(geo[1]), Number(geo[2])) : locationInputError('Use a geo: link with WGS84 latitude and longitude, or paste the coordinates directly.');
    }
    var decimal = parseLocationDecimalPair(text);
    if (decimal) return decimal;
    var cardinal = parseLocationCardinalPair(text);
    if (cardinal) return cardinal;
    if (text.indexOf('+') !== -1) {
      if (/\s/.test(text)) return locationInputError('For a short Plus Code, remove the place name and select a nearby destination, or paste the full Plus Code.');
      if (typeof OpenLocationCode === 'undefined') return locationInputError('Plus Code support has not loaded. Reload or enter coordinates.');
      var code = text.toUpperCase();
      var usedReference = false;
      if (OpenLocationCode.isShort(code)) {
        if (!reference || !validLocationInputPoint(reference.lat, reference.lng)) {
          return locationInputError('This is a short Plus Code. Select a nearby destination to complete it, or paste the full Plus Code.', true);
        }
        code = OpenLocationCode.recoverNearest(code, reference.lat, reference.lng);
        usedReference = true;
      }
      if (!OpenLocationCode.isFull(code)) return locationInputError('Check the Plus Code. A full code looks like 8FVC9G8F+6X.');
      var area = OpenLocationCode.decode(code);
      var point = locationInputPoint(area.latitudeCenter, area.longitudeCenter, 'plus-code');
      point.code = code;
      point.label = code + ' · ' + point.label;
      if (usedReference) point.usedReference = true;
      return point;
    }
    return locationInputError('Use latitude, longitude (for example 51.5074, -0.1278), N/S and E/W coordinates, or a full Plus Code.');
  } catch (error) {
    return locationInputError('That location could not be read. Check the coordinates or Plus Code.');
  }
}

function encodeLocationPlusCode(lat, lng) {
  if (!validLocationInputPoint(lat, lng) || typeof OpenLocationCode === 'undefined') return '';
  return OpenLocationCode.encode(lat, lng, 10);
}
