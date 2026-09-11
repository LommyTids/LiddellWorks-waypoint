// Execute each production application file as a separate classic script, in
// document order. Concatenating them would hide cross-file hoisting mistakes.
// The DOM/API doubles cover startup only; Leaflet layout, events and saves are
// exercised in test-asset-loading.js with real browsers.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadAppSources } = require('./test-source');

const { scripts, appScripts } = loadAppSources();
assert(appScripts.length > 1, 'Expected application feature scripts');
assert.equal(appScripts[0].src, '/WayPoint/js/core.js', 'Core must execute first');
assert.equal(appScripts.at(-1).src, '/WayPoint/js/boot.js', 'Boot must execute last');
assert.equal(new Set(appScripts.map(script => script.filename)).size, appScripts.length, 'Application scripts must not execute twice');
for (const script of appScripts) {
  assert(!/\b(?:async|defer)\b/i.test(script.attributes), script.src + ' must execute synchronously');
  assert(!/\btype\s*=/i.test(script.attributes), script.src + ' must remain a classic script');
}
function applicationFiles(directory) {
  return fs.readdirSync(path.join(__dirname, directory), { withFileTypes: true }).flatMap(entry => {
    const file = directory + '/' + entry.name;
    return entry.isDirectory() ? applicationFiles(file) : entry.name.endsWith('.js') ? [file] : [];
  });
}
assert.deepEqual(appScripts.map(script => script.filename).sort(), applicationFiles('public/WayPoint/js').sort(),
  'Every application JS file must be referenced and parsed by the production document');

function element() {
  const classes = new Set();
  return {
    innerHTML: '', textContent: '', dataset: {}, children: [],
    style: { setProperty() {} },
    classList: {
      add(name) { classes.add(name); }, remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); },
      toggle(name, force) { if (force) classes.add(name); else classes.delete(name); }
    },
    querySelectorAll() { return []; }, querySelector() { return null; },
    setAttribute() {}, getAttribute() { return null; },
    getBoundingClientRect() { return { height: 0 }; }, focus() {}
  };
}

async function startup(loggedIn) {
  const elements = new Map(['brand-icon', 'account-bar', 'system-banner', 'app', 'modal-root',
    'toast-root', 'save-indicator', 'main-content', 'polite-status'].map(id => [id, element()]));
  const listeners = new Set(), requests = [];
  const document = {
    body: element(), documentElement: element(),
    getElementById(id) { return elements.get(id) || null; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener(name) { listeners.add(name); }
  };
  const context = vm.createContext({
    console, document, navigator: { onLine: true },
    URL, URLSearchParams, AbortController,
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    MutationObserver: class { observe() {} }, ResizeObserver: class { observe() {} },
    getComputedStyle() { return { getPropertyValue() { return ''; } }; },
    requestAnimationFrame() {}, setTimeout() {}, clearTimeout() {},
    addEventListener(name) { listeners.add(name); },
    // The vendored Leaflet script needs a real DOM. Startup should never create
    // a map while rendering login or the dashboard; any eager L.* use fails.
    L: {},
    async fetch(url) {
      requests.push(url);
      if (url === '/WayPoint/api/whoami') return {
        ok: true, async json() { return { loggedIn, id: 'synthetic-user', username: 'Synthetic', isUberUser: true }; }
      };
      if (url === '/WayPoint/api/data' && loggedIn) return {
        ok: true, async json() { return { trips: [] }; }
      };
      throw new Error('Unexpected startup request: ' + url);
    }
  });
  context.window = context;
  const pending = [], deferred = [];
  function execute(script) {
    const result = vm.runInContext(script.code, context, { filename: script.filename, timeout: 2000 });
    if (result && typeof result.then === 'function') pending.push(result);
  }
  for (const script of scripts) {
    if (script.filename.includes('/vendor/')) continue;
    if (/\bdefer\b/i.test(script.attributes)) deferred.push(script);
    else execute(script);
  }
  deferred.forEach(execute);
  await Promise.all(pending);
  assert(elements.get('brand-icon').innerHTML.includes('<svg'), 'Brand icon did not initialize');
  assert(listeners.has('click') && listeners.has('submit') && listeners.has('online'), 'Event handlers did not initialize');
  assert.equal(typeof context.render, 'function');
  assert.equal(typeof context.initMap, 'function');
  if (loggedIn) {
    assert.deepEqual(requests, ['/WayPoint/api/whoami', '/WayPoint/api/data']);
    assert.equal(context.appLoadState, 'ready');
    assert.equal(context.stateIsTrustworthy, true);
    assert(elements.get('app').innerHTML.includes('No trips yet'), 'Authenticated startup did not render the dashboard');
  } else {
    assert.deepEqual(requests, ['/WayPoint/api/whoami']);
    assert(elements.get('app').innerHTML.includes('id="login-form"'), 'Signed-out startup did not render login');
  }
}

(async () => {
  await startup(false);
  await startup(true);
  console.log('Separate-script loading order, login and dashboard startup checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
