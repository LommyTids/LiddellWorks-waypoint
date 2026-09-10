// A tiny stand-in for the real Cloudflare Worker, used to test the
// frontend locally. Serves the static app at /WayPoint and implements the
// same API as the real Worker (in-memory instead of KV) — including the
// per-trip ownership/grants permission system and the index/per-trip
// storage split described at the top of src/worker.js. Re-implements that
// logic rather than importing worker.js directly, since worker.js is a
// Cloudflare Worker ES module (Web Crypto, KV bindings) that isn't meant
// to run under plain Node — the same tradeoff test-flight-lookup.js makes
// for the flight-lookup API (no real internet in this sandbox).
//
// Three deliberate differences from the real Worker, noted so nobody
// "fixes" this file to match worker.js exactly and breaks every test:
//   1. The session cookie has no `Secure` attribute — a real browser
//      refuses to store a Secure cookie on non-https, which would break
//      every test's login.
//   2. Passwords are compared as plain text, not PBKDF2-hashed — no real
//      secret is at stake in a throwaway in-memory server, and hashing
//      code (hashPassword()/verifyPassword() in src/worker.js) is
//      exercised by reading that file, not by this mock.
//   3. This mock never runs the legacy "state" -> index/content migration
//      (ensureMigrated() in src/worker.js) — there's no old data to
//      migrate in a server that always starts empty; migration logic is
//      likewise exercised by reading src/worker.js.
//
// Also adds two endpoints the real Worker doesn't have, under an obvious
// `/api/__` prefix, so tests can see otherwise-invisible state: `__writes`
// (how many times each trip's content/index has been written) and
// `__hide-content` (make one trip's content unreadable while its index
// entry stays, reproducing a state KV can reach on its own). See their
// own comments below, and test-storage-safety.js.
//
// Everything else — endpoint paths, JSON shapes, status codes, permission
// resolution, the storage split, schema field names, the safe merge-save
// logic, and the multi-delete safety pass — mirrors src/worker.js as
// closely as possible, since that's what the frontend is actually written
// against. Change permissions or storage in src/worker.js, make the same
// change here, or these tests stop meaning anything: `isUberUser` once
// went missing from the real Worker's login responses while this file
// still had it, and nothing caught it until production — which is why
// test-auth-roles.js now asserts that flag explicitly.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'public/WayPoint/index.html'), 'utf-8');

// ---- Trip storage: mirrors the real Worker's index + per-trip-content
// split (see "HOW TRIPS ARE STORED" in src/worker.js). `tripIndex` holds
// just enough per trip to render the dashboard and resolve permissions
// (tripId, name, dates, homeCurrency, ownerId, grants); `tripContents`
// maps tripId -> full content (destinations, activities, transport,
// accommodation, contacts, expenses, companions, notes, currencyRates,
// geocodeCache). No KV-style write-rate limit in-memory, but keeping the
// shape identical to production is what makes this a meaningful test double.
let tripIndex = { trips: [] };
let tripContents = {}; // tripId -> content object

// In-memory account list. Pass `--empty-users` to start with none, so a
// test can exercise the first-run "/api/setup" bootstrap screen — every
// other test gets one pre-seeded uber-user account (DEFAULT_ADMIN below,
// see "WHO IS ALLOWED IN" in src/worker.js) with full access to whatever
// trips it creates or needs, without running through setup itself.
const DEFAULT_ADMIN = { id: 'admin1', username: 'admin', password: 'testpass123', isUberUser: true };
// Stands in for the real deployment's WAYPOINT_PASSWORD secret (see
// handleSetup() in src/worker.js).
const SETUP_KEY = 'setup-key-for-tests';

let users = process.argv.indexOf('--empty-users') === -1 ? [Object.assign({}, DEFAULT_ADMIN)] : [];

// token -> { uid } — the mock's equivalent of a signed session cookie.
// Real HMAC signing is pure overhead here: nothing forges cookies against
// a local test server, and a random opaque token in a Map exercises "a
// cookie comes back on login and is sent + checked later" identically.
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
 * COMPANIONS & AVATARS — a direct mirror of the big comment of the same
 * name near AVATAR_COLOR_TOKENS in src/worker.js. Short version: every
 * account gets a self-picked coloured circle + animal; every companion
 * NOT linked to an account gets a fixed grey circle + a chosen-colour
 * smiley. The link lives on the companion (`accountId`), resolved by a
 * plain local lookup (resolveCompanionAvatars() below) — and, because a
 * companion is part of a trip's regular content (something even a "user"
 * grant gets to submit changes to), `accountId` is treated as a
 * server-computed, protected field exactly like `ownerId`/`tripId` — see
 * reconcileCompanionAccountLinks() below, and src/worker.js for the full
 * reasoning. ==========================================================*/

