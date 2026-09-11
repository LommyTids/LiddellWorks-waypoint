/* ---------- 14. Shared row-rendering helpers -------------------------- */

function copyBtn(value, label) {
  if (!value) return '';
  return '<button class="copy-btn" data-action="copy-text" data-value="' + esc(value) + '" aria-label="Copy ' + esc(label) + '" title="Copy ' + esc(label) + '">' + icon('copy') + '</button>';
}

function mapsLink(address) {
  if (!address) return '';
  var url = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(address);
  return '<a href="' + url + '" target="_blank" rel="noopener noreferrer">Open in Maps ' + icon('forward') + '</a>';
}

function costTag(trip, amount, currency, rateOverride) {
  if (!amount) return '';
  var hv = homeValue(trip, amount, currency, rateOverride);
  var label = money(amount, currency);
  if (currency && currency !== trip.homeCurrency) {
    label += hv.known ? ' (≈ ' + money(hv.value, trip.homeCurrency) + ')' : ' (rate needed)';
  }
  return '<span class="tag tag-cost">' + icon('expenses') + label + '</span>';
}

// Edit/Delete buttons for one item row — depends on this account's
// permission on `trip` (see "Per-trip permissions" near currentTrip()).
// `taggable` should be true for the four per-companion-scoped item types,
// false for companion/contact/expense (never editable by a "user" grant).
// Returns '' if this account can't do anything to this row.
function rowActions(trip, section, item) {
  var taggable = ['destination', 'activity', 'transport', 'accommodation'].indexOf(section) !== -1;
  var canEdit = taggable ? canEditItem(trip, item) : canFullyEditTrip(trip);
  // Deleting is always full-scope-only -- even a "user" grant can never
  // delete an item (mergeUserScopedList() in src/worker.js silently
  // keeps it even if missing from what they submit).
  var canDelete = canFullyEditTrip(trip);
  if (!canEdit && !canDelete) return '';
  var itemId = item[ENTITY_ID_FIELDS[section]];
  return '<div class="item-actions">' +
    (canEdit ? '<button class="btn btn-icon btn-ghost" data-action="edit-' + section + '" data-id="' + itemId + '" aria-label="Edit ' + section + '" title="Edit">' + icon('edit') + '</button>' : '') +
    (canDelete ? '<button class="btn btn-icon btn-ghost" data-action="delete-' + section + '" data-id="' + itemId + '" aria-label="Delete ' + section + '" title="Delete">' + icon('delete') + '</button>' : '') +
  '</div>';
}

var ITEM_META_ORDER = ['datetime', 'location', 'category', 'people', 'commerce'];

// How many metadata chips a card shows before the rest move behind a
// "+N more" disclosure. One number, tuned in one place; 0 never caps.
var ITEM_META_CAP = 3;

/* ---------- ItemRow: one card, many layouts -------------------------
   A card is a stack of lines; a line is a list of slot names. This table
   is the whole configuration surface -- a new context is an entry here,
   never a branch in the renderer. Before this, the Plan lists, the
   Timeline, the Map popovers and the three People lists had each drifted
   into their own markup for the same thing.

   Two rules let one layout serve a bare record and a fully populated one:
   a slot with nothing to show renders nothing, and a line whose slots are
   all empty does not render at all. `spacer` pushes what follows to the
   right edge and never keeps a line alive by itself. */
var ITEM_CARD_LAYOUTS = {
  plan:     [['time', 'icon', 'spacer', 'cost', 'actions'], ['title', 'badges'], ['metadata'], ['supporting'], ['status'], ['people']],
  timeline: [['time', 'icon', 'spacer', 'cost', 'actions'], ['title', 'badges'], ['supporting'], ['status']],
  map:      [['icon', 'spacer', 'actions'], ['title', 'badges'], ['datetime', 'location'], ['supporting'], ['people']],
  person:   [['avatar', 'icon', 'spacer', 'actions'], ['title', 'badges'], ['metadata'], ['supporting'], ['status']]
};

