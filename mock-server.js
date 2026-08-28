// A tiny stand-in for the real Cloudflare Worker, used only to test the
// adapted frontend locally before it's deployed for real. It serves the
// static app at /WayPoint and implements the same API the real Worker
// does (backed by in-memory variables instead of KV) — including the
// per-trip ownership/grants permission system described in the big
// comment at the top of src/worker.js. This file deliberately
// re-implements that logic rather than importing worker.js directly:
// worker.js is written as a Cloudflare Worker ES module (uses Web
// Crypto, KV bindings, etc.) and isn't meant to run under plain Node —
// keeping a parallel, simplified copy here is the same tradeoff already
// made for the real flight-lookup API (see test-flight-lookup.js's own
// comment: this sandbox has no route to the real internet, so tests
// intercept that one call directly instead).
//
// Two DELIBERATE differences from the real Worker, both purely about
// running locally over plain http instead of production https — neither
// is a bug, just noted here so nobody "fixes" this file to match
// worker.js exactly and breaks every test that uses it:
//   1. The session cookie is set WITHOUT the `Secure` attribute. A real
//      browser silently refuses to store a `Secure` cookie on a
//      non-https origin, so a faithful copy would mean no test could
//      ever stay logged in.
//   2. Passwords are compared as plain text in memory rather than
//      PBKDF2-hashed. There's no real secret at stake in a throwaway
//      in-memory test server, and hashing would just slow every test
//      down for no safety benefit — the actual hashing code (see
//      hashPassword()/verifyPassword() in src/worker.js) is exercised
//      by reading that file carefully, not by this mock.
//
// Everything else — endpoint paths, request/response JSON shapes, status
// codes, per-trip permission resolution, the safe merge-save logic, and
// the "no accounts yet -> setup screen" bootstrap behavior — mirrors
// src/worker.js as closely as possible, since THAT'S what the frontend's
// auth code is actually written against. If you change how permissions
// work in src/worker.js, make the SAME change here, or these tests stop
// meaning anything.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'public/WayPoint/index.html'), 'utf-8');
let stored = { trips: [] };

// In-memory account list. Pass `--empty-users` on the command line (see
// bottom of this file) to start with NO accounts at all, so a test can
// exercise the first-run "/api/setup" bootstrap screen — every other
// test gets one pre-seeded account (see DEFAULT_ADMIN below), set up as
// the uber-user (the site owner's account — see the big "WHO IS ALLOWED
// IN" comment in src/worker.js), so it doesn't have to run through that
// setup flow itself just to log in, and so it has full access to
// whatever trips a test creates or needs to reach regardless of who
// technically owns them.
const DEFAULT_ADMIN = { id: 'admin1', username: 'admin', password: 'testpass123', isUberUser: true };
// The setup key a test's setup flow needs to supply — stands in for the
// real deployment's WAYPOINT_PASSWORD secret (see handleSetup() in
// src/worker.js).
const SETUP_KEY = 'setup-key-for-tests';

let users = process.argv.indexOf('--empty-users') === -1 ? [Object.assign({}, DEFAULT_ADMIN)] : [];

// token -> { uid } — the mock's equivalent of a signed session cookie.
// Real signing/verification (HMAC over a base64url payload) is pure
// overhead here: nothing forges cookies against a local test server, and
// what the frontend actually needs exercised is "a cookie comes back on
// login, and gets sent + checked on later requests" — a random opaque
// token in a Map does that identically from the frontend's point of view.
const sessions = {};
let nextId = 2;

function newAccountId() { return 'u' + nextId++; }
function newToken() { return crypto.randomBytes(16).toString('hex'); }

function sendJson(res, status, body, extraHeaders) {
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {}));
  res.end(JSON.stringify(body));
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach(function (part) {
    var eq = part.indexOf('=');
    if (eq === -1) return;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  });
  return out;
}

function currentUser(req) {
  const token = parseCookies(req).wp_session;
  if (!token || !sessions[token]) return null;
  return users.find(function (u) { return u.id === sessions[token].uid; }) || null;
}

