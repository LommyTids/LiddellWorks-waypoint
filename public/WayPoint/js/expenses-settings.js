/* ---------- 21. Render: Expenses tab ---------------------------------------- */

function expenseActionsHtml(trip, line) {
  if (!canFullyEditTrip(trip) || !line.item) return '';
  // Linked costs are edited at their source. Only standalone expenses expose
  // Delete here, so deleting a ledger cost cannot delete an entire itinerary.
  if (line.section === 'expense') return rowActions(trip, 'expense', line.item);
  return '<button type="button" class="btn btn-icon btn-ghost" data-action="edit-' + line.section + '" data-id="' + esc(line.item[ENTITY_ID_FIELDS[line.section]]) + '" aria-label="Edit ' + esc(line.type.toLowerCase()) + ' cost" title="Edit source record">' + icon('edit') + '</button>';
}

function renderExpensesTab(trip) {
  var lines = allCostLines(trip);
  var spend = tripSpend(trip);
  var byCategory = {};
  lines.forEach(function (l) {
    var hv = homeValue(trip, l.amount, l.currency, l.rateOverride);
    if (!hv.known) return;
    byCategory[l.category] = (byCategory[l.category] || 0) + hv.value;
  });
  var catTiles = Object.keys(byCategory).sort(function (a, b) { return byCategory[b] - byCategory[a]; }).map(function (cat) {
    return '<div class="stat-tile"><div class="stat-label">' + esc(cat) + '</div><div class="stat-value">' + money(byCategory[cat], trip.homeCurrency) + '</div></div>';
  }).join('');
  // Expenses is a full-scope-only tab to begin with (see tabsForTrip() —
  // a scoped "user"/"viewer" grant never even gets a way to land here),
  // but "Add expense" is still gated explicitly rather than assumed, in
  // case that ever changes.
  var head = '<div class="tab-panel-head"><h2>Expenses</h2>' +
    '<div class="expenses-actions"><button class="btn" data-action="export-csv">' + icon('download') + ' Export CSV</button>' +
    (canFullyEditTrip(trip) ? '<button class="btn btn-accent" data-action="new-expense">' + icon('add') + ' Add expense</button>' : '') + '</div></div>';

  if (lines.length === 0) {
    return head + emptyStateHtml('empty', 'expenses', 'No expenses logged yet', 'Costs added to activities, transport and accommodation show up here automatically — use "Add expense" for everything else, like meals, taxis and souvenirs.');
  }

  var rows = lines.map(function (l) {
    var hv = homeValue(trip, l.amount, l.currency, l.rateOverride);
    return '<tr><td>' + formatDateShort(l.date) + '</td><td>' + esc(l.type) + '</td><td>' + esc(l.desc) +
      (l.receiptRef ? '<div class="item-sub">' + esc(l.receiptRef) + '</div>' : '') + '</td>' +
      '<td class="num">' + money(l.amount, l.currency) + '</td>' +
      '<td class="num">' + (hv.known ? money(hv.value, trip.homeCurrency) : '<span class="rate-missing">rate needed</span>') + '</td><td>' + expenseActionsHtml(trip, l) + '</td></tr>';
  }).join('');

  // The compact ledger is deliberately newest-first and grouped by date so a
  // phone user can reconcile recent spending without scanning a wide table.
  // Native and home values share identical type and width: conversion is
  // context, not a visually subordinate footnote.
  var ledgerByDate = {};
  lines.slice().reverse().forEach(function (line) {
    var key = line.date || '';
    if (!ledgerByDate[key]) ledgerByDate[key] = [];
    ledgerByDate[key].push(line);
  });
  var ledger = Object.keys(ledgerByDate).sort().reverse().map(function (date) {
    var items = ledgerByDate[date].map(function (line) {
      var home = homeValue(trip, line.amount, line.currency, line.rateOverride);
      return '<article class="expense-ledger-row">' +
        '<div class="expense-ledger-head"><span class="expense-ledger-title">' + esc(line.desc) + '</span><span class="expense-ledger-type">' + esc(line.type) + '</span></div>' +
        (line.receiptRef ? '<div class="expense-ledger-reference">' + esc(line.receiptRef) + '</div>' : '') +
        '<div class="expense-ledger-amounts">' +
          '<div class="expense-ledger-amount"><span class="expense-ledger-amount-label">Native</span><span class="expense-ledger-amount-value">' + money(line.amount, line.currency) + '</span></div>' +
          '<div class="expense-ledger-amount"><span class="expense-ledger-amount-label">Home · ' + esc(trip.homeCurrency) + '</span><span class="expense-ledger-amount-value">' + (home.known ? money(home.value, trip.homeCurrency) : '<span class="rate-missing">rate needed</span>') + '</span></div>' +
        '</div><div class="card-actions">' + expenseActionsHtml(trip, line) + '</div></article>';
    }).join('');
    return '<section class="expense-ledger-day"><h3 class="expense-ledger-date">' + esc(date ? formatDateHeading(date) : 'Date not set') + '</h3><div class="expense-ledger-list">' + items + '</div></section>';
  }).join('');

  return head +
    '<div class="stat-row"><div class="stat-tile"><div class="stat-label">Total (' + trip.homeCurrency + ')</div><div class="stat-value">' + money(spend.known, trip.homeCurrency) + '</div></div>' + catTiles + '</div>' +
    (spend.unknownCount ? '<div class="intro-note expense-rate-warning"><strong>' + spend.unknownCount + ' item(s)</strong> are in a currency with no exchange rate set — <button class="warn-link" data-action="switch-tab" data-tab="settings">set one in Settings</button> to include them in the total.</div>' : '') +
    '<div class="table-wrap expense-table"><table><caption class="sr-only">Expenses for ' + esc(trip.name) + '</caption><thead><tr><th scope="col">Date</th><th scope="col">Type</th><th scope="col">Description</th><th scope="col" class="num">Amount</th><th scope="col" class="num">' + esc(trip.homeCurrency) + '</th><th scope="col">Actions</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
    '<div class="expense-ledger" aria-label="Expenses grouped by date, newest first">' + ledger + '</div>';
}

