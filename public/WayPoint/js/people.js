/* ---------- Link (or unlink) a companion to an account, AND manage
   their privilege level on this trip. Superuser/Admin only
   (canLinkCompanion()). Two small dedicated endpoints do the work --
   /api/companions/link for the account link, /api/trip-grants (and
   /trip-grants/revoke) for the privilege level -- rather than the normal
   save path, since this is identity/access data needing its own
   server-side permission check (see handleCompanionLink()/
   handleTripGrantsUpsert() and COMPANIONS & AVATARS in src/worker.js).
   See submitCompanionAccess() below for how the calls fit together. --- */
var GRANT_ROLE_LABELS = {
  admin: 'Admin — full read/write',
  user: 'User — read/write, own items only',
  viewer: 'Viewer — read-only, own items only'
};

function openCompanionLinkForm(trip, companion) {
  var isLinked = isCompanionLinked(trip, companion);
  // Prefills the current username when there is one to show -- only
  // possible for a full-scope role (both receive `trip.grants`). If this
  // companion is linked to an account not shared on this trip, the field
  // just starts blank rather than guessing.
  var currentGrant = companion.accountId ? (trip.grants || []).find(function (g) { return g.accountId === companion.accountId; }) : null;
  var currentUsername = currentGrant ? currentGrant.username : '';
  // The privilege level to prefill, resolved the same way the
  // access-level tag on their row is (renderCompanionsTab()) --
  // 'superuser'/'admin'/'user'/'viewer', or undefined for none.
  var currentRole = trip.companionAccessLevels && trip.companionAccessLevels[companion.companionId];
  var iCanGrantAdmin = canGrantAdminRole(trip);
  // Two cases where the level can't be changed from this form -- shown
  // as a disabled select, not hidden, so their standing is still clear:
  //   - 'superuser' means this account IS the trip's owner (or uber-user)
  //     -- not a `grants` entry, nothing to upsert or revoke.
  //   - 'admin' when I can't grant Admin myself (only the real owner can).
  var roleLocked = currentRole === 'superuser' || (currentRole === 'admin' && !iCanGrantAdmin);
  var roleSelectHtml;
  if (roleLocked) {
    var lockedLabel = currentRole === 'superuser' ? 'Owner — can\'t be changed here' : GRANT_ROLE_LABELS.admin;
    roleSelectHtml = '<select disabled><option selected>' + esc(lockedLabel) + '</option></select>' +
      '<div class="field-hint">' + (currentRole === 'superuser'
        ? 'This account already owns this trip (or is the site owner) — its access can\'t be managed here.'
        : 'Only this trip\'s owner can change or remove another Admin\'s access.') + '</div>';
  } else {
    roleSelectHtml = '<select name="role">' +
      '<option value=""' + (!currentRole ? ' selected' : '') + '>No trip access (just linked)</option>' +
      '<option value="user"' + (currentRole === 'user' ? ' selected' : '') + '>' + esc(GRANT_ROLE_LABELS.user) + '</option>' +
      '<option value="viewer"' + (currentRole === 'viewer' ? ' selected' : '') + '>' + esc(GRANT_ROLE_LABELS.viewer) + '</option>' +
      (iCanGrantAdmin ? '<option value="admin"' + (currentRole === 'admin' ? ' selected' : '') + '>' + esc(GRANT_ROLE_LABELS.admin) + '</option>' : '') +
      '</select>' +
      '<div class="field-hint">Choosing a level shares this trip with them, scoped to ' + esc(companion.name) + '\'s own tagged items (or fully, for Admin) — leave "No trip access" if they should just get their own avatar without being able to see or edit this trip.</div>';
  }
  var root = document.getElementById('modal-root');
  root.innerHTML =
    '<div class="modal-backdrop" data-action="close-modal">' +
      '<div class="modal">' +
        '<div class="modal-head"><h2>' + esc(companion.name) + ': account &amp; access</h2>' +
          '<button class="btn btn-icon btn-ghost" data-action="close-modal" aria-label="Close dialog" title="Close">' + icon('close') + '</button></div>' +
        '<form id="companion-link-form" data-trip-id="' + esc(trip.tripId) + '" data-companion-id="' + esc(companion.companionId) + '" data-prior-account-id="' + esc(companion.accountId || '') + '">' +
          '<div class="modal-body">' +
            '<div class="field"><label>Username</label><input type="text" name="username" placeholder="an existing account" value="' + esc(currentUsername) + '">' +
            '<div class="field-hint">' + (isLinked && !currentUsername
              ? 'Already linked to an account, but its username isn\'t shown here (no access has been granted) — retype it if you want to change their access level below.'
              : 'Leave blank and save to remove the current link.') + '</div></div>' +
            '<div class="field"><label>Privilege level</label>' + roleSelectHtml + '</div>' +
          '</div>' +
          '<div class="modal-foot">' +
            '<button type="button" class="btn" data-action="close-modal">Cancel</button>' +
            '<button type="submit" class="btn btn-primary">Save</button>' +
          '</div>' +
        '</form>' +
      '</div>' +
    '</div>';
}