const AVATAR_COLOR_TOKENS = ['red', 'orange', 'amber', 'green', 'teal', 'cyan', 'blue', 'indigo', 'purple', 'pink'];
const AVATAR_ANIMAL_TOKENS = ['penguin', 'lion', 'fox', 'owl', 'panda', 'koala', 'tiger', 'elephant', 'giraffe', 'rabbit', 'bear', 'wolf', 'cat', 'dog', 'monkey', 'dolphin'];
const SUPERUSER_PARTICIPANT_ID = '__trip_superuser__';

function isValidAvatarColor(token) { return AVATAR_COLOR_TOKENS.indexOf(token) !== -1; }
function isValidAvatarAnimal(token) { return AVATAR_ANIMAL_TOKENS.indexOf(token) !== -1; }

// Mirrors deterministicIndex() in src/worker.js exactly (and
// deterministicAvatarIndex() in public/WayPoint/data/avatars.js) — a
// stable "what would this default to" fallback so a marker never renders
// blank before someone actually picks a colour/animal.
function deterministicIndex(seed, listLength) {
  let hash = 0;
  const text = String(seed || '');
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  }
  return hash % listLength;
}

function resolveAccountAvatar(account) {
  const saved = account && account.avatar;
  const color = (saved && isValidAvatarColor(saved.color)) ? saved.color : AVATAR_COLOR_TOKENS[deterministicIndex(account && account.id, AVATAR_COLOR_TOKENS.length)];
  const animal = (saved && isValidAvatarAnimal(saved.animal)) ? saved.animal : AVATAR_ANIMAL_TOKENS[deterministicIndex((account && account.id) + ':animal', AVATAR_ANIMAL_TOKENS.length)];
  return { color: color, animal: animal };
}

function resolveSuperuserParticipant(indexEntry) {
  const account = users.find(function (u) { return u.id === indexEntry.ownerId; }) ||
    users.find(function (u) { return u.isUberUser; });
  if (!account) return null;
  const avatar = resolveAccountAvatar(account);
  return {
    participantId: SUPERUSER_PARTICIPANT_ID,
    name: account.username,
    avatar: { type: 'account', color: avatar.color, animal: avatar.animal },
  };
}

function resolveCompanionAvatars(content) {
  const map = {};
  ((content && content.companions) || []).forEach(function (c) {
    if (c.accountId) {
      const account = users.find(function (u) { return u.id === c.accountId; });
      if (account) {
        const avatar = resolveAccountAvatar(account);
        map[c.companionId] = { type: 'account', color: avatar.color, animal: avatar.animal };
        return;
      }
    }
    const savedSmiley = c.avatar && c.avatar.smiley;
    const color = isValidAvatarColor(savedSmiley) ? savedSmiley : AVATAR_COLOR_TOKENS[deterministicIndex(c.companionId, AVATAR_COLOR_TOKENS.length)];
    map[c.companionId] = { type: 'smiley', color: color };
  });
  return map;
}

// Mirrors resolveCompanionAccessLevels() in src/worker.js exactly — see
// that file's big comment for the full reasoning. "Guest" (no login) vs
// "Companion" (has one) is just product vocabulary for whether
// `accountId` is set; what THIS resolves is a linked Companion's actual
// access LEVEL on this trip (Super/Admin/User/Viewer, i.e. exactly what
// permissionForTrip() would compute if that linked account were the one
// asking), by calling permissionForTrip() for their account instead of
// the caller's. Unlike `grants`, this map is sent to every role that can
// see the trip at all -- it only ever reveals a role level, never an
// accountId or username.
function resolveCompanionAccessLevels(indexEntry, content) {
  const map = {};
  ((content && content.companions) || []).forEach(function (c) {
    if (!c.accountId) return; // A Guest has no login, so no access level to show.
    const account = users.find(function (u) { return u.id === c.accountId; });
    if (!account) return; // Linked account has since been deleted -- nothing to resolve.
    const perm = permissionForTrip(indexEntry, account);
    if (perm) map[c.companionId] = perm.role;
  });
  return map;
}

