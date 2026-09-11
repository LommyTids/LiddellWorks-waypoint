
/* ================================================================
   WAYPOINT — application logic
   ----------------------------------------------------------------
   No build step, no framework: plain JavaScript that (a) keeps all
   trip data in one JS object called `state`, (b) turns that object
   into HTML strings whenever something changes (the render*
   functions), and (c) saves it to our own JSON API (see
   loadInitialState()/persist() in state.js), stored in Cloudflare KV.
   Classic scripts share scope and load in index.html order; boot.js
   starts the application after every feature is available.
   ================================================================ */

/* ---------- 1. Small constants ---------------------------------- */

// COMMON_CURRENCIES, COMMON_TIMEZONES, COMMON_COUNTRIES, COMMON_CITIES
// and COMMON_AIRPORTS are loaded from separate files under
// /WayPoint/data/ (see the <script> tags near the top, after
// leaflet.js) to keep this file smaller — they're still plain globals
// by the time any code below runs. See data/airports.js for why
// COMMON_AIRPORTS is shaped differently (objects with city/country,
// not flat strings) — that's for the Map tab's geocoding.

var WEEKDAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

var TRANSPORT_MODES = ['Flight','Train','Bus','Car','Ferry','Other'];
// How a transport leg was paid for — drives which cost-related fields
// show up on the form (see transportSectionsForMode()): Cash shows a
// currency+amount, Points shows a program+points-count, Combo shows
// both, and Free shows neither (nothing to record).
var TRANSPORT_PAYMENT_TYPES = ['Cash', 'Points', 'Combo', 'Free'];
var EXPENSE_CATEGORIES = ['Food & drink','Transport','Accommodation','Activities','Shopping','Other'];

/* ---------- 2. Generic utilities --------------------------------- */

