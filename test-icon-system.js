const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync('public/WayPoint/index.html', 'utf8');
const source = fs.readFileSync('public/WayPoint/ui/icons.js', 'utf8');
const warnings = [];
const sandbox = { window: {}, console: { warn: (...args) => warnings.push(args.join(' ')) } };
sandbox.window.console = sandbox.console;
vm.runInNewContext(source, sandbox, { filename: 'ui/icons.js' });

const system = sandbox.window.WayPointIcons;
if (!system || typeof system.render !== 'function') throw new Error('Icon registry did not initialise');

const required = [
  'brand', 'destination', 'activity', 'route', 'flight', 'rail', 'bus', 'car', 'ferry',
  'stay', 'person', 'contacts', 'companions', 'expenses', 'booking', 'overnight',
  'overview', 'plan', 'people', 'more',
  'timeline', 'date', 'time', 'map', 'settings', 'add', 'edit', 'delete', 'close',
  'forward', 'back', 'logout', 'download', 'copy', 'expand', 'collapse', 'unknown'
];
for (const name of required) {
  if (!system.names.includes(name)) throw new Error('Missing semantic icon: ' + name);
  const svg = system.render(name);
  if (!svg.includes('data-icon="' + name + '"')) throw new Error('Incorrect icon output: ' + name);
  if (!svg.includes('stroke-width="1.75"')) throw new Error('Incorrect stroke contract: ' + name);
  if (!svg.includes('aria-hidden="true"') || !svg.includes('focusable="false"')) {
    throw new Error('Decorative SVG accessibility contract missing: ' + name);
  }
}

if (!html.includes('/WayPoint/ui/icons.js')) throw new Error('Icon asset is not loaded by the app');
if (/var\s+ICONS\s*=/.test(html)) throw new Error('Obsolete inline icon registry remains');
if (/[◷□]/.test(html)) throw new Error('Text-character date/time glyph remains');
if (/\.back-link \.icon\s*\{[^}]*rotate/.test(html)) throw new Error('Back icon is still reversed in CSS');

// Every literal icon request in the app must resolve to intentional artwork.
const calls = [...html.matchAll(/icon\('([A-Za-z0-9.]+)'/g)].map(match => match[1]);
for (const name of new Set(calls)) {
  const resolved = system.resolve(name);
  if (!system.names.includes(resolved)) throw new Error('Unknown icon requested by app: ' + name);
}

// Icon-only buttons hide their SVG from assistive technology, so the button
// itself must always supply a stable accessible name.
for (const match of html.matchAll(/<button[^>]*class="[^"]*btn-icon[^"]*"[^>]*>/g)) {
  if (!/aria-label=/.test(match[0])) throw new Error('Icon-only button has no aria-label: ' + match[0]);
}

const fallback = system.render('definitely-not-an-icon');
if (!fallback.includes('data-icon="unknown"') || warnings.length !== 1) {
  throw new Error('Unknown icon fallback is not visible and diagnostic');
}

console.log('icon system regression checks passed');