function itemMetaDescriptorHtml(meta) {
  if (!meta || !meta.text) return '';
  var content = (meta.icon ? icon(meta.icon) : '') + esc(meta.text);
  if (meta.mapsAddress) content += ' ' + mapsLink(meta.mapsAddress);
  if (meta.copyValue) content += copyBtn(meta.copyValue, meta.copyLabel || meta.text);
  return '<span class="tag' + (meta.tone === 'cost' ? ' tag-cost' : '') + '">' + content + '</span>';
}

// The one metadata renderer. `slots` chooses which groups, `cap` how many
// chips appear before a disclosure takes the rest. itemMetadataHtml() is
// this with every group and no cap, so there is a single implementation
// rather than a capped copy alongside an uncapped one.
function itemMetaBlockHtml(trip, metadata, slots, cap) {
  var shown = 0;
  var overflow = [];
  var groups = slots.map(function (slot) {
    // companionTags() returns one joined run, so people count as a single
    // unit here. In the shipped layouts they sit on their own uncapped
    // line instead, so this only matters to itemMetadataHtml().
    var chips = slot === 'people'
      ? [companionTags(trip, metadata.people || [])]
      : (metadata[slot] || []).map(itemMetaDescriptorHtml);
    var present = chips.filter(function (chip) { return chip; });
    if (!present.length) return '';
    var visible = present.filter(function (chip) {
      if (cap && shown >= cap) { overflow.push(chip); return false; }
      shown++;
      return true;
    }).join('');
    return visible ? '<div class="item-meta-group" data-item-meta="' + slot + '">' + visible + '</div>' : '';
  }).join('');
  var more = overflow.length
    ? '<details class="item-meta-more"><summary class="item-meta-more-btn">' + icon('expand') + '+' + overflow.length + ' more</summary>' +
      '<div class="item-meta-more-rest">' + overflow.join('') + '</div></details>'
    : '';
  // Tested against the joined result, not inside the map callback: an
  // earlier version referenced a callback-local variable and threw on
  // every populated trip while empty ones appeared to work.
  return (groups || more) ? '<div class="item-metadata">' + groups + more + '</div>' : '';
}

function itemMetadataHtml(trip, metadata) {
  return itemMetaBlockHtml(trip, metadata, ITEM_META_ORDER, 0);
}

/* Each slot draws one thing and knows nothing about which context asked
   for it. The third argument is the set of metadata groups the catch-all
   `metadata` slot still owns -- see itemRowHtml() below. */
var ITEM_CARD_SLOTS = {
  time: function (trip, model) {
    return model.leadingTime ? '<span class="item-row-time">' + esc(model.leadingTime) + '</span>' : '';
  },
  icon: function (trip, model) {
    if (!model.icon) return '';
    return '<span class="item-icon tone-' + esc(model.tone || model.section || 'destination') + '">' + icon(model.icon) + '</span>';
  },
  // A person's own marker in place of a category glyph, which is how the
  // Companions rows already differed from every other list.
  avatar: function (trip, model) {
    return model.avatarHtml ? '<span class="item-icon item-icon-avatar">' + model.avatarHtml + '</span>' : '';
  },
  title: function (trip, model) {
    return '<span class="item-title">' + esc(model.title) + '</span>';
  },
  // Small tags that belong beside the title rather than in the metadata
  // run: a contact's role, a companion's access level, "Guest".
  badges: function (trip, model) {
    return model.badgesHtml ? '<span class="item-badges">' + model.badgesHtml + '</span>' : '';
  },
  cost: function (trip, model) {
    if (!model.cost) return '';
    return '<span class="item-row-cost' + (model.cost.known ? '' : ' rate-missing') + '">' + model.cost.text + '</span>';
  },
  actions: function (trip, model) {
    var extra = model.extraActionsHtml || '';
    var own = model.showRecordActions === false ? '' : rowActions(trip, model.section, model.item);
    return extra + own;
  },
  spacer: function () { return '<span class="item-row-spacer"></span>'; },
  // People scroll sideways rather than wrapping: a record with six
  // companions otherwise added six rows to every card in the list.
  // Focusable so the run can be panned from the keyboard.
  people: function (trip, model) {
    var tags = companionTags(trip, (model.metadata && model.metadata.people) || []);
    if (!tags) return '';
    return '<div class="item-people" tabindex="0" role="group" aria-label="People on this record">' + tags + '</div>';
  },
  metadata: function (trip, model, groups) {
    return itemMetaBlockHtml(trip, model.metadata || {}, groups, ITEM_META_CAP);
  },
  supporting: function (trip, model) {
    if (!model.supporting) return '';
    var note = '<div class="item-supporting">' + esc(model.supporting) + '</div>';
    // A clamped note carries the control that opens it. Whether notes clamp is
    // the caller's to declare -- the card does not know which context it is
    // drawing. markTruncatedNotes() then decides which cards really need one.
    if (!model.expandableNote) return note;
    return note + '<button type="button" class="item-more" data-action="toggle-card-text" aria-expanded="false">More</button>';
  },
  status: function (trip, model) {
    if (!model.status) return '';
    return '<div class="item-status">' + icon(model.status.icon || 'warning') + esc(model.status.text) + '</div>';
  }
};