// The one function both openCompanionLinkForm() above and
// openAddLinkedCompanionForm() below submit through -- reconciles a
// companion's account link and access grant in one go.
//
//   payload.username  -- '' unlinks (or never links, for a new companion).
//   payload.role       -- '' means "No trip access" was chosen (revoke
//                         any existing grant); a real role shares the
//                         trip as that role, replacing any existing
//                         grant; `undefined` means the select was
//                         disabled (roleLocked) and shouldn't be touched
//                         -- a disabled <select> is never in FormData,
//                         which is how these two cases are told apart.
//   payload.priorAccountId -- the account this companion was linked to
//                         before this submit, so a switch to "No trip
//                         access" knows whose grant to revoke, or a new
//                         grant knows which stale grant to replace.
async function submitCompanionAccess(payload) {
  var username = (payload.username || '').trim();
  var accessForm = document.getElementById('companion-link-form') || document.getElementById('add-linked-companion-form');
  if (payload.role && !username) {
    var form = document.getElementById('companion-link-form');
    showFormError(form, 'Enter the username to grant them access.', form && form.elements.username);
    return;
  }
  try {
    // Step 1: reconcile the account link.
    var linkRes = await fetch('/WayPoint/api/companions/link', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tripId: payload.tripId, companionId: payload.companionId, username: username })
    });
    var linkBody = await linkRes.json().catch(function () { return {}; });
    if (!linkRes.ok) { showFormError(accessForm, linkBody.error || 'Could not update that link.', accessForm && accessForm.elements.username); return; }

    // Step 2: reconcile the access grant to match whatever privilege
    // level was actually submitted (see this function's own comment
    // above for what each value of payload.role means).
    if (payload.role) {
      var grantRes = await fetch('/WayPoint/api/trip-grants', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tripId: payload.tripId,
          username: username,
          role: payload.role,
          companionId: payload.companionId,
          replaceAccountId: payload.priorAccountId || ''
        })
      });
      var grantBody = await grantRes.json().catch(function () { return {}; });
      if (!grantRes.ok) {
        // Linked successfully, but sharing failed (e.g. only the trip's
        // real owner may grant Admin) -- still refresh so the successful
        // link shows up, but say clearly the access level didn't stick.
        showFormError(accessForm, grantBody.error || 'Linked, but could not set their access level.', accessForm && accessForm.elements.role);
        state = await loadInitialState();
        render();
        return;
      }
    } else if (payload.role === '' && payload.priorAccountId) {
      // "No trip access" was explicitly chosen for someone who
      // previously had a real grant. Treat a failed revoke as a failed
      // access update; silently claiming success here could leave the old
      // account able to open the trip after the UI says access was removed.
      var revokeRes = await fetch('/WayPoint/api/trip-grants/revoke', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tripId: payload.tripId, accountId: payload.priorAccountId })
      });
      var revokeBody = await revokeRes.json().catch(function () { return {}; });
      if (!revokeRes.ok) {
        showFormError(accessForm, revokeBody.error || 'Linked, but could not remove the previous access grant.', accessForm && accessForm.elements.role);
        state = await loadInitialState();
        render();
        return;
      }
    }

    closeModal();
    setSaveStatus('saved');
    // Reloads rather than patching `state` in place -- simplest way to
    // pick up the server's freshly-recomputed `companionAvatars`/
    // `companionAccessLevels` (and, for a full-scope role, the
    // companion's own now-changed accountId) rather than trying to
    // guess what they'd now be.
    state = await loadInitialState();
    render();
  } catch (err) {
    showToast('Could not update that companion\'s access — check your connection and try again.', 'error');
  }
}

