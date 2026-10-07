// ISO values remain the form/storage contract. A text control supplies the
// same dd/mmm/yyyy presentation on every browser, with a native calendar.
function parseDisplayDate(value) {
  var match = /^(\d{2})\/([A-Za-z]{3})\/(\d{4})$/.exec(value.trim());
  if (!match) return '';
  var month = MONTHS.map(function (m) { return m.toLowerCase(); }).indexOf(match[2].toLowerCase());
  if (month < 0 || +match[3] < 100) return '';
  var date = new Date(Date.UTC(+match[3], month, +match[1]));
  if (date.getUTCMonth() !== month || date.getUTCDate() !== +match[1]) return '';
  return match[3] + '-' + String(month + 1).padStart(2, '0') + '-' + match[1];
}
function syncDateControls(scope) {
  Array.prototype.forEach.call(scope.querySelectorAll('input[type="date"]'), function (native) {
    if (native._dateDisplay && native.value !== native._dateLastValue) {
      native._dateDisplay.value = formatDateShort(native.value);
      native._dateDisplay.setCustomValidity('');
      native._dateLastValue = native.value;
    }
  });
}
function enhanceDateControls(scope) {
  Array.prototype.forEach.call(scope.querySelectorAll('input[type="date"]'), function (native) {
    if (native._dateDisplay) return;
    var wrapper = document.createElement('span'); wrapper.className = 'formatted-date';
    var display = document.createElement('input'); display.type = 'text'; display.placeholder = 'dd/mmm/yyyy';
    display.autocomplete = 'off'; display.required = native.required;
    display.value = formatDateShort(native.value);
    display.setAttribute('aria-label', native.getAttribute('aria-label') || ((native.closest('.field') || native.parentElement).querySelector('label') || {}).textContent || 'Date');
    native.parentNode.insertBefore(wrapper, native); wrapper.appendChild(display); wrapper.appendChild(native);
    var button = document.createElement('button'); button.type = 'button'; button.className = 'date-calendar-button';
    button.innerHTML = icon('date'); button.setAttribute('aria-label', 'Open calendar'); wrapper.appendChild(button);
    native.classList.add('date-calendar-native'); native.tabIndex = -1;
    native._dateDisplay = display; native._dateLastValue = native.value;
    native.setAttribute('aria-hidden', 'true');
    button.addEventListener('click', function () { if (native.showPicker) { try { native.showPicker(); } catch (_) { native.focus(); } } else native.focus(); });
    display.addEventListener('input', function () {
      var iso = parseDisplayDate(display.value);
      display.setCustomValidity(display.value && !iso ? 'Use a valid date in dd/mmm/yyyy format, for example 07/Oct/2026.' : '');
      native.value = iso; native._dateLastValue = iso;
    });
    display.addEventListener('change', function () {
      if (display.validity.valid) native.dispatchEvent(new Event('change', { bubbles: true }));
    });
    native.addEventListener('change', function () { native._dateLastValue = native.value; display.value = formatDateShort(native.value); display.setCustomValidity(''); });
  });
}
