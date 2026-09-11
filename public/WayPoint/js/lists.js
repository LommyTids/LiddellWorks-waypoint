/* ---------- 15. Render: Destinations tab ------------------------------ */

function renderDestinationsTab(trip) {
  return renderItemListTab(trip, trip.destinations, {
    title: 'Destinations', icon: 'destination', action: 'new-destination', addLabel: 'Add destination',
    emptyTitle: 'No destinations yet', emptyBody: 'Add the places or areas you\'ll be based in — activities and accommodation can then be tagged to them.',
    sortKey: function (item) { return item.arriveDate || ''; }, rowModel: destinationItemRowModel
  });
}

/* ---------- 16. Render: Activities tab -------------------------------- */

function renderActivitiesTab(trip) {
  return renderItemListTab(trip, trip.activities, {
    title: 'Activities', icon: 'activity', action: 'new-activity', addLabel: 'Add activity',
    emptyTitle: 'No activities yet', emptyBody: 'Tours, museum visits, dinner reservations — anything with a date and time.',
    sortKey: function (item) { return activityStartDate(item) + (item.startTime || ''); }, rowModel: activityItemRowModel
  });
}

/* ---------- 17. Render: Transport tab ---------------------------------- */

function renderTransportTab(trip) {
  return renderItemListTab(trip, trip.transport, {
    title: 'Transport', icon: 'flight', action: 'new-transport', addLabel: 'Add transport leg',
    emptyTitle: 'No transport legs yet', emptyBody: 'Flights, trains, buses, ferries or drives — each leg can span overnight, and will show up on both days in the Timeline.',
    sortKey: function (item) { return item.departDateTime || ''; }, rowModel: transportItemRowModel
  });
}

/* ---------- 18. Render: Accommodation tab ------------------------------- */

function renderAccommodationTab(trip) {
  return renderItemListTab(trip, trip.accommodation, {
    title: 'Accommodation', icon: 'stay', action: 'new-accommodation', addLabel: 'Add accommodation',
    emptyTitle: 'No accommodation yet', emptyBody: 'Hotels, hostels, apartments — check-in and check-out can each carry their own time.',
    sortKey: function (item) { return item.checkIn || ''; }, rowModel: accommodationItemRowModel
  });
}

/* ---------- 19. Render: Contacts tab -------------------------------------- */

function renderContactsTab(trip) {
  if (trip.contacts.length === 0) return emptyTab(trip, 'contacts', 'No contacts yet', 'Hotel front desks, tour operators, guides — save them here to link from activities, transport and accommodation.', 'new-contact', 'Add contact');
  var rows = trip.contacts.slice().sort(function (a, b) { return a.name.localeCompare(b.name); }).map(function (c) {
    // Phone and email stay icon-less: the icon set has no glyph for either,
    // and inventing one would say something the record doesn't.
    var reach = [];
    if (c.phone) reach.push({ text: c.phone, copyValue: c.phone, copyLabel: 'phone' });
    if (c.email) reach.push({ text: c.email, copyValue: c.email, copyLabel: 'email' });
    return itemRowHtml(trip, {
      context: 'person', section: 'contact', item: c, icon: 'person',
      title: c.name,
      badgesHtml: c.role ? '<span class="tag">' + esc(c.role) + '</span>' : '',
      metadata: {
        datetime: [], category: [], people: [],
        location: c.address ? [{ icon: 'location', text: c.address, mapsAddress: c.address }] : [],
        commerce: reach
      },
      supporting: c.notes || ''
    });
  }).join('');
  return tabHead(trip, 'Contacts', 'new-contact', 'Add contact') + '<div class="item-list">' + rows + '</div>';
}

/* ---------- 19b. Render: Companions tab ------------------------------- */

// Companions are who to tag on individual items (see 'tag-picker' in
// fieldHtml()) — this tab is where you add people, not tag them. No
// "used on N items" count: that would mean scanning every other list on
// each render for a number nobody's asked for.
/* ---- Part-trip participants -------------------------------------------
   A companion can carry joinsOn/leavesOn -- the days they are actually on
   the trip. Both optional; blank at either end means "from the start" or
   "to the end", which is what every record written before this field
   existed says, so nothing needed migrating.

   These are ADVISORY. Nothing is hidden and no save is refused because of
   them. Somebody may genuinely be tagged into one dinner on a day they
   are otherwise not around, and an itinerary that argued with its owner
   about that would be worse than one that stayed quiet. What they do buy
   is a warning at the moment you tag someone into a day they are not
   there for, which is when the information is worth having. ---------- */

// "4–11 Jun", "from 4 Jun", "until 11 Jun", or '' when they're there
// throughout. Reuses formatDateShort() so this reads like every other date
// on the page.
function companionStayLabel(companion) {
  var from = companion && companion.joinsOn;
  var to = companion && companion.leavesOn;
  if (from && to) return formatDateShort(from) + ' – ' + formatDateShort(to);
  if (from) return 'from ' + formatDateShort(from);
  if (to) return 'until ' + formatDateShort(to);
  return '';
}

