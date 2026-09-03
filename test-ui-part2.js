const fs = require('fs');

const html = fs.readFileSync('public/WayPoint/index.html', 'utf8');
const worker = fs.readFileSync('src/worker.js', 'utf8');
const icons = fs.readFileSync('public/WayPoint/ui/icons.js', 'utf8');

function requireText(source, pattern, message) {
  if (!pattern.test(source)) throw new Error(message);
}

function rejectText(source, pattern, message) {
  if (pattern.test(source)) throw new Error(message);
}

// System feedback and data-safety contract.
requireText(html, /var appLoadState = 'loading'/, 'missing explicit loading state');
requireText(html, /function editingAvailable\(\)/, 'missing central edit lock');
requireText(html, /window\.addEventListener\('offline'/, 'missing offline listener');
requireText(html, /function retryConnection\(options\)/, 'missing reconnect path');
requireText(html, /stateIsTrustworthy = false;[\s\S]{0,500}updateSystemFeedback\(\)/, 'save failure must lock editing');
requireText(html, /function showFormError\(/, 'validation errors must remain field-associated');
requireText(html, /Connection restored\. Your trips are up to date\./, 'connection events may use a global toast');
rejectText(html, /showToast\('(?:Account saved|Account deleted|Avatar saved|Currency settings saved|Copied)'\)/, 'ordinary success must not use a toast');

// Responsive expense ledger contract.
requireText(html, /\.expense-ledger \{ display: none; \}/, 'mobile ledger should be a separate responsive view');
requireText(html, /@media \(max-width: 640px\)[\s\S]*\.expense-table \{ display: none; \}[\s\S]*\.expense-ledger \{ display: block; \}/, 'mobile must replace the wide table');
requireText(html, /lines\.slice\(\)\.reverse\(\)/, 'mobile ledger must begin newest first');
requireText(html, /expense-ledger-amount-label">Native/, 'native amount is missing');
requireText(html, /expense-ledger-amount-label">Home/, 'home-currency amount is missing');

// Map consolidation contract.
['--wp-map-destination', '--wp-map-transport', '--wp-map-accommodation', '--wp-map-activity'].forEach((token) => requireText(html, new RegExp(token), 'missing map token ' + token));
requireText(html, /--wp-color-map-blue-dark/, 'missing dark map variants');
requireText(html, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/, 'mobile map layers must use a 2x2 grid');
requireText(html, /data-action="reset-map-view"/, 'missing persistent map reset');
requireText(html, /function resetMapView\(trip\)/, 'missing map reset behaviour');
requireText(html, /map-range-slider\.labels-overlap/, 'range labels must resolve collisions');
requireText(html, /function mapUnmappedRecords\(trip\)/, 'missing unmapped-record recovery list');

// Settings, exceptional states and cleanup contract.
requireText(worker, /\/WayPoint\/api\/site-status/, 'missing protected site-status endpoint');
requireText(worker, /!!env\.AERODATABOX_API_KEY/, 'site status must reveal only configuration presence');
requireText(html, /function renderSiteSettingsView\(\)/, 'missing Superuser site settings');
requireText(html, /<h3>Currency<\/h3>/, 'trip settings missing Currency group');
requireText(html, /<h3>Access<\/h3>/, 'trip settings missing Access group');
requireText(html, /<h3>Danger zone<\/h3>/, 'trip settings missing Danger group');
requireText(html, /function emptyStateHtml\(/, 'missing reusable exceptional-state component');
['saved', 'loading', 'offline', 'readonly'].forEach((name) => requireText(icons, new RegExp('\\b' + name + ':'), 'missing status icon ' + name));
['day-areas', 'area-chip', 'event-row', 'event-time', 'event-main', 'event-title', 'event-sub'].forEach((name) => rejectText(html, new RegExp('\\.' + name + '\\s*\\{'), 'obsolete selector remains: ' + name));

console.log('UI overhaul part 2 regression checks passed');
