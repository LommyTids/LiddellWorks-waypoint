/* ---------- 4. Application state & persistence --------------------
   `state` holds every trip, the single source of truth on screen.
   `currentView`/`currentTripId`/`currentTab` track where the viewer is
   (dashboard vs. a trip, which tab) — per-viewer navigation, not trip
   data, so it's kept out of `state` and never saved. */

var state = { trips: [] };
var currentView = 'dashboard';
var currentTripId = null;
var currentTab = 'timeline';
// Mobile remembers the last child used inside the three multi-view
// destinations. More intentionally opens its own directory page every time,
// matching the agreed information architecture rather than guessing whether
// Expenses or Settings was wanted.
var mobileLastTab = { overview: 'timeline', plan: 'destinations', people: 'companions' };
var accountMenuOpen = false;
// Timeline disclosure is local viewing state, never trip data. Missing entries
// use the date-sensitive default: earlier days closed, today/future days open.
var timelineDayExpansion = {};
// Which slice of a trip this viewer wants to LOOK AT: 'everything' or
// 'mine'. Same category as timelineDayExpansion above -- a viewing
// preference, never trip data, never sent to the server. Keyed by tripId,
// because "just my items" makes sense on a big group trip and not on a
// solo one. An absent entry means "use the role's default", so this object
// starts empty and only ever holds a deliberate choice --
// see itemScopeFor() and scopedTripForRender() by the permission helpers.
var itemScopePreference = {};
// Connection, loading and save feedback are separate axes. Keeping them
// separate prevents a successful historic load from being mistaken for an
// editable online session after the browser later loses its connection.
var appLoadState = 'loading';
var connectionState = typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'online';
var reconnectInFlight = false;

function timelineLocalTodayStr(now) {
  var date = now || new Date();
  var month = String(date.getMonth() + 1).padStart(2, '0');
  var day = String(date.getDate()).padStart(2, '0');
  return date.getFullYear() + '-' + month + '-' + day;
}

function timelineDayKey(tripId, day) { return String(tripId || '') + '|' + day; }

function timelineDayExpanded(tripId, day, today) {
  var key = timelineDayKey(tripId, day);
  if (Object.prototype.hasOwnProperty.call(timelineDayExpansion, key)) return timelineDayExpansion[key];
  return day >= (today || timelineLocalTodayStr());
}

// ---- Accounts / login (see section 4b, "Auth", further down) ----------
// `currentUser` is null until checkAuth() resolves at boot, and stays
// null for the session if nobody's logged in — renderBoot() then shows
// the login screen instead of trip data. { id, username, isUberUser }
// once set. No global "role" -- what an account can do is entirely per
// trip (each trip's own `myGrant`, from src/worker.js's
// buildResponseState(); see canFullyEditTrip()/canEditItem() below).
// `isUberUser` is this account's own flag, only in responses describing
// the caller's own account (login/whoami/setup), never other accounts —
// see "undisclosed" in src/worker.js. Used only to show "Manage accounts".
var currentUser = null;
// Reserved participant id for tagging the trip owner directly (an
// account, not a companion record) without a duplicate companion.
var SUPERUSER_PARTICIPANT_ID = '__trip_superuser__';
// Set by checkAuth() from whoami: true only when no accounts exist yet,
// so the login screen offers first-run setup instead of a login form.
// See renderAuthScreen().
var setupNeeded = false;
// Account list as last fetched for "Manage accounts" (site owner only).
// See loadAndRenderManageUsers()/renderManageUsersView().
var managedUsers = [];
var siteStatus = null;

// The first thing this page does (see init() at the bottom) is fetch()
// saved data from our own JSON API, backed by Cloudflare KV (see
// src/worker.js). loadInitialState() below always resolves to a valid
// { trips: [...] }, even on failure, so the rest of the app never
// worries about a missing/malformed response.
//
// `stateIsTrustworthy` is true only while `state` is known to be a
// faithful copy of the server's data, set false the moment a load
// fails — this is what stops persist() from ever saving over real data
// with a state that was never really loaded. WHY THIS MATTERS: a trip
// is deleted by being left out of what the browser sends back (no
// separate delete endpoint — see "SAVING SAFELY" in src/worker.js). If
// a load fails and falls back to "no trips at all", the next edit would
// POST an empty list and the server would read that as "delete
// everything this account can see" — for the site owner, every trip.
// The server refuses a save deleting more than one trip as a backstop,
// but the browser shouldn't be sending it in the first place.
var stateIsTrustworthy = false;