// The other four groups can also be placed individually, so a context can
// spread them across lines (the Map does). `people` is not among them --
// it has its own scrolling slot above.
['datetime', 'location', 'category', 'commerce'].forEach(function (metaSlot) {
  ITEM_CARD_SLOTS[metaSlot] = function (trip, model) {
    return itemMetaBlockHtml(trip, model.metadata || {}, [metaSlot], 0);
  };
});

function itemRowHtml(trip, model) {
  var layout = ITEM_CARD_LAYOUTS[model.context] || ITEM_CARD_LAYOUTS.plan;
  // A metadata group named anywhere in this layout drops out of the
  // catch-all `metadata` slot, so moving `people` onto its own line
  // cannot render it twice -- and there is no exclusion list to maintain.
  var placed = {};
  layout.forEach(function (slots) {
    slots.forEach(function (slot) { if (ITEM_META_ORDER.indexOf(slot) !== -1) placed[slot] = true; });
  });
  var catchAll = ITEM_META_ORDER.filter(function (slot) { return !placed[slot]; });

  var lines = layout.map(function (slots) {
    var filled = false;
    var html = slots.map(function (slot) {
      var render = ITEM_CARD_SLOTS[slot];
      var rendered = render ? render(trip, model, catchAll) : '';
      if (rendered && slot !== 'spacer') filled = true;
      return rendered;
    }).join('');
    return filled ? '<div class="item-row-line" data-item-line="' + esc(slots[0]) + '">' + html + '</div>' : '';
  }).join('');

  var itemId = model.item && model.section && ENTITY_ID_FIELDS[model.section] ? model.item[ENTITY_ID_FIELDS[model.section]] : '';
  // Pressing a card with a clamped note anywhere opens it. The nearest
  // [data-action] wins, so the edit, delete and add controls inside are
  // unaffected; the handler excludes the gestures that are their own.
  var pressable = model.expandableNote && model.supporting ? ' data-action="toggle-card-text"' : '';
  return '<article class="item-row item-row--' + esc(model.context || 'plan') + '" data-item-section="' + esc(model.section || '') + '"' +
    (itemId ? ' data-item-id="' + esc(itemId) + '"' : '') + pressable + '>' + lines + '</article>';
}

// A record's cost, for the card's own cost slot. Reported in the trip's home
// currency so a list of them compares down the column and reconciles with the
// trip total; when no rate is known the original amount is shown instead and
// flagged. This lives on row one rather than among the metadata chips because
// that run is capped -- and a price hidden behind "+N more" is worse than no
// price at all.
function recordCostLabel(trip, item) {
  if (!item || !item.costAmount) return null;
  var converted = homeValue(trip, item.costAmount, item.costCurrency, item.costRate);
  if (converted.known) return { text: money(converted.value, trip.homeCurrency), known: true };
  return { text: money(item.costAmount, item.costCurrency) + ' · rate needed', known: false };
}

function destinationItemRowModel(trip, destination, context) {
  var datetime = [{ icon: 'date', text: formatDateShort(destination.arriveDate) + ' – ' + formatDateShort(destination.departDate) }];
  if (destination.timezone) datetime.push({ icon: 'time', text: destination.timezone + (tzOffsetLabel(destination.timezone) ? ' (' + tzOffsetLabel(destination.timezone) + ')' : '') });
  return { context: context, section: 'destination', item: destination, icon: 'destination', tone: 'destination', title: destination.name + (destination.country ? ', ' + destination.country : ''), metadata: { datetime: datetime, location: destination.country ? [{ icon: 'location', text: destination.country }] : [], category: [], people: destination.companions || [], commerce: [] }, supporting: destination.notes || '', status: destination.locationStale ? { text: 'Location needs review' } : null };
}

