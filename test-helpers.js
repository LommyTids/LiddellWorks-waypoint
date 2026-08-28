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

module.exports = { DEFAULT_ADMIN, loginAsAdmin, loginAs };
