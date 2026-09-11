/* ---------- 12. Render: Dashboard ------------------------------------ */

function renderDashboard() {
  // "New trip" is always shown — creating one is open to any logged-in
  // account, not gated by any per-trip permission (there's nothing to
  // check permission against yet; whoever creates it becomes its
  // Superuser automatically — see openTripForm()).
  if (state.trips.length === 0) {
    if (!stateIsTrustworthy) {
      return '<div class="section-head"><h1 data-page-heading tabindex="-1">Your trips</h1></div>' +
        emptyStateHtml(connectionState === 'offline' ? 'offline' : 'error', connectionState === 'offline' ? 'offline' : 'warning', connectionState === 'offline' ? 'You are offline' : 'Trips could not be loaded', 'Your saved data has not been changed. Reconnect and retry before editing.', '<button type="button" class="btn btn-primary" data-action="retry-connection">Retry now</button>');
    }
    return (
      '<div class="section-head"><h1 data-page-heading tabindex="-1">Your trips</h1>' +
        '<button class="btn btn-accent" data-action="new-trip">' + icon('add') + ' New trip</button></div>' +
      emptyStateHtml('empty', 'brand', 'No trips yet', 'Add a trip to start planning destinations, activities, transport and accommodation — with expenses tracked across currencies as you go.')
    );
  }
  var sorted = state.trips.slice().sort(function (a, b) { return (a.startDate || '9999') < (b.startDate || '9999') ? -1 : 1; });
  var cards = sorted.map(function (trip) {
    var status = tripStatus(trip);
    var spend = tripSpend(trip);
    var statusLabel = status === 'ongoing' ? 'In progress' : (status === 'past' ? 'Past' : 'Upcoming');
    // Edit/Delete on the card itself are full-scope-only (Superuser,
    // admin grant, or the uber-user) — a "user"/"viewer" grant can see
    // this trip's card (it's in their `state.trips` at all) but never
    // touch the trip's own name/dates, let alone delete it.
    var cardActions = canFullyEditTrip(trip)
      ? '<div class="card-actions">' +
          '<button class="btn btn-icon btn-ghost" data-action="edit-trip" data-id="' + trip.tripId + '" aria-label="Edit trip" title="Edit trip">' + icon('edit') + '</button>' +
          '<button class="btn btn-icon btn-ghost" data-action="delete-trip" data-id="' + trip.tripId + '" aria-label="Delete trip" title="Delete trip">' + icon('delete') + '</button>' +
        '</div>'
      : '';
    return (
      '<article class="trip-card">' +
        '<button type="button" class="trip-card-open" data-action="open-trip" data-id="' + trip.tripId + '" aria-label="Open trip ' + esc(trip.name) + '">' +
        '<span class="trip-card-top">' +
          '<span><span class="trip-card-title">' + esc(trip.name) + '</span><span class="trip-dates">' +
            (trip.startDate ? formatDateShort(trip.startDate) : 'No dates set') +
            (trip.endDate ? ' – ' + formatDateShort(trip.endDate) : '') + '</span></span>' +
          '<span class="pill pill-' + status + '">' + statusLabel + '</span>' +
        '</span>' +
        '<span class="trip-stats">' +
          '<span>' + icon('destination') + ' <b>' + trip.destinations.length + '</b> areas</span>' +
          '<span>' + icon('expenses') + ' <b>' + money(spend.known, trip.homeCurrency) + '</b>' + (spend.unknownCount ? ' <span class="rate-missing">+' + spend.unknownCount + ' need rate</span>' : '') + '</span>' +
        '</span>' +
        tripCardAvatarsHtml(trip) +
        '</button>' +
        cardActions +
      '</article>'
    );
  }).join('');
  return (
    '<div class="intro-note"><strong>Waypoint</strong> keeps every trip\'s destinations, activities, transport and accommodation in one place, with a day-by-day timeline that shows overnight travel and multi-area days clearly, plus expenses tracked across currencies.</div>' +
    '<div class="section-head"><h1 data-page-heading tabindex="-1">Your trips</h1>' +
      '<button class="btn btn-accent" data-action="new-trip">' + icon('add') + ' New trip</button></div>' +
    '<div class="trip-grid">' + cards + '</div>'
  );
}

