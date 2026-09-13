/* ---------- 5. Toast & confirm dialog ------------------------------ */

// Toasts are deliberately reserved for global connection, save-failure and
// system events. Field validation belongs beside its field (showFormError),
// while successful record saves use the persistent top-bar save indicator.
function showToast(message, explicitKind) {
  var root = document.getElementById('toast-root');
  var div = document.createElement('div');
  var isError = explicitKind === 'error' || (!explicitKind && /could not|cannot|failed|not saved|invalid|error|enter |must |at least|before the start|after the start/i.test(message));
  div.className = 'toast' + (isError ? ' toast-error' : '');
  div.setAttribute('role', isError ? 'alert' : 'status');
  div.setAttribute('aria-live', isError ? 'assertive' : 'polite');
  div.setAttribute('aria-atomic', 'true');
  div.textContent = message;
  root.appendChild(div);
  requestAnimationFrame(function () { div.classList.add('show'); });
  setTimeout(function () {
    div.classList.remove('show');
    setTimeout(function () { div.remove(); }, 250);
  }, isError ? 8000 : 3200);
}

function announceStatus(message) {
  var region = document.getElementById('polite-status');
  if (!region) return;
  region.textContent = '';
  requestAnimationFrame(function () { region.textContent = message; });
}

/* ---------- 5a. Shared accessibility infrastructure -----------------
   WayPoint renders its UI from HTML strings, so these helpers apply the
   repeated behavioural guarantees in one place: field labelling, dialog
   focus containment and restoration, and stable descriptions for hints. */

var accessibilityId = 0;
var modalReturnFocus = null;

function ensureElementId(el, prefix) {
  if (!el.id) el.id = (prefix || 'wp-a11y') + '-' + (++accessibilityId);
  return el.id;
}

