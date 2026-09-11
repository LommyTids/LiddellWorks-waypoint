/* ---------- 4b. Auth: login / setup / logout / per-trip permissions ---
   Who's using the app right now, as opposed to what trip data they're
   looking at (`state`, above). See the top of src/worker.js for the
   server side; this is just the frontend's half: show a login screen
   with no session, remember who's logged in once there is one. What
   that account can DO is decided per trip (and, for a "user" grant, per
   item) — see canFullyEditTrip()/canEditItem() near currentTrip(). */

// Asks the server "is there a valid session, and if so who?" — always
// resolves (never throws), leaving currentUser null on failure so the
// app falls back to the login screen rather than a half-broken page.
async function checkAuth() {
  try {
    var res = await fetch('/WayPoint/api/whoami', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    var body = await res.json();
    if (body && body.loggedIn) {
      currentUser = { id: body.id, username: body.username, isUberUser: !!body.isUberUser, avatar: body.avatar || null };
    } else {
      currentUser = null;
      setupNeeded = !!(body && body.setupNeeded);
    }
  } catch (err) {
    currentUser = null;
  }
}

// Keeps the topbar's "who's logged in" area in sync with `currentUser`.
// Called whenever currentUser changes (checkAuth(), login/setup,
// logout). No global read-only styling here — permissions are per trip,
// checked by every trip/item-level render itself.
function applyAuthUI() {
  var el = document.getElementById('account-bar');
  if (!el) return;
  if (!currentUser) { el.innerHTML = ''; return; }
  // The avatar swatch itself IS the "change your avatar" control -- a
  // single clickable button, rather than a separate edit link. See
  // openAvatarPicker(). currentUser.avatar is always a real
  // {color,animal} pair once logged in (resolveAccountAvatar() on the
  // server never sends back nothing), so no "not set yet" case here.
  var marker = avatarMarkerHtml(currentUser.avatar ? { type: 'account', color: currentUser.avatar.color, animal: currentUser.avatar.animal } : null, currentUser.username);
  var manageDesktop = currentUser.isUberUser ? '<button class="btn btn-ghost" data-action="open-site-settings">Site settings</button><button class="btn btn-ghost" data-action="open-manage-users">Manage accounts</button>' : '';
  var manageMobile = currentUser.isUberUser ? '<button class="account-menu-item" role="menuitem" data-action="open-site-settings">' + icon('settings') + ' Site settings</button><button class="account-menu-item" role="menuitem" data-action="open-manage-users">' + icon('people') + ' Manage accounts</button>' : '';
  el.innerHTML =
    '<div class="account-desktop-actions">' +
      '<button class="account-avatar-btn" data-action="open-avatar-picker" aria-label="Change your avatar" title="Change your avatar">' + marker +
        '<span class="account-label account-label-inline">' + esc(currentUser.username) + '</span>' +
      '</button>' + manageDesktop +
      '<button class="btn btn-ghost" data-action="logout">Log out</button>' +
    '</div>' +
    '<div class="account-menu">' +
      '<button class="account-avatar-btn account-menu-toggle" data-action="toggle-account-menu" aria-label="Open account menu" aria-haspopup="menu" aria-expanded="' + String(accountMenuOpen) + '">' + marker + '</button>' +
      (accountMenuOpen ? '<div class="account-popover" role="menu" aria-label="Account">' +
        '<div class="account-popover-name">Signed in as ' + esc(currentUser.username) + '</div>' +
        '<button class="account-menu-item" role="menuitem" data-action="open-avatar-picker">' + icon('edit') + ' Change avatar</button>' +
        manageMobile +
        '<button class="account-menu-item" role="menuitem" data-action="logout">' + icon('logout') + ' Log out</button>' +
      '</div>' : '') +
    '</div>';
}

// Builds the login screen, or (if no account exists yet — see
// setupNeeded, set by checkAuth()) the one-time setup screen instead.
// `errorMessage`, when given, is shown above the form.
function renderAuthScreen(errorMessage) {
  var errorHtml = errorMessage ? '<p class="auth-error" role="alert" tabindex="-1">' + esc(errorMessage) + '</p>' : '';
  if (setupNeeded) {
    return '<div class="auth-screen"><div class="auth-card">' +
      '<h1>Set up Waypoint</h1>' +
      '<p class="field-hint">No accounts exist yet — create your own account to get started. It becomes the site owner\'s account, with full access to everything. You\'ll need the setup key (the <code>WAYPOINT_PASSWORD</code> secret set in the Cloudflare dashboard when this was first deployed).</p>' +
      errorHtml +
      '<form id="setup-form">' +
        '<div class="field"><label>Setup key</label><input type="password" name="setupKey" required autocomplete="off"></div>' +
        '<div class="field"><label>Choose a username</label><input type="text" name="username" required autocomplete="username"></div>' +
        '<div class="field"><label>Choose a password</label><input type="password" name="password" required autocomplete="new-password"><div class="field-hint">At least 8 characters.</div></div>' +
        '<button type="submit" class="btn btn-primary auth-primary">Create account</button>' +
      '</form>' +
    '</div></div>';
  }
  return '<div class="auth-screen"><div class="auth-card">' +
    '<h1>Log in to Waypoint</h1>' +
    errorHtml +
    '<form id="login-form">' +
      '<div class="field"><label>Username</label><input type="text" name="username" required autocomplete="username"></div>' +
      '<div class="field"><label>Password</label><input type="password" name="password" required autocomplete="current-password"></div>' +
      '<button type="submit" class="btn btn-primary auth-primary">Log in</button>' +
    '</form>' +
    '<p class="field-hint auth-footer">Don\'t have an account? Ask the site owner to set one up for you.</p>' +
  '</div></div>';
}

// Shared by the login form and the first-run setup form ('login-form'/
// 'setup-form' branches in the submit listener below) — POSTs
// credentials, lands in the app on success or re-shows the screen with
// an error on failure, rather than leaving the form silently stuck.
async function submitAuthForm(url, payload) {
  try {
    var res = await fetch(url, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    var body = await res.json().catch(function () { return {}; });
    if (!res.ok) {
      var errorApp = document.getElementById('app');
      errorApp.innerHTML = renderAuthScreen(body.error || 'Something went wrong — try again.');
      enhanceAccessibility(errorApp);
      var authError = errorApp.querySelector('.auth-error');
      if (authError) authError.focus();
      return;
    }
    currentUser = { id: body.id, username: body.username, isUberUser: !!body.isUberUser, avatar: body.avatar || null };
    clearSavedNav();
    await renderBoot();
  } catch (err) {
    var offlineApp = document.getElementById('app');
    offlineApp.innerHTML = renderAuthScreen('Could not reach the server — check your connection and try again.');
    enhanceAccessibility(offlineApp);
    var offlineError = offlineApp.querySelector('.auth-error');
    if (offlineError) offlineError.focus();
  }
}

// Forgets "which trip/tab was last open" (see persist()'s
// sessionStorage.setItem and renderBoot()'s read of it) whenever the
// logged-in account changes. Without this, logging out of one account
// into a different one on the same browser tab (routine on a shared
// family device) could land the new account inside the previous
// account's trip instead of the dashboard — a real bug caught by
// test-auth-roles.js.
function clearSavedNav() {
  try { sessionStorage.removeItem('waypoint-nav'); } catch (e) { /* sessionStorage may be unavailable */ }
}

async function doLogout() {
  try {
    await fetch('/WayPoint/api/logout', { method: 'POST', credentials: 'same-origin' });
  } catch (err) {
    // Worst case the server-side cookie lingers until it expires -- we
    // still drop back to the login screen client-side either way, and
    // every real data endpoint re-checks the session regardless.
  }
  state = { trips: [] };
  currentView = 'dashboard'; currentTripId = null; currentTab = 'timeline';
  clearSavedNav();
  // Re-run checkAuth() (not just currentUser = null) so setupNeeded
  // refreshes too -- otherwise logging out right after first-ever setup
  // would show the setup screen again instead of a login form.
  await checkAuth();
  await renderBoot();
}

// The single entry point deciding what the page shows: the login/setup
// screen, or the normal app. Called once at boot (see init() at the
// bottom) and after every login/setup/logout -- always this function,
// never render() directly, decides that top-level split.
async function renderBoot() {
  applyAuthUI();
  if (!currentUser) {
    document.body.classList.remove('is-trip-view');
    var authApp = document.getElementById('app');
    authApp.innerHTML = renderAuthScreen();
    enhanceAccessibility(authApp);
    return;
  }
  state = await loadInitialState();
  try {
    var nav = JSON.parse(sessionStorage.getItem('waypoint-nav') || 'null');
    if (nav && nav.view === 'trip' && byId(state.trips, nav.tripId, 'tripId')) {
      currentView = 'trip'; currentTripId = nav.tripId; currentTab = nav.tab || 'timeline';
      if (nav.mobileLastTab && typeof nav.mobileLastTab === 'object') {
        ['overview', 'plan', 'people'].forEach(function (destination) {
          if (typeof nav.mobileLastTab[destination] === 'string') mobileLastTab[destination] = nav.mobileLastTab[destination];
        });
      }
      // Restore the viewing lens, keeping only values this build knows.
      // Anything else is ignored so an old or hand-edited blob can't put
      // the app into a scope it has no control for.
      if (nav.itemScope && typeof nav.itemScope === 'object') {
        Object.keys(nav.itemScope).forEach(function (tripId) {
          var stored = nav.itemScope[tripId];
          if (stored === 'mine' || stored === 'everything') itemScopePreference[tripId] = stored;
        });
      }
    }
  } catch (e) { /* ignore malformed/unavailable sessionStorage */ }
  render();
}

/* ---------- 4c. Manage accounts (site owner / uber-user only) ---------
   A trip-agnostic screen (currentView === 'manage-users') for creating,
   renaming, resetting the password of, and deleting logins. Minimal,
   since permissions live on trips now, not accounts -- roles and trip
   access are each trip's own Superuser/Admin's call, via that trip's
   Companions tab (openCompanionLinkForm()/openAddLinkedCompanionForm()).
   Reached via "Manage accounts" in the topbar (applyAuthUI()), shown
   only for the uber-user -- the server enforces the same rule
   independently (src/worker.js's /api/users routes). */

async function loadAndRenderManageUsers() {
  currentView = 'manage-users';
  try {
    var res = await fetch('/WayPoint/api/users', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    var body = await res.json();
    managedUsers = (body && body.users) || [];
  } catch (err) {
    managedUsers = [];
    showToastSafe('Could not load accounts.');
  }
  pendingRenderFocus = '[data-page-heading]';
  render();
}

function renderManageUsersView() {
  var rows = managedUsers.slice().sort(function (a, b) { return a.username.localeCompare(b.username); }).map(function (u) {
    // Accounts are not a trip record, so rowActions() has no id field or
    // permission rule for them -- the two controls are supplied directly
    // and the card's own action slot is switched off.
    return itemRowHtml(null, {
      context: 'person', section: 'account', item: u, icon: 'person',
      title: u.username,
      showRecordActions: false,
      extraActionsHtml: '<div class="item-actions">' +
        '<button class="btn btn-icon btn-ghost" data-action="edit-user" data-id="' + u.id + '" aria-label="Edit account" title="Edit account">' + icon('edit') + '</button>' +
        '<button class="btn btn-icon btn-ghost" data-action="delete-user" data-id="' + u.id + '" aria-label="Delete account" title="Delete account">' + icon('delete') + '</button>' +
      '</div>',
      metadata: {}
    });
  }).join('');
  return '<button class="back-link" data-action="back-to-dashboard">' + icon('back') + ' All trips</button>' +
    '<div class="tab-panel-head"><h1 data-page-heading tabindex="-1">Manage accounts</h1>' +
      '<button class="btn btn-accent" data-action="new-user">' + icon('add') + ' Add account</button></div>' +
    '<p class="field-hint manage-users-intro">You set every account\'s username and password yourself and share it with them directly — there\'s no self-signup or "forgot password" flow. Creating an account here just gives someone a login; it doesn\'t give them access to any trip. Whoever creates a trip becomes that trip\'s owner, and can then share it with any of these accounts from that trip\'s own Settings tab.</p>' +
    (managedUsers.length ? '<div class="item-list">' + rows + '</div>' : '<p class="field-hint">No accounts yet.</p>');
}

async function loadAndRenderSiteSettings() {
  currentView = 'site-settings';
  siteStatus = null;
  pendingRenderFocus = '[data-page-heading]';
  render();
  try {
    var res = await fetch('/WayPoint/api/site-status', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('Status ' + res.status);
    siteStatus = await res.json();
  } catch (err) {
    siteStatus = { error: true };
  }
  render();
}

function integrationStatusBadge(configured) {
  return configured
    ? '<span class="status-badge is-limited">' + icon('saved') + ' Configured</span>'
    : '<span class="status-badge is-readonly">' + icon('warning') + ' Not configured</span>';
}

function renderSiteSettingsView() {
  if (!currentUser || !currentUser.isUberUser) return emptyStateHtml('permission', 'readonly', 'Site settings restricted', 'Only the site owner can view site-wide integrations and service status.');
  var content;
  if (!siteStatus) {
    content = emptyStateHtml('loading', 'loading', 'Checking integrations', 'Waypoint is checking which site services are configured.', '', true);
  } else if (siteStatus.error) {
    content = emptyStateHtml('error', 'warning', 'Site status unavailable', 'The integration status could not be loaded. No secret values were exposed or changed.', '<button type="button" class="btn" data-action="open-site-settings">Retry</button>', true);
  } else {
    var integrations = siteStatus.integrations || {};
    content = '<div class="settings-stack"><section class="settings-section"><div class="settings-section-head"><div><h2>Integrations</h2><p>Site-wide services used by every trip. Secret values remain editable only in Cloudflare.</p></div></div><div class="integration-list">' +
      '<div class="integration-row"><div class="integration-copy"><strong>Flight lookup</strong><span>AeroDataBox through RapidAPI · AERODATABOX_API_KEY</span></div>' + integrationStatusBadge(!!integrations.flightLookup) + '</div>' +
      '<div class="integration-row"><div class="integration-copy"><strong>Location search</strong><span>LocationIQ search and boundaries · LOCATIONIQ_API_KEY</span></div>' + integrationStatusBadge(!!integrations.locationSearch) + '</div>' +
      '</div></section></div>';
  }
  return '<button class="back-link" data-action="back-to-dashboard">' + icon('back') + ' All trips</button><div class="section-head"><h1 data-page-heading tabindex="-1">Site settings</h1></div>' + content;
}

// Opens the Add/Edit account modal. Built directly rather than through
// the openForm()/fieldHtml() system every other form uses -- too small a
// fixed shape to be worth the generic machinery. Uses the same visual
// chrome (.modal, .field, .btn classes) by hand.
function openUserForm(existing) {
  var root = document.getElementById('modal-root');
  root.innerHTML =
    '<div class="modal-backdrop" data-action="close-modal">' +
      '<div class="modal">' +
        '<div class="modal-head"><h2>' + (existing ? 'Edit account' : 'Add account') + '</h2>' +
          '<button class="btn btn-icon btn-ghost" data-action="close-modal" aria-label="Close dialog" title="Close">' + icon('close') + '</button></div>' +
        '<form id="user-form" data-existing-id="' + (existing ? esc(existing.id) : '') + '">' +
          '<div class="modal-body">' +
            '<div class="field"><label>Username</label><input type="text" name="username" value="' + esc(existing ? existing.username : '') + '" required></div>' +
            '<div class="field"><label>' + (existing ? 'New password' : 'Password') + '</label>' +
              '<input type="password" name="password" autocomplete="new-password" placeholder="' + (existing ? 'Leave blank to keep the current password' : 'At least 8 characters') + '">' +
              (existing ? '' : '<div class="field-hint">You set this directly and share it with them — there\'s no self-signup or "forgot password" flow.</div>') +
            '</div>' +
          '</div>' +
          '<div class="modal-foot">' +
            '<button type="button" class="btn" data-action="close-modal">Cancel</button>' +
            '<button type="submit" class="btn btn-primary">Save</button>' +
          '</div>' +
        '</form>' +
      '</div>' +
    '</div>';
}

async function saveUserAccount(payload) {
  var form = document.getElementById('user-form');
  try {
    var res = await fetch('/WayPoint/api/users', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    var body = await res.json().catch(function () { return {}; });
    if (!res.ok) { showFormError(form, body.error || 'Could not save that account.', form && form.elements.username); return; }
    closeModal();
    setSaveStatus('saved');
    await loadAndRenderManageUsers();
  } catch (err) {
    showToast('Could not save that account — check your connection and try again.', 'error');
  }
}

function deleteUserAccount(id) {
  var u = managedUsers.find(function (x) { return x.id === id; });
  if (!u) return;
  openConfirm({
    title: 'Delete this account?', message: 'This deletes the login for "' + u.username + '". This can\'t be undone.', confirmLabel: 'Delete',
    onConfirm: async function () {
      try {
        var res = await fetch('/WayPoint/api/users/delete', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: id })
        });
        var body = await res.json().catch(function () { return {}; });
        if (!res.ok) { showToast(body.error || 'Could not delete that account.'); return; }
        setSaveStatus('saved');
        await loadAndRenderManageUsers();
      } catch (err) {
        showToast('Could not delete that account — check your connection and try again.', 'error');
      }
    }
  });
}