// Mirrors reconcileCompanionAccountLinks() in src/worker.js exactly — see
// that file's comment for the full "why reassert rather than delete"
// reasoning. Every companion keeps EXACTLY the accountId it already has
// in storage, no matter what the client submitted for it.
function reconcileCompanionAccountLinks(storedContent, incomingCompanions) {
  const storedAccountIdByCompanionId = {};
  ((storedContent && storedContent.companions) || []).forEach(function (c) {
    storedAccountIdByCompanionId[c.companionId] = c.accountId || null;
  });
  return (incomingCompanions || []).map(function (c) {
    const copy = Object.assign({}, c);
    const real = Object.prototype.hasOwnProperty.call(storedAccountIdByCompanionId, c.companionId)
      ? storedAccountIdByCompanionId[c.companionId]
      : null;
    if (real) copy.accountId = real; else delete copy.accountId;
    return copy;
  });
}

// Mirrors assignCompanionAccountId() in src/worker.js exactly.
function assignCompanionAccountId(content, companionId, accountId) {
  (content.companions || []).forEach(function (c) {
    if (accountId && c.accountId === accountId && c.companionId !== companionId) {
      delete c.accountId;
    }
  });
  const target = (content.companions || []).find(function (c) { return c.companionId === companionId; });
  if (!target) return content;
  if (accountId) target.accountId = accountId; else delete target.accountId;
  return content;
}

/* ============================================================================
 * Permission resolution + trip storage helpers — a direct mirror of the
 * equivalents in src/worker.js (permissionForTrip(), resolveGrants(),
 * buildVisibleTrip(), buildResponseState()). See that file's big "SAVING
 * SAFELY", "WHO IS ALLOWED IN" and "HOW TRIPS ARE STORED" comments for the
 * full reasoning; kept terse here since it's already explained there.
 * ==========================================================================*/

// `indexEntry` is one entry from `tripIndex.trips` — has tripId/ownerId/
// grants, NOT the trip's actual content (that's looked up separately from
// `tripContents` by tripId, same split as loadTripIndex()/loadTripContent()
// in src/worker.js).
function findGrant(indexEntry, accountId) {
  return (indexEntry.grants || []).find(function (g) { return g.accountId === accountId; }) || null;
}

function permissionForTrip(indexEntry, user) {
  if (user.isUberUser) return { role: 'superuser' };
  if (indexEntry.ownerId === user.id) return { role: 'superuser' };
  const grant = findGrant(indexEntry, user.id);
  if (!grant) return null;
  if (grant.role === 'admin') return { role: 'admin' };
  if (grant.role === 'user') return { role: 'user', companionId: grant.companionId || '' };
  if (grant.role === 'viewer') return { role: 'viewer', companionId: grant.companionId || '' };
  return null;
}

function resolveGrants(indexEntry) {
  return (indexEntry.grants || [])
    .map(function (g) {
      const account = users.find(function (u) { return u.id === g.accountId; });
      if (!account) return null;
      return { accountId: g.accountId, username: account.username, role: g.role, companionId: g.companionId || '' };
    })
    .filter(function (g) { return g !== null; });
}

// Combines an index entry's bookkeeping (ownerId/grants, or a scoped view
// of neither) with that trip's own content, into the full trip object the
// frontend expects for one visible trip. Mirrors buildVisibleTrip() in
// src/worker.js exactly.
function buildVisibleTrip(indexEntry, content, perm) {
  // Resolved once, shared by both branches -- see the COMPANIONS &
  // AVATARS comment above for why this is safe to hand to every role.
  const companionAvatars = resolveCompanionAvatars(content);
  const companionAccessLevels = resolveCompanionAccessLevels(indexEntry, content);
  const superuserParticipant = resolveSuperuserParticipant(indexEntry);

  if (perm.role === 'superuser' || perm.role === 'admin') {
    const ownerAccount = users.find(function (u) { return u.id === indexEntry.ownerId; });
    return Object.assign({ tripId: indexEntry.tripId }, content, {
      ownerId: indexEntry.ownerId,
      myGrant: perm,
      ownerUsername: ownerAccount ? ownerAccount.username : '',
      grants: resolveGrants(indexEntry),
      companionAvatars: companionAvatars,
      companionAccessLevels: companionAccessLevels,
      superuserParticipant: superuserParticipant,
    });
  }

  // "user" / "viewer": scoped to their own tagged items only.
  const companionId = perm.companionId;
  const taggedTo = function (item) { return (item.companions || []).indexOf(companionId) !== -1; };
  return Object.assign({ tripId: indexEntry.tripId }, content, {
    destinations: (content.destinations || []).filter(taggedTo),
    activities: (content.activities || []).filter(taggedTo),
    accommodation: (content.accommodation || []).filter(taggedTo),
    transport: (content.transport || []).filter(taggedTo),
    expenses: [],
    myGrant: perm,
    companionAvatars: companionAvatars,
    companionAccessLevels: companionAccessLevels,
    superuserParticipant: superuserParticipant,
    // A scoped grant never sees raw accountId on a companion -- same
    // reason it never sees `grants` -- see buildVisibleTrip() in
    // src/worker.js. companionAccessLevels is different -- it's sent here
    // too, deliberately, since it only ever reveals a role LEVEL, never
    // an accountId or username -- see resolveCompanionAccessLevels()'s
    // own comment above.
    companions: (content.companions || []).map(function (c) {
      const copy = Object.assign({}, c);
      delete copy.accountId;
      return copy;
    }),
  });
  // No ownerId/grants added at all for a scoped account -- see the class
  // comment on buildVisibleTrip() in src/worker.js: a scoped account has
  // no business knowing who else has access to a trip they can barely
  // see into themselves.
}