function appendDescribedBy(control, id) {
  var values = (control.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
  if (values.indexOf(id) === -1) values.push(id);
  control.setAttribute('aria-describedby', values.join(' '));
}

function enhanceAccessibility(scope) {
  if (!scope || !scope.querySelectorAll) return;
  Array.prototype.forEach.call(scope.querySelectorAll('.field'), function (field) {
    var controls = Array.prototype.filter.call(field.querySelectorAll('input:not([type="hidden"]), select, textarea'), function (control) {
      return control.closest('.field') === field && !control.closest('label');
    });
    var label = Array.prototype.find.call(field.children, function (child) { return child.tagName === 'LABEL'; });
    var control = controls[0];
    if (label && control) {
      var controlId = ensureElementId(control, 'wp-field');
      label.htmlFor = controlId;
      if (control.required && !label.querySelector('.required-marker')) {
        var marker = document.createElement('span');
        marker.className = 'required-marker';
        marker.textContent = ' (required)';
        label.appendChild(marker);
      }
      Array.prototype.forEach.call(field.querySelectorAll('.field-hint'), function (hint) {
        if (hint.closest('.field') !== field) return;
        appendDescribedBy(control, ensureElementId(hint, 'wp-hint'));
      });
    }
    var picker = field.querySelector('.tag-picker');
    if (picker && label) {
      picker.setAttribute('role', 'group');
      picker.setAttribute('aria-labelledby', ensureElementId(label, 'wp-group-label'));
    }
  });

  Array.prototype.forEach.call(scope.querySelectorAll('.avatar-picker-section'), function (section) {
    var heading = section.querySelector('h4');
    var grid = section.querySelector('.avatar-swatch-grid');
    if (heading && grid) {
      grid.setAttribute('role', 'group');
      grid.setAttribute('aria-labelledby', ensureElementId(heading, 'wp-avatar-group'));
    }
  });
  Array.prototype.forEach.call(scope.querySelectorAll('button.avatar-swatch-btn'), function (button) {
    button.setAttribute('aria-pressed', String(button.classList.contains('is-selected')));
  });
  // If connectivity changes while a modal or screen is already open, disable
  // every state-changing control in that rendered subtree. Navigation and
  // local view controls remain available, so saved data can still be read.
  Array.prototype.forEach.call(scope.querySelectorAll('[data-action]'), function (control) {
    if (isMutationAction(control.dataset.action)) control.disabled = !editingAvailable();
  });
  updateSubmitAvailability(scope);
}

function updateSubmitAvailability(scope) {
  Array.prototype.forEach.call(scope.querySelectorAll('form:not(#login-form):not(#setup-form) button[type="submit"]'), function (button) {
    // Retain intentional (e.g. pending request) disables when the lock lifts.
    if (!editingAvailable() && !button.disabled) { button.dataset.editLock = 'true'; button.disabled = true; }
    else if (editingAvailable() && button.dataset.editLock === 'true') { delete button.dataset.editLock; button.disabled = false; }
  });
}

function modalFocusableElements(dialog) {
  return Array.prototype.filter.call(dialog.querySelectorAll('button:not([disabled]), summary, [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'), function (el) {
    // Hidden disclosure contents and CSS-hidden controls cannot receive focus.
    return !el.closest('[hidden], [inert], [aria-hidden="true"]') && el.getClientRects().length > 0;
  });
}

function setModalBackgroundInert(inert) {
  ['.topbar', '#main-content', '#system-banner'].forEach(function (selector) {
    var el = document.querySelector(selector);
    if (!el) return;
    el.inert = inert;
    if (inert) el.setAttribute('aria-hidden', 'true');
    else el.removeAttribute('aria-hidden');
  });
}

function activateModal() {
  var root = document.getElementById('modal-root');
  var dialog = root && root.querySelector('.modal');
  if (!dialog) return;
  enhanceAccessibility(dialog);
  if (dialog.dataset.accessibilityReady === 'true') return;
  dialog.dataset.accessibilityReady = 'true';
  modalReturnFocus = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('tabindex', '-1');
  var heading = dialog.querySelector('.modal-head h2');
  if (heading) dialog.setAttribute('aria-labelledby', ensureElementId(heading, 'wp-dialog-title'));
  setModalBackgroundInert(true);
  document.body.classList.add('has-modal');
  requestAnimationFrame(function () {
    if (!dialog.isConnected) return;
    var initial = dialog.querySelector('[data-modal-initial]') || modalFocusableElements(dialog)[0] || dialog;
    initial.focus();
  });
}

function showFormError(form, message, control) {
  if (!form) { showToast(message); return; }
  var body = form.querySelector('.modal-body') || form;
  var summary = form.querySelector('.form-error-summary');
  if (!summary) {
    summary = document.createElement('div');
    summary.className = 'form-error-summary';
    summary.setAttribute('role', 'alert');
    summary.setAttribute('tabindex', '-1');
    body.insertBefore(summary, body.firstChild);
  }
  summary.textContent = message;
  if (control) {
    // Invalid fields can live in a collapsed optional section. Reveal every
    // ancestor disclosure before focus so the error is visible and reachable.
    var ancestor = control.parentElement;
    while (ancestor && ancestor !== form) {
      if (ancestor.tagName === 'DETAILS') ancestor.open = true;
      ancestor = ancestor.parentElement;
    }
    control.setAttribute('aria-invalid', 'true');
    var error = control.parentElement && control.parentElement.querySelector('.field-error');
    if (!error) {
      error = document.createElement('div');
      error.className = 'field-error';
      if (control.parentElement) control.parentElement.appendChild(error);
    }
    error.textContent = message;
    appendDescribedBy(control, ensureElementId(error, 'wp-error'));
    control.focus();
  } else {
    summary.focus();
  }
}

function isMutationAction(action) {
  if (!action) return false;
  return /^(new-|edit-|delete-|timeline-add-|link-companion$)/.test(action) ||
    ['confirm-yes', 'open-avatar-picker', 'set-location-pin', 'use-typed-location', 'apply-location-input', 'review-map-location'].indexOf(action) !== -1;
}

function clearFieldError(event) {
  var control = event.target;
  if (!control || !control.removeAttribute) return;
  if (control.getAttribute('aria-invalid') === 'true') {
    control.removeAttribute('aria-invalid');
    var error = control.parentElement && control.parentElement.querySelector('.field-error');
    if (error) {
      var errorId = error.id;
      error.remove();
      var descriptions = (control.getAttribute('aria-describedby') || '').split(/\s+/).filter(function (id) { return id && id !== errorId; });
      if (descriptions.length) control.setAttribute('aria-describedby', descriptions.join(' '));
      else control.removeAttribute('aria-describedby');
    }
    var form = control.form;
    if (form && !form.querySelector('[aria-invalid="true"]')) {
      var summary = form.querySelector('.form-error-summary');
      if (summary) summary.remove();
    }
  }
}
document.addEventListener('input', clearFieldError);
document.addEventListener('change', clearFieldError);

// Native constraint validation is still the source of truth, but presenting
// its message inside the dialog makes the failure persistent, programmatically
// associated with the field, and reachable by screen-reader and keyboard users.
var invalidFormResetTimer = null;
document.addEventListener('invalid', function (event) {
  var control = event.target;
  var form = control && control.form;
  event.preventDefault();
  if (!form || form.dataset.invalidMessageShown === 'true') return;
  form.dataset.invalidMessageShown = 'true';
  showFormError(form, control.validationMessage || 'Check the highlighted field and try again.', control);
  clearTimeout(invalidFormResetTimer);
  invalidFormResetTimer = setTimeout(function () { delete form.dataset.invalidMessageShown; }, 0);
}, true);

document.addEventListener('keydown', function (event) {
  if (event.key === 'Escape') {
    var openDayAdd = document.querySelector('.day-add[open]');
    if (openDayAdd) {
      event.preventDefault();
      openDayAdd.removeAttribute('open');
      var dayAddToggle = openDayAdd.querySelector('.day-add-btn');
      if (dayAddToggle) dayAddToggle.focus();
      return;
    }
  }
  if (event.key === 'Escape' && accountMenuOpen) {
    event.preventDefault();
    accountMenuOpen = false;
    applyAuthUI();
    var accountToggle = document.querySelector('.account-menu-toggle');
    if (accountToggle) accountToggle.focus();
    return;
  }
  if (accountMenuOpen && event.target.closest && event.target.closest('.account-popover') && ['ArrowDown', 'ArrowUp', 'Home', 'End'].indexOf(event.key) !== -1) {
    var menuItems = Array.prototype.slice.call(document.querySelectorAll('.account-popover [role="menuitem"]'));
    if (menuItems.length) {
      event.preventDefault();
      var menuIndex = menuItems.indexOf(document.activeElement);
      if (event.key === 'Home') menuIndex = 0;
      else if (event.key === 'End') menuIndex = menuItems.length - 1;
      else if (event.key === 'ArrowDown') menuIndex = (menuIndex + 1) % menuItems.length;
      else menuIndex = (menuIndex <= 0 ? menuItems.length : menuIndex) - 1;
      menuItems[menuIndex].focus();
    }
    return;
  }
  var dialog = document.querySelector('#modal-root .modal');
  if (!dialog) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    // Dismiss the innermost popup first; a second Escape closes the dialog.
    if (typeof suggestDropdownState !== 'undefined' && suggestDropdownState.input && suggestDropdownState.input.getAttribute('aria-expanded') === 'true') {
      closeSuggestions(suggestDropdownState.input);
      return;
    }
    closeModal();
    return;
  }
  if (event.key !== 'Tab') return;
  var focusable = modalFocusableElements(dialog);
  if (!focusable.length) { event.preventDefault(); dialog.focus(); return; }
  var first = focusable[0], last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});

