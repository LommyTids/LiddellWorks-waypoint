// Shared helpers for the Playwright test files in this repo. Since every
// page now requires a logged-in session (see the auth system described
// in src/worker.js and mirrored by mock-server.js), every test needs to
// log in as SOMETHING before it can do anything else — this is the one
// place that login step is written, so it isn't duplicated (and doesn't
// drift) across every test file.
const DEFAULT_ADMIN = { username: 'admin', password: 'testpass123' };

// Logs in as the mock server's pre-seeded Admin account (see
// DEFAULT_ADMIN in mock-server.js) and waits for the dashboard to
// actually appear — most tests just need this once, right after
// page.goto(), before doing anything else.
async function loginAsAdmin(page) {
  await page.waitForSelector('#login-form', { timeout: 5000 });
  await page.fill('#login-form input[name="username"]', DEFAULT_ADMIN.username);
  await page.fill('#login-form input[name="password"]', DEFAULT_ADMIN.password);
  await page.click('#login-form button[type="submit"]');
  await page.waitForSelector('.empty-state, .trip-grid', { timeout: 5000 });
}

// Logs in as an arbitrary already-created account (viewer/user roles, or
// a second admin) — used by the roles/permissions tests, which create
// their own accounts via the Manage Users screen first.
async function loginAs(page, username, password) {
  await page.waitForSelector('#login-form', { timeout: 5000 });
  await page.fill('#login-form input[name="username"]', username);
  await page.fill('#login-form input[name="password"]', password);
  await page.click('#login-form button[type="submit"]');
}

// Waits for the app's own in-page trip-content save to actually finish,
// instead of guessing with a fixed page.waitForTimeout(). The app's save
// pipeline (persist() in public/WayPoint/index.html) now spaces
// consecutive /WayPoint/api/data saves at least MIN_SAVE_INTERVAL_MS
// (1.1s) apart and retries a 429 with backoff, to respect Cloudflare
// KV's one-write-per-second-per-key limit — a change added on the
// `security-fixes` branch, after most of this file's fixed short waits
// were originally written. A save can now genuinely take well over a
// second, so a 80-150ms guess is no longer reliably enough time for a
// companion/trip/grant change to have actually reached the mock server
// — which matters here specifically because several assertions below
// either reload the page or make a raw fetch() straight to the mock
// server afterward, either of which needs the save to have REALLY
// landed, not just for the browser's own optimistic UI to look right.
//
// saveInFlight/pendingSaveState are plain top-level `var`s in that
// inline script, so (being no module) they're already properties of
// `window` — this just polls the exact same two flags the app's own
// internal waitForSaveToSettle() polls, from the Node/Playwright side.
// If no save is in flight when this is called, it resolves on its very
// first check — so it's safe to await after ANY action, not just ones
// that are known to trigger a save.
async function waitForSaveToSettle(page, timeoutMs) {
  await page.waitForFunction(
    function () { return !window.saveInFlight && !window.pendingSaveState; },
    null,
    { timeout: timeoutMs || 10000 }
  );
}

// The companion-link form (#companion-link-form / #add-linked-companion-
// form, submitCompanionAccess()/submitAddLinkedCompanion() in
// public/WayPoint/index.html) does NOT go through persist()'s
// saveInFlight/pendingSaveState queue at all -- it AWAITS its own
// fetch() calls straight to /api/companions/link and /api/trip-grants
// (or /revoke), then only calls closeModal() once every one of those
// has actually finished. So waitForSaveToSettle() above (which polls
// those two persist()-only flags) can return long before this form's
// real work is done -- for this form specifically, the form element
// itself being removed from the DOM (closeModal() sets #modal-root's
// innerHTML to '') IS the actual completion signal.
async function waitForModalToClose(page, formSelector, timeoutMs) {
  await page.waitForSelector(formSelector, { state: 'detached', timeout: timeoutMs || 10000 });
}

module.exports = { DEFAULT_ADMIN, loginAsAdmin, loginAs, waitForSaveToSettle, waitForModalToClose };