function buildResponseState(user) {
  const trips = [];
  tripIndex.trips.forEach(function (indexEntry) {
    const perm = permissionForTrip(indexEntry, user);
    if (!perm) return; // Invisible entirely.
    const content = tripContents[indexEntry.tripId];
    if (!content) return; // Index says it exists but content's missing -- shouldn't happen, skip rather than crash.
    trips.push(buildVisibleTrip(indexEntry, content, perm));
  });
  return { trips: trips };
}

// Never let a client-submitted trip smuggle its own idea of who owns it,
// who it's shared with, or its permission into storage -- those fields
// only exist in a GET response as a UI convenience and are always
// recomputed server-side. Also strips tripId, which lives in the
// index/storage key. Mirrors stripClientOwnershipFields() in src/worker.js.
function stripClientOwnershipFields(trip) {
  const copy = Object.assign({}, trip);
  delete copy.tripId;
  delete copy.ownerId;
  delete copy.grants;
  delete copy.myGrant;
  delete copy.ownerUsername;
  delete copy.superuserParticipant;
  return copy;
}

// Which id field each of a trip's item lists uses -- see the "SCHEMA
// NOTE" comment near the top of src/worker.js. Centralised here so
// mergeUserScopedList() stays generic across all four list types rather
// than needing a copy of itself per type. Mirrors listItemIdField() in
// src/worker.js.
function listItemIdField(listKey) {
  return {
    destinations: 'destinationId',
    activities: 'activityId',
    accommodation: 'accommodationId',
    transport: 'transportId',
  }[listKey];
}

function mergeUserScopedList(storedList, incomingList, companionId, idField) {
  const incomingById = {};
  incomingList.forEach(function (item) { if (item && item[idField]) incomingById[item[idField]] = item; });
  const taggedTo = function (item) { return (item.companions || []).indexOf(companionId) !== -1; };
  return storedList.map(function (storedItem) {
    if (!taggedTo(storedItem)) return storedItem;
    const incomingItem = incomingById[storedItem[idField]];
    if (!incomingItem) return storedItem;
    if (!taggedTo(incomingItem)) return storedItem;
    // Apply their edits, but the item's own id/companions always stay as
    // stored -- a "user" grant can change an item's OTHER fields, never
    // which item it is or who it's tagged to.
    const applied = Object.assign({}, incomingItem);
    applied[idField] = storedItem[idField];
    applied.companions = storedItem.companions;
    return applied;
  });
  // Any id present in `incomingList` but not in `storedList` (a brand-new
  // item) is silently dropped here -- a "user" grant can't create items,
  // only edit ones that already exist and are already theirs.
}

function mergeUserScopedTrip(storedContent, incomingContent, companionId) {
  // `storedContent` can legitimately be missing -- an index entry whose
  // content couldn't be found. Mirrors the same guard in src/worker.js.
  const stored = storedContent || {};
  const merged = Object.assign({}, stored); // Start from stored truth.
  ['destinations', 'activities', 'accommodation', 'transport'].forEach(function (listKey) {
    merged[listKey] = mergeUserScopedList(stored[listKey] || [], incomingContent[listKey] || [], companionId, listItemIdField(listKey));
  });
  // Phase 3 of Companions/Avatars: a "user" grant may APPEND a brand-new
  // companion, but can't touch an existing one -- see
  // mergeUserScopedCompanions() below and its counterpart in
  // src/worker.js for the full reasoning.
  merged.companions = mergeUserScopedCompanions(stored.companions, incomingContent.companions);
  return merged;
}

const MAX_COMPANIONS_PER_TRIP = 100; // Mirrors src/worker.js -- sanity backstop, not a real limit.