new MutationObserver(function () {
  var root = document.getElementById('modal-root');
  if (root && root.querySelector('.modal')) activateModal();
}).observe(document.getElementById('modal-root'), { childList: true, subtree: true });

var pendingConfirm = null;

function openConfirm(opts) {
  pendingConfirm = opts.onConfirm;
  var root = document.getElementById('modal-root');
  root.innerHTML =
    '<div class="modal-backdrop" data-action="close-modal">' +
      '<div class="modal">' +
        '<div class="modal-head"><h2>' + esc(opts.title || 'Are you sure?') + '</h2>' +
          '<button class="btn btn-icon btn-ghost" data-action="close-modal" aria-label="Close dialog" title="Close">' + icon('close') + '</button></div>' +
        '<div class="modal-body"><p class="confirm-text">' + esc(opts.message) + '</p></div>' +
        '<div class="modal-foot">' +
          '<button class="btn" data-action="close-modal" data-modal-initial>Cancel</button>' +
          '<button class="btn btn-danger" data-action="confirm-yes">' + esc(opts.confirmLabel || 'Delete') + '</button>' +
        '</div>' +
      '</div>' +
    '</div>';
}

function closeModal() {
  disposeLocationPickers(document.getElementById('modal-root'));
  if (typeof suggestDropdownState !== 'undefined' && suggestDropdownState.input) closeSuggestions(suggestDropdownState.input);
  document.getElementById('modal-root').innerHTML = '';
  setModalBackgroundInert(false);
  document.body.classList.remove('has-modal');
  window.__formConfig = null;
  pendingConfirm = null;
  var restore = modalReturnFocus;
  modalReturnFocus = null;
  requestAnimationFrame(function () {
    // Saving replaces the main panel, so the original opener may be detached.
    var target = restore && restore.isConnected ? restore : document.querySelector('#trip-panel h2, [data-page-heading], #main-content');
    if (target) { if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1'); target.focus(); }
  });
}