async function loadInitialState() {
  appLoadState = 'loading';
  updateSystemFeedback();
  try {
    var res = await fetch('/WayPoint/api/data', { credentials: 'same-origin', headers: { 'Accept': 'application/json' } });
    if (!res.ok) throw new Error('Server responded with status ' + res.status);
    var parsed = await res.json();
    if (!parsed || typeof parsed !== 'object') parsed = {};
    if (!parsed.trips) parsed.trips = [];
    stateIsTrustworthy = true;
    connectionState = 'online';
    appLoadState = 'ready';
    updateSystemFeedback();
    return parsed;
  } catch (e) {
    console.error('Waypoint: could not load saved data from the server', e);
    stateIsTrustworthy = false;
    appLoadState = 'error';
    if (typeof navigator !== 'undefined' && navigator.onLine === false) connectionState = 'offline';
    updateSystemFeedback();
    showToastSafe('Could not load your trips. Your data is safe on the server; editing is locked until Waypoint reconnects.');
    return { trips: [] };
  }
}

// showToast() itself isn't defined yet at the point loadInitialState()
// first runs (script order), and toast-root may not exist yet either if
// something goes very wrong very early — this tiny wrapper just makes
// sure a failed load never throws a *second*, more confusing error on
// top of the first one.
function showToastSafe(message) {
  try { showToast(message, 'error'); } catch (e) { console.error(message); }
}


function setSaveStatus(kind, message) {
  var el = document.getElementById('save-indicator');
  if (!el) return;
  el.dataset.kind = kind;
  el.setAttribute('role', kind === 'error' || kind === 'unsaved' ? 'alert' : 'status');
  el.setAttribute('aria-live', kind === 'error' || kind === 'unsaved' ? 'assertive' : 'polite');
  var labels = { saving: 'Saving…', saved: 'Saved', error: message || 'Save failed', readonly: message || 'Read-only', unsaved: message || 'Not saved' };
  el.textContent = labels[kind] || '';
}

function editingAvailable() {
  return appLoadState === 'ready' && connectionState === 'online' && stateIsTrustworthy;
}

function updateSystemFeedback() {
  var banner = document.getElementById('system-banner');
  if (!banner) return;
  var kind = '';
  var message = '';
  if (connectionState === 'offline') {
    kind = 'offline';
    message = 'You are offline. Trip data remains visible, but editing is locked until Waypoint reconnects.';
  } else if (appLoadState === 'loading') {
    kind = 'loading';
    message = 'Loading your trips…';
  } else if (appLoadState === 'error' || !stateIsTrustworthy) {
    kind = 'error';
    message = 'Waypoint could not refresh your trips. Editing remains locked to protect your saved data.';
  }
  banner.className = 'system-banner' + (kind ? ' is-visible' : '');
  banner.dataset.kind = kind;
  banner.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  banner.innerHTML = kind
    ? icon(kind === 'loading' ? 'loading' : (kind === 'offline' ? 'offline' : 'warning')) + '<span class="system-banner-message">' + esc(message) + '</span>' +
      ((kind === 'offline' || kind === 'error') ? '<button type="button" class="btn btn-ghost" data-action="retry-connection"' + (reconnectInFlight ? ' disabled' : '') + '>' + (reconnectInFlight ? 'Retrying…' : 'Retry now') + '</button>' : '')
    : '';
  document.body.classList.toggle('editing-locked', !editingAvailable());
  updateStickyShellOffsets();
  updateSubmitAvailability(document);
  Array.prototype.forEach.call(document.querySelectorAll('[data-action]'), function (control) {
    if (isMutationAction(control.dataset.action)) control.disabled = !editingAvailable();
  });
}

// Sticky offsets follow the actual rendered header/banner, including text
// zoom, role badges and wrapping offline messages, rather than fixed heights.
function updateStickyShellOffsets() {
  var topbar = document.querySelector('.topbar');
  var banner = document.getElementById('system-banner');
  if (topbar) document.documentElement.style.setProperty('--wp-shell-bar-height', topbar.getBoundingClientRect().height + 'px');
  if (banner) document.documentElement.style.setProperty('--wp-shell-banner-height', banner.getBoundingClientRect().height + 'px');
}

async function retryConnection(options) {
  if (reconnectInFlight || !currentUser) return;
  reconnectInFlight = true;
  if (typeof navigator === 'undefined' || navigator.onLine !== false) connectionState = 'online';
  updateSystemFeedback();
  try {
    var fresh = await loadInitialState();
    if (!stateIsTrustworthy) return;
    state = fresh;
    // A reconnect deliberately trusts the server copy. A failed optimistic
    // save is never replayed without the person seeing and choosing it again.
    pendingSaveState = null;
    render();
    if (!(options && options.silent)) showToast('Connection restored. Your trips are up to date.', 'status');
  } finally {
    reconnectInFlight = false;
    updateSystemFeedback();
  }
}