// Mirrors mergeUserScopedCompanions() in src/worker.js exactly.
function mergeUserScopedCompanions(storedCompanions, incomingCompanions) {
  const stored = storedCompanions || [];
  const storedIds = {};
  stored.forEach(function (c) { storedIds[c.companionId] = true; });

  const appended = [];
  const seenNewIds = {};
  (incomingCompanions || []).forEach(function (c) {
    if (!c || !c.companionId) return;
    if (storedIds[c.companionId]) return;
    if (seenNewIds[c.companionId]) return;
    if (stored.length + appended.length >= MAX_COMPANIONS_PER_TRIP) return;
    const name = String(c.name || '').trim().slice(0, 80);
    if (!name) return;
    seenNewIds[c.companionId] = true;
    const sanitized = { companionId: c.companionId, name: name };
    const smiley = c.avatar && c.avatar.smiley;
    if (isValidAvatarColor(smiley)) sanitized.avatar = { smiley: smiley };
    appended.push(sanitized);
  });
  return stored.concat(appended);
}

// Counts how many times each trip's content, and the shared index, was
// actually written. A test affordance (exposed via /WayPoint/api/__writes
// below) that makes the storage split's core claim -- "saving trip A
// doesn't touch trip B's key" -- verifiable, since every response looks
// identical whether a write was skipped or not. See test-storage-writes.js.
let writeCounts = { index: 0, trips: {} };

function writeTripContent(tripId, content) {
  // Mirrors src/worker.js's "only write a trip's content key when its
  // content actually changed" comparison. Keeping the skip here (rather
  // than always writing, which would be simpler for an in-memory store)
  // is what lets the tests verify that behavior at all.
  if (JSON.stringify(tripContents[tripId] === undefined ? null : tripContents[tripId]) === JSON.stringify(content)) return;
  tripContents[tripId] = content;
  writeCounts.trips[tripId] = (writeCounts.trips[tripId] || 0) + 1;
}

