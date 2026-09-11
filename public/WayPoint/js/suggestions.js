// ---- Generic suggestion dropdown -------------------------------------
//
// Every free-text field with suggestions — currency, timezone, country,
// city, airport — shares this one mechanism. Replaces a native
// <input list="..."> + <datalist> (dropped after two real problems: the
// browser's own popup renders wherever it decides, with no CSS hook, so
// it can cover the input near a narrow modal's edge; and swapping
// <option>s live for airport's search-as-you-type interrupted mid-word
// typing on at least one device). A plain app-rendered <div>
// (`.suggest-list`, positioned by `.suggest-input-wrap`) sidesteps both.
//
// A field opts in by rendering its input inside `.suggest-input-wrap`
// with `data-suggest-type="..."` naming one of the sources below (see
// fieldHtml()'s 'currency'/'country'/'city'/'timezone'/'airport' cases).
//
// Each source is { search(query) -> items, display(item) -> the string
// shown and written on selection }. Plain-string fields share one
// substring search; airport keeps its own richer scoring (see
// searchAirports() above).
function searchStringList(list, query) {
  var q = (query || '').trim().toLowerCase();
  if (!q) return list;
  // Ranked so a "starts with" match (what most people are typing
  // towards) surfaces before a mere "contains" match, same spirit as
  // searchAirports()'s scoring, just for plain string lists.
  var starts = [], contains = [];
  for (var i = 0; i < list.length; i++) {
    var lower = list[i].toLowerCase();
    if (lower.indexOf(q) === 0) starts.push(list[i]);
    else if (lower.indexOf(q) !== -1) contains.push(list[i]);
  }
  return starts.concat(contains);
}

var SUGGEST_SOURCES = {
  currency: { search: function (q) { return searchStringList(COMMON_CURRENCIES, q); }, display: function (item) { return item; } },
  timezone: { search: function (q) { return searchStringList(COMMON_TIMEZONES, q); }, display: function (item) { return item; } },
  country: { search: function (q) { return searchStringList(COMMON_COUNTRIES, q); }, display: function (item) { return item; } },
  city: { search: function (q) { return searchStringList(COMMON_CITIES, q); }, display: function (item) { return item; } },
  airport: { search: searchAirports, display: airportDisplay }
};

// suggestDropdownState tracks whichever one field currently has its
// dropdown open — only one can be focused at a time, so a single shared
// state object keeps the keyboard-navigation handlers below simple.
var suggestDropdownState = { input: null, items: [], activeIndex: -1, source: null };

function suggestListEl(input) {
  return input ? document.getElementById(input.name + '-suggest') : null;
}

function suggestSourceFor(input) {
  var type = input && input.getAttribute && input.getAttribute('data-suggest-type');
  return type ? SUGGEST_SOURCES[type] : null;
}

function isSuggestInput(el) {
  return !!(el && el.getAttribute && el.getAttribute('data-suggest-type'));
}

function closeSuggestions(input) {
  clearTimeout(suggestDebounce);
  var el = suggestListEl(input);
  if (el) { el.classList.remove('is-open'); el.innerHTML = ''; }
  if (input) {
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }
  if (suggestDropdownState.input === input) suggestDropdownState = { input: null, items: [], activeIndex: -1, source: null };
}

function renderSuggestList(input) {
  var el = suggestListEl(input);
  if (!el) return;
  var items = suggestDropdownState.items;
  var display = suggestDropdownState.source.display;
  var status = document.getElementById(input.name + '-suggest-status');
  input.setAttribute('aria-expanded', 'true');
  if (!items.length) {
    el.innerHTML = '<div class="suggest-empty">No matches yet</div>';
    el.classList.add('is-open');
    input.removeAttribute('aria-activedescendant');
    if (status) status.textContent = 'No suggestions available.';
    return;
  }
  el.innerHTML = items.map(function (item, i) {
    return '<div class="suggest-item' + (i === suggestDropdownState.activeIndex ? ' is-active' : '') +
      '" id="' + input.name + '-suggest-option-' + i + '" role="option" aria-selected="' + (i === suggestDropdownState.activeIndex) + '" data-index="' + i + '">' + esc(display(item)) + '</div>';
  }).join('');
  el.classList.add('is-open');
  if (status) status.textContent = items.length + ' suggestion' + (items.length === 1 ? '' : 's') + ' available. Use the arrow keys to review them.';
  if (suggestDropdownState.activeIndex >= 0) {
    var active = el.querySelector('.suggest-item.is-active');
    if (active) input.setAttribute('aria-activedescendant', active.id);
    if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
  } else {
    input.removeAttribute('aria-activedescendant');
  }
}