function activityItemRowModel(trip, activity, context) {
  var destination = activity.destinationId ? byId(trip.destinations, activity.destinationId, 'destinationId') : null;
  var contact = activity.contactId ? byId(trip.contacts, activity.contactId, 'contactId') : null;
  var commerce = [];
  if (activity.bookingRef) commerce.push({ icon: 'booking', text: activity.bookingRef, copyValue: activity.bookingRef, copyLabel: 'booking reference' });
  if (contact) commerce.push({ icon: 'person', text: contact.name });
  if (activity.receiptRef) commerce.push({ icon: 'receipt', text: activity.receiptRef, copyValue: activity.receiptRef, copyLabel: 'receipt reference' });
  var locations = [];
  if (activity.location) locations.push({ icon: 'location', text: activity.location });
  if (activity.address) locations.push({ icon: 'location', text: activity.address, mapsAddress: activity.address });
  if (destination) locations.push({ icon: 'destination', text: destination.name });
  return { context: context, section: 'activity', item: activity, cost: recordCostLabel(trip, activity), icon: activityIsAllDay(activity) ? 'allDay' : 'activity', tone: 'activity', title: activity.title, metadata: { datetime: [{ icon: activityIsAllDay(activity) ? 'allDay' : 'time', text: activityDateTimeLabel(activity) }], location: locations, category: [{ icon: 'category', text: activity.category || 'Other' }], people: activity.companions || [], commerce: commerce }, supporting: activity.notes || '', status: activity.addressLocationStale ? { text: 'Location needs review' } : null };
}

function transportItemRowModel(trip, transport, context) {
  var contact = transport.contactId ? byId(trip.contacts, transport.contactId, 'contactId') : null;
  var overnight = dateOnly(transport.departDateTime) !== dateOnly(transport.arriveDateTime);
  var category = [{ icon: transportIconKey(transport.mode), text: transport.mode || 'Transport' }];
  if (transport.carrier) category.push({ text: transport.carrier });
  if (transport.flightNumber) category.push({ icon: 'flight', text: transport.flightNumber, copyValue: transport.flightNumber, copyLabel: 'flight number' });
  if (transport.licensePlate) category.push({ text: transport.licensePlate });
  if (overnight) category.push({ icon: 'overnight', text: 'Overnight' });
  var commerce = [];
  if (transport.bookingRef) commerce.push({ icon: 'booking', text: transport.bookingRef, copyValue: transport.bookingRef, copyLabel: 'booking reference' });
  if (contact) commerce.push({ icon: 'person', text: contact.name });
  if (transport.pointsAmount) commerce.push({ icon: 'points', text: transport.pointsAmount + (transport.pointsProgram ? ' ' + transport.pointsProgram : ' points') });
  if (transport.receiptRef) commerce.push({ icon: 'receipt', text: transport.receiptRef, copyValue: transport.receiptRef, copyLabel: 'receipt reference' });
  return { context: context, section: 'transport', item: transport, cost: recordCostLabel(trip, transport), icon: transportIconKey(transport.mode), tone: 'transport', title: transport.fromLocation + ' → ' + transport.toLocation, metadata: { datetime: [{ icon: 'time', text: formatDateShort(dateOnly(transport.departDateTime)) + ' ' + timeOnly(transport.departDateTime) + ' → ' + formatDateShort(dateOnly(transport.arriveDateTime)) + ' ' + timeOnly(transport.arriveDateTime) }], location: [{ icon: 'location', text: transport.fromLocation + ' → ' + transport.toLocation }], category: category, people: transport.companions || [], commerce: commerce }, supporting: transport.notes || '', status: transport.fromLocationStale || transport.toLocationStale ? { text: 'One or more locations need review' } : null };
}