// Is `day` (a YYYY-MM-DD string) outside this person's window? False
// whenever the answer isn't knowable -- no dates, or no day to test --
// because a warning shown on a guess is worse than no warning at all.
function companionAwayOn(companion, day) {
  if (!companion || !day) return false;
  if (companion.joinsOn && day < companion.joinsOn) return true;
  if (companion.leavesOn && day > companion.leavesOn) return true;
  return false;
}

// The names, if any, tagged on this item who aren't on the trip that day.
// Takes the ids actually ticked rather than reading the stored record, so
// the warning tracks the form as it is being filled in.
function companionsAwayFor(trip, companionIds, day) {
  if (!day) return [];
  return (companionIds || []).map(function (id) {
    var person = (trip && trip.companions || []).find(function (c) { return c.companionId === id; });
    return companionAwayOn(person, day) ? person : null;
  }).filter(Boolean);
}

function companionTags(trip, companionIds) {
  return (companionIds || [])
    .map(function (id) { return taggablePersonById(trip, id); })
    .filter(Boolean)
    .map(function (c) { return '<span class="tag">' + companionAvatarHtml(trip, c.companionId, c.name) + esc(c.name) + (c.isSuperuser ? '<span class="tag-role">Trip Owner</span>' : '') + '</span>'; })
    .join('');
}

// The Companions tab is the one place you manage everyone on a trip --
// both "who's traveling" (companions, tagged to items) and "who can log
// in and see/edit this" (accounts, via sharing). See
// claude/waypoint-companions-plan.md for the design discussion.
//
// GUEST vs COMPANION is product vocabulary, not a new data field: every
// person is stored the same way (COMPANION_FIELDS above), and whether
// they're a "Guest" or "Companion" is purely whether `accountId` is set
// (a Waypoint login). The list is visually split into two sections
// (renderCompanionsTab()).
//   - A GUEST has no login. Anyone who canAddCompanion() (a "user" grant
//     included) can add one -- name + smiley colour only.
//   - A COMPANION has one. Only canLinkCompanion() (Superuser/Admin) can
//     create one directly, or upgrade a Guest by linking a username --
//     see openAddLinkedCompanionForm()/openCompanionLinkForm() below.
//     Either action also asks for a privilege level (Admin/User/Viewer,
//     or "no trip access") in the same form and grants it automatically.
// A Companion who also has access to this trip gets an extra tag showing
// that level -- Owner/Admin/User/Viewer, from resolveCompanionAccessLevels()
// in src/worker.js, sent as `trip.companionAccessLevels`. Unlike raw
// `grants`, that map goes to every role that can see the trip, so these
// tags render the same for the Trip Owner and a scoped Viewer alike.
//
// The KEYS here are the roles as the server stores them; the VALUES are
// only ever shown to a reader. That split is deliberate: "superuser" is
// load-bearing in permissionForTrip() (src/worker.js), in every
// myGrant.role check below, and in a CSS class name built by
// concatenation -- so the word on screen was changed to "Owner" without
// touching the stored role anywhere.
var COMPANION_ACCESS_LEVEL_LABELS = { superuser: 'Owner', admin: 'Admin', user: 'User', viewer: 'Viewer' };

// Reads `trip.companionAvatars[...].type` rather than `c.accountId` to
// decide Guest vs Companion -- accountId is stripped from a scoped
// "user"/"viewer" role's own companion list (buildVisibleTrip() in
// src/worker.js), so it's always falsy for them even when genuinely
// linked. `companionAvatars` is sent to every role and its `type`
// ('account' vs 'smiley') already encodes this same fact, so Guest/
// Companion always agrees with the marker shown, including for a
// deleted linked account (which falls back to 'smiley' too).
function isCompanionLinked(trip, c) {
  return !!(trip.companionAvatars && trip.companionAvatars[c.companionId] && trip.companionAvatars[c.companionId].type === 'account');
}