/* ---------- 22. Render: Settings tab ------------------------------------------ */

function renderSettingsTab(trip) {
  var currencies = usedCurrencies(trip);
  var canEdit = canFullyEditTrip(trip);
  var generalSection = canEdit ? '<section class="settings-section"><div class="settings-section-head"><div><h3>Trip details</h3><p>Name, dates and notes. These controls remain available on phone screens.</p></div></div><button class="btn" data-action="edit-trip" data-id="' + esc(trip.tripId) + '">' + icon('edit') + ' Edit trip details</button></section>' : '';
  var rateRows = currencies.map(function (cur) {
    var rate = trip.currencyRates[cur];
    return '<div class="field-row"><div class="field"><label>1 ' + esc(cur) + ' =</label>' +
      '<input type="number" step="any" name="rate_' + cur + '" value="' + (rate !== undefined ? esc(rate) : '') + '" placeholder="e.g. 0.79"' + (canEdit ? '' : ' disabled') + '></div>' +
      '<div class="field"><label>&nbsp;</label><div class="field-hint settings-inline-hint">' + esc(trip.homeCurrency) + ' per 1 ' + esc(cur) + '</div></div></div>';
  }).join('');
  var currencySection = '<form id="rates-form"><section class="settings-section"><div class="settings-section-head"><div><h3>Currency</h3><p>Home currency and fixed exchange rates used for trip totals.</p></div>' + (!canEdit ? tripAccessBadgeHtml(trip) : '') + '</div>' +
    '<div class="field"><label>Home currency</label><div class="settings-currency-input">' +
      suggestInputHtml({ key: 'homeCurrency' }, trip.homeCurrency, canEdit ? 'required' : 'disabled', 'currency', 'maxlength="3" class="settings-uppercase"', 'GBP') +
      '</div><div class="field-hint">Every total on this trip converts into this currency.</div></div>' +
    (currencies.length
      ? '<div class="field"><label>Fixed exchange rates for this trip</label><div class="field-hint settings-rate-intro">Used whenever an item in that currency does not have its own rate override.</div><div class="rate-table">' + rateRows + '</div></div>'
      : '<p class="field-hint">No foreign-currency costs logged yet — rates will appear here once you add one.</p>') +
    (canEdit ? '<button type="submit" class="btn btn-primary">Save currency settings</button>' : '') +
    '</section></form>';
  // The viewing lens. Unlike everything else in Settings, this is not trip
  // data -- it changes only what THIS browser draws, and nobody else's view
  // of the trip moves. The copy has to say so: the word "see" around
  // permissions means something much stronger, and this is not that.
  //
  // Shown only where it can actually work (canScopeToOwnItems()): a scoped
  // user/viewer grant was already filtered by the Worker, and an Admin
  // nobody has linked to a person on this trip has no "mine" to show. In
  // the latter case we still explain why, rather than silently omitting a
  // section they were told about.
  var scope = itemScopeFor(trip);
  var viewSection = '';
  if (canScopeToOwnItems(trip)) {
    var hiddenNow = itemScopeHiddenCount(trip);
    viewSection = '<section class="settings-section"><div class="settings-section-head"><div><h3>What you see</h3>' +
      '<p>Narrow this trip to the items you are tagged on. This changes your view only — it does not change what anyone can open or edit, and everyone else still sees the whole trip.</p></div></div>' +
      '<div class="scope-switch" role="group" aria-label="Which items to show">' +
        '<button class="btn scope-option' + (scope === 'everything' ? ' is-active' : '') + '" data-action="set-item-scope" data-scope="everything"' + (scope === 'everything' ? ' aria-pressed="true"' : ' aria-pressed="false"') + '>' + icon('people') + ' Everything</button>' +
        '<button class="btn scope-option' + (scope === 'mine' ? ' is-active' : '') + '" data-action="set-item-scope" data-scope="mine"' + (scope === 'mine' ? ' aria-pressed="true"' : ' aria-pressed="false"') + '>' + icon('person') + ' Just my items</button>' +
      '</div>' +
      '<div class="field-hint">' + (scope === 'mine'
        ? (hiddenNow > 0 ? 'Hiding ' + hiddenNow + ' record' + (hiddenNow === 1 ? '' : 's') + ' you are not tagged on. Items tagged to nobody stay visible.' : 'You are tagged on everything in this trip, so nothing is hidden right now.')
        : 'Showing every record on this trip.') + '</div>' +
      '</section>';
  } else if (canFullyEditTrip(trip)) {
    viewSection = '<section class="settings-section"><div class="settings-section-head"><div><h3>What you see</h3>' +
      '<p>Narrow this trip to the items you are tagged on.</p></div></div>' +
      '<div class="field-hint">Nobody on this trip is linked to your account yet, so there are no items to call yours. Link yourself to a person on the Companions tab first.</div>' +
      '<button class="btn" data-action="switch-tab" data-tab="companions">' + icon('companions') + ' Open Companions</button>' +
      '</section>';
  }
  var accessContent = canShareTrip(trip)
    ? '<p class="field-hint">Access is managed alongside each person, so permissions and companion tagging stay connected.</p><button class="btn" data-action="switch-tab" data-tab="companions">' + icon('companions') + ' Manage trip access</button>'
    : emptyStateHtml('permission', 'readonly', 'Permission restricted', 'Your access to this trip is read-only or limited to items tagged to you. Ask the trip owner or an Admin to change it.', '', true);
  var accessSection = '<section class="settings-section"><div class="settings-section-head"><div><h3>Access</h3><p>Who can see and edit this trip.</p></div></div>' + accessContent + '</section>';
  var dangerSection = canEdit ? '<section class="settings-section settings-section-danger"><div class="settings-section-head"><div><h3>Danger zone</h3><p>Permanently remove this trip and every record stored inside it.</p></div></div><button class="btn btn-danger" data-action="delete-trip" data-id="' + trip.tripId + '">' + icon('delete') + ' Delete this trip</button></section>' : '';
  return (
    '<div class="tab-panel-head"><h2>Settings</h2></div><div class="settings-stack">' + generalSection + currencySection + viewSection + accessSection + dangerSection + renderDependencyDisclosure() + '</div>'
  );
}