/* ---- "Add companion" -- the one-step Guest+link+share flow -----------
   Superuser/Admin only (canLinkCompanion(), same bar as managing an
   existing companion's access above). This is deliberately NOT a new
   server-side endpoint: it's the same three actions a Superuser/Admin
   could already do by hand -- add a guest, link them to a username, and
   share the trip with them -- just chained together behind one form so
   they don't have to leave the Companions tab and come back. See
   submitAddLinkedCompanion() below for why they run strictly in that
   order, one fully finished before the next starts. --------------------- */
function openAddLinkedCompanionForm(trip) {
  var iCanGrantAdmin = canGrantAdminRole(trip);
  var root = document.getElementById('modal-root');
  root.innerHTML =
    '<div class="modal-backdrop" data-action="close-modal">' +
      '<div class="modal">' +
        '<div class="modal-head"><h2>Add companion</h2>' +
          '<button class="btn btn-icon btn-ghost" data-action="close-modal" aria-label="Close dialog" title="Close">' + icon('close') + '</button></div>' +
        '<form id="add-linked-companion-form" data-trip-id="' + esc(trip.tripId) + '">' +
          '<div class="modal-body">' +
            '<p class="field-hint companion-form-intro">A companion is someone with their own Waypoint login — their marker uses their own account\'s colour + animal instead of a smiley, and this shares the trip with them right away at whatever privilege level you pick below.</p>' +
            '<div class="field"><label>Name</label><input type="text" name="name" required placeholder="e.g. Sarah"></div>' +
            '<div class="field"><label>Username</label><input type="text" name="username" required placeholder="an existing account"></div>' +
            '<div class="field"><label>Privilege level</label><select name="role" required>' +
              '<option value="user" selected>' + esc(GRANT_ROLE_LABELS.user) + '</option>' +
              '<option value="viewer">' + esc(GRANT_ROLE_LABELS.viewer) + '</option>' +
              (iCanGrantAdmin ? '<option value="admin">' + esc(GRANT_ROLE_LABELS.admin) + '</option>' : '') +
            '</select></div>' +
          '</div>' +
          '<div class="modal-foot">' +
            '<button type="button" class="btn" data-action="close-modal">Cancel</button>' +
            '<button type="submit" class="btn btn-primary">Add companion</button>' +
          '</div>' +
        '</form>' +
      '</div>' +
    '</div>';
}

// Polls until the save queue is empty -- see persist() above for why
// only one POST /api/data is ever in flight. submitAddLinkedCompanion()
// below needs to know the new companion it added has actually reached
// the server before linking it (handleCompanionLink() 404s otherwise). A
// short poll is simpler than threading a promise through
// updateState()/persist()/sendSave() for this rare, explicit action.
function waitForSaveToSettle() {
  return new Promise(function (resolve) {
    (function check() {
      if (!saveInFlight && !pendingSaveState) resolve();
      else setTimeout(check, 50);
    })();
  });
}