/* ---------- 13. Render: Trip view shell (header + tabs) -------------- */

// The two "big picture" views of a trip — see the day-by-day agenda, or
// see it on a map — are surfaced as large hero buttons. The data-entry
// views are grouped by purpose, so someone planning a trip sees the
// itinerary-building tools together and doesn't have to parse one long,
// undifferentiated tab row. Every button still uses the same simple
// "switch-tab" click handler below.
var HERO_TABS = [
  { key: 'timeline', label: 'Timeline', icon: 'timeline' },
  { key: 'map', label: 'Map', icon: 'map' }
];

var TAB_GROUPS = [
  { label: 'Plan', tabs: [
    { key: 'destinations', label: 'Destinations', icon: 'destination' },
    { key: 'transport', label: 'Transport', icon: 'flight' },
    { key: 'accommodation', label: 'Accommodation', icon: 'stay' },
    { key: 'activities', label: 'Activities', icon: 'activity' }
  ] },
  { label: 'People', tabs: [
    { key: 'companions', label: 'Companions', icon: 'companions' },
    { key: 'contacts', label: 'Contacts', icon: 'contacts' }
  ] },
  { label: 'Manage', tabs: [
    // Expenses is hidden for a scoped "user"/"viewer" grant because the
    // server strips it from their trip data; an empty financial tab would
    // be misleading rather than useful.
    { key: 'expenses', label: 'Expenses', icon: 'expenses' },
    { key: 'settings', label: 'Settings', icon: 'settings' }
  ] }
];

// The groups to actually show for THIS trip — full scope gets everything;
// scoped roles lose only Expenses. Settings stays visible because it still
// contains useful read-only trip information for them.
function tabGroupsForTrip(trip) {
  return TAB_GROUPS.map(function (group) {
    return {
      label: group.label,
      tabs: group.tabs.filter(function (tab) { return canFullyEditTrip(trip) || tab.key !== 'expenses'; })
    };
  }).filter(function (group) { return group.tabs.length > 0; });
}

var MOBILE_DESTINATIONS = [
  { key: 'overview', label: 'Overview', icon: 'overview' },
  { key: 'plan', label: 'Plan', icon: 'plan' },
  { key: 'people', label: 'People', icon: 'people' },
  { key: 'more', label: 'More', icon: 'more' }
];

function mobileDestinationForTab(tab) {
  if (tab === 'timeline' || tab === 'map') return 'overview';
  if (['destinations', 'transport', 'accommodation', 'activities'].indexOf(tab) !== -1) return 'plan';
  if (tab === 'companions' || tab === 'contacts') return 'people';
  return 'more';
}

function tabsForMobileDestination(destination, trip) {
  if (destination === 'overview') return HERO_TABS;
  var groupLabel = destination === 'plan' ? 'Plan' : destination === 'people' ? 'People' : 'Manage';
  var group = tabGroupsForTrip(trip).find(function (item) { return item.label === groupLabel; });
  return group ? group.tabs : [];
}

function rememberMobileChild(tab) {
  var destination = mobileDestinationForTab(tab);
  if (destination !== 'more') mobileLastTab[destination] = tab;
}

function mobileDestinationTarget(destination, trip) {
  if (destination === 'more') return 'more';
  var tabs = tabsForMobileDestination(destination, trip);
  var remembered = mobileLastTab[destination];
  return tabs.some(function (tab) { return tab.key === remembered; }) ? remembered : (tabs[0] ? tabs[0].key : 'timeline');
}