// Inventory of direct runtime/build dependencies, not an exhaustive list of
// transitive npm packages. All entries describe what is actually on main.
function renderDependencyDisclosure() {
  var dependencies = [
    ['Leaflet', 'Local map renderer: markers, route lines and area overlays.'],
    ['OpenStreetMap', 'Base-map tiles and geographic data attribution.'],
    ['LocationIQ', 'Place search and destination boundary lookup, through the Worker.'],
    ['AeroDataBox / RapidAPI', 'Flight-number and date lookup: schedules, airports and terminal details.'],
    ['Cloudflare Workers / Assets', 'Application API, authentication and static website hosting.'],
    ['Cloudflare KV', 'Stored trips, accounts, sessions and cached destination boundaries.'],
    ['Web Crypto / Intl', 'Built-in browser/platform cryptography and date, timezone and currency formatting.'],
    ['Google Fonts', 'Fraunces, Work Sans and IBM Plex Mono font delivery.'],
    ['Local reference assets', 'Airport coordinates, cities, countries, currencies, timezone names, avatars and semantic SVG icons.'],
    ['Wrangler', 'Development and deployment tools for Cloudflare.'],
    ['Playwright', 'Browser interaction and responsive regression tests (development only).'],
    ['Node.js', 'Local mock server and automated regression test runner (development only).']
  ];
  return '<details class="settings-section settings-dependencies"><summary>Dependencies and services</summary><p class="field-hint">Direct dependencies and what they do. This list contains no API keys or account details.</p><dl>' + dependencies.map(function (entry) {
    return '<div class="dependency-row"><dt>' + esc(entry[0]) + '</dt><dd>' + esc(entry[1]) + '</dd></div>';
  }).join('') + '</dl></details>';
}