// Every mutation goes through here: `mutator` receives a deep clone of
// the current state and edits it in place, then persist() saves it to
// the server. The clone means a save that fails partway never leaves
// the on-screen state half-changed.
function updateState(mutator) {
  if (!editingAvailable()) {
    setSaveStatus('readonly', connectionState === 'offline' ? 'Offline' : 'Editing locked');
    updateSystemFeedback();
    return false;
  }
  var next = cloneState(state);
  mutator(next);
  persist(next);
  return true;
}

// Every mutation goes through updateState() -> persist(): persist() is
// the only place that talks to the network. It (a) swaps in the live
// `state`, (b) re-renders immediately so the UI feels instant, and (c)
// saves to the server in the background, updating the "Saved"/"Saving…"
// label in the top bar.
//
// Save queue. Only ever one POST to /api/data in flight; if more edits
// happen while one runs, only the newest state is sent afterwards
// (every POST carries the whole picture, not a diff). This avoids two
// problems: ordering (two overlapping saves finishing out of order could
// let an older state undo a newer edit), and deleting two trips in quick
// succession putting two requests in flight that both omit the second
// trip, which the server rejects as a suspicious multi-trip deletion.
var saveInFlight = false;
var pendingSaveState = null;
var lastSaveStartedAt = 0;
var MIN_SAVE_INTERVAL_MS = 1100;

function waitMs(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function saveNavigationState() {
  try {
    sessionStorage.setItem('waypoint-nav', JSON.stringify({
      view: currentView,
      tripId: currentTripId,
      tab: currentTab,
      mobileLastTab: mobileLastTab,
      itemScope: itemScopePreference
    }));
  } catch (e) { /* Navigation persistence is an enhancement; rendering still works without storage. */ }
}

async function persist(newState) {
  // See stateIsTrustworthy above: refuse to save rather than risk
  // writing over real data with a state never successfully loaded. The
  // edit stays on screen but is NOT saved; the indicator says so.
  if (!stateIsTrustworthy) {
    setSaveStatus('readonly', 'Editing locked');
    updateSystemFeedback();
    return;
  }

  state = newState;
  saveNavigationState();
  render();

  if (saveInFlight) { pendingSaveState = state; return; }
  sendSave(state);
}

// The actual network half of persist(), split out so that draining the
// queue below doesn't re-run persist()'s render() — re-rendering for a
// save that changed nothing on screen would, among other things, tear
// down and rebuild the Leaflet map mid-view (see render()).
async function sendSave(toSave) {
  saveInFlight = true;
  setSaveStatus('saving');
  try {
    // Cloudflare KV permits only one write per second to a given key. The
    // queue already prevents overlap; this spacing also prevents the next
    // queued snapshot from immediately following the previous request.
    var spacing = MIN_SAVE_INTERVAL_MS - (Date.now() - lastSaveStartedAt);
    if (spacing > 0) await waitMs(spacing);

    var res;
    for (var attempt = 0; attempt < 3; attempt++) {
      lastSaveStartedAt = Date.now();
      res = await fetch('/WayPoint/api/data', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(toSave)
      });
      if (res.status !== 429 || attempt === 2) break;
      var retryAfter = Number(res.headers.get('Retry-After')) || Math.pow(2, attempt + 1);
      await waitMs(Math.min(retryAfter * 1000, 8000));
    }
    if (!res.ok) {
      // The server sends a human-readable explanation for a refused save
      // (e.g. the multi-trip-deletion guard) — show that, not a bare code.
      var body = await res.json().catch(function () { return {}; });
      throw new Error(body.error || ('Server responded with status ' + res.status));
    }
    var savedBody = await res.json().catch(function () { return {}; });
    var revisions = savedBody.revisions || {};
    [state, pendingSaveState, toSave].forEach(function (snapshot) {
      if (!snapshot || !Array.isArray(snapshot.trips)) return;
      snapshot.trips.forEach(function (trip) {
        if (Object.prototype.hasOwnProperty.call(revisions, trip.tripId)) trip.revision = revisions[trip.tripId];
      });
    });
    setSaveStatus('saved');
  } catch (err) {
    console.error('Waypoint: save failed', err);
    setSaveStatus('error', 'Could not save');
    if ((typeof navigator !== 'undefined' && navigator.onLine === false) || err instanceof TypeError) connectionState = 'offline';
    stateIsTrustworthy = false;
    appLoadState = 'error';
    pendingSaveState = null;
    updateSystemFeedback();
    showToast('Could not save your change: ' + (err && err.message ? err.message : 'unknown error'), 'error');
  } finally {
    saveInFlight = false;
    if (pendingSaveState && editingAvailable()) {
      var queued = pendingSaveState;
      pendingSaveState = null;
      sendSave(queued);
    }
  }
}