// Deliberately does NOT include `isUberUser` — same "undisclosed" reason
// as publicUser() in src/worker.js: this is what OTHER accounts see
// about an account (the Manage accounts listing), and that flag is only
// ever told to an account about ITSELF (see the login/whoami/setup
// response shapes below).
function publicUser(u) {
  return { id: u.id, username: u.username, createdAt: u.createdAt || '' };
}

function countUberUsers() { return users.filter(function (u) { return u.isUberUser; }).length; }

/* ============================================================================
 * Permission resolution — a direct mirror of permissionForTrip() /
 * buildResponseState() in src/worker.js. See that file's big "SAVING
 * SAFELY" and "WHO IS ALLOWED IN" comments for the full reasoning; kept
 * terse here since it's already explained there.
 * ==========================================================================*/

function findGrant(trip, accountId) {
  return (trip.grants || []).find(function (g) { return g.accountId === accountId; }) || null;
}

function permissionForTrip(trip, user) {
  if (user.isUberUser) return { role: 'superuser' };
  if (trip.ownerId === user.id) return { role: 'superuser' };
  const grant = findGrant(trip, user.id);
  if (!grant) return null;
  if (grant.role === 'admin') return { role: 'admin' };
  if (grant.role === 'user') return { role: 'user', companionId: grant.companionId || '' };
  if (grant.role === 'viewer') return { role: 'viewer', companionId: grant.companionId || '' };
  return null;
}

function resolveGrants(trip) {
  return (trip.grants || [])
    .map(function (g) {
      const account = users.find(function (u) { return u.id === g.accountId; });
      if (!account) return null;
      return { accountId: g.accountId, username: account.username, role: g.role, companionId: g.companionId || '' };
    })
    .filter(function (g) { return g !== null; });
}

function buildResponseState(fullState, user) {
  const trips = [];
  (fullState.trips || []).forEach(function (trip) {
    const perm = permissionForTrip(trip, user);
    if (!perm) return;

    if (perm.role === 'superuser' || perm.role === 'admin') {
      const ownerAccount = users.find(function (u) { return u.id === trip.ownerId; });
      trips.push(Object.assign({}, trip, {
        myGrant: perm,
        ownerUsername: ownerAccount ? ownerAccount.username : '',
        grants: resolveGrants(trip),
      }));
      return;
    }

    const companionId = perm.companionId;
    const taggedTo = function (item) { return (item.companions || []).indexOf(companionId) !== -1; };
    const scoped = Object.assign({}, trip, {
      destinations: (trip.destinations || []).filter(taggedTo),
      activities: (trip.activities || []).filter(taggedTo),
      accommodation: (trip.accommodation || []).filter(taggedTo),
      transport: (trip.transport || []).filter(taggedTo),
      expenses: [],
      myGrant: perm,
    });
    delete scoped.ownerId;
    delete scoped.grants;
    trips.push(scoped);
  });
  return { trips: trips };
}

function stripClientOwnershipFields(trip) {
  const copy = Object.assign({}, trip);
  delete copy.ownerId;
  delete copy.grants;
  delete copy.myGrant;
  delete copy.ownerUsername;
  return copy;
}

function mergeUserScopedList(storedList, incomingList, companionId) {
  const incomingById = {};
  incomingList.forEach(function (item) { if (item && item.id) incomingById[item.id] = item; });
  const taggedTo = function (item) { return (item.companions || []).indexOf(companionId) !== -1; };
  return storedList.map(function (storedItem) {
    if (!taggedTo(storedItem)) return storedItem;
    const incomingItem = incomingById[storedItem.id];
    if (!incomingItem) return storedItem;
    if (!taggedTo(incomingItem)) return storedItem;
    return Object.assign({}, incomingItem, { id: storedItem.id, companions: storedItem.companions });
  });
}

function mergeUserScopedTrip(storedTrip, incomingTrip, companionId) {
  const merged = Object.assign({}, storedTrip);
  ['destinations', 'activities', 'accommodation', 'transport'].forEach(function (listKey) {
    merged[listKey] = mergeUserScopedList(storedTrip[listKey] || [], incomingTrip[listKey] || [], companionId);
  });
  return merged;
}