function accommodationItemRowModel(trip, accommodation, context) {
  var destination = accommodation.destinationId ? byId(trip.destinations, accommodation.destinationId, 'destinationId') : null;
  var contact = accommodation.contactId ? byId(trip.contacts, accommodation.contactId, 'contactId') : null;
  var commerce = [];
  if (accommodation.bookingRef) commerce.push({ icon: 'booking', text: accommodation.bookingRef, copyValue: accommodation.bookingRef, copyLabel: 'booking reference' });
  if (contact) commerce.push({ icon: 'person', text: contact.name });
  if (accommodation.receiptRef) commerce.push({ icon: 'receipt', text: accommodation.receiptRef, copyValue: accommodation.receiptRef, copyLabel: 'receipt reference' });
  var locations = [];
  if (accommodation.address) locations.push({ icon: 'location', text: accommodation.address, mapsAddress: accommodation.address });
  if (destination) locations.push({ icon: 'destination', text: destination.name });
  return { context: context, section: 'accommodation', item: accommodation, cost: recordCostLabel(trip, accommodation), icon: 'stay', tone: 'stay', title: accommodation.name, metadata: { datetime: [{ icon: 'time', text: formatDateShort(dateOnly(accommodation.checkIn)) + ' ' + timeOnly(accommodation.checkIn) + ' → ' + formatDateShort(dateOnly(accommodation.checkOut)) + ' ' + timeOnly(accommodation.checkOut) }], location: locations, category: [{ icon: 'category', text: accommodation.type || 'Other' }], people: accommodation.companions || [], commerce: commerce }, supporting: accommodation.notes || '', status: accommodation.locationStale ? { text: 'Location needs review' } : null };
}

function recordItemRowModel(trip, section, item, context) {
  if (section === 'destination') return destinationItemRowModel(trip, item, context);
  if (section === 'activity') return activityItemRowModel(trip, item, context);
  if (section === 'transport') return transportItemRowModel(trip, item, context);
  return accommodationItemRowModel(trip, item, context);
}

// The "Add X" button/empty-state prompt: only ever shown to a full-scope
// role (Superuser/admin/uber) — a "user"/"viewer" grant can never create
// a new item of any kind, only edit ones already tagged to them (see
// canEditItem()'s comment).
function emptyTab(trip, iconName, title, body, addAction, addLabel) {
  var action = canFullyEditTrip(trip) ? '<button class="btn btn-accent" data-action="' + addAction + '">' + icon('add') + ' ' + esc(addLabel) + '</button>' : '';
  // A tab emptied by the viewing lens must not claim the trip is empty.
  // `trip` here has already been filtered, so ask the live trip how many
  // records the lens is holding back (see itemScopeHiddenCount()). Offer
  // the way out in the same breath as the diagnosis.
  var hidden = itemScopeHiddenCount(trip);
  if (hidden > 0) {
    return emptyStateHtml('empty', iconName, 'Nothing here tagged to you',
      'This trip has ' + hidden + ' record' + (hidden === 1 ? '' : 's') + ' you are not tagged on. You are viewing just your own items.',
      '<button class="btn" data-action="set-item-scope" data-scope="everything">' + icon('people') + ' Show everything</button>' + action);
  }
  return emptyStateHtml('empty', iconName, title, body, action);
}

function tabHead(trip, title, addAction, addLabel) {
  return '<div class="tab-panel-head"><h2>' + esc(title) + '</h2>' +
    (canFullyEditTrip(trip) ? '<button class="btn btn-accent" data-action="' + addAction + '">' + icon('add') + ' ' + esc(addLabel) + '</button>' : '') +
    '</div>';
}

// The four Plan lists share their empty state, sorting and card container.
function renderItemListTab(trip, items, options) {
  if (!items.length) return emptyTab(trip, options.icon, options.emptyTitle, options.emptyBody, options.action, options.addLabel);
  var sorted = items.slice().sort(function (a, b) { return options.sortKey(a) < options.sortKey(b) ? -1 : 1; });
  var rows = sorted.map(function (item) { return itemRowHtml(trip, options.rowModel(trip, item, 'plan')); }).join('');
  return tabHead(trip, options.title, options.action, options.addLabel) + '<div class="item-list">' + rows + '</div>';
}