// Mirrors handlePost() in src/worker.js — see its big comment for the
// full trip-by-trip rules. Mutates `tripIndex`/`tripContents` in place,
// same as the real Worker rewrites the index KV key and any changed
// "trip:<id>" content keys. Returns null on success, or
// { status, error } if the save was rejected outright (in which case
// nothing has been changed).
function applySafeMergeSave(submitted, user) {
  const indexById = {};
  tripIndex.trips.forEach(function (t) { indexById[t.tripId] = t; });
  const submittedById = {};
  submitted.trips.forEach(function (t) { if (t && t.tripId) submittedById[t.tripId] = t; });

  // ---- SAFETY PASS: mirrors the identically-named pass in
  // src/worker.js's handlePost() — see that file for the full reasoning.
  // Works out what this save would DELETE before changing anything, so a
  // browser working from a stale or failed-to-load copy of the data can't
  // wipe out trips by simply omitting them.
  const contentMissingForTripId = {};
  const plannedDeletions = [];
  tripIndex.trips.forEach(function (indexEntry) {
    if (submittedById[indexEntry.tripId]) return;
    const perm = permissionForTrip(indexEntry, user);
    if (!perm || perm.role === 'viewer' || perm.role === 'user') return;
    if (tripContents[indexEntry.tripId] === undefined) {
      contentMissingForTripId[indexEntry.tripId] = true;
      return;
    }
    plannedDeletions.push(indexEntry.tripId);
  });
  if (plannedDeletions.length > 1) {
    return {
      status: 409,
      error: 'That save would have deleted ' + plannedDeletions.length + ' trips at once, which the app never does on purpose — ' +
        'so it was rejected and nothing was changed. This usually means this page\'s copy of your trips is out of date ' +
        'or failed to load. Refresh the page and try your change again.',
    };
  }

  let indexChanged = false;
  const nextIndexTrips = [];

  // ---- Every EXISTING trip: apply exactly what this account's REAL
  // permission on it (from the stored index) allows. ----
  tripIndex.trips.forEach(function (indexEntry) {
    const perm = permissionForTrip(indexEntry, user);
    const incoming = submittedById[indexEntry.tripId];

    if (!perm || perm.role === 'viewer') {
      // No access, or read-only: completely untouched.
      nextIndexTrips.push(indexEntry);
      return;
    }

    if (perm.role === 'superuser' || perm.role === 'admin') {
      if (!incoming) {
        if (contentMissingForTripId[indexEntry.tripId]) {
          // Content couldn't be found, so the browser was never shown
          // this trip and its absence means nothing -- keep it.
          nextIndexTrips.push(indexEntry);
          return;
        }
        // Left out by a full-scope account -> deleted.
        delete tripContents[indexEntry.tripId];
        indexChanged = true;
        return;
      }
      const newContent = stripClientOwnershipFields(incoming);
      // A companion's accountId is protected exactly like ownerId/tripId
      // -- see the COMPANIONS & AVATARS comment above and
      // reconcileCompanionAccountLinks() in src/worker.js for why even a
      // full-scope save can't be trusted to carry it through unmodified.
      if (newContent.companions) {
        newContent.companions = reconcileCompanionAccountLinks(tripContents[indexEntry.tripId], newContent.companions);
      }
      writeTripContent(indexEntry.tripId, newContent);
      const nextEntry = Object.assign({}, indexEntry, {
        name: newContent.name || '',
        startDate: newContent.startDate || '',
        endDate: newContent.endDate || '',
        homeCurrency: newContent.homeCurrency || '',
        // ownerId/grants deliberately NOT taken from newContent -- see
        // handlePost() in src/worker.js for why.
      });
      if (JSON.stringify(nextEntry) !== JSON.stringify(indexEntry)) indexChanged = true;
      nextIndexTrips.push(nextEntry);
      return;
    }

    // perm.role === 'user': scoped read/write.
    if (!incoming) {
      // A "user" grant can't delete the trip -- leave it exactly as it was.
      nextIndexTrips.push(indexEntry);
      return;
    }
    const storedContent = tripContents[indexEntry.tripId];
    writeTripContent(indexEntry.tripId, mergeUserScopedTrip(storedContent, incoming, perm.companionId));
    nextIndexTrips.push(indexEntry); // A "user" grant never changes name/dates/ownership.
  });

  // ---- Anything submitted that ISN'T an existing trip id is brand new --
  // any logged-in account may create one, becoming its Superuser. ----
  const createdTripIds = {};
  submitted.trips.forEach(function (incoming) {
    if (!incoming || !incoming.tripId) return;
    if (indexById[incoming.tripId]) return; // Already handled above.
    if (createdTripIds[incoming.tripId]) return; // Same new id listed twice.
    createdTripIds[incoming.tripId] = true;
    const newContent = stripClientOwnershipFields(incoming);
    // A brand-new trip has no stored content yet -- every companion on it
    // gets accountId stripped, same reasoning as src/worker.js.
    if (newContent.companions) {
      newContent.companions = reconcileCompanionAccountLinks(null, newContent.companions);
    }
    writeTripContent(incoming.tripId, newContent);
    nextIndexTrips.push({
      tripId: incoming.tripId,
      name: newContent.name || '',
      startDate: newContent.startDate || '',
      endDate: newContent.endDate || '',
      homeCurrency: newContent.homeCurrency || '',
      ownerId: user.id,
      grants: [],
    });
    indexChanged = true;
  });

  if (indexChanged) {
    tripIndex = { trips: nextIndexTrips };
    writeCounts.index += 1;
  }
  return null;
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
    return sendJson(res, 200, { status: 'ok', id: user.id, username: user.username, isUberUser: !!user.isUberUser, avatar: resolveAccountAvatar(user) }, { 'Set-Cookie': 'wp_session=' + token + '; Path=/WayPoint; HttpOnly; SameSite=Lax' });
  }
  if (urlPath === '/WayPoint/api/logout' && req.method === 'POST') {
    const token = parseCookies(req).wp_session;
    if (token) delete sessions[token];
    return sendJson(res, 200, { status: 'ok' }, { 'Set-Cookie': 'wp_session=; Path=/WayPoint; Max-Age=0' });
  }
  if (urlPath === '/WayPoint/api/whoami' && req.method === 'GET') {
    const user = currentUser(req);
    if (!user) return sendJson(res, 200, { loggedIn: false, setupNeeded: users.length === 0 });
    return sendJson(res, 200, { loggedIn: true, id: user.id, username: user.username, isUberUser: !!user.isUberUser, avatar: resolveAccountAvatar(user) });
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
    return sendJson(res, 200, { status: 'ok', id: user.id, username: user.username, isUberUser: true, avatar: resolveAccountAvatar(user) }, { 'Set-Cookie': 'wp_session=' + token + '; Path=/WayPoint; HttpOnly; SameSite=Lax' });
  }

  // ---- Everything else under /api/ needs a session ---------------------
  if (urlPath.indexOf('/WayPoint/api/') === 0) {
    const user = currentUser(req);
    if (!user) return sendJson(res, 401, { error: 'Please log in.' });

    if (urlPath === '/WayPoint/api/data' && req.method === 'GET') {
      return sendJson(res, 200, buildResponseState(user));
    }
    if (urlPath === '/WayPoint/api/data' && req.method === 'POST') {
      let body;
      try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: 'Request body was not valid JSON.' }); }
      if (!body || !Array.isArray(body.trips)) return sendJson(res, 400, { error: "Request body didn't look like trip data (expected { trips: [...] })." });
      const rejection = applySafeMergeSave(body, user);
      if (rejection) return sendJson(res, rejection.status, { error: rejection.error });
      return sendJson(res, 200, { status: 'ok' });
    }

    // ---- Test-only introspection: write counts (see writeCounts above).
    // GET reads, DELETE resets between test phases. ----
    if (urlPath === '/WayPoint/api/__writes') {
      if (req.method === 'DELETE') { writeCounts = { index: 0, trips: {} }; return sendJson(res, 200, { status: 'ok' }); }
      if (req.method === 'GET') return sendJson(res, 200, writeCounts);
    }

    // ---- Test-only: make one trip's content unreadable while leaving
    // its index entry in place. Reproduces a real, reachable KV state
    // (eventually consistent: a just-written key can briefly read as
    // missing elsewhere) whose handling decides whether a trip survives
    // or is destroyed. See src/worker.js's SAFETY PASS. ----
    if (urlPath === '/WayPoint/api/__hide-content' && req.method === 'POST') {
      let body;
      try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: 'bad json' }); }
      delete tripContents[body.tripId];
      return sendJson(res, 200, { status: 'ok' });
    }

    // ---- Sharing a trip (grant/revoke) -- owner or Admin (Admin can only
    // grant/revoke User/Viewer, never Admin), mirroring
    // handleTripGrantsUpsert()/handleTripGrantsRevoke() in src/worker.js.
    // ------------------------------------------------------
    if (urlPath === '/WayPoint/api/trip-grants' && req.method === 'POST') {
      let body;
      try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: 'Request body was not valid JSON.' }); }
      const tripId = body.tripId;
      const username = (body.username || '').trim();
      const role = body.role;
      const companionId = (body.companionId || '').trim();
      const replaceAccountId = (body.replaceAccountId || '').trim();
      if (!tripId) return sendJson(res, 400, { error: 'No trip specified.' });
      if (!username) return sendJson(res, 400, { error: 'Enter the username to share this trip with.' });
      if (GRANT_ROLES.indexOf(role) === -1) return sendJson(res, 400, { error: 'Role must be admin, user or viewer.' });
      if ((role === 'user' || role === 'viewer') && !companionId) {
        return sendJson(res, 400, { error: "Pick which companion this person is, so their access is scoped correctly." });
      }
      const indexEntry = tripIndex.trips.find(function (t) { return t.tripId === tripId; });
      if (!indexEntry) return sendJson(res, 404, { error: 'That trip no longer exists.' });
      const perm = permissionForTrip(indexEntry, user);
      if (!perm || (perm.role !== 'superuser' && perm.role !== 'admin')) {
        return sendJson(res, 403, { error: "Only this trip's owner or an Admin can share it." });
      }
      if (role === 'admin' && perm.role !== 'superuser') {
        return sendJson(res, 403, { error: "Only this trip's owner can grant Admin access." });
      }
      if (perm.role === 'admin' && replaceAccountId) {
        const replacedGrant = (indexEntry.grants || []).find(function (g) { return g.accountId === replaceAccountId; });
        if (replacedGrant && replacedGrant.role === 'admin') {
          return sendJson(res, 403, { error: "Only this trip's owner can replace another Admin's access." });
        }
      }
      const targetAccount = users.find(function (u) { return u.username.toLowerCase() === username.toLowerCase(); });
      if (!targetAccount) return sendJson(res, 404, { error: 'No account with that username exists yet — ask the site owner to create one first.' });
      if (targetAccount.id === indexEntry.ownerId) return sendJson(res, 400, { error: 'That account already owns this trip.' });
      if (targetAccount.isUberUser) return sendJson(res, 400, { error: 'That account already has full access to everything.' });
      let content = null;
      if (role === 'user' || role === 'viewer') {
        // Cloned (rather than the live tripContents[tripId] reference) so
        // writeTripContent()'s before/after JSON comparison further down
        // is meaningful -- same reason loadTripContent() in src/worker.js
        // always hands back a freshly-parsed object, never the exact
        // in-memory value that's about to be saved back over it.
        content = tripContents[tripId] ? JSON.parse(JSON.stringify(tripContents[tripId])) : null;
        const companionExists = ((content && content.companions) || []).some(function (c) { return c.companionId === companionId; });
        if (!companionExists) return sendJson(res, 400, { error: "That companion isn't on this trip." });
      }
      indexEntry.grants = (indexEntry.grants || []).filter(function (g) {
        return g.accountId !== targetAccount.id && (!replaceAccountId || g.accountId !== replaceAccountId);
      });
      indexEntry.grants.push({ accountId: targetAccount.id, role: role, companionId: role === 'admin' ? '' : companionId });
      // Sharing AS a specific companion is also how that companion's
      // account link gets set -- see the COMPANIONS & AVATARS comment
      // and handleTripGrantsUpsert() in src/worker.js.
      if (content && (role === 'user' || role === 'viewer')) {
        writeTripContent(tripId, assignCompanionAccountId(content, companionId, targetAccount.id));
      }
      return sendJson(res, 200, { status: 'ok', grants: resolveGrants(indexEntry) });
    }
    if (urlPath === '/WayPoint/api/trip-grants/revoke' && req.method === 'POST') {
      let body;
      try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: 'Request body was not valid JSON.' }); }
      const tripId = body.tripId, accountId = body.accountId;
      if (!tripId || !accountId) return sendJson(res, 400, { error: 'Missing trip or account.' });
      const indexEntry = tripIndex.trips.find(function (t) { return t.tripId === tripId; });
      if (!indexEntry) return sendJson(res, 404, { error: 'That trip no longer exists.' });
      const perm = permissionForTrip(indexEntry, user);
      if (!perm || (perm.role !== 'superuser' && perm.role !== 'admin')) {
        return sendJson(res, 403, { error: "Only this trip's owner or an Admin can change who has access to it." });
      }
      if (perm.role === 'admin') {
        const targetGrant = (indexEntry.grants || []).find(function (g) { return g.accountId === accountId; });
        if (targetGrant && targetGrant.role === 'admin') {
          return sendJson(res, 403, { error: "Only this trip's owner can remove another Admin's access." });
        }
      }
      indexEntry.grants = (indexEntry.grants || []).filter(function (g) { return g.accountId !== accountId; });
      // Deliberately does NOT clear the companion's accountId link -- see
      // handleTripGrantsRevoke() in src/worker.js for why.
      return sendJson(res, 200, { status: 'ok' });
    }

    // ---- Linking (or, with an empty username, unlinking) a companion to
    // an account -- mirrors handleCompanionLink() in src/worker.js. -------
    if (urlPath === '/WayPoint/api/companions/link' && req.method === 'POST') {
      let body;
      try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: 'Request body was not valid JSON.' }); }
      const tripId = body.tripId;
      const companionId = body.companionId;
      const username = (body.username || '').trim();
      if (!tripId || !companionId) return sendJson(res, 400, { error: 'Missing trip or companion.' });
      const indexEntry = tripIndex.trips.find(function (t) { return t.tripId === tripId; });
      if (!indexEntry) return sendJson(res, 404, { error: 'That trip no longer exists.' });
      const perm = permissionForTrip(indexEntry, user);
      if (!perm || (perm.role !== 'superuser' && perm.role !== 'admin')) {
        return sendJson(res, 403, { error: "Only this trip's owner or an Admin can link a companion to an account." });
      }
      const content = tripContents[tripId] ? JSON.parse(JSON.stringify(tripContents[tripId])) : null;
      const companion = ((content && content.companions) || []).find(function (c) { return c.companionId === companionId; });
      if (!companion) return sendJson(res, 404, { error: "That companion isn't on this trip." });
      let accountId = null;
      if (username) {
        const account = users.find(function (u) { return u.username.toLowerCase() === username.toLowerCase(); });
        if (!account) return sendJson(res, 404, { error: 'No account with that username exists yet — ask the site owner to create one first.' });
        accountId = account.id;
      }
      writeTripContent(tripId, assignCompanionAccountId(content, companionId, accountId));
      return sendJson(res, 200, { status: 'ok' });
    }

    // ---- Self-service avatar picker -- any logged-in account may set
    // their OWN avatar. Mirrors handleAccountAvatarUpdate() in
    // src/worker.js. --------------------------------------------------
    if (urlPath === '/WayPoint/api/account/avatar' && req.method === 'POST') {
      let body;
      try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: 'Request body was not valid JSON.' }); }
      if (!isValidAvatarColor(body.color)) return sendJson(res, 400, { error: 'Pick one of the available colours.' });
      if (!isValidAvatarAnimal(body.animal)) return sendJson(res, 400, { error: 'Pick one of the available animals.' });
      user.avatar = { color: body.color, animal: body.animal };
      return sendJson(res, 200, { status: 'ok', avatar: resolveAccountAvatar(user) });
    }

    // ---- Account management (site owner / uber-user only) ---------------
    if (urlPath === '/WayPoint/api/site-status' && req.method === 'GET') {
      if (!user.isUberUser) return sendJson(res, 403, { error: "Only the site owner's account can view site settings." });
      return sendJson(res, 200, { integrations: { flightLookup: true, locationSearch: true } });
    }
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