async function submitAddLinkedCompanion(payload) {
  var name = (payload.name || '').trim();
  var username = (payload.username || '').trim();
  var role = payload.role || 'user';
  var form = document.getElementById('add-linked-companion-form');
  if (!name) { showFormError(form, 'Enter a name.', form && form.elements.name); return; }
  if (!username) { showFormError(form, 'Enter the username to link.', form && form.elements.username); return; }

  var newCompanionId = newId();
  // Step 1: add them as an ordinary Guest first, through the same
  // optimistic updateState()/persist() pipeline every other edit uses --
  // going through the normal queued save means this can never race an
  // unrelated in-flight save and clobber it.
  updateState(function (next) {
    var t = byId(next.trips, payload.tripId, 'tripId');
    t.companions.push({ companionId: newCompanionId, name: name });
  });
  // Step 2: wait for that save to finish, so the companion exists
  // server-side before asking to link/share it.
  await waitForSaveToSettle();
  // Step 3: link and share it in one go (see submitCompanionAccess()).
  // priorAccountId is null: this companion didn't exist a moment ago.
  // If this fails, the person still ends up added as a Guest rather than
  // not existing -- the row's "Manage account & access" button can retry.
  await submitCompanionAccess({ tripId: payload.tripId, companionId: newCompanionId, username: username, role: role, priorAccountId: null });
}

// Self-service avatar picker -- every logged-in account can change only
// its own colour+animal (handleAccountAvatarUpdate() in src/worker.js
// always writes to `user.id` from the session). Hand-written rather than
// through openForm(), since two linked swatch grids feeding one shared
// live preview don't fit that helper's one-field-at-a-time model.
// Selection is tracked in two hidden inputs (name="color"/"animal") the
// swatch clicks update directly, so submit still works via FormData.
function openAvatarPicker() {
  // currentUser.avatar is always a real {color,animal} pair once logged
  // in -- this fallback only guards against a malformed/missing response.
  var current = currentUser.avatar || { color: AVATAR_COLORS[0].token, animal: AVATAR_ANIMALS[0].token };
  var root = document.getElementById('modal-root');
  root.innerHTML =
    '<div class="modal-backdrop" data-action="close-modal">' +
      '<div class="modal">' +
        '<div class="modal-head"><h2>Choose your avatar</h2>' +
          '<button class="btn btn-icon btn-ghost" data-action="close-modal" aria-label="Close dialog" title="Close">' + icon('close') + '</button></div>' +
        '<form id="avatar-pick-form">' +
          '<div class="modal-body">' +
            '<div class="avatar-picker-preview">' +
              '<span class="avatar-marker" id="avatar-picker-preview-marker" style="background:' + (avatarColorHex(current.color) || AVATAR_GREY_HEX) + '">' + (avatarAnimalEmoji(current.animal) || '') + '</span>' +
              '<span>' + esc(currentUser.username) + '</span>' +
            '</div>' +
            '<input type="hidden" name="color" value="' + esc(current.color) + '">' +
            '<input type="hidden" name="animal" value="' + esc(current.animal) + '">' +
            '<div class="avatar-picker-section"><h4>Colour</h4><div class="avatar-swatch-grid">' +
              AVATAR_COLORS.map(function (c) {
                return '<button type="button" class="avatar-swatch-btn' + (c.token === current.color ? ' is-selected' : '') + '" style="background:' + c.hex + '" data-action="pick-avatar-swatch" data-kind="color" data-value="' + c.token + '" title="' + esc(c.token) + '" aria-label="' + esc(c.token) + '"></button>';
              }).join('') +
            '</div></div>' +
            '<div class="avatar-picker-section"><h4>Animal</h4><div class="avatar-swatch-grid">' +
              AVATAR_ANIMALS.map(function (a) {
                return '<button type="button" class="avatar-swatch-btn' + (a.token === current.animal ? ' is-selected' : '') + '" data-action="pick-avatar-swatch" data-kind="animal" data-value="' + a.token + '" title="' + esc(a.token) + '" aria-label="' + esc(a.token) + '">' + a.emoji + '</button>';
              }).join('') +
            '</div></div>' +
          '</div>' +
          '<div class="modal-foot">' +
            '<button type="button" class="btn" data-action="close-modal">Cancel</button>' +
            '<button type="submit" class="btn btn-primary">Save</button>' +
          '</div>' +
        '</form>' +
      '</div>' +
    '</div>';
}

