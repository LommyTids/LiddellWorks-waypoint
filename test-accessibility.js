const fs = require('fs');

const html = fs.readFileSync('public/WayPoint/index.html', 'utf8');
const style = (html.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || '';

function requirePattern(pattern, message) {
  if (!pattern.test(html)) throw new Error(message);
}

// Structural navigation and asynchronous feedback must remain discoverable.
requirePattern(/<a class="skip-link" href="#main-content">/, 'Skip link is missing');
requirePattern(/<header class="topbar">/, 'Top-level header landmark is missing');
requirePattern(/<main id="main-content"[^>]*tabindex="-1">/, 'Focusable main landmark is missing');
requirePattern(/id="save-indicator"[^>]*role="status"[^>]*aria-live="polite"/, 'Save status is not announced');

// Dialogs are created from several call sites, so the shared activation path
// owns semantics, initial focus, Tab containment, Escape, inert background and
// return focus rather than leaving each individual modal to drift.
requirePattern(/dialog\.setAttribute\('role', 'dialog'\)/, 'Modal dialog role is missing');
requirePattern(/dialog\.setAttribute\('aria-modal', 'true'\)/, 'aria-modal is missing');
requirePattern(/dialog\.setAttribute\('aria-labelledby'/, 'Dialog title association is missing');
requirePattern(/el\.inert = inert/, 'Modal background is not made inert');
requirePattern(/event\.key === 'Escape'[\s\S]*?closeModal\(\)/, 'Escape does not close dialogs');
requirePattern(/event\.key !== 'Tab'[\s\S]*?modalFocusableElements/, 'Dialog focus containment is missing');
requirePattern(/restore && restore\.isConnected[\s\S]*?restore\.focus\(\)/, 'Dialog trigger focus is not restored');

// Form labels, hints, required state and errors are deliberately centralised
// because almost all WayPoint forms are assembled from reusable field schemas.
requirePattern(/label\.htmlFor = controlId/, 'Rendered fields are not associated with labels');
requirePattern(/marker\.textContent = ' \(required\)'/, 'Required fields have no visible marker');
requirePattern(/appendDescribedBy\(control,[\s\S]*?'wp-hint'/, 'Field hints are not associated');
requirePattern(/className = 'form-error-summary'/, 'Persistent form error summary is missing');
requirePattern(/control\.setAttribute\('aria-invalid', 'true'\)/, 'Invalid fields are not exposed');
requirePattern(/document\.addEventListener\('invalid'/, 'Native invalid events are not surfaced inline');
requirePattern(/<fieldset class="field activity-timing-field/, 'Activity timing is not a semantic field group');

// Custom widgets and cards must expose native or ARIA keyboard contracts.
requirePattern(/role="combobox" aria-autocomplete="list" aria-expanded="false"/, 'Suggestion input lacks combobox semantics');
requirePattern(/role="listbox"/, 'Suggestion popup lacks listbox semantics');
requirePattern(/aria-activedescendant/, 'Combobox active option is not exposed');
requirePattern(/<button type="button" class="trip-card-open"/, 'Trip cards do not use a native button');
requirePattern(/<caption class="sr-only">Expenses for/, 'Expenses table has no accessible caption');
requirePattern(/<th scope="col">Date<\/th>/, 'Expenses columns have no header scope');

if (/outline\s*:\s*none/.test(style)) throw new Error('A focus outline is explicitly suppressed');
if (!/:focus-visible\s*\{[^}]*var\(--wp-focus-ring\)/.test(style)) throw new Error('Global focus-visible treatment is missing');
if (!/@media \(prefers-reduced-motion: reduce\)/.test(style)) throw new Error('Reduced-motion preference is not respected');
if (!/\.copy-btn\s*\{[^}]*min-width:\s*24px[^}]*min-height:\s*24px/.test(style)) throw new Error('Copy target is below 24px');

// Minimal contrast regression coverage for the pairs introduced by this pass.
function luminance(hex) {
  const rgb = hex.match(/[a-f\d]{2}/gi).map(value => parseInt(value, 16) / 255);
  const linear = rgb.map(value => value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4));
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function contrast(a, b) {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

const contrastPairs = [
  ['#5c6676', '#ffffff', 4.5, 'light muted text'],
  ['#8c97aa', '#1b212b', 4.5, 'dark muted text'],
  ['#966820', '#ffffff', 4.5, 'light accent button'],
  ['#838d9e', '#ffffff', 3, 'light form border'],
  ['#6e788c', '#1b212b', 3, 'dark form border']
];

for (const [foreground, background, minimum, label] of contrastPairs) {
  const ratio = contrast(foreground, background);
  if (ratio < minimum) throw new Error(`${label} contrast ${ratio.toFixed(2)} is below ${minimum}:1`);
}

console.log('accessibility regression checks passed');
