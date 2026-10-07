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

/* ---------- 13. Atlas trip workspace -------------------------------- */
var HERO_TABS = [
  { key: 'timeline', label: 'Agenda', icon: 'timeline' },
  { key: 'map', label: 'Map', icon: 'map' }
];
var TAB_GROUPS = [
  { label: 'Plan', tabs: [
    { key: 'destinations', label: 'Areas', icon: 'destination' },
    { key: 'transport', label: 'Travel', icon: 'flight' },
    { key: 'accommodation', label: 'Stays', icon: 'stay' },
    { key: 'activities', label: 'Activities', icon: 'activity' }
  ] },
  { label: 'People', tabs: [
    { key: 'companions', label: 'Travellers', icon: 'companions' },
    { key: 'contacts', label: 'Contacts', icon: 'contacts' }
  ] },
  { label: 'Manage', tabs: [
    { key: 'expenses', label: 'Expenses', icon: 'expenses' },
    { key: 'settings', label: 'Trip settings', icon: 'settings' }
  ] }
];
function tabGroupsForTrip(trip) {
  return TAB_GROUPS.map(function (group) {
    return { label: group.label, tabs: group.tabs.filter(function (tab) { return canFullyEditTrip(trip) || tab.key !== 'expenses'; }) };
  }).filter(function (group) { return group.tabs.length > 0; });
}
// Internal keys remain compatible with saved navigation from the old shell.
var MOBILE_DESTINATIONS = [
  { key: 'overview', label: 'Itinerary', icon: 'overview' },
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
  var label = destination === 'plan' ? 'Plan' : destination === 'people' ? 'People' : 'Manage';
  var group = tabGroupsForTrip(trip).find(function (entry) { return entry.label === label; });
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
  return '<nav class="atlas-local-nav' + (destination === 'overview' ? ' atlas-itinerary-switch mobile-overview-switch' : '') + '" aria-label="' + esc(destination === 'overview' ? 'Itinerary view' : destination + ' sections') + '">' + tabs.map(function (tab) {
    return '<button id="trip-nav-' + tab.key + '" type="button" class="mobile-child-btn ' + (currentTab === tab.key ? 'active' : '') + '" data-action="switch-tab" data-tab="' + tab.key + '" aria-controls="trip-panel"' + (currentTab === tab.key ? ' aria-current="page"' : '') + '>' + icon(tab.icon) + esc(tab.label) + '</button>';
  }).join('') + '</nav>';
}
function renderMobileDestinationNav(trip) {
  var activeDestination = mobileDestinationForTab(currentTab);
  return '<nav class="mobile-destination-nav" aria-label="Trip destinations">' + MOBILE_DESTINATIONS.map(function (destination) {
    return '<button id="mobile-destination-' + destination.key + '" type="button" class="mobile-destination-btn ' + (activeDestination === destination.key ? 'active' : '') + '" data-action="switch-mobile-destination" data-destination="' + destination.key + '"' + (activeDestination === destination.key ? ' aria-current="page"' : '') + '>' + icon(destination.icon) + '<span>' + destination.label + '</span></button>';
  }).join('') + '</nav>';
}
function renderMobileMoreTab(trip) {
  var items = [];
  if (canFullyEditTrip(trip)) items.push({ key: 'expenses', icon: 'expenses', label: 'Expenses', description: 'Recorded trip costs and currencies' });
  items.push({ key: 'settings', icon: 'settings', label: 'Trip settings', description: 'Trip details, currency and exports' });
  return '<div class="tab-panel-head"><h2>More</h2></div><div class="mobile-more-list">' + items.map(function (item) {
    return '<button class="mobile-more-card" data-action="switch-tab" data-tab="' + item.key + '">' + icon(item.icon) + '<span class="mobile-more-card-copy"><span class="mobile-more-card-title">' + item.label + '</span><span class="mobile-more-card-description">' + item.description + '</span></span>' + icon('forward') + '</button>';
  }).join('') + '</div>';
}
function companionFiltersHtml(trip) {
  var people = taggablePeople(trip);
  if (!people.length) return '';
  if (!canFullyEditTrip(trip)) return '<div class="atlas-filter-heading">' + icon('companions') + '<strong>Your tagged plans</strong><span>Only records your account can access</span></div>';
  var all = !(companionSelection[trip.tripId] || []).length;
  return '<div class="atlas-filter-heading">' + icon('companions') + '<strong>Whose plans?</strong><span>View filter · assignments stay unchanged</span></div>' +
    '<div class="companion-filters" role="group" aria-label="Filter items by people"><button type="button" class="companion-filter' + (all ? ' is-selected' : '') + '" data-action="show-all-people" aria-pressed="' + all + '">All people</button>' + people.map(function (person) {
      var selected = !all && companionIsSelected(trip, person.companionId);
      return '<button type="button" class="companion-filter' + (selected ? ' is-selected' : '') + '" data-action="toggle-companion-filter" data-id="' + esc(person.companionId) + '" aria-pressed="' + selected + '" aria-label="Show items for ' + esc(person.name) + '">' + (companionAvatarHtml(trip, person.companionId, person.name) || avatarMarkerHtml({ type: 'companion' }, person.name)) + '<span>' + esc(person.name) + '</span></button>';
    }).join('') + (all ? '' : '<span class="companion-filter-note">Matches any selected person · unassigned plans remain visible</span>') + '</div>';
}
function atlasRailHtml(trip) {
  var section = mobileDestinationForTab(currentTab);
  var entries = [
    { label: 'Itinerary', icon: 'timeline', destination: 'overview' },
    { label: 'Plan', icon: 'plan', destination: 'plan' },
    { label: 'People', icon: 'people', destination: 'people' }
  ];
  if (canFullyEditTrip(trip)) entries.push({ label: 'Expenses', icon: 'expenses', tab: 'expenses' });
  entries.push({ label: 'Trip settings', icon: 'settings', tab: 'settings' });
  return '<nav class="desktop-trip-nav atlas-rail" aria-label="Trip sections"><button type="button" class="back-link" data-action="back-to-dashboard">' + icon('back') + ' All trips</button><div class="nav-group-label">' + esc(trip.name) + '</div>' + entries.map(function (entry) {
    var active = entry.tab ? currentTab === entry.tab : section === entry.destination;
    return '<button type="button" class="atlas-rail-button' + (active ? ' active' : '') + '" data-action="' + (entry.tab ? 'switch-tab' : 'switch-mobile-destination') + '" ' + (entry.tab ? 'data-tab="' + entry.tab : 'data-destination="' + entry.destination) + '" aria-controls="trip-panel"' + (active ? ' aria-current="page"' : '') + '>' + icon(entry.icon) + entry.label + '</button>';
  }).join('') + '</nav>';
}
function atlasAddStripHtml(trip) {
  if (!canFullyEditTrip(trip)) return '';
  return '<div class="atlas-add-strip"><span class="nav-group-label">Add to trip</span><div>' + [
    ['destination', 'destination', 'Area'], ['transport', 'flight', 'Travel'], ['accommodation', 'stay', 'Stay'], ['activity', 'activity', 'Activity']
  ].map(function (item) { return '<button type="button" class="btn btn-secondary" data-action="new-' + item[0] + '">' + icon(item[1]) + item[2] + '</button>'; }).join('') + '</div></div>';
}
function renderTripView() {
  var trip = currentTrip();
  if (!trip) { currentView = 'dashboard'; return renderDashboard(); }
  if (currentTab === 'expenses' && !canFullyEditTrip(trip)) currentTab = 'timeline';
  // Filtering is only a presentation lens: edits always operate on the live trip.
  var viewTrip = scopedTripForRender(trip);
  var spend = tripSpend(trip);
  var section = mobileDestinationForTab(currentTab);
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
  var names = { overview: 'Itinerary', plan: 'Plan', people: 'People', more: currentTab === 'expenses' ? 'Expenses' : currentTab === 'settings' ? 'Trip settings' : 'More' };
  var controls = section === 'overview' || section === 'plan' || section === 'people' ? renderMobileChildNav(trip, section) : '';
  return '<div class="atlas-trip-layout">' + atlasRailHtml(trip) + '<div class="atlas-trip-main">' +
    '<header class="trip-header atlas-trip-identity"><button class="back-link atlas-mobile-back" data-action="back-to-dashboard">' + icon('back') + ' All trips</button>' +
    '<div class="trip-title-row"><div><div class="nav-group-label">Your trip</div><h1 data-page-heading tabindex="-1">' + esc(trip.name) + '</h1></div>' +
    '<div class="trip-meta"><span class="trip-date-range">' + (trip.startDate ? formatDateShort(trip.startDate) : 'Dates not set') + (trip.endDate ? ' – ' + formatDateShort(trip.endDate) : '') + '</span><div>' + tripAccessBadgeHtml(trip) + '</div>' +
    (canFullyEditTrip(trip) ? '<span class="trip-spend-meta">' + money(spend.known, trip.homeCurrency) + ' whole-trip recorded costs' + (spend.unknownCount ? ' · <button class="warn-link" data-action="switch-tab" data-tab="settings">' + spend.unknownCount + ' need a rate</button>' : '') + '</span>' : '') + '</div></div></header>' +
    atlasAddStripHtml(trip) + (['overview', 'plan'].indexOf(section) !== -1 || currentTab === 'expenses' ? '<div class="atlas-companion-bar">' + companionFiltersHtml(trip) + itemScopeIndicatorHtml(trip) + '</div>' : '') +
    '<div class="atlas-section-controls"><h2>' + names[section] + '</h2>' + controls + (section === 'more' && currentTab !== 'more' ? '<button class="back-link mobile-more-return" data-action="switch-mobile-destination" data-destination="more">' + icon('back') + ' More</button>' : '') + '</div>' +
    '<section id="trip-panel" class="trip-panel" tabindex="-1" aria-label="' + names[section] + '">' + panel + '</section></div></div>' + renderMobileDestinationNav(trip);
}