// Redraws just the live preview marker in the (still open) avatar-picker
// modal after a swatch click -- reads the two hidden inputs' CURRENT
// values (already updated by the click handler just before this runs)
// rather than taking color/animal as arguments, so it always reflects
// both selections together even though each swatch grid only knows about
// its own kind.
function updateAvatarPickerPreview(form) {
  var marker = document.getElementById('avatar-picker-preview-marker');
  if (!marker) return;
  var color = form.querySelector('input[name="color"]').value;
  var animal = form.querySelector('input[name="animal"]').value;
  marker.style.background = avatarColorHex(color) || AVATAR_GREY_HEX;
  marker.textContent = avatarAnimalEmoji(animal) || '';
}

async function submitAvatarPick(payload) {
  var form = document.getElementById('avatar-pick-form');
  try {
    var res = await fetch('/WayPoint/api/account/avatar', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    var body = await res.json().catch(function () { return {}; });
    if (!res.ok) { showFormError(form, body.error || 'Could not save your avatar.'); return; }
    // Trust the server's re-resolved avatar rather than echoing what was sent.
    currentUser.avatar = body.avatar || payload;
    applyAuthUI();
    closeModal();
    setSaveStatus('saved');
    // Any companion linked to this account needs its companionAvatars
    // entry updated too, on every trip it's shared on -- simplest is to
    // reload state rather than patching each trip's map by hand.
    state = await loadInitialState();
    render();
  } catch (err) {
    showToast('Could not save your avatar — check your connection and try again.', 'error');
  }
}

function openExpenseForm(trip, existing) {
  openForm({
    title: existing ? 'Edit expense' : 'Add expense', fields: EXPENSE_FIELDS,
    initial: existing || { category: 'Other' }, trip: trip, submitLabel: 'Save',
    onSubmit: function (v) {
      updateState(function (next) {
        var t = byId(next.trips, trip.tripId, 'tripId');
        var rec = {
          expenseId: existing ? existing.expenseId : newId(), description: v.description, category: v.category || 'Other', date: v.date,
          amount: v.amount, currency: (v.currency || '').toUpperCase(), rateOverride: v.rateOverride || '',
          receiptRef: v.receiptRef || '', contactId: v.contactId || '', notes: v.notes || ''
        };
        if (existing) t.expenses[t.expenses.findIndex(function (x) { return x.expenseId === existing.expenseId; })] = rec;
        else t.expenses.push(rec);
      });
    }
  });
}

function deleteEntity(trip, section, id, label) {
  var idField = ENTITY_ID_FIELDS[section];
  openConfirm({
    title: 'Delete ' + label + '?', message: 'This can\'t be undone.', confirmLabel: 'Delete',
    onConfirm: function () {
      updateState(function (next) {
        var t = byId(next.trips, trip.tripId, 'tripId');
        t[section] = t[section].filter(function (x) { return x[idField] !== id; });
      });
    }
  });
}

function deleteTrip(id) {
  var t = byId(state.trips, id, 'tripId');
  openConfirm({
    title: 'Delete trip?', message: 'This deletes "' + t.name + '" and everything in it — destinations, activities, transport, accommodation, contacts, companions and expenses. This can\'t be undone.', confirmLabel: 'Delete trip',
    onConfirm: function () {
      updateState(function (next) { next.trips = next.trips.filter(function (x) { return x.tripId !== id; }); });
      currentView = 'dashboard'; currentTripId = null;
    }
  });
}