function renderCompanionsTab(trip) {
  var canAddGuest = canAddCompanion(trip);
  var canAddLinked = canLinkCompanion(trip);
  // Superuser/Admin get two explicit choices (link an existing login and
  // share in one step, or add someone with no login); a "user" grant
  // only gets the second -- enforced server-side by
  // mergeUserScopedCompanions() in src/worker.js.
  //
  // "Add companion" gets the accent button, "Add guest" the plain grey
  // one -- matching the colour-coding already used for their markers
  // elsewhere (a Companion's marker is their account's colour+animal, a
  // Guest's is the plain grey circle). Wrapped
  // in a shared .head-btn-row so the pair sits right next to each other
  // (see that class's own comment for why that needs a wrapper at all).
  var addButtons =
    (canAddLinked ? '<button class="btn btn-accent" data-action="new-linked-companion">' + icon('add') + ' Add companion</button>' : '') +
    (canAddGuest ? '<button class="btn" data-action="new-companion">' + icon('add') + ' Add guest</button>' : '');
  var addButtonsRow = addButtons ? '<div class="head-btn-row">' + addButtons + '</div>' : '';
  var head = '<div class="tab-panel-head"><h2>Companions</h2>' + addButtonsRow + '</div>';

  if (trip.companions.length === 0) {
    return head + emptyStateHtml('empty', 'companions', 'No one added yet', 'Add people as companions when they have a Waypoint login, or as guests when they do not, then tag who is joining each part of the trip.', addButtonsRow);
  }

  // One row-renderer shared by both sections below -- a Companion row
  // and a Guest row differ only in which tags/actions apply, not in
  // their overall shape, so there's no reason to duplicate the HTML
  // structure itself.
  function companionRowHtml(c) {
    var linkedAccount = c.accountId ? (trip.grants || []).find(function (g) { return g.accountId === c.accountId; }) : null;
    // A companion can be linked to an account not shared on this trip
    // (e.g. "no trip access", see openCompanionLinkForm()). `trip.grants`
    // only exists for full-scope roles, so the linked-tag below just
    // says "has a login" when there's nothing to look the username up in.
    var linkedTag = c.accountId
      ? '<span class="tag">' + icon('person') + (linkedAccount ? esc(linkedAccount.username) : 'has a login') + '</span>'
      : '';
    // The access-level tag -- see the comment above this function. A
    // Guest always reads "Guest". A Companion shows their resolved
    // access level (Super/Admin/User/Viewer), or a generic "Companion"
    // tag when linked but with no actual access to this trip.
    var isLinked = isCompanionLinked(trip, c);
    var accessRole = trip.companionAccessLevels && trip.companionAccessLevels[c.companionId];
    var accessTag = isLinked
      ? '<span class="tag' + (accessRole ? ' tag-role-' + accessRole : '') + '">' + (accessRole ? esc(COMPANION_ACCESS_LEVEL_LABELS[accessRole] || accessRole) : 'Companion') + '</span>'
      : '<span class="tag">Guest</span>';
    // Only rendered for somebody who isn't there for all of it -- the
    // common case stays as uncluttered as it was.
    var stay = companionStayLabel(c);
    var stayTag = stay ? '<span class="tag tag-stay" title="On the trip ' + esc(stay) + '">' + icon('calendar') + esc(stay) + '</span>' : '';
    // A separate, second `.item-actions` group rather than trying to
    // merge into rowActions()'s own -- both are just small icon-button
    // clusters, so two side by side reads identically to one, without
    // needing rowActions() itself to know anything about linking.
    var linkLabel = isLinked ? 'Manage account link and access level' : 'Upgrade guest to companion';
    var linkAction = canAddLinked
      ? '<div class="item-actions"><button class="btn btn-icon btn-ghost" data-action="link-companion" data-id="' + c.companionId + '" aria-label="' + linkLabel + '" title="' + linkLabel + '">' + icon('companions') + '</button></div>'
      : '';
    // Through the shared card like every other list: this row used to be
    // built by hand and had drifted -- its access level was a tag where a
    // contact's role was an .item-sub, and neither got a category stripe.
    return itemRowHtml(trip, {
      context: 'person', section: 'companion', item: c,
      avatarHtml: companionAvatarHtml(trip, c.companionId, c.name),
      title: c.name,
      badgesHtml: accessTag + linkedTag + stayTag,
      extraActionsHtml: linkAction,
      metadata: {},
      supporting: c.notes || ''
    });
  }

  var sorted = trip.companions.slice().sort(function (a, b) { return a.name.localeCompare(b.name); });
  var companionRows = sorted.filter(function (c) { return isCompanionLinked(trip, c); });
  var guestRows = sorted.filter(function (c) { return !isCompanionLinked(trip, c); });

  // Segregated into two clearly-labelled lists rather than one mixed
  // one -- this is what replaced the old "Share access" panel's spot at
  // the bottom of the tab (see the big comment above this function).
  var companionsSection = '<h3 class="section-subhead">Companions</h3>' +
    (companionRows.length
      ? '<div class="item-list">' + companionRows.map(companionRowHtml).join('') + '</div>'
      : '<p class="field-hint">Nobody with a Waypoint login on this trip yet.</p>');
  var guestsSection = '<h3 class="section-subhead">Guests</h3>' +
    (guestRows.length
      ? '<div class="item-list">' + guestRows.map(companionRowHtml).join('') + '</div>'
      : '<p class="field-hint">Nobody without a login on this trip yet.</p>');

  return head + companionsSection + guestsSection;
}