// Turns any value into a short random-ish id, unique enough for a
// personal planner (not a distributed database, so this is plenty).
function newId() {
  return 'id_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

// Escapes text so it's safe to drop into an HTML template string as
// element text or inside a quoted attribute. Without this, a note
// containing `<` or `"` could break the page's markup.
function esc(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Resolves a semantic design token for JavaScript-owned surfaces such as
// Leaflet paths. Keeping the source of truth in CSS means these elements use
// the same approved light/dark palette as the rest of the application.
function cssToken(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// Finds one item in `list` by its id. Most Waypoint data uses a typed id
// field (tripId, destinationId, ...; see "SCHEMA" in src/worker.js) --
// pass which field to match as `idField`, e.g. byId(trip.destinations,
// someId, 'destinationId'). Account/login records still use plain `id`,
// the default when `idField` is omitted.
function byId(list, id, idField) {
  var field = idField || 'id';
  return (list || []).find(function (x) { return x[field] === id; });
}

// Maps a trip item type -- plural key on the trip ("destinations") or
// singular name in click-action strings ("edit-destination") -- to that
// item's own id field, so deleteEntity() and rowActions() stay in sync.
var ENTITY_ID_FIELDS = {
  destination: 'destinationId', destinations: 'destinationId',
  activity: 'activityId', activities: 'activityId',
  transport: 'transportId',
  accommodation: 'accommodationId',
  contact: 'contactId', contacts: 'contactId',
  companion: 'companionId', companions: 'companionId',
  expense: 'expenseId', expenses: 'expenseId'
};

// Deep-clones the app state before we mutate it, so a half-finished
// edit never leaks into the UI before it's actually saved.
function cloneState(s) {
  if (typeof structuredClone === 'function') return structuredClone(s);
  return JSON.parse(JSON.stringify(s));
}

function slug(str) {
  return String(str || 'trip').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'trip';
}

/* ---- date/time helpers ----
   Dates are stored as "YYYY-MM-DD", date+times as "YYYY-MM-DDTHH:MM".
   Deliberately not fed into `new Date("YYYY-MM-DD")` for display: that
   parses as UTC midnight, and a local timezone conversion can then
   silently roll the displayed date back a day. The UTC getters keep
   everyone's timeline showing the date they actually typed. */

function addDays(dateStr, n) {
  var parts = dateStr.split('-').map(Number);
  var dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

// Whole days between two "YYYY-MM-DD" dates. Built from Date.UTC parts for
// the same reason as addDays(): a local-timezone parse can shift the result.
function daysBetween(fromDate, toDate) {
  var from = fromDate.split('-').map(Number);
  var to = toDate.split('-').map(Number);
  return Math.round((Date.UTC(to[0], to[1] - 1, to[2]) - Date.UTC(from[0], from[1] - 1, from[2])) / 86400000);
}

function formatDateHeading(dateStr) {
  var parts = dateStr.split('-').map(Number);
  var dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  return WEEKDAYS[dt.getUTCDay()] + ' ' + parts[2] + ' ' + MONTHS[parts[1] - 1] + ' ' + parts[0];
}

function formatDateShort(dateStr) {
  if (!dateStr) return '';
  var parts = dateStr.split('-').map(Number);
  return parts[2] + ' ' + MONTHS[parts[1] - 1] + ' ' + parts[0];
}

function dateOnly(iso) { return iso ? iso.slice(0, 10) : ''; }
function timeOnly(iso) { return (iso && iso.length >= 16) ? iso.slice(11, 16) : ''; }

function combineDateTime(date, time) {
  if (!date) return '';
  return date + 'T' + (time || '00:00');
}
function splitDateTime(iso) {
  return { date: dateOnly(iso), time: timeOnly(iso) };
}

// Activities originally stored one `date` plus optional times. Keep that
// field as a compatibility mirror, while all new UI reads the explicit range.
// This lets an older saved activity open naturally in the redesigned editor
// and makes every date-aware view use the same inclusive range.
function activityStartDate(activity) { return (activity && (activity.startDate || activity.date)) || ''; }
function activityEndDate(activity) { return (activity && (activity.endDate || activityStartDate(activity))) || ''; }
function activityIsAllDay(activity) {
  if (!activity) return true;
  return activity.allDay === true || activity.allDay === 'true' || (!activity.startTime && !activity.endTime);
}
function activityOccursOn(activity, day) {
  var start = activityStartDate(activity), end = activityEndDate(activity);
  return !!(day && start && start <= day && day <= end);
}
function activityDateTimeLabel(activity) {
  var start = activityStartDate(activity), end = activityEndDate(activity);
  if (!start) return '';
  var dates = formatDateShort(start) + (end && end !== start ? ' – ' + formatDateShort(end) : '');
  if (activityIsAllDay(activity)) return dates + ' · All day';
  var startTime = activity.startTime || '';
  var endTime = activity.endTime || '';
  if (end && end !== start) return dates + (startTime ? ' · ' + startTime : '') + (endTime ? ' → ' + endTime : '');
  return dates + (startTime ? ' · ' + startTime : '') + (endTime ? '–' + endTime : '');
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

/* ---- currency helpers ---- */

// Converts an amount in `currency` into the trip's home currency. A
// per-item `rateOverride` always wins; otherwise falls back to the
// trip's fixed rate for that currency (set in Settings). `known` is
// false when neither is available, so callers can flag the amount
// instead of silently treating it as zero.
function homeValue(trip, amount, currency, rateOverride) {
  var amt = Number(amount) || 0;
  if (!currency || currency === trip.homeCurrency) return { value: amt, rateUsed: 1, known: true };
  var rate = (rateOverride !== undefined && rateOverride !== null && rateOverride !== '')
    ? Number(rateOverride)
    : trip.currencyRates[currency];
  if (rate === undefined || rate === null || isNaN(rate)) return { value: 0, rateUsed: null, known: false };
  return { value: amt * rate, rateUsed: rate, known: true };
}

function money(amount, currency) {
  var n = Number(amount) || 0;
  return esc(currency || '') + ' ' + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Turns an IANA timezone name (e.g. "Asia/Bangkok") into a short
// current UTC-offset label (e.g. "GMT+7") via the browser's timezone
// database. Returns '' for a blank/unrecognised timezone rather than
// throwing -- only ever used as a friendly hint next to the typed name.
function tzOffsetLabel(tz) {
  if (!tz) return '';
  try {
    var parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(new Date());
    var part = parts.find(function (p) { return p.type === 'timeZoneName'; });
    return part ? part.value : '';
  } catch (e) {
    return '';
  }
}

/* ---------- 3. Icons ---------------------------------------------
   Artwork lives in ui/icons.js. This local wrapper keeps existing render
   functions terse while routing every request through semantic validation. */

// Returns the icon key that best represents a transport mode, so the
// timeline and transport list show a plane for flights, a train icon
// for trains, and so on.
function transportIconKey(mode) {
  var m = (mode || '').toLowerCase();
  if (m === 'flight') return 'flight';
  if (m === 'train') return 'rail';
  if (m === 'bus') return 'bus';
  if (m === 'car') return 'car';
  if (m === 'ferry') return 'ferry';
  return 'route';
}

// One-line label for a transport leg, e.g. "Flight BA15: LHR → HND" or
// plain "Car: Hotel → Airport" for modes with no flight number. Shared
// by the Transport tab, the Timeline and the expense ledger so the
// same leg always reads the same way everywhere.
function transportLabel(t) {
  return (t.mode || 'Transport') + (t.flightNumber ? ' ' + t.flightNumber : '') + ': ' + t.fromLocation + ' → ' + t.toLocation;
}

function icon(name, extraClass) {
  return WayPointIcons.render(name, extraClass);
}

// The brand mark is sourced from the registry as well, rather than being a
// second hand-maintained inline SVG in the page shell.
document.getElementById('brand-icon').innerHTML = icon('brand');

/* ---------- 3b. Avatars (Companions/Avatars feature) ------------------
   Draws a companion/account marker: item rows, trip cards, the
   timeline, the tag-picker (companionTags()/renderTripCardAvatars()/
   eventRowHtml()/the 'tag-picker' case in fieldHtml()). Resolution --
   animal vs. smiley, which colour/animal -- always happens server-side
   (resolveCompanionAvatars() in src/worker.js, the `companionAvatars`
   map on every trip); this only turns the resolved
   `{ type, color, animal }` into HTML, via avatarColorHex()/
   avatarAnimalEmoji() (data/avatars.js) so a token never gets written
   straight into a `style` attribute (see that file for the
   CSS-injection risk). `name` is always shown as a title/tooltip. */
function avatarMarkerHtml(avatar, name, extraClass) {
  if (!avatar) return '';
  var title = ' title="' + esc(name || '') + '" aria-label="' + esc(name || '') + '"';
  if (avatar.type === 'account') {
    var bg = avatarColorHex(avatar.color) || AVATAR_GREY_HEX;
    var glyph = avatarAnimalEmoji(avatar.animal) || '';
    return '<span class="avatar-marker ' + (extraClass || '') + '" style="background:' + bg + '"' + title + '>' + glyph + '</span>';
  }
  // Non-account companion: fixed grey circle (see AVATAR_GREY_HEX),
  // coloured smiley per whoever added them.
  var smileyHex = avatarColorHex(avatar.color) || '#6b7280';
  return '<span class="avatar-marker ' + (extraClass || '') + '" style="background:' + AVATAR_GREY_HEX + '"' + title + '>' +
    '<span class="avatar-marker-smiley" style="color:' + smileyHex + '">☺</span></span>';
}

// Looks up companion `companionId`'s resolved marker on `trip` and draws
// it via avatarMarkerHtml() above, paired with their name. Returns ''
// for a dangling/removed companion id, degrading to "nothing shown"
// rather than an error.
function companionAvatarHtml(trip, companionId, name) {
  if (companionId === SUPERUSER_PARTICIPANT_ID) {
    return avatarMarkerHtml(trip.superuserParticipant && trip.superuserParticipant.avatar, name);
  }
  var avatar = trip.companionAvatars && trip.companionAvatars[companionId];
  return avatarMarkerHtml(avatar, name);
}

// The full list offered by a People picker. The trip owner is deliberately
// virtual: it is supplied from server-owned account data, while ordinary
// companions continue to use the existing per-trip records and ids.
function taggablePeople(trip) {
  var people = [];
  if (trip && trip.superuserParticipant && trip.superuserParticipant.name) {
    people.push({
      companionId: SUPERUSER_PARTICIPANT_ID,
      name: trip.superuserParticipant.name,
      isSuperuser: true
    });
  }
  return people.concat(((trip && trip.companions) || []).filter(function (c) {
    return c.companionId !== SUPERUSER_PARTICIPANT_ID;
  }));
}

function taggablePersonById(trip, id) {
  return taggablePeople(trip).find(function (person) { return person.companionId === id; }) || null;
}

// Dashboard trip cards: "who's on this trip at a glance". Bare markers
// with no '.tag' pill (unlike companionTags() above) — a plain row of
// small circles rather than the pill treatment used inside a trip's own
// tabs. Capped at MAX_CARD_AVATARS; overflow collapses into a single
// "+N" bubble (title lists remaining names) rather than wrapping. Data
// is already scoped/stripped server-side per buildVisibleTrip(), so
// there's nothing extra to permission-check here.
var MAX_CARD_AVATARS = 6;
function tripCardAvatarsHtml(trip) {
  var companions = trip.companions || [];
  if (companions.length === 0) return '';
  var shown = companions.slice(0, MAX_CARD_AVATARS);
  var overflow = companions.length - shown.length;
  var html = shown.map(function (c) { return companionAvatarHtml(trip, c.companionId, c.name); }).join('');
  if (overflow > 0) {
    var remainingNames = companions.slice(MAX_CARD_AVATARS).map(function (c) { return c.name; }).join(', ');
    html += '<span class="avatar-marker avatar-marker-overflow" title="' + esc(remainingNames) + '">+' + overflow + '</span>';
  }
  return '<span class="avatar-row trip-card-avatars">' + html + '</span>';
}