function renderMobileChildNav(trip, destination) {
  if (destination === 'more') return '';
  var tabs = tabsForMobileDestination(destination, trip);
  return '<nav class="mobile-child-nav' + (destination === 'overview' ? ' mobile-overview-switch' : '') + '" aria-label="' + esc(destination === 'overview' ? 'Overview view' : destination + ' sections') + '">' +
    tabs.map(function (tab) {
      return '<button id="mobile-tab-' + tab.key + '" class="mobile-child-btn ' + (currentTab === tab.key ? 'active' : '') + '" data-action="switch-tab" data-tab="' + tab.key + '" aria-controls="trip-panel"' + (currentTab === tab.key ? ' aria-current="page"' : '') + '>' + icon(tab.icon) + esc(tab.label) + '</button>';
    }).join('') +
  '</nav>';
}

function renderMobileDestinationNav(trip) {
  var activeDestination = mobileDestinationForTab(currentTab);
  return '<nav class="mobile-destination-nav" aria-label="Trip destinations">' + MOBILE_DESTINATIONS.map(function (destination) {
    var active = activeDestination === destination.key;
    return '<button id="mobile-destination-' + destination.key + '" class="mobile-destination-btn ' + (active ? 'active' : '') + '" data-action="switch-mobile-destination" data-destination="' + destination.key + '"' + (active ? ' aria-current="page"' : '') + '>' + icon(destination.icon) + '<span>' + destination.label + '</span></button>';
  }).join('') + '</nav>';
}

function renderMobileMoreTab(trip) {
  var items = [];
  if (canFullyEditTrip(trip)) {
    items.push({ key: 'expenses', icon: 'expenses', label: 'Expenses', description: 'Review trip spending and currencies' });
  }
  items.push({ key: 'settings', icon: 'settings', label: 'Settings', description: 'Trip details, export and access information' });
  return '<div class="tab-panel-head"><h2>More</h2></div><div class="mobile-more-list">' + items.map(function (item) {
    return '<button class="mobile-more-card" data-action="switch-tab" data-tab="' + item.key + '">' + icon(item.icon) + '<span class="mobile-more-card-copy"><span class="mobile-more-card-title">' + item.label + '</span><span class="mobile-more-card-description">' + item.description + '</span></span>' + icon('forward') + '</button>';
  }).join('') + '</div>';
}