function openSuggestions(input) {
  var source = suggestSourceFor(input);
  if (!source) return;
  var items = source.search(input.value);
  suggestDropdownState = { input: input, items: items, activeIndex: -1, source: source };
  renderSuggestList(input);
}

function selectSuggestion(input, item) {
  input.value = suggestDropdownState.source.display(item);
  closeSuggestions(input);
  // Airport-only: keep the resolve-hint in sync when the value changes
  // via a click/keyboard selection, same as it already does on typed
  // input (see the 'input' listener below).
  if (input.getAttribute('data-suggest-type') === 'airport') updateAirportResolveHint(input);
  // Programmatic choices must notify Journey captions and validation just as
  // typed changes do, without reopening the suggestion list.
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

// Debounced so a fast typist doesn't trigger a dropdown rebuild on
// every single keystroke — 120ms is short enough to still feel
// immediate, long enough to skip the in-between keystrokes of a normal
// typing burst. Airport's resolve-hint update is cheap enough (no list
// rebuild, just one lookup) to run on every keystroke without this.
var suggestDebounce = null;
document.addEventListener('input', function (e) {
  if (!isSuggestInput(e.target)) return;
  var input = e.target;
  if (input.getAttribute('data-suggest-type') === 'airport') updateAirportResolveHint(input);
  clearTimeout(suggestDebounce);
  suggestDebounce = setTimeout(function () { if (input.isConnected && document.activeElement === input) openSuggestions(input); }, 120);
});

// Opens with whatever's already there (the field's default list, on an
// empty field) as soon as the field is focused, same as a native
// datalist would've offered on focus.
document.addEventListener('focusin', function (e) {
  if (!isSuggestInput(e.target)) return;
  openSuggestions(e.target);
});

// Closing on blur needs a short delay: a click on a suggestion fires
// the input's blur before the click's own handler runs, so closing
// immediately would remove the option out from under the click. The
// mousedown handler below cancels that click from ever blurring the
// input in the first place, but the delay stays as a safety net for
// any other way focus can leave the field (Tab, tapping elsewhere).
document.addEventListener('focusout', function (e) {
  if (!isSuggestInput(e.target)) return;
  var input = e.target;
  setTimeout(function () { closeSuggestions(input); }, 150);
});

// preventDefault on mousedown (not click) is what stops the input
// from blurring at all when a suggestion is tapped/clicked — by the
// time a 'click' event would fire, blur has already happened.
document.addEventListener('mousedown', function (e) {
  var item = e.target.closest && e.target.closest('.suggest-item');
  if (!item) return;
  e.preventDefault();
  var input = suggestDropdownState.input;
  if (!input) return;
  var chosen = suggestDropdownState.items[parseInt(item.getAttribute('data-index'), 10)];
  if (chosen) selectSuggestion(input, chosen);
});

document.addEventListener('keydown', function (e) {
  if (!isSuggestInput(e.target) || suggestDropdownState.input !== e.target) return;
  var items = suggestDropdownState.items;
  if (e.key === 'Escape') { closeSuggestions(e.target); return; }
  if (!items.length) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    suggestDropdownState.activeIndex = Math.min(suggestDropdownState.activeIndex + 1, items.length - 1);
    renderSuggestList(e.target);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    suggestDropdownState.activeIndex = Math.max(suggestDropdownState.activeIndex - 1, 0);
    renderSuggestList(e.target);
  } else if (e.key === 'Enter' && suggestDropdownState.activeIndex >= 0) {
    e.preventDefault();
    selectSuggestion(e.target, items[suggestDropdownState.activeIndex]);
  }
});