// Mirrors handlePost() in src/worker.js — see its big comment for the
// full trip-by-trip rules. Mutates and returns a brand-new `{ trips }`
// object rather than touching `stored` in place, same as the real
// Worker builds `resultTrips` before writing it back to KV in one go.
function applySafeMergeSave(storedState, submitted, user) {
  const storedTrips = storedState.trips || [];
  const storedById = {};
  storedTrips.forEach(function (t) { storedById[t.id] = t; });
  const submittedById = {};
  submitted.trips.forEach(function (t) { if (t && t.id) submittedById[t.id] = t; });

  const resultTrips = [];

  storedTrips.forEach(function (storedTrip) {
    const perm = permissionForTrip(storedTrip, user);
    const incoming = submittedById[storedTrip.id];

    if (!perm || perm.role === 'viewer') {
      resultTrips.push(storedTrip);
      return;
    }
    if (perm.role === 'superuser' || perm.role === 'admin') {
      if (!incoming) return; // Left out by a full-scope account -> deleted.
      resultTrips.push(Object.assign({}, stripClientOwnershipFields(incoming), {
        id: storedTrip.id,
        ownerId: storedTrip.ownerId,
        grants: storedTrip.grants || [],
      }));
      return;
    }
    if (!incoming) {
      resultTrips.push(storedTrip);
      return;
    }
    resultTrips.push(mergeUserScopedTrip(storedTrip, incoming, perm.companionId));
  });

  submitted.trips.forEach(function (incoming) {
    if (!incoming || !incoming.id) return;
    if (storedById[incoming.id]) return;
    resultTrips.push(Object.assign({}, stripClientOwnershipFields(incoming), {
      ownerId: user.id,
      grants: [],
    }));
  });

  return { trips: resultTrips };
}

function readJsonBody(req) {
  return new Promise(function (resolve, reject) {
    var body = '';
    req.on('data', function (chunk) { body += chunk; });
    req.on('end', function () {
      try { resolve(body ? JSON.parse(body) : {}); } catch (err) { reject(err); }
    });
  });
}

const GRANT_ROLES = ['admin', 'user', 'viewer'];