function renderTripView() {
  var trip = currentTrip();
  if (!trip) { currentView = 'dashboard'; return renderDashboard(); }
  // A scoped role landing on a tab that's just been filtered out (e.g.
  // sessionStorage restored "expenses" from a previous, full-scope
  // account on this same browser) falls back to the Timeline rather
  // than rendering a panel for a tab that's no longer in the tab bar.
  if (currentTab === 'expenses' && !canFullyEditTrip(trip)) currentTab = 'timeline';
  // `trip` stays the live object from state.trips and is what every
  // permission check and trip-level figure below reads. `viewTrip` is the
  // same trip seen through this viewer's lens, and is the ONLY thing the
  // item panels are allowed to draw from -- see scopedTripForRender() for
  // why the distinction matters (a filtered trip reaching a save would
  // delete the filtered-out items).
  //
  // Deliberately unfiltered: the spend total and the trip status. Those
  // describe the trip itself, like its name and dates. Having the headline
  // figure drop when you narrow your view would read as money going
  // missing rather than as a filter being on.
  var viewTrip = scopedTripForRender(trip);
  var spend = tripSpend(trip);
  var status = tripStatus(trip);
  var heroHtml = HERO_TABS.map(function (t) {
    return '<button id="trip-nav-' + t.key + '" class="hero-btn ' + (currentTab === t.key ? 'active' : '') + '" data-action="switch-tab" data-tab="' + t.key + '" aria-controls="trip-panel"' + (currentTab === t.key ? ' aria-current="page"' : '') + '>' +
      icon(t.icon) + t.label + '</button>';
  }).join('');
  var tabsHtml = tabGroupsForTrip(trip).map(function (group) {
    var buttons = group.tabs.map(function (t) {
      return '<button id="trip-nav-' + t.key + '" class="tab-btn ' + (currentTab === t.key ? 'active' : '') + '" data-action="switch-tab" data-tab="' + t.key + '" aria-controls="trip-panel"' + (currentTab === t.key ? ' aria-current="page"' : '') + '>' +
        icon(t.icon) + t.label + '</button>';
    }).join('');
    return '<div class="tab-group"><div class="tab-group-label">' + esc(group.label) + '</div><div class="tab-group-tabs">' + buttons + '</div></div>';
  }).join('');
  var panel;
  switch (currentTab) {
    case 'destinations': panel = renderDestinationsTab(viewTrip); break;
    case 'activities': panel = renderActivitiesTab(viewTrip); break;
    case 'transport': panel = renderTransportTab(viewTrip); break;
    case 'accommodation': panel = renderAccommodationTab(viewTrip); break;
    case 'map': panel = renderMapTab(viewTrip); break;
    case 'contacts': panel = renderContactsTab(viewTrip); break;
    case 'companions': panel = renderCompanionsTab(viewTrip); break;
    case 'expenses': panel = renderExpensesTab(viewTrip); break;
    case 'settings': panel = renderSettingsTab(viewTrip); break;
    case 'more': panel = renderMobileMoreTab(viewTrip); break;
    default: panel = renderTimelineTab(viewTrip);
  }
  var headerActions = canFullyEditTrip(trip)
    ? '<div class="card-actions">' +
        '<button class="btn btn-icon btn-ghost" data-action="edit-trip" data-id="' + trip.tripId + '" aria-label="Edit trip" title="Edit trip">' + icon('edit') + '</button>' +
        '<button class="btn btn-icon btn-ghost" data-action="delete-trip" data-id="' + trip.tripId + '" aria-label="Delete trip" title="Delete trip">' + icon('delete') + '</button>' +
      '</div>'
    : '';
  return (
    '<div class="trip-header">' +
      '<button class="back-link" data-action="back-to-dashboard">' + icon('back') + '<span class="back-label-wide">All trips</span><span class="back-label-compact">Back</span></button>' +
      '<div class="trip-title-row">' +
        '<div><div class="trip-heading-line"><h1 data-page-heading tabindex="-1">' + esc(trip.name) + '</h1>' + tripAccessBadgeHtml(trip) + itemScopeIndicatorHtml(trip) + '</div>' +
          '<div class="trip-meta">' +
            '<span class="trip-date-range">' + (trip.startDate ? formatDateShort(trip.startDate) : '?') + ' – ' + (trip.endDate ? formatDateShort(trip.endDate) : '?') + '</span>' +
            (canFullyEditTrip(trip) ? '<span class="trip-spend-meta"><b>' + money(spend.known, trip.homeCurrency) + '</b> spent so far' +
              (spend.unknownCount ? ' · <button class="warn-link" data-action="switch-tab" data-tab="settings">' + spend.unknownCount + ' need an exchange rate</button>' : '') +
            '</span>' : '') +
          '</div>' +
        '</div>' +
        headerActions +
      '</div>' +
    '</div>' +
      '<nav class="desktop-trip-nav" aria-label="Trip sections"><div class="nav-group-label">View</div><div class="hero-row">' + heroHtml + '</div>' +
    '<div class="tabbar">' + tabsHtml + '</div></nav>' +
    '<div class="mobile-trip-shell">' + renderMobileChildNav(trip, mobileDestinationForTab(currentTab)) +
      (mobileDestinationForTab(currentTab) === 'more' && currentTab !== 'more' ? '<button class="back-link mobile-more-return" data-action="switch-mobile-destination" data-destination="more">' + icon('back') + ' More</button>' : '') +
    '</div>' +
    '<section id="trip-panel" class="trip-panel" tabindex="-1" ' + (currentTab === 'more' ? 'aria-label="More"' : 'aria-labelledby="trip-nav-' + currentTab + '"') + '>' + panel + '</section>' +
    renderMobileDestinationNav(trip)
  );
}

