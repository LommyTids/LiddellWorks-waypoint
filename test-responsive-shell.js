const fs = require('fs');

const html = fs.readFileSync('public/WayPoint/index.html', 'utf8');
const icons = fs.readFileSync('public/WayPoint/ui/icons.js', 'utf8');

function requirePattern(pattern, message) {
  if (!pattern.test(html)) throw new Error(message);
}

// Desktop and mobile representations must coexist so the responsive shell
// never forks permissions, content rendering or record state.
requirePattern(/class="desktop-trip-nav"[^>]*aria-label="Trip sections"/, 'Desktop trip navigation is missing');
requirePattern(/class="mobile-destination-nav"[^>]*aria-label="Trip destinations"/, 'Mobile destination navigation is missing');
requirePattern(/grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\)/, 'Mobile navigation does not reserve four equal destinations');
for (const destination of ['overview', 'plan', 'people', 'more']) {
  requirePattern(new RegExp("key: '" + destination + "', label: '"), 'Missing mobile destination: ' + destination);
  if (!new RegExp(destination + ": '<").test(icons)) throw new Error('Missing mobile navigation icon: ' + destination);
}

// Compact identity and Overview hierarchy are the agreed phone shell.
requirePattern(/\.trip-header\s*\{[\s\S]*?position:\s*sticky[\s\S]*?top:\s*56px/, 'Trip header is not sticky below the mobile top bar');
requirePattern(/class="trip-date-range"/, 'Compact trip header has no date range');
requirePattern(/mobile-overview-switch/, 'Timeline and Map have no prominent mobile segmented control');
requirePattern(/body\.is-trip-view \.page/, 'Trip view does not reserve space for bottom navigation');

// More is a real directory page, and Expenses remains permission-gated.
requirePattern(/function renderMobileMoreTab\(trip\)[\s\S]*?if \(canFullyEditTrip\(trip\)\)[\s\S]*?key: 'expenses'[\s\S]*?key: 'settings'/, 'More page does not preserve Expenses permissions');
requirePattern(/destination === 'more'\) return 'more'/, 'More does not open its directory page');

// The account popover replaces narrow-screen action clutter while keeping the
// desktop controls and its keyboard/accessibility contract.
requirePattern(/class="account-desktop-actions"/, 'Desktop account actions are missing');
requirePattern(/aria-haspopup="menu" aria-expanded="' \+ String\(accountMenuOpen\)/, 'Avatar menu does not expose its expanded state');
requirePattern(/class="account-popover" role="menu"/, 'Mobile account popover is missing menu semantics');
requirePattern(/event\.key === 'Escape' && accountMenuOpen/, 'Escape does not close the account popover');
requirePattern(/\['ArrowDown', 'ArrowUp', 'Home', 'End'\]/, 'Account menu lacks arrow-key navigation');

// Destination navigation remembers child views but never exposes a filtered
// tab merely because it was stored by a more privileged session.
requirePattern(/var mobileLastTab = \{ overview: 'timeline', plan: 'destinations', people: 'companions' \}/, 'Mobile child-view memory defaults are missing');
requirePattern(/tabs\.some\(function \(tab\) \{ return tab\.key === remembered; \}\)/, 'Remembered tabs are not checked against visible permissions');
requirePattern(/action === 'switch-mobile-destination'/, 'Mobile destination action is not wired');

console.log('responsive shell regression checks passed');