const server = http.createServer(async (req, res) => {
  const urlPath = req.url.split('?')[0];

  // ---- Auth endpoints (no session required to reach these) ------------
  if (urlPath === '/WayPoint/api/login' && req.method === 'POST') {
    let body;
    try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: 'Request body was not valid JSON.' }); }
    const username = (body.username || '').trim().toLowerCase();
    const user = users.find(function (u) { return u.username.toLowerCase() === username; });
    if (!user || user.password !== (body.password || '')) return sendJson(res, 401, { error: 'Incorrect username or password.' });
    const token = newToken();
    sessions[token] = { uid: user.id };
    return sendJson(res, 200, { status: 'ok', id: user.id, username: user.username, isUberUser: !!user.isUberUser }, { 'Set-Cookie': 'wp_session=' + token + '; Path=/WayPoint; HttpOnly; SameSite=Lax' });
  }
  if (urlPath === '/WayPoint/api/logout' && req.method === 'POST') {
    const token = parseCookies(req).wp_session;
    if (token) delete sessions[token];
    return sendJson(res, 200, { status: 'ok' }, { 'Set-Cookie': 'wp_session=; Path=/WayPoint; Max-Age=0' });
  }
  if (urlPath === '/WayPoint/api/whoami' && req.method === 'GET') {
    const user = currentUser(req);
    if (!user) return sendJson(res, 200, { loggedIn: false, setupNeeded: users.length === 0 });
    return sendJson(res, 200, { loggedIn: true, id: user.id, username: user.username, isUberUser: !!user.isUberUser });
  }
  if (urlPath === '/WayPoint/api/setup' && req.method === 'POST') {
    if (users.length > 0) return sendJson(res, 403, { error: 'Setup has already been completed — ask the site owner for an account instead.' });
    let body;
    try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: 'Request body was not valid JSON.' }); }
    if (body.setupKey !== SETUP_KEY) return sendJson(res, 401, { error: 'Incorrect setup key.' });
    if (!body.username) return sendJson(res, 400, { error: 'Choose a username.' });
    if (!body.password || body.password.length < 8) return sendJson(res, 400, { error: 'Choose a password of at least 8 characters.' });
    const user = { id: newAccountId(), username: body.username, password: body.password, isUberUser: true, createdAt: new Date().toISOString() };
    users.push(user);
    const token = newToken();
    sessions[token] = { uid: user.id };
    return sendJson(res, 200, { status: 'ok', id: user.id, username: user.username, isUberUser: true }, { 'Set-Cookie': 'wp_session=' + token + '; Path=/WayPoint; HttpOnly; SameSite=Lax' });
  }

  // ---- Everything else under /api/ needs a session ---------------------
  if (urlPath.indexOf('/WayPoint/api/') === 0) {
    const user = currentUser(req);
    if (!user) return sendJson(res, 401, { error: 'Please log in.' });

    if (urlPath === '/WayPoint/api/data' && req.method === 'GET') {
      return sendJson(res, 200, buildResponseState(stored, user));
    }
    if (urlPath === '/WayPoint/api/data' && req.method === 'POST') {
      let body;
      try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: 'Request body was not valid JSON.' }); }
      if (!body || !Array.isArray(body.trips)) return sendJson(res, 400, { error: "Request body didn't look like trip data (expected { trips: [...] })." });
      stored = applySafeMergeSave(stored, body, user);
      return sendJson(res, 200, { status: 'ok' });
    }

    // ---- Sharing a trip (grant/revoke) -- owner (or the uber-user) only,
    // mirroring handleTripGrantsUpsert()/handleTripGrantsRevoke() in
    // src/worker.js. ------------------------------------------------------
    if (urlPath === '/WayPoint/api/trip-grants' && req.method === 'POST') {
      let body;
      try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: 'Request body was not valid JSON.' }); }
      const tripId = body.tripId;
      const username = (body.username || '').trim();
      const role = body.role;
      const companionId = (body.companionId || '').trim();
      if (!tripId) return sendJson(res, 400, { error: 'No trip specified.' });
      if (!username) return sendJson(res, 400, { error: 'Enter the username to share this trip with.' });
      if (GRANT_ROLES.indexOf(role) === -1) return sendJson(res, 400, { error: 'Role must be admin, user or viewer.' });
      if ((role === 'user' || role === 'viewer') && !companionId) {
        return sendJson(res, 400, { error: "Pick which companion this person is, so their access is scoped correctly." });
      }
      const trip = (stored.trips || []).find(function (t) { return t.id === tripId; });
      if (!trip) return sendJson(res, 404, { error: 'That trip no longer exists.' });
      if (!(user.isUberUser || trip.ownerId === user.id)) {
        return sendJson(res, 403, { error: "Only this trip's owner can decide who has access to it." });
      }
      const targetAccount = users.find(function (u) { return u.username.toLowerCase() === username.toLowerCase(); });
      if (!targetAccount) return sendJson(res, 404, { error: 'No account with that username exists yet — ask the site owner to create one first.' });
      if (targetAccount.id === trip.ownerId) return sendJson(res, 400, { error: 'That account already owns this trip.' });
      if (targetAccount.isUberUser) return sendJson(res, 400, { error: 'That account already has full access to everything.' });
      if (role === 'user' || role === 'viewer') {
        const companionExists = (trip.companions || []).some(function (c) { return c.id === companionId; });
        if (!companionExists) return sendJson(res, 400, { error: "That companion isn't on this trip." });
      }
      trip.grants = (trip.grants || []).filter(function (g) { return g.accountId !== targetAccount.id; });
      trip.grants.push({ accountId: targetAccount.id, role: role, companionId: role === 'admin' ? '' : companionId });
      return sendJson(res, 200, { status: 'ok', grants: resolveGrants(trip) });
    }
    if (urlPath === '/WayPoint/api/trip-grants/revoke' && req.method === 'POST') {
      let body;
      try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: 'Request body was not valid JSON.' }); }
      const tripId = body.tripId, accountId = body.accountId;
      if (!tripId || !accountId) return sendJson(res, 400, { error: 'Missing trip or account.' });
      const trip = (stored.trips || []).find(function (t) { return t.id === tripId; });
      if (!trip) return sendJson(res, 404, { error: 'That trip no longer exists.' });
      if (!(user.isUberUser || trip.ownerId === user.id)) {
        return sendJson(res, 403, { error: "Only this trip's owner can decide who has access to it." });
      }
      trip.grants = (trip.grants || []).filter(function (g) { return g.accountId !== accountId; });
      return sendJson(res, 200, { status: 'ok' });
    }

    // ---- Account management (site owner / uber-user only) ---------------
    if (urlPath === '/WayPoint/api/users' && req.method === 'GET') {
      if (!user.isUberUser) return sendJson(res, 403, { error: "Only the site owner's account can manage logins." });
      return sendJson(res, 200, { users: users.map(publicUser) });
    }
    if (urlPath === '/WayPoint/api/users' && req.method === 'POST') {
      if (!user.isUberUser) return sendJson(res, 403, { error: "Only the site owner's account can manage logins." });
      let body;
      try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: 'Request body was not valid JSON.' }); }
      const username = (body.username || '').trim();
      if (!username) return sendJson(res, 400, { error: 'Username is required.' });
      const taken = users.some(function (u) { return u.username.toLowerCase() === username.toLowerCase() && u.id !== body.id; });
      if (taken) return sendJson(res, 409, { error: 'That username is already taken.' });
      if (body.id) {
        const existing = users.find(function (u) { return u.id === body.id; });
        if (!existing) return sendJson(res, 404, { error: 'That account no longer exists.' });
        existing.username = username;
        if (body.password) {
          if (body.password.length < 8) return sendJson(res, 400, { error: 'Choose a password of at least 8 characters.' });
          existing.password = body.password;
        }
        return sendJson(res, 200, { status: 'ok', user: publicUser(existing) });
      }
      if (!body.password || body.password.length < 8) return sendJson(res, 400, { error: 'Choose a password of at least 8 characters.' });
      const newUser = { id: newAccountId(), username: username, password: body.password, isUberUser: false, createdAt: new Date().toISOString() };
      users.push(newUser);
      return sendJson(res, 200, { status: 'ok', user: publicUser(newUser) });
    }
    if (urlPath === '/WayPoint/api/users/delete' && req.method === 'POST') {
      if (!user.isUberUser) return sendJson(res, 403, { error: "Only the site owner's account can manage logins." });
      let body;
      try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: 'Request body was not valid JSON.' }); }
      const existing = users.find(function (u) { return u.id === body.id; });
      if (!existing) return sendJson(res, 404, { error: 'That account no longer exists.' });
      if (existing.isUberUser && countUberUsers() <= 1) return sendJson(res, 400, { error: "Can't delete the last remaining site-owner account." });
      users = users.filter(function (u) { return u.id !== body.id; });
      return sendJson(res, 200, { status: 'ok' });
    }
    return sendJson(res, 404, { error: 'Not found.' });
  }

  // ---- Static files (no auth required — see src/worker.js's comment on
  // why serving the app shell openly is intentional) ---------------------
  if (req.url === '/WayPoint' || req.url === '/WayPoint/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }
  if (req.url.indexOf('/WayPoint/') === 0) {
    var relPath = req.url.slice('/WayPoint/'.length).split('?')[0];
    var filePath = path.join(__dirname, 'public/WayPoint', relPath);
    if (filePath.indexOf(path.join(__dirname, 'public/WayPoint')) === 0 && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      var ext = path.extname(filePath).toLowerCase();
      var mime = { '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.html': 'text/html' }[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime });
      res.end(fs.readFileSync(filePath));
      return;
    }
  }
  res.writeHead(404);
  res.end('not found');
});

const port = process.argv[2] || 8787;
server.listen(port, () => console.log('mock server listening on ' + port));
