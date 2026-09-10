/**
 * Waypoint — Cloudflare Worker
 *
 * Server half of the Waypoint travel planner. The other half is the single
 * static HTML file in public/WayPoint/index.html (no build step, no
 * framework), which does everything else in the browser.
 *
 * Routes:
 *   1. /WayPoint/api/data — the trip data API. GET reads trips from
 *      Cloudflare KV and returns whatever this account can see; POST merges
 *      a submitted state into KV rather than overwriting it (see "Saving
 *      safely" below).
 *   2. /WayPoint/api/flight-lookup — proxies a flight number + date to the
 *      AeroDataBox API (via RapidAPI) and returns carrier, origin/
 *      destination airports, and scheduled departure/arrival, to auto-fill
 *      the transport form. Requires the AERODATABOX_API_KEY secret (see
 *      handleFlightLookup()); done server-side so the key never reaches
 *      the browser.
 *   3. /api/login, /api/logout, /api/whoami, /api/setup — accounts/
 *      sessions. /api/trip-grants(/revoke) — share/unshare a trip.
 *      /api/users* — site-owner-only login management. See "Who is
 *      allowed in" below.
 *   4. Everything else (the page, CSS/JS/images) is served by Cloudflare's
 *      static asset binding (env.ASSETS), deliberately with no auth check —
 *      required so the login screen itself can load.
 *
 * ----------------------------------------------------------------------------
 * WHO IS ALLOWED IN
 * ----------------------------------------------------------------------------
 * Permissions are per trip, not one global role. Each trip has one owner
 * (its creator), the "Superuser", who can share it with other accounts
 * under a role:
 *   - Superuser (owner) — full read/write, and the only one who can grant
 *     or revoke others' access (the "Share this trip" panel).
 *   - "admin" — full read/write, but can't manage sharing.
 *   - "user" — sees/edits only items already tagged with the one companion
 *     they're linked to (their own flights, accommodation, etc). Can't
 *     create, delete, retag, or touch trip-level fields (name/dates/
 *     notes) or the companions/contacts list.
 *   - "viewer" — same scoping as "user", read-only.
 * A trip nobody has shared with you is left out of your data entirely, not
 * just hidden in the UI.
 *
 * There's also one undisclosed "uber-user" account (the site owner's own
 * login, created once via handleSetup()) with Superuser-equivalent access
 * to every trip, without being added to any trip's grant list — so the
 * owner can always get in, even to a trip nobody shared with them. It's
 * undisclosed in that API responses never flag it as special to anyone but
 * the account itself (see handleLogin()); everywhere else it resolves to
 * the same `{ role: "superuser" }` a real owner gets, so there's no
 * separate code path that could leak its status.
 *
 * Accounts live in KV under USERS_KEY ("users") — id, username, hashed
 * (never plain-text) password, and whether they're the uber-user. All
 * actual permissions live on the TRIP (ownerId, grants[]), not the
 * account — see permissionForTrip() for how a trip + account resolve into
 * what it may do.
 *
 * Bootstrap: with no accounts yet, WAYPOINT_PASSWORD (the old single-
 * password secret) doubles as a one-time setup key. Visit
 * /WayPoint/api/setup once with it to create the first (uber-user)
 * account; the endpoint then refuses to run again. The secret is inert
 * afterwards — fine to leave set or remove.
 *
 * Not commercial-grade auth: no self-service signup, no password reset, no
 * login rate-limiting beyond a best-effort in-memory throttle. Matches the
 * brief — a personal app for a small trusted group (family/friends, ~20
 * people), where the site owner hands out every login via /api/users.
 *
 * Static files carry no trip data or secrets, so they're served unauthed;
 * only /api/data is gated.
 *
 * ----------------------------------------------------------------------------
 * HOW TRIPS ARE STORED
 * ----------------------------------------------------------------------------
 * Trips used to live in one KV value under "state", read and rewritten in
 * full on every visit/save. Two problems as trip count grows: KV caps a
 * value at 25 MiB, and KV allows only one write/sec per key — so two
 * people saving two *different* trips in the same second could silently
 * collide on that one shared key.
 *
 * Storage is now split:
 *   - TRIP_INDEX_KEY ("trip_index") — one small doc listing every trip
 *     (name, dates, currency, ownerId, grants), enough to render the
 *     dashboard and resolve permissions without loading any trip's
 *     content. The only place ownerId/grants live. See
 *     loadTripIndex()/saveTripIndex().
 *   - "trip:<tripId>" — one KV key per trip, holding that trip's actual
 *     content (destinations, activities, transport, accommodation,
 *     contacts, expenses, companions, notes, currency rates, geocode
 *     cache). See loadTripContent()/saveTripContent()/deleteTripContent().
 *
 * A save now reads/writes only the one trip being changed, so two
 * different trips saved at once no longer collide. The index is still one
 * shared key, so renaming a trip or changing its sharing (both touch the
 * index) keep a narrower version of the old collision window — see the
 * comment on saveTripIndex() for why that trade-off is acceptable.
 *
 * Anything saved under the old "state" key is picked up automatically by
 * migrateFromLegacyState() and left in place afterwards as an inert backup.
 *
 * ----------------------------------------------------------------------------
 * SCHEMA: every item's id field is named for what it is
 * ----------------------------------------------------------------------------
 * Trip/destination/activity/transport/accommodation/contact/expense/
 * companion objects now use `tripId`, `destinationId`, `activityId`,
 * `transportId`, `accommodationId`, `contactId`, `expenseId`,
 * `companionId` instead of a generic `id` — clearer when several item
 * types are mixed in raw JSON (e.g. hand-editing KV in the dashboard).
 * Reference fields that already used this naming (an activity's
 * destinationId, a grant's companionId) are unchanged. Account/login
 * records deliberately keep a plain `id`.
 *
 * ----------------------------------------------------------------------------
 * SAVING SAFELY
 * ----------------------------------------------------------------------------
 * The frontend still POSTs its whole known `state` to /api/data on every
 * change — the wire format is unchanged. But since trips are private by
 * default, any one account's `state.trips` is only ever the subset GET
 * gave it (see buildResponseState()). Writing that subset straight to
 * storage would silently delete every trip the account can't see.
 *
 * So handlePost() never does that. For every save it:
 *   1. Loads the real, full, currently-stored trip index (never the
 *      client's copy) — ownerId/grants always come from storage.
 *   2. Works out what this account may change: the whole trip
 *      (Superuser/admin), just its own tagged items ("user"), or nothing
 *      (no access, or "viewer").
 *   3. Applies only that, trip by trip — rewriting a trip's "trip:<id>"
 *      key only when that trip actually changed; every other trip (and
 *      the index, unless a trip was renamed/created/deleted) is left
 *      alone.
 * See the comment on handlePost() for the full trip-by-trip rules. Net
 * effect: no matter what a browser sends, an account can never affect a
 * trip (or, under a "user" grant, an item) beyond its own permissions —
 * the save endpoint enforces the same boundaries as GET, in reverse.
 */

// Caps a request body so a runaway request or frontend bug can't fill KV
// with an oversized payload. 5 MB is far more than any realistic trip set.
const MAX_BODY_BYTES = 5 * 1024 * 1024;

// The old single-blob storage key, read only by migrateFromLegacyState()
// to pick up pre-migration data — never written to again.
const LEGACY_STATE_KEY = "state";

// The lightweight "list of every trip" document — see "HOW TRIPS ARE
// STORED" above. The one and only place a trip's ownerId/grants live.
const TRIP_INDEX_KEY = "trip_index";

// Every trip's actual content lives under its own key, "trip:<tripId>".
function tripContentKey(tripId) {
  return "trip:" + tripId;
}

// The account list's KV key — separate from trip data so editing accounts
// never risks corrupting trips, and vice versa.
const USERS_KEY = "users";
const USERS_INITIALIZED_KEY = "users_initialized";

// Empty index/trip shape for a brand-new install, so nothing else has to
// special-case "not set up yet" versus "something went wrong".
const EMPTY_INDEX = JSON.stringify({ trips: [] });

// Sanity backstop on account count (built for a friends-and-family group
// expected to top out around 20 people) — cheap insurance against a
// runaway script or mistake, not a hard business rule.
const MAX_USERS = 200;

// Session cookie name and lifetime. 30 days is generous on purpose — a
// low-stakes personal app on trusted people's own devices.
const SESSION_COOKIE_NAME = "wp_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

// PBKDF2 password hashing parameters — 100,000 iterations of SHA-256 is
// comfortably slow for guessing, instant for a real login. See
// hashPassword()/verifyPassword() below.
const PBKDF2_ITERATIONS = 100000;
const PBKDF2_HASH_BYTES = 32; // 256 bits
const SALT_BYTES = 16;

// Best-effort per-isolate throttle. A Cloudflare zone-level rate-limit rule
// should also cover this route because separate isolates do not share memory.
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 8;
const loginAttempts = new Map();

// Roles that can be GRANTED on a trip (via /api/trip-grants). "superuser"
// is deliberately excluded — it only ever comes from creating the trip
// (trip.ownerId), see permissionForTrip().
const GRANT_ROLES = ["admin", "user", "viewer"];
// Virtual participant id for itinerary items that tag the trip owner.
// Stored in the existing `companions` id arrays, but resolves from
// server-owned account data rather than a duplicate companion record.
const SUPERUSER_PARTICIPANT_ID = "__trip_superuser__";

/* ----------------------------------------------------------------------------
 * COMPANIONS & AVATARS
 * ----------------------------------------------------------------------------
 * Every account gets a self-picked coloured circle + animal face (e.g.
 * green circle, penguin). Every companion who isn't linked to an account
 * gets a fixed grey circle + a smiley in a colour its adder picked — the
 * two looks differ deliberately, so a marker shows at a glance whether
 * that person can log in. See claude/waypoint-companions-plan.md.
 *
 * The account<->companion link lives on the companion record as an
 * `accountId` field (not on the grant), so an account's avatar is the same
 * everywhere it appears on a trip via one local lookup (see
 * resolveCompanionAvatars()) rather than cross-referencing grants.
 *
 * Because a companion is regular trip CONTENT that even a scoped "user"
 * grant can submit changes to (see mergeUserScopedTrip()), `accountId` is
 * treated as a server-computed, PROTECTED field — like ownerId/tripId on
 * the trip itself — never taken from client-submitted content, no matter
 * the role saving. reconcileCompanionAccountLinks() enforces this on every
 * companion for every content-writing path in handlePost(). It's only
 * ever set via two dedicated, permission-gated actions: the auto-link in
 * handleTripGrantsUpsert() when sharing a trip as a specific companion,
 * and handleCompanionLink()'s standalone link/unlink — both restricted to
 * a trip's Superuser or Admin.
 *
 * A colour/animal is always one of a small ALLOWLISTED set (see
 * AVATAR_COLOR_TOKENS/AVATAR_ANIMAL_TOKENS below); the Worker validates
 * every incoming token against its own copy, never trusting the page's
 * (kept in sync with public/WayPoint/data/avatars.js, which also holds
 * the hex/emoji values the frontend needs to draw a marker). This closes
 * off a CSS-injection-style bug if a raw stored value were ever
 * interpolated into a style attribute.
 * ----------------------------------------------------------------------------*/

// Keep in sync with public/WayPoint/data/avatars.js's AVATAR_COLORS list
// (which also carries each token's hex value — the Worker only needs the
// token itself, to validate).
const AVATAR_COLOR_TOKENS = ["red", "orange", "amber", "green", "teal", "cyan", "blue", "indigo", "purple", "pink"];

// Keep in sync with public/WayPoint/data/avatars.js's AVATAR_ANIMALS list.
const AVATAR_ANIMAL_TOKENS = ["penguin", "lion", "fox", "owl", "panda", "koala", "tiger", "elephant", "giraffe", "rabbit", "bear", "wolf", "cat", "dog", "monkey", "dolphin"];

function isValidAvatarColor(token) {
  return AVATAR_COLOR_TOKENS.indexOf(token) !== -1;
}

function isValidAvatarAnimal(token) {
  return AVATAR_ANIMAL_TOKENS.indexOf(token) !== -1;
}

// Stable default color/animal index so a marker never renders blank before
// its avatar is chosen. Mirrors deterministicAvatarIndex() in
// public/WayPoint/data/avatars.js. Not cryptographic — just an array index.
function deterministicIndex(seed, listLength) {
  let hash = 0;
  const text = String(seed || "");
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  }
  return hash % listLength;
}

// Resolves one account's avatar: its saved color/animal if both are still
// valid allowlisted tokens, otherwise a deterministic default from the
// account id (see deterministicIndex()). Always returns a real
// `{ color, animal }`, never null, so callers need no fallback of their own.
function resolveAccountAvatar(account) {
  const saved = account && account.avatar;
  const color = (saved && isValidAvatarColor(saved.color)) ? saved.color : AVATAR_COLOR_TOKENS[deterministicIndex(account && account.id, AVATAR_COLOR_TOKENS.length)];
  const animal = (saved && isValidAvatarAnimal(saved.animal)) ? saved.animal : AVATAR_ANIMAL_TOKENS[deterministicIndex((account && account.id) + ":animal", AVATAR_ANIMAL_TOKENS.length)];
  return { color: color, animal: animal };
}

// The trip owner is a taggable person even though ownership lives in the
// trip index rather than `content.companions`. Expose only the display name
// and resolved avatar; the account id remains server-side. A legacy unowned
// trip falls back to the site owner, who is the only account able to reach it.
function resolveSuperuserParticipant(indexEntry, usersDoc) {
  const account = usersDoc.users.find(function (u) { return u.id === indexEntry.ownerId; }) ||
    usersDoc.users.find(function (u) { return u.isUberUser; });
  if (!account) return null;
  const avatar = resolveAccountAvatar(account);
  return {
    participantId: SUPERUSER_PARTICIPANT_ID,
    name: account.username,
    avatar: { type: "account", color: avatar.color, animal: avatar.animal },
  };
}

// Resolves every companion on a trip to the marker it should show, keyed
// by companionId, from server-side truth only — a plain local lookup
// rather than cross-referencing `grants` (see COMPANIONS & AVATARS above).
// Never hands out a raw accountId, only a color/animal — safe to send to
// every role that can see the trip, including a scoped "user"/"viewer"
// grant (compare buildVisibleTrip(), which strips accountId itself from a
// scoped role's own companions list for the same reason).
function resolveCompanionAvatars(content, usersDoc) {
  const map = {};
  (content && content.companions || []).forEach(function (c) {
    if (c.accountId) {
      const account = usersDoc.users.find(function (u) { return u.id === c.accountId; });
      if (account) {
        const avatar = resolveAccountAvatar(account);
        map[c.companionId] = { type: "account", color: avatar.color, animal: avatar.animal };
        return;
      }
      // Linked account was deleted -- fall through to the smiley below.
    }
    const savedSmiley = c.avatar && c.avatar.smiley;
    const color = isValidAvatarColor(savedSmiley) ? savedSmiley : AVATAR_COLOR_TOKENS[deterministicIndex(c.companionId, AVATAR_COLOR_TOKENS.length)];
    map[c.companionId] = { type: "smiley", color: color };
  });
  return map;
}

/* ---- Guest vs Companion, and the access-level tag ----------------------
 * "Guest"/"Companion" are frontend vocabulary, not a new field: a
 * companion with no `accountId` is a Guest, one with an accountId is a
 * Companion (see COMPANIONS & AVATARS above). This resolves WHAT ACCESS
 * LEVEL a Companion has on this trip — Super/Admin/User/Viewer — as a tag
 * next to their name, by calling permissionForTrip() (the same function
 * that gates real permission checks, so this can't drift out of sync with
 * it) for each linked companion's account instead of the caller's.
 *
 * A companion linked only for their avatar, with no actual access on this
 * trip (see handleCompanionLink()), gets no entry; the frontend falls
 * back to a generic "Companion" tag.
 *
 * Unlike `grants` (which lists every account with access and is withheld
 * from scoped User/Viewer roles — see buildVisibleTrip()), this map goes
 * to every role that can see the trip. It only reveals a role level per
 * companion already visible in the companion list, never an accountId or
 * username.
 */
function resolveCompanionAccessLevels(indexEntry, content, usersDoc) {
  const map = {};
  (content && content.companions || []).forEach(function (c) {
    if (!c.accountId) return; // A Guest has no login, so no access level to show.
    const account = usersDoc.users.find(function (u) { return u.id === c.accountId; });
    if (!account) return; // Linked account has since been deleted -- nothing to resolve.
    const perm = permissionForTrip(indexEntry, account);
    if (perm) map[c.companionId] = perm.role; // "superuser" | "admin" | "user" | "viewer"
    // else: linked but genuinely no access on this trip -- leave unset.
  });
  return map;
}

// Reasserts `accountId` on every companion in `incomingCompanions` from
// the trip's REAL stored content, on every save, for every role — see
// COMPANIONS & AVATARS above. A companion keeps exactly the accountId it
// already has in storage regardless of what the client sent; a brand-new
// companion can never arrive pre-linked, since linking only happens
// through the two dedicated actions below. This reasserts rather than
// deletes the field, because deleting it would mean an ordinary save
// (e.g. changing the trip currency, which resubmits the whole companions
// list as last read) would silently erase every existing account link.
function reconcileCompanionAccountLinks(storedContent, incomingCompanions) {
  const storedAccountIdByCompanionId = {};
  (storedContent && storedContent.companions || []).forEach(function (c) {
    storedAccountIdByCompanionId[c.companionId] = c.accountId || null;
  });
  return (incomingCompanions || []).map(function (c) {
    const copy = Object.assign({}, c);
    const real = Object.prototype.hasOwnProperty.call(storedAccountIdByCompanionId, c.companionId)
      ? storedAccountIdByCompanionId[c.companionId]
      : null; // Not a companion that exists in storage yet -- can't be linked.
    if (real) copy.accountId = real; else delete copy.accountId;
    return copy;
  });
}

// Sets (or, when accountId is falsy, clears) which account companion
// `companionId` is linked to. Enforces one companion per account on a
// trip: if the account is linked to a different companion, that link is
// cleared first, so two companions can never claim the same account.
// Mutates `content` in place; caller saves it back to KV. Shared by
// handleTripGrantsUpsert() (auto-link when sharing a trip as a specific
// companion) and handleCompanionLink() (standalone link/unlink), so this
// rule is only implemented once.
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

export default {
  async fetch(request, env, ctx) {
    try {
    return await (async function () {
    const url = new URL(request.url);
    const path = url.pathname;

    // ---- Auth endpoints (these ARE the login system, so none of them
    // require you to already be logged in) --------------------------------
    if (path === "/WayPoint/api/login" && request.method === "POST") {
      return handleLogin(request, env);
    }
    if (path === "/WayPoint/api/logout" && request.method === "POST") {
      return handleLogout(request, env);
    }
    if (path === "/WayPoint/api/whoami" && request.method === "GET") {
      return handleWhoami(request, env);
    }
    if (path === "/WayPoint/api/setup" && request.method === "POST") {
      return handleSetup(request, env);
    }

    // ---- Everything below this line needs a real, logged-in account -----
    if (path.startsWith("/WayPoint/api/")) {
      const user = await getCurrentUser(request, env);
      if (!user) {
        return jsonError(401, "Please log in.");
      }

      // ---- Our JSON API (trip data) ---------------------------------
      if (path === "/WayPoint/api/data") {
        if (request.method === "GET") return handleGet(env, user);
        if (request.method === "POST") return handlePost(request, env, user);
        return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST" } });
      }

      // ---- Sharing a trip (grant/revoke) -- owner or Admin (Admin can
      // only grant/revoke User/Viewer, never Admin); enforced inside
      // these handlers against the REAL stored ownerId/grants, never
      // anything the client claims. ----------------
      if (path === "/WayPoint/api/trip-grants") {
        if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
        return handleTripGrantsUpsert(request, env, user);
      }
      if (path === "/WayPoint/api/trip-grants/revoke" && request.method === "POST") {
        return handleTripGrantsRevoke(request, env, user);
      }

      // ---- Linking (or unlinking) a companion to an account -- see
      // COMPANIONS & AVATARS near AVATAR_COLOR_TOKENS. Same owner-or-Admin
      // permission bar as sharing a trip. ----------------
      if (path === "/WayPoint/api/companions/link" && request.method === "POST") {
        return handleCompanionLink(request, env, user);
      }

      // ---- Self-service avatar picker -- any logged-in account may set
      // its OWN avatar; handleAccountAvatarUpdate() always writes to
      // `user` from the session, never a body-supplied id. -------------
      if (path === "/WayPoint/api/account/avatar" && request.method === "POST") {
        return handleAccountAvatarUpdate(request, env, user);
      }

      // ---- Flight lookup (reverse: flight number -> carrier + route) --
      if (path === "/WayPoint/api/flight-lookup") {
        if (request.method !== "GET") {
          return new Response("Method not allowed", { status: 405, headers: { Allow: "GET" } });
        }
        return handleFlightLookup(url, env);
      }

      // ---- Location search and durable destination boundaries ---------
      // These routes intentionally sit behind the existing session check:
      // LocationIQ's key stays in the Worker and address queries are not a
      // public, unauthenticated service.
      if (path === "/WayPoint/api/location-search") {
        if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET" } });
        return handleLocationSearch(url, env, user);
      }
      if (path === "/WayPoint/api/location-boundary") {
        if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET" } });
        return handleLocationBoundary(url, env, user);
      }
      if (path === "/WayPoint/api/location-boundaries") {
        if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
        return handleLocationBoundaries(request, env);
      }

      // ---- Account management (site-owner / uber-user only) -----------
      if (path === "/WayPoint/api/site-status" && request.method === "GET") {
        if (!user.isUberUser) return jsonError(403, "Only the site owner's account can view site settings.");
        // Report presence only. Secret values never leave the Worker, even to
        // the site owner; the Cloudflare dashboard remains their sole editor.
        return new Response(JSON.stringify({
          integrations: {
            flightLookup: !!env.AERODATABOX_API_KEY,
            locationSearch: !!env.LOCATIONIQ_API_KEY
          }
        }), { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
      }
      if (path === "/WayPoint/api/users") {
        if (!user.isUberUser) return jsonError(403, "Only the site owner's account can manage logins.");
        if (request.method === "GET") return handleUsersList(env);
        if (request.method === "POST") return handleUsersUpsert(request, env);
        return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST" } });
      }
      if (path === "/WayPoint/api/users/delete" && request.method === "POST") {
        if (!user.isUberUser) return jsonError(403, "Only the site owner's account can manage logins.");
        return handleUsersDelete(request, env);
      }

      // An /api/ path that isn't any of the above.
      return jsonError(404, "Not found.");
    }

    // ---- Everything else: hand off to the static file server --------------
    // `env.ASSETS` is configured in wrangler.toml to serve whatever's in the
    // public/ folder. Because this Worker's route (see wrangler.toml) only
    // matches liddellworks.com/WayPoint*, this never touches any other page
    // on the site — a request for e.g. liddellworks.com/blog never reaches
    // this Worker at all, Cloudflare routes it to whatever normally serves
    // the rest of the site instead. No auth check here — see the big
    // comment at the top of this file for why that's intentional.
    return env.ASSETS.fetch(request);
    })();
    } catch (err) {
      if (err && err.name === "UsersStorageError") {
        return jsonError(503, "Account storage is unavailable or corrupt. Setup and login are disabled until it is repaired.");
      }
      throw err;
    }
  },
};

/* ============================================================================
 * Trip storage — the index, per-trip content, and the one-time migration
 * from the old single-blob "state" key. See the big "HOW TRIPS ARE STORED"
 * comment near the top of this file for the reasoning behind this shape.
 * ==========================================================================*/

/**
 * Reads the trip index — { trips: [{tripId, name, startDate, endDate,
 * homeCurrency, ownerId, grants}, ...] } — running the one-time migration
 * from the old "state" key first if needed. Always resolves to a valid
 * { trips: [] } shape, same as loadUsers() for accounts.
 *
 * Reads the index once in the normal (already-migrated) case, rather than
 * calling ensureMigrated() and then reading separately — that would read
 * the same KV key twice on every request just to ask "has migration run?"
 */
async function loadTripIndex(env) {
  let saved = await env.WAYPOINT_KV.get(TRIP_INDEX_KEY);
  if (saved === null) {
    // No index yet: a new install, or an existing one still on the old
    // "state" blob. migrateFromLegacyState() handles both.
    await migrateFromLegacyState(env);
    saved = await env.WAYPOINT_KV.get(TRIP_INDEX_KEY);
  }
  return saved !== null ? JSON.parse(saved) : JSON.parse(EMPTY_INDEX);
}

/**
 * Writes the trip index back. Unlike a single trip's own content, this is
 * still one shared key across every trip, so two different index-touching
 * changes (renaming two different trips) landing in the same second can
 * still collide — a much narrower window than before, since it only
 * matters for renames/date changes/create/delete/sharing, never ordinary
 * content edits. A proper fix would need a retry-with-fresh-read loop;
 * not worth the complexity for how rarely that collision would happen on
 * a small family/friends app. Known, accepted trade-off.
 */
async function saveTripIndex(env, index) {
  await env.WAYPOINT_KV.put(TRIP_INDEX_KEY, JSON.stringify(index));
}

/** A single trip's full content, or null if that trip doesn't exist. */
async function loadTripContent(env, tripId) {
  const saved = await env.WAYPOINT_KV.get(tripContentKey(tripId));
  return saved !== null ? JSON.parse(saved) : null;
}

async function saveTripContent(env, tripId, content) {
  await env.WAYPOINT_KV.put(tripContentKey(tripId), JSON.stringify(content));
}

async function deleteTripContent(env, tripId) {
  await env.WAYPOINT_KV.delete(tripContentKey(tripId));
}

// A trip's own CONTENT fields — everything except index-level bookkeeping
// (tripId/ownerId/grants, which live only in the trip index) and the
// response-only fields a GET adds (see stripClientOwnershipFields()).
// What migration copies into a "trip:<id>" document. Deliberately omits
// tripId, which lives only in the index and the KV key name, never
// duplicated inside content.
const TRIP_CONTENT_FIELDS = [
  "name", "startDate", "endDate", "homeCurrency", "notes", "currencyRates",
  "destinations", "activities", "transport", "accommodation", "contacts",
  "expenses", "companions", "geocodeCache",
];

// Client data is hostile input even when it came from our own page: a scoped
// account can call the API directly, and stored strings are later rendered by
// more privileged accounts. Only these fields may cross the storage boundary.
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_DATE_PATTERN = /^$|^\d{4}-\d{2}-\d{2}$/;
const SAFE_TIME_PATTERN = /^$|^\d{2}:\d{2}$/;
const SAFE_DATETIME_PATTERN = /^$|^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/;
const SAFE_CURRENCY_PATTERN = /^$|^[A-Z]{3}$/;
const SAFE_LOCATION_REF_PATTERN = /^(?:liq:[NWR]\d{1,16}|local:airport:[A-Z]{3})$/;
const SAFE_BOUNDARY_REF_PATTERN = /^liq:[WR]\d{1,16}$/;
const LOCATION_METHOD_VALUES = new Set(["selected", "manual", "legacy_cache"]);
const LOCATION_GRANULARITY_VALUES = new Set(["unknown", "address", "venue", "station", "airport", "locality", "area"]);
const BOUNDARY_QUALITY_VALUES = new Set(["exact_simplified", "approximate_bbox", "none"]);
const MAX_BOUNDARY_COORDINATES = 10000;
const MAX_BOUNDARY_BYTES = 250 * 1024;
const MAX_ITEMS_PER_LIST = 1000;
// The browser exposes these as fixed dropdowns. Keep the stored taxonomy
// equally bounded even for a hand-crafted save request; "Other" is the
// safe fallback for old or unrecognised values.
const ACTIVITY_CATEGORY_VALUES = new Set(["Other", "Dining & drinks", "Tour / experience", "Show / performance", "Culture & sights", "Outdoor / active", "Shopping", "Wellness", "Nightlife"]);
const ACCOMMODATION_TYPE_VALUES = new Set(["Other", "Hotel / hostel", "Apartment / holiday rental", "Guesthouse / B&B", "Resort", "Camping / glamping", "Friends / family", "Cruise ship"]);

const ITEM_FIELDS = {
  destinations: ["destinationId", "name", "country", "arriveDate", "departDate", "timezone", "companions", "notes", "lat", "lng", "locationRef", "locationMethod", "locationGranularity", "locationStale", "locationKindLabel", "bbox", "boundaryRef", "boundaryQuality"],
  activities: ["activityId", "title", "category", "destinationId", "date", "startDate", "endDate", "allDay", "startTime", "endTime", "location", "address", "bookingRef", "contactId", "costAmount", "costCurrency", "costRate", "receiptRef", "companions", "notes", "addressLat", "addressLng", "addressLocationRef", "addressLocationMethod", "addressLocationGranularity", "addressLocationStale", "addressLocationKindLabel"],
  transport: ["transportId", "mode", "carrier", "flightNumber", "licensePlate", "fromLocation", "toLocation", "departDateTime", "arriveDateTime", "paymentType", "costCurrency", "costAmount", "costRate", "pointsProgram", "pointsAmount", "bookingRef", "contactId", "receiptRef", "companions", "notes", "fromLat", "fromLng", "toLat", "toLng", "fromLocationRef", "toLocationRef", "fromLocationMethod", "toLocationMethod", "fromLocationGranularity", "toLocationGranularity", "fromLocationStale", "toLocationStale", "fromLocationKindLabel", "toLocationKindLabel"],
  accommodation: ["accommodationId", "name", "type", "destinationId", "address", "checkIn", "checkOut", "bookingRef", "contactId", "costAmount", "costCurrency", "costRate", "receiptRef", "companions", "notes", "lat", "lng", "locationRef", "locationMethod", "locationGranularity", "locationStale", "locationKindLabel"],
  contacts: ["contactId", "name", "role", "phone", "email", "address", "notes"],
  expenses: ["expenseId", "description", "category", "date", "amount", "currency", "rateOverride", "receiptRef", "contactId", "notes"],
  companions: ["companionId", "name", "notes", "avatar", "accountId"],
};

const ITEM_ID_FIELDS = {
  destinations: "destinationId", activities: "activityId", transport: "transportId",
  accommodation: "accommodationId", contacts: "contactId", expenses: "expenseId", companions: "companionId",
};

function safeText(value, max) {
  return String(value === undefined || value === null ? "" : value).slice(0, max || 300);
}

function safeId(value, allowEmpty) {
  const id = safeText(value, 128);
  if (!id && allowEmpty) return "";
  if (!SAFE_ID_PATTERN.test(id)) throw new Error("Invalid identifier in trip data.");
  return id;
}

function safeNumeric(value) {
  if (value === "" || value === null || value === undefined) return "";
  const number = Number(value);
  if (!Number.isFinite(number) || Math.abs(number) > 1e12) throw new Error("Invalid numeric value in trip data.");
  return typeof value === "number" ? number : String(number);
}

function safeCoordinate(value, axis) {
  if (value === "" || value === null || value === undefined) return "";
  const number = Number(value);
  const limit = axis === "lat" ? 90 : 180;
  if (!Number.isFinite(number) || number < -limit || number > limit) throw new Error("Invalid location coordinate in trip data.");
  return number;
}

function safeLocationRef(value, boundaryOnly) {
  const ref = safeText(value, 120);
  if (!ref) return "";
  if (!(boundaryOnly ? SAFE_BOUNDARY_REF_PATTERN : SAFE_LOCATION_REF_PATTERN).test(ref)) throw new Error("Invalid location reference in trip data.");
  return ref;
}

function safeLocationValue(value, values, label) {
  const text = safeText(value, 32);
  if (!text) return "";
  if (!values.has(text)) throw new Error("Invalid " + label + " in trip data.");
  return text;
}

function normaliseBbox(value, centre) {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const raw = value.map(Number);
  if (!raw.every(Number.isFinite)) return null;
  const valid = function (west, south, east, north) {
    return west >= -180 && west <= 180 && east >= -180 && east <= 180 &&
      south >= -90 && south <= 90 && north >= -90 && north <= 90 &&
      west <= east && south <= north;
  };
  const candidates = [
    raw, // Waypoint's stored [west, south, east, north] order.
    [raw[2], raw[0], raw[3], raw[1]], // Nominatim / LocationIQ [south, north, west, east].
    [raw[1], raw[0], raw[3], raw[2]] // [south, west, north, east].
  ].filter(function (bbox) { return valid(bbox[0], bbox[1], bbox[2], bbox[3]); });
  if (!candidates.length) return null;

  // Some places (for example Cairo) can make more than one coordinate
  // ordering look numerically valid. When the destination has a saved point,
  // choose the bounds that contain it and whose centre is closest. That makes
  // normalisation work in every latitude/longitude region, not only Seoul.
  const lat = centre && centre.lat !== "" && centre.lat !== null && centre.lat !== undefined ? Number(centre.lat) : NaN;
  const lng = centre && centre.lng !== "" && centre.lng !== null && centre.lng !== undefined ? Number(centre.lng) : NaN;
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    const containing = candidates.filter(function (bbox) {
      return lng >= bbox[0] && lng <= bbox[2] && lat >= bbox[1] && lat <= bbox[3];
    });
    if (containing.length) {
      containing.sort(function (a, b) {
        const da = Math.pow((a[0] + a[2]) / 2 - lng, 2) + Math.pow((a[1] + a[3]) / 2 - lat, 2);
        const db = Math.pow((b[0] + b[2]) / 2 - lng, 2) + Math.pow((b[1] + b[3]) / 2 - lat, 2);
        return da - db;
      });
      return containing[0];
    }
  }
  return candidates[0];
}

function safeBbox(value, centre) {
  if (value === "" || value === null || value === undefined) return [];
  const bbox = normaliseBbox(value, centre);
  // Bounds only improve map framing and are never needed to keep a trip
  // record valid. Providers and older records can contain an unknown order,
  // so fall back to a point rather than rejecting the entire save.
  return bbox || [];
}

function sanitizeItem(listKey, item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid item in trip data.");
  const output = {};
  ITEM_FIELDS[listKey].forEach(function (key) {
    if (!Object.prototype.hasOwnProperty.call(item, key)) return;
    const value = item[key];
    if (key === ITEM_ID_FIELDS[listKey]) output[key] = safeId(value, false);
    else if (/Id$/.test(key)) output[key] = safeId(value, true);
    else if (key === "lat") output[key] = safeCoordinate(value, "lat");
    else if (key === "lng") output[key] = safeCoordinate(value, "lng");
    else if (key === "fromLat" || key === "toLat" || key === "addressLat") output[key] = safeCoordinate(value, "lat");
    else if (key === "fromLng" || key === "toLng" || key === "addressLng") output[key] = safeCoordinate(value, "lng");
    else if (key === "locationRef" || key === "fromLocationRef" || key === "toLocationRef" || key === "addressLocationRef") output[key] = safeLocationRef(value, false);
    else if (key === "boundaryRef") output[key] = safeLocationRef(value, true);
    else if (key === "locationMethod" || key === "fromLocationMethod" || key === "toLocationMethod" || key === "addressLocationMethod") output[key] = safeLocationValue(value, LOCATION_METHOD_VALUES, "location method");
    else if (key === "locationGranularity" || key === "fromLocationGranularity" || key === "toLocationGranularity" || key === "addressLocationGranularity") output[key] = safeLocationValue(value, LOCATION_GRANULARITY_VALUES, "location granularity");
    else if (key === "boundaryQuality") output[key] = safeLocationValue(value, BOUNDARY_QUALITY_VALUES, "boundary quality");
    else if (key === "locationStale" || key === "fromLocationStale" || key === "toLocationStale" || key === "addressLocationStale") output[key] = value === true;
    else if (key === "bbox") output[key] = safeBbox(value, item);
    else if (listKey === "activities" && key === "allDay") output[key] = value === true || value === "true" || value === "on";
    else if (listKey === "activities" && key === "category") {
      const category = safeText(value, 80);
      output.category = ACTIVITY_CATEGORY_VALUES.has(category) ? category : "Other";
    } else if (listKey === "accommodation" && key === "type") {
      const type = safeText(value, 80);
      output.type = ACCOMMODATION_TYPE_VALUES.has(type) ? type : "Other";
    }
    else if (key === "companions") output[key] = Array.isArray(value) ? value.slice(0, 100).map(function (id) { return safeId(id, false); }) : [];
    else if (key === "departDateTime" || key === "arriveDateTime" || key === "checkIn" || key === "checkOut") {
      const dateTime = safeText(value, 16);
      if (!SAFE_DATETIME_PATTERN.test(dateTime)) throw new Error("Invalid date/time in trip data.");
      output[key] = dateTime;
    } else if (/Date$/.test(key) || key === "date") {
      const date = safeText(value, 10);
      if (!SAFE_DATE_PATTERN.test(date)) throw new Error("Invalid date in trip data.");
      output[key] = date;
    } else if (/Time$/.test(key)) {
      const time = safeText(value, 5);
      if (!SAFE_TIME_PATTERN.test(time)) throw new Error("Invalid time in trip data.");
      output[key] = time;
    } else if (key === "currency" || key === "costCurrency") {
      const currency = safeText(value, 3).toUpperCase();
      if (!SAFE_CURRENCY_PATTERN.test(currency)) throw new Error("Invalid currency in trip data.");
      output[key] = currency;
    } else if (["costAmount", "costRate", "amount", "rateOverride", "pointsAmount", "fromLat", "fromLng", "toLat", "toLng"].indexOf(key) !== -1) {
      output[key] = safeNumeric(value);
    } else if (key === "avatar") {
      const smiley = value && value.smiley;
      if (isValidAvatarColor(smiley)) output.avatar = { smiley: smiley };
    } else {
      output[key] = safeText(value, key === "notes" ? 5000 : 500);
    }
  });
  if (listKey === "activities") {
    const startDate = output.startDate || output.date || "";
    const endDate = output.endDate || startDate;
    if (startDate && endDate && endDate < startDate) throw new Error("Activity end date cannot be before its start date.");
    // `date` was the pre-range activity field. Keep it in lockstep for
    // clients that have not yet adopted startDate/endDate.
    if (output.startDate) {
      output.date = output.startDate;
      output.endDate = endDate;
    }
    if (output.allDay) {
      output.startTime = "";
      output.endTime = "";
    } else if (startDate && startDate === endDate && output.startTime && output.endTime && output.endTime < output.startTime) {
      throw new Error("Activity end time must be after its start time.");
    }
  }
  return output;
}

function sanitizeTripContent(trip) {
  if (!trip || typeof trip !== "object" || Array.isArray(trip)) throw new Error("Invalid trip data.");
  const output = {
    name: safeText(trip.name, 200),
    startDate: safeText(trip.startDate, 10),
    endDate: safeText(trip.endDate, 10),
    homeCurrency: safeText(trip.homeCurrency, 3).toUpperCase(),
    notes: safeText(trip.notes, 10000),
  };
  if (!SAFE_DATE_PATTERN.test(output.startDate) || !SAFE_DATE_PATTERN.test(output.endDate)) throw new Error("Invalid trip date.");
  if (!SAFE_CURRENCY_PATTERN.test(output.homeCurrency)) throw new Error("Invalid home currency.");

  Object.keys(ITEM_FIELDS).forEach(function (listKey) {
    const list = Array.isArray(trip[listKey]) ? trip[listKey] : [];
    if (list.length > MAX_ITEMS_PER_LIST) throw new Error("Too many items in trip data.");
    output[listKey] = list.map(function (item) { return sanitizeItem(listKey, item); });
  });

  output.currencyRates = {};
  Object.keys(trip.currencyRates || {}).slice(0, 100).forEach(function (currency) {
    const code = safeText(currency, 3).toUpperCase();
    if (!SAFE_CURRENCY_PATTERN.test(code) || !code) return;
    const rate = Number(trip.currencyRates[currency]);
    if (Number.isFinite(rate) && rate > 0 && rate <= 1e9) output.currencyRates[code] = rate;
  });

  output.geocodeCache = {};
  Object.keys(trip.geocodeCache || {}).slice(0, 500).forEach(function (place) {
    const coords = trip.geocodeCache[place];
    const lat = coords && Number(coords.lat);
    const lng = coords && Number(coords.lng);
    if (place.length <= 500 && Number.isFinite(lat) && lat >= -90 && lat <= 90 && Number.isFinite(lng) && lng >= -180 && lng <= 180) {
      output.geocodeCache[place] = { lat: lat, lng: lng };
    }
  });
  return output;
}

/**
 * One-time migration from the old single "state" blob into the new
 * index + per-trip-key shape. Only called by loadTripIndex() above, only
 * when there's no index yet.
 *
 * Safe to retry if interrupted partway: each per-trip content key is
 * written independently, and the index — which loadTripIndex() checks to
 * decide "has this run?" — is written last, once every trip has saved
 * successfully. A retry just harmlessly rewrites the same content again.
 * Two requests racing to migrate at once is likewise harmless.
 *
 * Also applies the id-field rename from "SCHEMA" above (trip.id ->
 * tripId, destination.id -> destinationId, etc). Reference fields already
 * used the typed name, so only each object's own id needs rewriting. The
 * old "state" key is left in place afterwards as an inert backup.
 */
async function migrateFromLegacyState(env) {
  const legacy = await env.WAYPOINT_KV.get(LEGACY_STATE_KEY);
  const legacyTrips = legacy ? (JSON.parse(legacy).trips || []) : [];

  const index = { trips: [] };
  for (const oldTrip of legacyTrips) {
    const tripId = oldTrip.id || oldTrip.tripId;
    if (!tripId) continue; // Shouldn't happen, but skip rather than crash migration.

    const content = renameIdFieldsForMigration(oldTrip);
    await saveTripContent(env, tripId, content);

    index.trips.push({
      tripId: tripId,
      name: oldTrip.name || "",
      startDate: oldTrip.startDate || "",
      endDate: oldTrip.endDate || "",
      homeCurrency: oldTrip.homeCurrency || "",
      ownerId: oldTrip.ownerId || null, // null = unclaimed; only the uber-user can reach it until re-owned or shared.
      grants: oldTrip.grants || [],
    });
  }
  await saveTripIndex(env, index);
}

// Renames the generic `id` field on a trip and every item inside it to its
// typed name (tripId/destinationId/activityId/...) for a trip object
// coming out of the OLD storage format during migration. Reference fields
// already used the typed name, so only each object's own id is renamed.
function renameIdFieldsForMigration(oldTrip) {
  const content = {};
  TRIP_CONTENT_FIELDS.forEach(function (key) {
    content[key] = oldTrip[key];
  });
  // Deliberately no content.tripId -- see TRIP_CONTENT_FIELDS' comment.
  // Writing it here would make the first save after migration always look
  // like a change, since every save strips it back out.
  content.destinations = (oldTrip.destinations || []).map(function (d) {
    return renamedIdCopy(d, "destinationId");
  });
  content.activities = (oldTrip.activities || []).map(function (a) {
    return renamedIdCopy(a, "activityId");
  });
  content.transport = (oldTrip.transport || []).map(function (t) {
    return renamedIdCopy(t, "transportId");
  });
  content.accommodation = (oldTrip.accommodation || []).map(function (a) {
    return renamedIdCopy(a, "accommodationId");
  });
  content.contacts = (oldTrip.contacts || []).map(function (c) {
    return renamedIdCopy(c, "contactId");
  });
  content.expenses = (oldTrip.expenses || []).map(function (e) {
    return renamedIdCopy(e, "expenseId");
  });
  content.companions = (oldTrip.companions || []).map(function (c) {
    return renamedIdCopy(c, "companionId");
  });
  content.geocodeCache = oldTrip.geocodeCache || {};
  content.currencyRates = oldTrip.currencyRates || {};
  return content;
}

// Copies `item`, replacing its generic `id` field with `newIdField` —
// used only during migration (see above); new saves already use the
// typed name directly.
function renamedIdCopy(item, newIdField) {
  const copy = Object.assign({}, item);
  if (Object.prototype.hasOwnProperty.call(copy, "id") && !Object.prototype.hasOwnProperty.call(copy, newIdField)) {
    copy[newIdField] = copy.id;
    delete copy.id;
  }
  return copy;
}

// ---- Permission resolution — the one function that decides what an
// account may do with a trip, from server-side truth only. ----

function findGrant(trip, accountId) {
  return (trip.grants || []).find(function (g) { return g.accountId === accountId; }) || null;
}

/**
 * Resolves what `user` may do with `indexEntry` (an entry from the trip
 * index — ownerId/grants, not the trip's content), purely from
 * indexEntry.ownerId/grants and user.isUberUser, never from client input.
 * Returns null if this account has no access (treat as nonexistent), or:
 *
 *   { role: "superuser" }                  — owner or uber-user. Full
 *                                             read/write, manages sharing.
 *   { role: "admin" }                      — full read/write, can't
 *                                             manage sharing.
 *   { role: "user",   companionId: "..." } — read/write, only items
 *                                             tagged with that companion.
 *   { role: "viewer", companionId: "..." } — same scoping, read-only.
 */
function permissionForTrip(indexEntry, user) {
  if (user.isUberUser) return { role: "superuser" };
  if (indexEntry.ownerId === user.id) return { role: "superuser" };
  const grant = findGrant(indexEntry, user.id);
  if (!grant) return null;
  if (grant.role === "admin") return { role: "admin" };
  if (grant.role === "user") return { role: "user", companionId: grant.companionId || "" };
  if (grant.role === "viewer") return { role: "viewer", companionId: grant.companionId || "" };
  return null; // Unrecognised role on the stored grant -- fail closed.
}

/**
 * Turns a trip's raw `grants` array (account ids + roles) into something
 * the browser can show, resolving each accountId to its username via
 * `usersDoc`. An entry whose account was since deleted is left out.
 */
function resolveGrants(indexEntry, usersDoc) {
  return (indexEntry.grants || [])
    .map(function (g) {
      const account = usersDoc.users.find(function (u) { return u.id === g.accountId; });
      if (!account) return null;
      return { accountId: g.accountId, username: account.username, role: g.role, companionId: g.companionId || "" };
    })
    .filter(function (g) { return g !== null; });
}

/**
 * Builds the full trip object the frontend expects for one trip this user
 * can see: the index entry's bookkeeping (ownerId/grants, or a scoped
 * view of neither) plus that trip's content loaded from its "trip:<id>"
 * key. Mirrors what the old single-blob buildResponseState() did per trip.
 */
function buildVisibleTrip(indexEntry, content, perm, usersDoc) {
  const revision = Number.isInteger(content && content._revision) ? content._revision : 0;
  // Normalize stored data again on the way out, to protect upgraded
  // deployments from values written by an older, less strict Worker.
  content = sanitizeTripContent(content);
  // Resolved once, shared below -- safe for every role since it's already
  // reduced to a color + animal, never a raw accountId (see COMPANIONS &
  // AVATARS near AVATAR_COLOR_TOKENS).
  const companionAvatars = resolveCompanionAvatars(content, usersDoc);
  // Same "safe for everyone" reasoning as companionAvatars just
  // above -- see resolveCompanionAccessLevels()'s own big comment for why
  // this is sent to every role, unlike `grants` below it.
  const companionAccessLevels = resolveCompanionAccessLevels(indexEntry, content, usersDoc);
  const superuserParticipant = resolveSuperuserParticipant(indexEntry, usersDoc);

  if (perm.role === "superuser" || perm.role === "admin") {
    const ownerAccount = usersDoc.users.find(function (u) { return u.id === indexEntry.ownerId; });
    return Object.assign({ tripId: indexEntry.tripId }, content, {
      ownerId: indexEntry.ownerId,
      myGrant: perm,
      ownerUsername: ownerAccount ? ownerAccount.username : "",
      grants: resolveGrants(indexEntry, usersDoc),
      companionAvatars: companionAvatars,
      companionAccessLevels: companionAccessLevels,
      superuserParticipant: superuserParticipant,
      revision: revision,
      // A full-scope role already sees `grants` (who has access to this
      // trip and as whom), so the raw accountId on each companion isn't
      // hiding anything NEW from them -- left in place here (unlike the
      // scoped branch below) since the Companions tab's "already linked
      // to an account" UI needs it. It's still never trusted coming back
      // IN from this same role on a save -- see
      // reconcileCompanionAccountLinks() and handlePost() below.
    });
  }

  // "user" / "viewer": scoped to their own tagged items only.
  const companionId = perm.companionId;
  const taggedTo = function (item) { return (item.companions || []).indexOf(companionId) !== -1; };
  const destinations = (content.destinations || []).filter(taggedTo);
  const activities = (content.activities || []).filter(taggedTo);
  const accommodation = (content.accommodation || []).filter(taggedTo);
  const transport = (content.transport || []).filter(taggedTo);
  const referencedContactIds = {};
  activities.concat(accommodation, transport).forEach(function (item) {
    if (item.contactId) referencedContactIds[item.contactId] = true;
  });
  // Build a new response rather than cloning the full trip. In particular,
  // geocodeCache keys contain raw place/address text and must not reveal
  // locations belonging only to someone else's hidden items.
  return {
    tripId: indexEntry.tripId,
    name: content.name,
    startDate: content.startDate,
    endDate: content.endDate,
    homeCurrency: content.homeCurrency,
    notes: content.notes,
    currencyRates: content.currencyRates,
    destinations: destinations,
    activities: activities,
    accommodation: accommodation,
    transport: transport,
    contacts: (content.contacts || []).filter(function (contact) { return !!referencedContactIds[contact.contactId]; }),
    expenses: [],
    geocodeCache: {},
    myGrant: perm,
    companionAvatars: companionAvatars,
    companionAccessLevels: companionAccessLevels,
    superuserParticipant: superuserParticipant,
    revision: revision,
    // Unlike the full-scope branch above, a scoped "user"/"viewer" grant
    // is deliberately NOT sent the `grants` array (they must not learn
    // who else has access to this trip) -- and an unlinked-from-content
    // raw `accountId` on a companion would leak exactly the same thing
    // (which account, if any, some other person on this trip is), so it
    // gets stripped here for the same reason. `companionAvatars` and
    // `companionAccessLevels` above already carry everything they're
    // allowed to see about it: a colour, an animal, and an access-LEVEL
    // (never a raw accountId or username) -- see
    // resolveCompanionAccessLevels()'s own comment for why that one field
    // is safe to share even though `grants` itself isn't.
    companions: (content.companions || []).map(function (c) {
      const copy = Object.assign({}, c);
      delete copy.accountId;
      return copy;
    }),
  };
  // No ownerId/grants added for a scoped account -- they have no business
  // knowing who else has access to a trip they can barely see into.
}

/**
 * Builds the whole GET /api/data response: every trip `user` has any
 * access to (from the index), loaded and annotated per buildVisibleTrip()
 * above. Costs one extra KV read per visible trip versus the old
 * single-blob design, a fine trade-off to avoid loading every trip that
 * exists just to show the ones you can see.
 */
async function buildResponseState(env, user, usersDoc) {
  const index = await loadTripIndex(env);
  const trips = [];
  for (const indexEntry of (index.trips || [])) {
    const perm = permissionForTrip(indexEntry, user);
    if (!perm) continue; // Invisible entirely.
    const content = await loadTripContent(env, indexEntry.tripId);
    if (!content) continue; // Index says it exists but content's missing -- shouldn't happen, skip rather than crash.
    trips.push(buildVisibleTrip(indexEntry, content, perm, usersDoc));
  }
  return { trips: trips };
}

async function handleGet(env, user) {
  const usersDoc = await loadUsers(env);
  const responseState = await buildResponseState(env, user, usersDoc);
  return new Response(JSON.stringify(responseState), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Saves the page's current `state.trips` -- safely (see "SAVING SAFELY"
 * near the top of this file for why a plain overwrite is dangerous now
 * that trips are private by default).
 *
 * The rule, trip by trip, computed from the REAL stored index (never the
 * client):
 *   - No access, or "viewer": left completely untouched, content key not
 *     even read.
 *   - Superuser (owner/uber-user) or "admin": content is replaced with
 *     what they submitted; leaving it out deletes it (content key deleted,
 *     index entry removed). ownerId/grants always come from the stored
 *     index, never the client -- only /api/trip-grants can change sharing.
 *   - "user": only fields on items that existed AND were tagged with
 *     their companion both before and after get updated (see
 *     mergeUserScopedTrip()). Can't add/remove items, retag, or touch
 *     trip-level fields, companions or contacts.
 *   - Any tripId not already in the index is a new trip: any logged-in
 *     account may create one and becomes its permanent Superuser.
 *
 * A trip's content key is written only when its content actually changed
 * (JSON-string comparison against storage) -- editing Trip A never
 * touches Trip B's key even though B is normally included in what the
 * browser resubmits. The index is rewritten only on create/delete/
 * rename/date/currency change -- ordinary item edits never touch it.
 */
async function handlePost(request, env, user) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_BODY_BYTES) return jsonError(413, "Request body too large.");

  const bodyText = await request.text();
  if (bodyText.length > MAX_BODY_BYTES) return jsonError(413, "Request body too large.");
  if (!bodyText) return jsonError(400, "Request body was empty.");

  let submitted;
  try {
    submitted = JSON.parse(bodyText);
  } catch (err) {
    return jsonError(400, "Request body was not valid JSON.");
  }
  if (!submitted || !Array.isArray(submitted.trips)) {
    return jsonError(400, "Request body didn't look like trip data (expected { trips: [...] }).");
  }
  try {
    submitted.trips.forEach(function (trip) {
      if (!trip || typeof trip !== "object") throw new Error("Invalid trip entry.");
      safeId(trip.tripId, false);
      sanitizeTripContent(trip);
    });
  } catch (err) {
    return jsonError(400, err && err.message ? err.message : "Invalid trip data.");
  }

  const index = await loadTripIndex(env);
  const indexById = {};
  index.trips.forEach(function (t) { indexById[t.tripId] = t; });

  const submittedById = {};
  submitted.trips.forEach(function (t) { if (t && t.tripId) submittedById[t.tripId] = t; });

  /* ---- SAFETY PASS: work out what this save would DELETE, before
   * writing anything. A trip is deleted by being left out of what the
   * browser sends (there's no "delete" endpoint). That's fine when the
   * browser genuinely has the full picture, dangerous when it doesn't --
   * two cases this pass catches:
   *
   *   1. A trip whose content key couldn't be read. buildResponseState()
   *      skips such a trip in the GET response, so the browser never had
   *      it to send back -- treating that absence as "delete" would
   *      destroy a trip purely because a read failed. KV is eventually
   *      consistent (a just-written key can briefly read as missing
   *      elsewhere), so this is a real, reachable state.
   *   2. More than one trip missing at once. The UI only ever deletes one
   *      trip at a time behind a confirmation dialog, so two-or-more means
   *      the browser is working from a stale or empty copy of the data --
   *      applying it would wipe out everything that account can see.
   *      Rejecting the whole request is the only safe answer.
   *
   * A separate pass rather than a check in the main loop below, because it
   * must be able to reject the request having written nothing, and the
   * main loop writes as it goes.
   */
  const contentMissingForTripId = {};
  const plannedDeletions = [];
  for (const indexEntry of index.trips) {
    if (submittedById[indexEntry.tripId]) continue; // Present -- not a deletion.
    const perm = permissionForTrip(indexEntry, user);
    // Only a full-scope role can delete at all; for everyone else an
    // omission is already a no-op further down, so it isn't a deletion.
    if (!perm || perm.role === "viewer" || perm.role === "user") continue;
    const storedContent = await loadTripContent(env, indexEntry.tripId);
    if (storedContent === null) {
      contentMissingForTripId[indexEntry.tripId] = true;
      continue; // Case 1 above -- absence proves nothing, so never a deletion.
    }
    plannedDeletions.push(indexEntry.tripId);
  }
  if (plannedDeletions.length > 1) {
    return jsonError(409,
      "That save would have deleted " + plannedDeletions.length + " trips at once, which the app never does on purpose — " +
      "so it was rejected and nothing was changed. This usually means this page's copy of your trips is out of date " +
      "or failed to load. Refresh the page and try your change again.");
  }

  // Optimistic-concurrency preflight: reject a stale browser snapshot before
  // writing anything. Existing KV documents start at revision zero and pick
  // up a server-owned revision on their first actual change.
  const storedContentByTripId = {};
  for (const indexEntry of index.trips) {
    const incoming = submittedById[indexEntry.tripId];
    if (!incoming) continue;
    const perm = permissionForTrip(indexEntry, user);
    if (!perm || perm.role === "viewer") continue;
    const storedContent = await loadTripContent(env, indexEntry.tripId);
    storedContentByTripId[indexEntry.tripId] = storedContent;
    if (storedContent === null) continue;
    const storedRevision = Number.isInteger(storedContent._revision) ? storedContent._revision : 0;
    const incomingRevision = Number.isInteger(incoming.revision) ? incoming.revision : 0;
    if (incomingRevision !== storedRevision) {
      return jsonError(409, "This trip changed in another session. Refresh to load the newest version before saving again.");
    }
  }

  let indexChanged = false;
  const nextIndexTrips = [];
  const revisions = {};

  // ---- Every EXISTING trip: apply exactly what this account's REAL
  // permission on it (from the stored index) allows. ----
  for (const indexEntry of index.trips) {
    const perm = permissionForTrip(indexEntry, user);
    const incoming = submittedById[indexEntry.tripId];

    if (!perm || perm.role === "viewer") {
      // No access, or read-only: completely untouched, content key not
      // even read.
      nextIndexTrips.push(indexEntry);
      continue;
    }

    if (perm.role === "superuser" || perm.role === "admin") {
      if (!incoming) {
        if (contentMissingForTripId[indexEntry.tripId]) {
          // Case 1 from the safety pass: we couldn't read this trip's
          // content, so the browser was never shown it and its absence
          // here means nothing. Keep the index entry exactly as it is --
          // if the content turns up on a later read (KV catching up), the
          // trip simply reappears, intact.
          nextIndexTrips.push(indexEntry);
          continue;
        }
        // Left out by a full-scope account -> deleted.
        await deleteTripContent(env, indexEntry.tripId);
        indexChanged = true;
        continue;
      }
      const newContent = stripClientOwnershipFields(incoming);
      const storedContent = Object.prototype.hasOwnProperty.call(storedContentByTripId, indexEntry.tripId)
        ? storedContentByTripId[indexEntry.tripId]
        : await loadTripContent(env, indexEntry.tripId);
      // accountId is protected like ownerId/tripId -- see COMPANIONS &
      // AVATARS near AVATAR_COLOR_TOKENS. Reasserted rather than deleted,
      // or every existing account link would be erased on the next save.
      if (newContent.companions) {
        newContent.companions = reconcileCompanionAccountLinks(storedContent, newContent.companions);
      }
      const storedComparable = storedContent ? sanitizeTripContent(storedContent) : null;
      const storedRevision = Number.isInteger(storedContent && storedContent._revision) ? storedContent._revision : 0;
      if (JSON.stringify(newContent) !== JSON.stringify(storedComparable)) {
        newContent._revision = storedRevision + 1;
        await saveTripContent(env, indexEntry.tripId, newContent);
        revisions[indexEntry.tripId] = newContent._revision;
      } else {
        revisions[indexEntry.tripId] = storedRevision;
      }
      const nextEntry = Object.assign({}, indexEntry, {
        name: newContent.name || "",
        startDate: newContent.startDate || "",
        endDate: newContent.endDate || "",
        homeCurrency: newContent.homeCurrency || "",
        // ownerId/grants deliberately NOT taken from newContent -- they
        // were never in it (stripClientOwnershipFields removed them, and
        // the frontend doesn't send them for a full-scope save anyway) --
        // this keeps indexEntry's existing ownerId/grants exactly as they
        // were, unless /api/trip-grants changes them.
      });
      if (JSON.stringify(nextEntry) !== JSON.stringify(indexEntry)) indexChanged = true;
      nextIndexTrips.push(nextEntry);
      continue;
    }

    // perm.role === "user": scoped read/write.
    if (!incoming) {
      // A "user" grant can't delete the trip -- if it's missing from what
      // they sent (shouldn't happen, the UI never offers it), the safe
      // thing is to just leave it exactly as it was.
      nextIndexTrips.push(indexEntry);
      continue;
    }
    const storedContent = Object.prototype.hasOwnProperty.call(storedContentByTripId, indexEntry.tripId)
      ? storedContentByTripId[indexEntry.tripId]
      : await loadTripContent(env, indexEntry.tripId);
    const mergedContent = mergeUserScopedTrip(storedContent, incoming, perm.companionId);
    if (JSON.stringify(mergedContent) !== JSON.stringify(storedContent)) {
      mergedContent._revision = (Number.isInteger(storedContent && storedContent._revision) ? storedContent._revision : 0) + 1;
      await saveTripContent(env, indexEntry.tripId, mergedContent);
      revisions[indexEntry.tripId] = mergedContent._revision;
    } else {
      revisions[indexEntry.tripId] = Number.isInteger(storedContent && storedContent._revision) ? storedContent._revision : 0;
    }
    nextIndexTrips.push(indexEntry); // A "user" grant never changes name/dates/ownership.
  }

  // ---- Anything submitted that ISN'T an existing trip id is brand new --
  // any logged-in account may create one, becoming its Superuser. ----
  const createdTripIds = {};
  for (const incoming of submitted.trips) {
    if (!incoming || !incoming.tripId) continue;
    if (indexById[incoming.tripId]) continue; // Already handled above.
    // A malformed body listing the same brand-new tripId twice would
    // otherwise add it to the index twice, leaving a duplicate entry that
    // nothing else in this file expects.
    if (createdTripIds[incoming.tripId]) continue;
    createdTripIds[incoming.tripId] = true;
    const newContent = stripClientOwnershipFields(incoming);
    // A brand-new trip has no stored content yet, so `storedContent` is
    // null here -- reconcileCompanionAccountLinks() treats that as "no
    // companion can be pre-linked", stripping accountId from every one
    // of them. Same reasoning as the existing-trip branch above.
    if (newContent.companions) {
      newContent.companions = reconcileCompanionAccountLinks(null, newContent.companions);
    }
    newContent._revision = 1;
    await saveTripContent(env, incoming.tripId, newContent);
    revisions[incoming.tripId] = 1;
    nextIndexTrips.push({
      tripId: incoming.tripId,
      name: newContent.name || "",
      startDate: newContent.startDate || "",
      endDate: newContent.endDate || "",
      homeCurrency: newContent.homeCurrency || "",
      ownerId: user.id,
      grants: [],
    });
    indexChanged = true;
  }

  if (indexChanged) {
    await saveTripIndex(env, { trips: nextIndexTrips });
  }

  return new Response(JSON.stringify({ status: "ok", revisions: revisions }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// Never let a client-submitted trip smuggle its own idea of who owns it,
// who it's shared with, or its permission into storage -- those fields
// only exist in a GET response as a UI convenience and are always
// recomputed server-side. Also strips tripId, which lives in the index/KV
// key, never inside a trip's own content document.
function stripClientOwnershipFields(trip) {
  return sanitizeTripContent(trip);
}

/**
 * Applies a "user" grant's edits to a trip's CONTENT: only fields on items
 * that already existed and were tagged with `companionId` in both the
 * stored and submitted version get updated. Everything else -- trip
 * name/dates/notes, contacts, other people's items -- comes back exactly
 * as stored, no matter what the client sent. This is what makes a "user"
 * grant safe to give write access to: even a buggy or compromised client
 * can't reach outside its own tagged items. (ownerId/grants live only in
 * the index, which a "user" grant never touches.)
 *
 * One exception (Phase 3 of Companions/Avatars): a "user" grant may
 * APPEND a brand-new companion (see mergeUserScopedCompanions()) but
 * can't rename, delete, retag, or set an accountId on any companion, new
 * or existing (see COMPANIONS & AVATARS near AVATAR_COLOR_TOKENS).
 */
function mergeUserScopedTrip(storedContent, incomingContent, companionId) {
  // `storedContent` can legitimately be null -- an index entry whose
  // content key couldn't be read (see loadTripContent()). Guarding here
  // rather than assuming an object matters: without it this function
  // throws a TypeError on `storedContent[listKey]` and the whole save
  // fails with a 500, for every trip in the request, not just this one.
  const stored = storedContent || {};
  const merged = Object.assign({}, stored); // Start from stored truth.
  ["destinations", "activities", "accommodation", "transport"].forEach(function (listKey) {
    merged[listKey] = mergeUserScopedList(stored[listKey] || [], incomingContent[listKey] || [], companionId, listItemIdField(listKey), listKey);
  });
  merged.companions = mergeUserScopedCompanions(stored.companions, incomingContent.companions);
  return merged;
}

// Sanity backstop on how many companions one trip can ever hold -- not a
// real business rule (this app is built for a friends-and-family group,
// see MAX_USERS' own comment for the same reasoning), just cheap
// insurance against a runaway script or a mistake appending hundreds of
// companions by accident.
const MAX_COMPANIONS_PER_TRIP = 100;

// The Phase-3 half of mergeUserScopedTrip(): lets a "user" grant APPEND a
// brand-new companion, nothing more. Every existing companion in
// `storedCompanions` is carried through untouched -- no rename, delete,
// re-color, or account link, no matter what `incomingCompanions` sends
// for it. A genuinely new companion (unrecognized companionId) is
// rebuilt from scratch out of only the two fields a "user" grant may
// specify -- name and an optional smiley color -- rather than trusting
// the submitted object. Stricter than mergeUserScopedList() below: a
// "user" grant doesn't own the companion it's adding, so there's no
// "their own data" here to trust, only a name to accept.
function mergeUserScopedCompanions(storedCompanions, incomingCompanions) {
  const stored = storedCompanions || [];
  const storedIds = {};
  stored.forEach(function (c) { storedIds[c.companionId] = true; });

  const appended = [];
  const seenNewIds = {};
  (incomingCompanions || []).forEach(function (c) {
    if (!c || !c.companionId) return;
    if (storedIds[c.companionId]) return; // Already exists -- can't be edited this way, see above.
    if (seenNewIds[c.companionId]) return; // Same new id submitted twice in one request.
    if (stored.length + appended.length >= MAX_COMPANIONS_PER_TRIP) return;
    const name = String(c.name || "").trim().slice(0, 80);
    if (!name) return; // A companion needs at least a name to be worth adding.
    seenNewIds[c.companionId] = true;
    const sanitized = { companionId: c.companionId, name: name };
    const smiley = c.avatar && c.avatar.smiley;
    if (isValidAvatarColor(smiley)) sanitized.avatar = { smiley: smiley };
    // Deliberately no `notes` and no `accountId` -- name + an optional
    // smiley colour is the whole of what a "user" grant may specify
    // about a companion they're adding (see the plan doc's Phase 3).
    appended.push(sanitized);
  });
  return stored.concat(appended);
}

// Which id field each of a trip's item lists uses -- see the "SCHEMA NOTE"
// comment near the top of this file. Centralised here so
// mergeUserScopedList() stays generic across all four list types rather
// than needing a copy of itself per type.
function listItemIdField(listKey) {
  return {
    destinations: "destinationId",
    activities: "activityId",
    accommodation: "accommodationId",
    transport: "transportId",
  }[listKey];
}

function mergeUserScopedList(storedList, incomingList, companionId, idField, listKey) {
  const incomingById = {};
  incomingList.forEach(function (item) { if (item && item[idField]) incomingById[item[idField]] = item; });
  const taggedTo = function (item) { return (item.companions || []).indexOf(companionId) !== -1; };

  return storedList.map(function (storedItem) {
    if (!taggedTo(storedItem)) return storedItem; // Not theirs -- untouched.
    const incomingItem = incomingById[storedItem[idField]];
    if (!incomingItem) return storedItem; // Can't delete -- keep it.
    if (!taggedTo(incomingItem)) return storedItem; // Can't un-tag themselves -- ignore the attempt.
    // Apply their edits, but the item's own id/companions always stay as
    // stored -- a "user" grant can change an item's OTHER fields, never
    // which item it is or who it's tagged to.
    // Explicit schema copy prevents arbitrary properties from surviving a
    // scoped edit and becoming stored XSS in a privileged user's browser.
    const applied = sanitizeItem(listKey, incomingItem);
    applied[idField] = storedItem[idField];
    applied.companions = storedItem.companions;
    return applied;
  });
  // Any id present in `incomingList` but not in `storedList` (a brand-new
  // item) is silently dropped here -- a "user" grant can't create items,
  // only edit ones that already exist and are already theirs.
}

/* ---- Route handlers: sharing a trip (grant / revoke) ----
 * A trip's Superuser (owner or uber-user) can grant any role, including
 * Admin. An "admin" grant can also share the trip, but only as User or
 * Viewer, never Admin -- creating another Admin stays the owner's call
 * alone. Both handlers check this against the real stored ownerId/grants
 * on the trip's index entry, never anything the client claims. ---- */

async function handleTripGrantsUpsert(request, env, user) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError(400, "Request body was not valid JSON.");
  }
  const tripId = body.tripId;
  const username = (body.username || "").trim();
  const role = body.role;
  const companionId = (body.companionId || "").trim();
  const replaceAccountId = (body.replaceAccountId || "").trim();
  if (!tripId) return jsonError(400, "No trip specified.");
  if (!username) return jsonError(400, "Enter the username to share this trip with.");
  if (GRANT_ROLES.indexOf(role) === -1) return jsonError(400, "Role must be admin, user or viewer.");
  if ((role === "user" || role === "viewer") && !companionId) {
    return jsonError(400, "Pick which companion this person is, so their access is scoped correctly.");
  }

  const index = await loadTripIndex(env);
  const indexEntry = index.trips.find(function (t) { return t.tripId === tripId; });
  if (!indexEntry) return jsonError(404, "That trip no longer exists.");
  const perm = permissionForTrip(indexEntry, user);
  if (!perm || (perm.role !== "superuser" && perm.role !== "admin")) {
    return jsonError(403, "Only this trip's owner or an Admin can share it.");
  }
  if (role === "admin" && perm.role !== "superuser") {
    // An Admin grant can share as User/Viewer, but granting someone ELSE
    // Admin access stays the owner's call alone -- see the class comment
    // above.
    return jsonError(403, "Only this trip's owner can grant Admin access.");
  }
  if (perm.role === "admin" && replaceAccountId) {
    const replacedGrant = (indexEntry.grants || []).find(function (g) { return g.accountId === replaceAccountId; });
    if (replacedGrant && replacedGrant.role === "admin") {
      return jsonError(403, "Only this trip's owner can replace another Admin's access.");
    }
  }

  const usersDoc = await loadUsers(env);
  const targetAccount = usersDoc.users.find(function (u) { return u.username.toLowerCase() === username.toLowerCase(); });
  if (!targetAccount) return jsonError(404, "No account with that username exists yet — ask the site owner to create one first.");
  if (targetAccount.id === indexEntry.ownerId) return jsonError(400, "That account already owns this trip.");
  if (targetAccount.isUberUser) return jsonError(400, "That account already has full access to everything.");
  let content = null;
  if (role === "user" || role === "viewer") {
    content = await loadTripContent(env, tripId);
    const companionExists = (content && content.companions || []).some(function (c) { return c.companionId === companionId; });
    if (!companionExists) return jsonError(400, "That companion isn't on this trip.");
  }

  // Upsert the target and, when relinking a companion, remove the previous
  // account's grant in this same write, so it can't retain invisible access.
  indexEntry.grants = (indexEntry.grants || []).filter(function (g) {
    return g.accountId !== targetAccount.id && (!replaceAccountId || g.accountId !== replaceAccountId);
  });
  indexEntry.grants.push({ accountId: targetAccount.id, role: role, companionId: role === "admin" ? "" : companionId });
  await saveTripIndex(env, index);

  // Sharing a trip as a specific companion (User/Viewer) also sets that
  // companion's account link (see COMPANIONS & AVATARS near
  // AVATAR_COLOR_TOKENS); assignCompanionAccountId() clears this account
  // off any other companion already linked to it. A second, separate KV
  // write (the grant lives in the index, the link in the trip content) --
  // if it fails partway, the grant still exists and the avatar just falls
  // back to "not linked yet" until retried, rather than the share failing.
  if (content && (role === "user" || role === "viewer")) {
    const linkedContent = assignCompanionAccountId(content, companionId, targetAccount.id);
    await saveTripContent(env, tripId, linkedContent);
  }

  return new Response(JSON.stringify({ status: "ok", grants: resolveGrants(indexEntry, usersDoc) }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function handleTripGrantsRevoke(request, env, user) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError(400, "Request body was not valid JSON.");
  }
  const tripId = body.tripId;
  const accountId = body.accountId;
  if (!tripId || !accountId) return jsonError(400, "Missing trip or account.");

  const index = await loadTripIndex(env);
  const indexEntry = index.trips.find(function (t) { return t.tripId === tripId; });
  if (!indexEntry) return jsonError(404, "That trip no longer exists.");
  const perm = permissionForTrip(indexEntry, user);
  if (!perm || (perm.role !== "superuser" && perm.role !== "admin")) {
    return jsonError(403, "Only this trip's owner or an Admin can change who has access to it.");
  }
  if (perm.role === "admin") {
    // An Admin can revoke a User/Viewer they (or the owner) shared with,
    // but can't remove another Admin's access -- symmetric with not
    // being able to GRANT Admin access, above. Revoking a grant that
    // doesn't exist is harmless either way (the filter below is a no-op),
    // so this only needs to check the case that actually matters.
    const targetGrant = (indexEntry.grants || []).find(function (g) { return g.accountId === accountId; });
    if (targetGrant && targetGrant.role === "admin") {
      return jsonError(403, "Only this trip's owner can remove another Admin's access.");
    }
  }

  indexEntry.grants = (indexEntry.grants || []).filter(function (g) { return g.accountId !== accountId; });
  await saveTripIndex(env, index);
  // Deliberately does not clear the revoked account's companion.accountId
  // link (see COMPANIONS & AVATARS) -- revoking access doesn't mean
  // they've stopped being a genuine companion, so their avatar keeps
  // showing for everyone else. Use handleCompanionLink() below
  // (accountId: null) if the link itself needs undoing too.
  return new Response(JSON.stringify({ status: "ok" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Standalone action for linking (or, with empty `username`, unlinking) a
 * companion to an account without necessarily granting trip access --
 * e.g. giving an already-Admin account its own avatar as a companion, or
 * fixing a mislinked companion from handleTripGrantsUpsert() above. Same
 * permission bar as sharing (Superuser or Admin) -- linking grants no new
 * access, but it's still identity data a scoped role shouldn't touch.
 *
 * Looks up a `username`, like /api/trip-grants above, rather than a raw
 * accountId, so this endpoint never needs the full account list handed
 * to an Admin who (unlike the site owner) can't open "Manage accounts".
 */
async function handleCompanionLink(request, env, user) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError(400, "Request body was not valid JSON.");
  }
  const tripId = body.tripId;
  const companionId = body.companionId;
  const username = (body.username || "").trim(); // Empty -> unlink.
  if (!tripId || !companionId) return jsonError(400, "Missing trip or companion.");

  const index = await loadTripIndex(env);
  const indexEntry = index.trips.find(function (t) { return t.tripId === tripId; });
  if (!indexEntry) return jsonError(404, "That trip no longer exists.");
  const perm = permissionForTrip(indexEntry, user);
  if (!perm || (perm.role !== "superuser" && perm.role !== "admin")) {
    return jsonError(403, "Only this trip's owner or an Admin can link a companion to an account.");
  }

  const content = await loadTripContent(env, tripId);
  const companion = (content && content.companions || []).find(function (c) { return c.companionId === companionId; });
  if (!companion) return jsonError(404, "That companion isn't on this trip.");

  let accountId = null;
  if (username) {
    const usersDoc = await loadUsers(env);
    const account = usersDoc.users.find(function (u) { return u.username.toLowerCase() === username.toLowerCase(); });
    if (!account) return jsonError(404, "No account with that username exists yet — ask the site owner to create one first.");
    accountId = account.id;
  }

  const linkedContent = assignCompanionAccountId(content, companionId, accountId);
  await saveTripContent(env, tripId, linkedContent);
  return new Response(JSON.stringify({ status: "ok" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// Only forward something that looks like a real flight number (letters
// and digits, sensible length) and a real calendar date -- not a security
// boundary (both get URL-encoded anyway), just a cheap way to fail fast
// instead of sending obvious junk to a third party.
const FLIGHT_NUMBER_PATTERN = /^[A-Z0-9]{2,8}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// AeroDataBox is accessed the same way for everyone via RapidAPI: this
// fixed host, plus a personal API key.
const AERODATABOX_HOST = "aerodatabox.p.rapidapi.com";

/**
 * Reverse-looks-up a flight number + date (e.g. "BA15" on 2026-09-03)
 * into its airline, origin/destination airports, and scheduled local
 * departure/arrival, by proxying to the AeroDataBox API
 * (https://aerodatabox.com/) via RapidAPI. Server-side rather than
 * called from the page: keeps the RapidAPI key out of public JS, keeps
 * every outbound call to one place (easy to swap providers), and turns a
 * flaky upstream or quota problem into a clean error instead of a raw
 * fetch failure landing in the form.
 *
 * Requires the secret AERODATABOX_API_KEY in the Cloudflare dashboard
 * (Workers & Pages → waypoint-app → Settings → Variables and Secrets).
 * Sign up free at https://rapidapi.com/aedbx-aedbx/api/aerodatabox; the
 * free tier comfortably covers personal, occasional use.
 */
async function handleFlightLookup(url, env) {
  const flightNumber = (url.searchParams.get("flightNumber") || "").trim().toUpperCase();
  const date = (url.searchParams.get("date") || "").trim();

  if (!flightNumber) {
    return jsonError(400, "No flight number given.");
  }
  if (!FLIGHT_NUMBER_PATTERN.test(flightNumber)) {
    return jsonError(400, "That doesn't look like a flight number (letters and digits only, e.g. BA15).");
  }
  if (!date) {
    return jsonError(400, "No date given — flight schedules are looked up per date.");
  }
  if (!DATE_PATTERN.test(date)) {
    return jsonError(400, "That doesn't look like a date (expected YYYY-MM-DD).");
  }

  if (!env.AERODATABOX_API_KEY) {
    return jsonError(501, "Flight lookup isn't set up yet — add the AERODATABOX_API_KEY secret in the Cloudflare dashboard first.");
  }

  // Don't let a slow upstream hang the Worker (and the person's form)
  // indefinitely.
  const controller = new AbortController();
  const timeout = setTimeout(function () { controller.abort(); }, 8000);

  let upstreamResponse;
  try {
    // withLocation=true includes each airport's lat/lon, used by the
    // frontend as a fallback coordinate source for airports outside its
    // curated shortlist (see COMMON_AIRPORTS in data/airports.js, and
    // index.html's airportCoordsFromText()/lastFlightLookupCoords).
    // Everything else (aircraft image, flight plan) stays off, unused.
    const apiUrl = "https://" + AERODATABOX_HOST + "/flights/Number/" + encodeURIComponent(flightNumber) +
      "/" + encodeURIComponent(date) + "?withLocation=true&withAircraftImage=false&withFlightPlan=false";
    upstreamResponse = await fetch(apiUrl, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "X-RapidAPI-Key": env.AERODATABOX_API_KEY,
        "X-RapidAPI-Host": AERODATABOX_HOST,
      },
    });
  } catch (err) {
    return jsonError(502, "Couldn't reach the flight lookup service — try again in a moment.");
  } finally {
    clearTimeout(timeout);
  }

  if (upstreamResponse.status === 404) {
    return jsonError(404, "No flight found for that number and date.");
  }
  if (upstreamResponse.status === 401 || upstreamResponse.status === 403) {
    return jsonError(502, "AeroDataBox rejected the request — double-check the API key, and that your RapidAPI plan includes this endpoint.");
  }
  if (upstreamResponse.status === 429) {
    return jsonError(429, "Hit the AeroDataBox rate/quota limit — wait a moment (or check your RapidAPI usage) and try again.");
  }
  if (!upstreamResponse.ok) {
    return jsonError(502, "The flight lookup service had a problem — try again in a moment.");
  }

  let flights;
  try {
    flights = await upstreamResponse.json();
  } catch (err) {
    return jsonError(502, "The flight lookup service returned something unexpected.");
  }

  if (!Array.isArray(flights) || !flights.length) {
    return jsonError(404, "No flight found for that number and date.");
  }

  // A flight number can occasionally match more than one actual flight
  // on the same date (codeshares, or a number reused later that day) —
  // AeroDataBox returns all of them. There's no good way to guess
  // which one the viewer meant, so this just uses the first and says
  // how many others there were, so a wrong pick is at least visible
  // rather than silently swallowed.
  const flight = flights[0];

  const result = {
    airline: (flight.airline && flight.airline.name) || "",
    aircraft: (flight.aircraft && flight.aircraft.model) || "",
    origin: airportSummary(flight.departure && flight.departure.airport),
    destination: airportSummary(flight.arrival && flight.arrival.airport),
    departure: movementSummary(flight.departure),
    arrival: movementSummary(flight.arrival),
    matchCount: flights.length,
  };

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/* -------------------------------------------------------------------------
 * Location search and boundary storage
 *
 * The browser only sees Waypoint's own result shape. LocationIQ's access
 * token, response quirks and OSM identifiers remain behind this adapter.
 * A saved destination references a shared boundary record; opening a map
 * never calls the provider, only reads that record from KV.
 * ---------------------------------------------------------------------- */

const LOCATIONIQ_AUTOCOMPLETE_URL = "https://api.locationiq.com/v1/autocomplete";
const LOCATIONIQ_LOOKUP_URL = "https://us1.locationiq.com/v1/lookup";
const LOCATIONIQ_ATTRIBUTION = { label: "Search by LocationIQ.com", url: "https://locationiq.com/" };
const LOCATION_CONTEXT_VALUES = new Set(["activity", "accommodation", "airport", "rail", "bus", "port", "transport", "destination"]);
const LOCATION_SEARCH_WINDOW_MS = 15 * 60 * 1000;
const LOCATION_SEARCH_MAX_PER_WINDOW = 36;

function locationResponse(status, body) {
  return new Response(JSON.stringify(body), { status: status, headers: { "Content-Type": "application/json" } });
}

function locationError(status, code, message) {
  return locationResponse(status, { error: message, code: code });
}

function locationBbox(value) {
  if (!Array.isArray(value) || value.length !== 4) return null;
  // Nominatim-shaped LocationIQ results use [minLat, maxLat, minLng,
  // maxLng] strings. Normalize once, here, into GeoJSON-style bounds.
  const south = Number(value[0]);
  const north = Number(value[1]);
  const west = Number(value[2]);
  const east = Number(value[3]);
  if (![south, north, west, east].every(Number.isFinite) || south < -90 || north > 90 || west < -180 || east > 180 || south > north || west > east) return null;
  return [west, south, east, north];
}

function locationLabel(value) {
  return safeText(String(value || "").replace(/[_-]+/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); }), 80);
}

function locationGranularity(raw, area) {
  if (area) return "area";
  if (raw.class === "aeroway") return "airport";
  if (raw.class === "railway" || raw.type === "station" || raw.type === "halt") return "station";
  if (raw.class === "amenity" || raw.class === "tourism" || raw.class === "leisure") return "venue";
  if (raw.class === "place" || raw.type === "city" || raw.type === "town" || raw.type === "village") return "locality";
  return raw.address && (raw.address.road || raw.address.house_number) ? "address" : "unknown";
}

function locationScore(raw, context, area) {
  const tags = ((raw.class || "") + ":" + (raw.type || "")).toLowerCase();
  if (area) return /(place:|boundary:|park|reserve|protected)/.test(tags) ? 20 : 0;
  const wanted = {
    activity: /tourism:|amenity:(restaurant|cafe|bar|theatre|cinema)|leisure:/,
    accommodation: /tourism:(hotel|hostel|guest_house|camp_site|caravan_site|resort)|building:apartments/,
    airport: /aeroway:/,
    rail: /railway:(station|halt)|public_transport:/,
    bus: /amenity:bus_station|highway:bus_stop|public_transport:/,
    port: /amenity:ferry_terminal|harbour:|waterway:/,
    transport: /railway:|aeroway:|ferry|bus_station|public_transport:|harbour:/,
  };
  return wanted[context] && wanted[context].test(tags) ? 20 : 0;
}

function normalizeLocationResult(raw, kind, context) {
  const lat = Number(raw && raw.lat);
  const lng = Number(raw && raw.lon);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) return null;
  const osmType = String(raw.osm_type || "").toLowerCase();
  const osmId = String(raw.osm_id || "");
  const prefix = osmType === "node" ? "N" : (osmType === "way" ? "W" : (osmType === "relation" ? "R" : ""));
  const ref = prefix && /^\d{1,16}$/.test(osmId) ? "liq:" + prefix + osmId : "";
  const area = kind === "area";
  const primary = raw.name || (raw.namedetails && raw.namedetails.name) || String(raw.display_name || "").split(",")[0] || "Unnamed place";
  const result = {
    locationRef: ref,
    name: safeText(primary, 200),
    formattedAddress: safeText(raw.display_name || primary, 500),
    kindLabel: locationLabel(raw.type || raw.class || (area ? "area" : "place")),
    lat: lat,
    lng: lng,
    granularity: locationGranularity(raw, area),
    bbox: locationBbox(raw.boundingbox),
    boundaryRef: area && /^liq:[WR]\d{1,16}$/.test(ref) ? ref : "",
    _score: locationScore(raw, context, area) + Number(raw.importance || 0),
  };
  return result;
}

async function fetchLocationIQ(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(function () { controller.abort(); }, timeoutMs || 5000);
  try {
    return await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
  } finally {
    clearTimeout(timeout);
  }
}

async function takeLocationSearchSlot(env, user) {
  const key = "location-rate:v1:" + user.id;
  const now = Date.now();
  let record = null;
  try { record = JSON.parse(await env.WAYPOINT_KV.get(key)); } catch (err) { record = null; }
  if (!record || !Number.isFinite(record.startedAt) || now - record.startedAt >= LOCATION_SEARCH_WINDOW_MS) record = { startedAt: now, count: 0 };
  if (!Number.isFinite(record.count) || record.count < 0) record.count = 0;
  if (record.count >= LOCATION_SEARCH_MAX_PER_WINDOW) return false;
  record.count++;
  await env.WAYPOINT_KV.put(key, JSON.stringify(record));
  return true;
}

async function handleLocationSearch(url, env, user) {
  const query = (url.searchParams.get("q") || "").trim();
  const kind = (url.searchParams.get("kind") || "point").trim();
  const context = (url.searchParams.get("context") || "transport").trim();
  const country = (url.searchParams.get("country") || "").trim().toLowerCase();
  const lat = url.searchParams.get("lat");
  const lng = url.searchParams.get("lng");
  if (query.length < 2 || query.length > 200) return locationError(400, "INVALID_QUERY", "Enter at least two characters to search.");
  if (kind !== "point" && kind !== "area") return locationError(400, "INVALID_QUERY", "Invalid location search kind.");
  if (!LOCATION_CONTEXT_VALUES.has(context)) return locationError(400, "INVALID_QUERY", "Invalid location search context.");
  if (country && !/^[a-z]{2}$/.test(country)) return locationError(400, "INVALID_QUERY", "Invalid country filter.");
  if (!env.LOCATIONIQ_API_KEY) return locationError(501, "LOCATION_NOT_CONFIGURED", "Location search is not configured yet.");
  if (!(await takeLocationSearchSlot(env, user))) return locationError(429, "LOCATION_QUOTA_REACHED", "Too many location searches in a short time. Wait a few minutes or set a pin manually.");

  const upstream = new URL(LOCATIONIQ_AUTOCOMPLETE_URL);
  upstream.searchParams.set("key", env.LOCATIONIQ_API_KEY);
  upstream.searchParams.set("q", query);
  upstream.searchParams.set("limit", "10");
  upstream.searchParams.set("dedupe", "1");
  upstream.searchParams.set("normalizecity", "1");
  if (country) upstream.searchParams.set("countrycodes", country);
  const biasLat = Number(lat);
  const biasLng = Number(lng);
  if (lat !== null && lng !== null && lat !== "" && lng !== "" && Number.isFinite(biasLat) && biasLat >= -90 && biasLat <= 90 && Number.isFinite(biasLng) && biasLng >= -180 && biasLng <= 180) {
    const d = 0.5;
    upstream.searchParams.set("viewbox", [biasLng - d, biasLat + d, biasLng + d, biasLat - d].join(","));
  }

  let response;
  try {
    response = await fetchLocationIQ(upstream.toString(), 5000);
  } catch (err) {
    return locationError(504, "LOCATION_PROVIDER_TIMEOUT", "Location search timed out. Try again or set a pin manually.");
  }
  if (response.status === 404) return locationResponse(200, { results: [], attribution: LOCATIONIQ_ATTRIBUTION });
  if (response.status === 429) return locationError(429, "LOCATION_QUOTA_REACHED", "Location search has reached its free allowance. You can still use a typed location or set a pin manually.");
  if (response.status === 401 || response.status === 403) return locationError(502, "LOCATION_PROVIDER_UNAVAILABLE", "Location search is not available. Check the Worker secret and provider restrictions.");
  if (!response.ok) return locationError(502, "LOCATION_PROVIDER_UNAVAILABLE", "Location search is temporarily unavailable.");
  let rawResults;
  try {
    rawResults = await response.json();
  } catch (err) {
    return locationError(502, "LOCATION_PROVIDER_UNAVAILABLE", "Location search returned an unexpected response.");
  }
  const results = (Array.isArray(rawResults) ? rawResults : []).map(function (raw) {
    return normalizeLocationResult(raw, kind, context);
  }).filter(Boolean).sort(function (a, b) { return b._score - a._score; }).slice(0, 6).map(function (result) {
    delete result._score;
    return result;
  });
  return locationResponse(200, { results: results, attribution: LOCATIONIQ_ATTRIBUTION });
}

function geometryBbox(geometry) {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  const visit = function (value) {
    if (typeof value[0] === "number") {
      west = Math.min(west, value[0]); east = Math.max(east, value[0]);
      south = Math.min(south, value[1]); north = Math.max(north, value[1]);
      return;
    }
    value.forEach(visit);
  };
  visit(geometry.coordinates);
  return [west, south, east, north];
}

function sanitizeBoundaryGeometry(geometry) {
  if (!geometry || (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon") || !Array.isArray(geometry.coordinates)) return null;
  let positions = 0;
  let crossesAntimeridian = false;
  const sanitizeRing = function (ring) {
    if (!Array.isArray(ring) || ring.length < 4) return null;
    const out = [];
    let priorLng = null;
    for (const position of ring) {
      if (!Array.isArray(position) || position.length < 2) return null;
      const lng = Number(position[0]);
      const lat = Number(position[1]);
      if (!Number.isFinite(lng) || !Number.isFinite(lat) || lng < -180 || lng > 180 || lat < -90 || lat > 90) return null;
      if (priorLng !== null && Math.abs(lng - priorLng) > 180) crossesAntimeridian = true;
      priorLng = lng;
      positions++;
      if (positions > MAX_BOUNDARY_COORDINATES) return null;
      out.push([lng, lat]);
    }
    return out;
  };
  let coordinates;
  if (geometry.type === "Polygon") {
    coordinates = geometry.coordinates.map(sanitizeRing);
    if (coordinates.some(function (ring) { return !ring; })) return null;
  } else {
    coordinates = geometry.coordinates.map(function (polygon) {
      if (!Array.isArray(polygon)) return null;
      const out = polygon.map(sanitizeRing);
      return out.some(function (ring) { return !ring; }) ? null : out;
    });
    if (coordinates.some(function (polygon) { return !polygon; })) return null;
  }
  // Leaflet cannot safely render a wrapped ring without splitting it. Until
  // we add a true antimeridian splitter, a point fallback is honest and
  // avoids drawing a band across the whole world.
  if (crossesAntimeridian) return null;
  const output = { type: geometry.type, coordinates: coordinates };
  if (JSON.stringify(output).length > MAX_BOUNDARY_BYTES) return null;
  return output;
}

function boundaryKey(ref) { return "boundary:v1:" + ref; }

function parseBoundaryRecord(raw) {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    const geometry = sanitizeBoundaryGeometry(value.geometry);
    if (!geometry) return null;
    const geometryBounds = geometryBbox(geometry);
    const bbox = safeBbox(value.bbox, geometryBounds ? {
      lat: (geometryBounds[1] + geometryBounds[3]) / 2,
      lng: (geometryBounds[0] + geometryBounds[2]) / 2,
    } : null);
    if (!bbox.length) return null;
    return { geometry: geometry, geometryQuality: "exact_simplified", bbox: bbox, source: "openstreetmap" };
  } catch (err) {
    return null;
  }
}

async function getStoredBoundary(env, ref) {
  return parseBoundaryRecord(await env.WAYPOINT_KV.get(boundaryKey(ref)));
}

async function handleLocationBoundary(url, env, user) {
  const ref = (url.searchParams.get("ref") || "").trim();
  if (!SAFE_BOUNDARY_REF_PATTERN.test(ref)) return locationError(400, "INVALID_QUERY", "Invalid destination boundary reference.");
  const stored = await getStoredBoundary(env, ref);
  if (stored) return locationResponse(200, Object.assign({ ref: ref, attribution: LOCATIONIQ_ATTRIBUTION }, stored));
  if (!env.LOCATIONIQ_API_KEY) return locationError(501, "LOCATION_NOT_CONFIGURED", "Location search is not configured yet.");
  if (!(await takeLocationSearchSlot(env, user))) return locationError(429, "LOCATION_QUOTA_REACHED", "Too many location searches in a short time. Wait a few minutes or save this destination as a point.");

  const upstream = new URL(LOCATIONIQ_LOOKUP_URL);
  upstream.searchParams.set("key", env.LOCATIONIQ_API_KEY);
  upstream.searchParams.set("osm_ids", ref.slice(4));
  upstream.searchParams.set("polygon_geojson", "1");
  upstream.searchParams.set("polygon_threshold", "0.003");
  upstream.searchParams.set("format", "json");
  let response;
  try {
    response = await fetchLocationIQ(upstream.toString(), 5000);
  } catch (err) {
    return locationError(504, "LOCATION_PROVIDER_TIMEOUT", "Destination boundary lookup timed out.");
  }
  if (response.status === 404) return locationError(404, "NO_BOUNDARY", "No boundary is available for this destination.");
  if (response.status === 429) return locationError(429, "LOCATION_QUOTA_REACHED", "Location search has reached its free allowance.");
  if (!response.ok) return locationError(502, "LOCATION_PROVIDER_UNAVAILABLE", "Destination boundary lookup is unavailable.");
  let values;
  try { values = await response.json(); } catch (err) { return locationError(502, "LOCATION_PROVIDER_UNAVAILABLE", "Destination boundary lookup returned an unexpected response."); }
  const raw = Array.isArray(values) ? values[0] : null;
  const geometry = sanitizeBoundaryGeometry(raw && raw.geojson);
  if (!geometry) return locationError(404, "NO_BOUNDARY", "This destination has no usable boundary for the map.");
  const bbox = locationBbox(raw && raw.boundingbox) || geometryBbox(geometry);
  const record = { schemaVersion: 1, geometry: geometry, bbox: bbox, fetchedAt: new Date().toISOString() };
  await env.WAYPOINT_KV.put(boundaryKey(ref), JSON.stringify(record));
  return locationResponse(200, { ref: ref, geometry: geometry, geometryQuality: "exact_simplified", bbox: bbox, source: "openstreetmap", attribution: LOCATIONIQ_ATTRIBUTION });
}

async function handleLocationBoundaries(request, env) {
  let body;
  try { body = await request.json(); } catch (err) { return locationError(400, "INVALID_QUERY", "Boundary request body was invalid."); }
  const refs = Array.isArray(body && body.refs) ? body.refs : [];
  if (refs.length > 20) return locationError(400, "INVALID_QUERY", "Request no more than 20 destination boundaries at once.");
  const boundaries = {};
  for (const ref of Array.from(new Set(refs))) {
    if (typeof ref !== "string" || !SAFE_BOUNDARY_REF_PATTERN.test(ref)) continue;
    const stored = await getStoredBoundary(env, ref);
    if (stored) boundaries[ref] = stored;
  }
  return locationResponse(200, { boundaries: boundaries, attribution: LOCATIONIQ_ATTRIBUTION });
}

// `country` is read defensively — AeroDataBox may return `country.name`
// or just `countryCode` depending on the endpoint — trying the friendlier
// shape first and falling back rather than throwing; worst case is an
// empty string, which airportDisplay() (index.html) already treats as
// optional.
//
// `location` (present since the request passes withLocation=true) is
// reshaped to {lat, lng} to match the frontend's Map tab (Leaflet/
// Nominatim use "lng", AeroDataBox uses "lon"). Lets index.html fall back
// to a real coordinate for an airport outside its curated
// COMMON_AIRPORTS shortlist (see lastFlightLookupCoords in index.html)
// instead of asking Nominatim to guess at free text it sometimes can't
// resolve.
function airportSummary(airport) {
  if (!airport) return { code: "", name: "", municipality: "", country: "", location: null };
  return {
    code: airport.iata || airport.icao || "",
    name: airport.name || "",
    municipality: airport.municipalityName || "",
    country: (airport.country && airport.country.name) || airport.countryCode || "",
    location: (airport.location && typeof airport.location.lat === "number" && typeof airport.location.lon === "number")
      ? { lat: airport.location.lat, lng: airport.location.lon }
      : null,
  };
}

// Pulls the scheduled local date+time and terminal/gate out of one side
// (departure or arrival) of an AeroDataBox flight. AeroDataBox's "local"
// time strings look like "2026-09-03 14:35+01:00" (space not "T", plus a
// UTC offset) — rather than trust every browser's Date parser with that
// non-standard format (Safari especially), the date and time are pulled
// out with a simple pattern match and sent as plain strings that drop
// straight into <input type="date">/<input type="time"> with no parsing.
function movementSummary(movement) {
  var empty = { date: "", time: "", terminal: "", gate: "" };
  if (!movement) return empty;
  var timeInfo = movement.scheduledTime || movement.revisedTime;
  var match = timeInfo && timeInfo.local && /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/.exec(timeInfo.local);
  return {
    date: match ? match[1] : "",
    time: match ? match[2] : "",
    terminal: movement.terminal || "",
    gate: movement.gate || "",
  };
}

// ---- Accounts, password hashing, and sessions. Account records keep
// their plain `id` field rather than being renamed to `accountId` — see
// "SCHEMA" near the top of this file. ----

/**
 * Reads the account list out of KV. A brand-new install has none yet, so
 * this always resolves to a valid { users: [] } shape rather than null —
 * same trick loadTripIndex() plays for trip data.
 */
async function loadUsers(env) {
  const saved = await env.WAYPOINT_KV.get(USERS_KEY);
  if (saved === null) {
    const initialized = await env.WAYPOINT_KV.get(USERS_INITIALIZED_KEY);
    if (initialized === "1") throw new UsersStorageError("Account data is missing after initialization.");
    return { users: [] };
  }
  try {
    const parsed = JSON.parse(saved);
    if (!parsed || !Array.isArray(parsed.users)) throw new Error("Invalid users schema");
    return parsed;
  } catch (err) {
    throw new UsersStorageError("Account data is malformed.");
  }
}

async function saveUsers(env, usersDoc) {
  await env.WAYPOINT_KV.put(USERS_KEY, JSON.stringify(usersDoc));
  await env.WAYPOINT_KV.put(USERS_INITIALIZED_KEY, "1");
}

class UsersStorageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsersStorageError";
  }
}

// Strips everything sensitive (passwordSalt/passwordHash) before a user
// record is sent to a browser. Every response with account info goes
// through this. Deliberately omits `isUberUser` — see "undisclosed" at
// the top of this file: the client never needs to know who has that
// status, since permission checks already resolve to the same
// `{ role: "superuser" }` a genuine trip owner gets.
function publicUser(u) {
  return { id: u.id, username: u.username, createdAt: u.createdAt || "" };
}

// A short id for a new account — not cryptographically meaningful itself
// (that's the password hash/session signature's job), just unique enough
// to key a KV document's array by.
function newAccountId() {
  return "u_" + crypto.randomUUID();
}

/* ---- Password hashing (PBKDF2 via the Web Crypto API) --------------------
 * Cloudflare Workers use the standard Web Crypto API (crypto.subtle, no
 * Node `crypto` module). PBKDF2 turns a password into a fixed-length
 * block of bytes, deliberately slowly (see PBKDF2_ITERATIONS above),
 * mixing in a random salt so two people with the same password don't get
 * the same stored hash. Only the salt + hash are ever stored, never the
 * password; a guess is checked by hashing it the same way and comparing,
 * which is what verifyPassword() does.
 * ------------------------------------------------------------------------ */

function bytesToHex(bytes) {
  return Array.prototype.map.call(bytes, function (b) { return b.toString(16).padStart(2, "0"); }).join("");
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

async function pbkdf2(password, saltBytes) {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: saltBytes, iterations: PBKDF2_ITERATIONS },
    keyMaterial,
    PBKDF2_HASH_BYTES * 8
  );
  return bytesToHex(new Uint8Array(derived));
}

async function hashPassword(password) {
  const saltBytes = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await pbkdf2(password, saltBytes);
  return { salt: bytesToHex(saltBytes), hash: hash };
}

// Constant-time-ish comparison of two equal-length hex strings, so a
// timing attack can't narrow down a correct hash byte-by-byte.
function safeCompareHex(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifyPassword(password, saltHex, expectedHashHex) {
  const candidateHash = await pbkdf2(password, hexToBytes(saltHex));
  return safeCompareHex(candidateHash, expectedHashHex);
}

/* ---- Signed session cookies -----------------------------------------------
 * A session cookie is `<payload>.<signature>`, both base64url-encoded. The
 * payload is only ever `{ uid, exp }`. Nothing else travels in it: every
 * request re-reads the account's current record and re-resolves every
 * trip's permissions fresh from KV (see getCurrentUser(),
 * permissionForTrip()) rather than trusting anything decided at login —
 * so revoking access or deleting an account takes effect immediately, not
 * whenever the cookie expires. The signature is an HMAC-SHA256 over the
 * payload keyed by WAYPOINT_SESSION_SECRET; without that secret nobody
 * can forge a payload for a different account.
 * ------------------------------------------------------------------------ */

function base64UrlEncode(bytesOrString) {
  const bytes = typeof bytesOrString === "string" ? new TextEncoder().encode(bytesOrString) : bytesOrString;
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecodeToString(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
  return atob(padded);
}

async function hmacSign(message, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return base64UrlEncode(new Uint8Array(signature));
}

async function signSession(payload, env) {
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const signature = await hmacSign(payloadB64, env.WAYPOINT_SESSION_SECRET);
  return payloadB64 + "." + signature;
}

async function verifySession(token, env) {
  if (!token || !env.WAYPOINT_SESSION_SECRET) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, signature] = parts;
  const expectedSignature = await hmacSign(payloadB64, env.WAYPOINT_SESSION_SECRET);
  // Signatures are themselves base64url text of equal expected length when
  // valid — safe to compare with the same helper used for password hashes.
  if (signature.length !== expectedSignature.length || !safeCompareHex(signature, expectedSignature)) return null;
  let payload;
  try {
    payload = JSON.parse(base64UrlDecodeToString(payloadB64));
  } catch (err) {
    return null;
  }
  if (!payload || typeof payload.uid !== "string" || typeof payload.exp !== "number") return null;
  if (Date.now() > payload.exp) return null; // Expired.
  return payload;
}

function getCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  const parts = header.split(";");
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

// `Secure` requires HTTPS — fine for the real deployment (liddellworks.com
// is always https), but note for anyone adapting this for local testing
// over plain http: a `Secure` cookie is silently refused by the browser on
// a non-https origin, which is why this project's mock-server.js (used by
// the Playwright tests) deliberately builds its OWN, simpler cookie header
// without this attribute rather than reusing this function.
function buildSessionCookieHeader(token) {
  return SESSION_COOKIE_NAME + "=" + token + "; Path=/WayPoint; Max-Age=" + SESSION_MAX_AGE_SECONDS +
    "; HttpOnly; Secure; SameSite=Lax";
}

function buildClearCookieHeader() {
  return SESSION_COOKIE_NAME + "=; Path=/WayPoint; Max-Age=0; HttpOnly; Secure; SameSite=Lax";
}

/**
 * The one function nearly every request goes through: figures out which
 * account (if any) a request belongs to, by verifying the session cookie
 * and re-reading that account fresh out of KV (see "Signed session
 * cookies" above). Returns the full account record (passwordSalt/Hash/
 * isUberUser included) for internal use only; always pass it through
 * publicUser() before it reaches a response body.
 */
async function getCurrentUser(request, env) {
  const token = getCookie(request, SESSION_COOKIE_NAME);
  if (!token) return null;
  const payload = await verifySession(token, env);
  if (!payload) return null;
  const usersDoc = await loadUsers(env);
  const user = usersDoc.users.find(function (u) { return u.id === payload.uid; });
  if (!user) return null;
  if ((payload.sv || 0) !== (user.sessionVersion || 0)) return null;
  return user;
}

/* ---- Route handlers: login / logout / whoami / setup --------------------- */

async function handleLogin(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError(400, "Request body was not valid JSON.");
  }
  const username = (body.username || "").trim().toLowerCase();
  const password = body.password || "";
  if (!username || !password) return jsonError(400, "Username and password are both required.");
  if (username.length > 80 || typeof password !== "string" || password.length > 256) {
    return jsonError(400, "Username or password was too long.");
  }

  const attemptKey = (request.headers.get("CF-Connecting-IP") || "unknown") + ":" + username;
  const now = Date.now();
  const recent = (loginAttempts.get(attemptKey) || []).filter(function (time) { return now - time < LOGIN_WINDOW_MS; });
  if (recent.length >= LOGIN_MAX_ATTEMPTS) {
    return new Response(JSON.stringify({ error: "Too many login attempts. Wait a few minutes and try again." }), {
      status: 429,
      headers: { "Content-Type": "application/json", "Retry-After": String(Math.ceil(LOGIN_WINDOW_MS / 1000)) },
    });
  }
  recent.push(now);
  loginAttempts.set(attemptKey, recent);

  const usersDoc = await loadUsers(env);
  const user = usersDoc.users.find(function (u) { return u.username.toLowerCase() === username; });
  // Deliberately the same generic message whether the username doesn't
  // exist or the password's wrong — doesn't help an attacker narrow down
  // which one they got wrong, at basically no cost to a genuine user.
  const genericError = function () { return jsonError(401, "Incorrect username or password."); };
  // Unknown users still perform the same expensive derivation, closing the
  // measurable fast-path that otherwise reveals which usernames exist.
  const dummySalt = "00000000000000000000000000000000";
  const dummyHash = "0000000000000000000000000000000000000000000000000000000000000000";
  const passwordOk = await verifyPassword(password, user ? user.passwordSalt : dummySalt, user ? user.passwordHash : dummyHash);
  if (!user) return genericError();
  if (!passwordOk) return genericError();

  loginAttempts.delete(attemptKey);
  const token = await signSession({ uid: user.id, sv: user.sessionVersion || 0, exp: Date.now() + SESSION_MAX_AGE_SECONDS * 1000 }, env);
  // isUberUser is included here (and in handleWhoami/handleSetup), unlike
  // publicUser() -- this response only ever describes the caller's own
  // account, so there's no "undisclosed uber-user" leak. The frontend
  // needs this bit to show the "Manage accounts" button (applyAuthUI() in
  // index.html). `avatar` is always resolved (never null) so the topbar
  // has something to draw before the avatar picker is ever opened.
  return new Response(JSON.stringify({ status: "ok", id: user.id, username: user.username, isUberUser: !!user.isUberUser, avatar: resolveAccountAvatar(user) }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Set-Cookie": buildSessionCookieHeader(token) },
  });
}

async function handleLogout(request, env) {
  return new Response(JSON.stringify({ status: "ok" }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Set-Cookie": buildClearCookieHeader() },
  });
}

// Always 200 -- `loggedIn` in the body carries session state rather than
// the HTTP status, so the frontend's check is one plain fetch + read with
// no special-casing a 401. `setupNeeded` (true only when no account
// exists yet) tells it whether to show an ordinary login form or the
// one-time "create your account" screen (see handleSetup()).
async function handleWhoami(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user) {
    const usersDoc = await loadUsers(env);
    return new Response(JSON.stringify({ loggedIn: false, setupNeeded: usersDoc.users.length === 0 }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return new Response(JSON.stringify({ loggedIn: true, id: user.id, username: user.username, isUberUser: !!user.isUberUser, avatar: resolveAccountAvatar(user) }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * One-time bootstrap: creates the first account — the site owner's login,
 * which becomes the undisclosed "uber-user" with full access to
 * everything — gated by the WAYPOINT_PASSWORD secret (see the comment at
 * the top of this file). Refuses to run once any account exists, so it's
 * safe to leave reachable rather than removing it after first use.
 */
async function handleSetup(request, env) {
  const usersDoc = await loadUsers(env);
  if (usersDoc.users.length > 0) {
    return jsonError(403, "Setup has already been completed — ask the site owner for an account instead.");
  }
  if (!env.WAYPOINT_PASSWORD) {
    return jsonError(501, "Setup isn't available — the WAYPOINT_PASSWORD secret needs to be set first (Cloudflare dashboard -> Workers & Pages -> waypoint-app -> Settings -> Variables and Secrets).");
  }

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError(400, "Request body was not valid JSON.");
  }
  if (body.setupKey !== env.WAYPOINT_PASSWORD) {
    return jsonError(401, "Incorrect setup key.");
  }
  const username = (body.username || "").trim();
  const password = body.password || "";
  if (!username) return jsonError(400, "Choose a username.");
  if (password.length < 8) return jsonError(400, "Choose a password of at least 8 characters.");

  const { salt, hash } = await hashPassword(password);
  const user = {
    id: newAccountId(), username: username, passwordSalt: salt, passwordHash: hash,
    isUberUser: true, sessionVersion: 0, createdAt: new Date().toISOString(),
  };
  usersDoc.users.push(user);
  await saveUsers(env, usersDoc);

  const token = await signSession({ uid: user.id, sv: user.sessionVersion, exp: Date.now() + SESSION_MAX_AGE_SECONDS * 1000 }, env);
  return new Response(JSON.stringify({ status: "ok", id: user.id, username: user.username, isUberUser: true, avatar: resolveAccountAvatar(user) }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Set-Cookie": buildSessionCookieHeader(token) },
  });
}

/**
 * Self-service avatar picker's save action -- see COMPANIONS & AVATARS
 * near AVATAR_COLOR_TOKENS. `user` always comes from the current session
 * (getCurrentUser(), via fetch()'s auth check), never the request body,
 * so an account can only ever set its own avatar.
 */
async function handleAccountAvatarUpdate(request, env, user) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError(400, "Request body was not valid JSON.");
  }
  if (!isValidAvatarColor(body.color)) return jsonError(400, "Pick one of the available colours.");
  if (!isValidAvatarAnimal(body.animal)) return jsonError(400, "Pick one of the available animals.");

  const usersDoc = await loadUsers(env);
  const existing = usersDoc.users.find(function (u) { return u.id === user.id; });
  if (!existing) return jsonError(404, "That account no longer exists.");
  existing.avatar = { color: body.color, animal: body.animal };
  await saveUsers(env, usersDoc);

  return new Response(JSON.stringify({ status: "ok", avatar: resolveAccountAvatar(existing) }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/* ---- Route handlers: account management (site-owner / uber-user only,
   enforced in fetch() before these are called) ----
   Minimal, since roles/links live on trips, not accounts: create a
   login, reset its password, or delete it. Sharing a trip is the job of
   that trip's own Superuser, via /api/trip-grants above. ---------- */

async function handleUsersList(env) {
  const usersDoc = await loadUsers(env);
  return new Response(JSON.stringify({ users: usersDoc.users.map(publicUser) }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// Creates a new account, or resets an existing one's password / renames it
// if `body.id` is present. Handles both in one endpoint (rather than
// separate create/edit routes) since the Manage accounts screen in
// index.html always submits the same shape either way.
async function handleUsersUpsert(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError(400, "Request body was not valid JSON.");
  }
  const username = (body.username || "").trim();
  if (!username) return jsonError(400, "Username is required.");

  const usersDoc = await loadUsers(env);
  const usernameTaken = usersDoc.users.some(function (u) {
    return u.username.toLowerCase() === username.toLowerCase() && u.id !== body.id;
  });
  if (usernameTaken) return jsonError(409, "That username is already taken.");

  if (body.id) {
    // ---- Update an existing account (rename, and/or reset password) ----
    const existing = usersDoc.users.find(function (u) { return u.id === body.id; });
    if (!existing) return jsonError(404, "That account no longer exists.");
    existing.username = username;
    if (body.password) {
      if (body.password.length < 8) return jsonError(400, "Choose a password of at least 8 characters.");
      const { salt, hash } = await hashPassword(body.password);
      existing.passwordSalt = salt;
      existing.passwordHash = hash;
      existing.sessionVersion = (existing.sessionVersion || 0) + 1;
    }
    await saveUsers(env, usersDoc);
    return new Response(JSON.stringify({ status: "ok", user: publicUser(existing) }), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  // ---- Create a new account (never the uber-user -- that status only
  // ever comes from the one-time /api/setup bootstrap above) ----
  if (usersDoc.users.length >= MAX_USERS) return jsonError(400, "Reached the maximum number of accounts (" + MAX_USERS + ").");
  if (!body.password || body.password.length < 8) return jsonError(400, "Choose a password of at least 8 characters.");
  const { salt, hash } = await hashPassword(body.password);
  const user = {
    id: newAccountId(), username: username, passwordSalt: salt, passwordHash: hash,
    isUberUser: false, sessionVersion: 0, createdAt: new Date().toISOString(),
  };
  usersDoc.users.push(user);
  await saveUsers(env, usersDoc);
  return new Response(JSON.stringify({ status: "ok", user: publicUser(user) }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function countUberUsers(users) {
  return users.filter(function (u) { return u.isUberUser; }).length;
}

async function handleUsersDelete(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError(400, "Request body was not valid JSON.");
  }
  const usersDoc = await loadUsers(env);
  const existing = usersDoc.users.find(function (u) { return u.id === body.id; });
  if (!existing) return jsonError(404, "That account no longer exists.");
  if (existing.isUberUser && countUberUsers(usersDoc.users) <= 1) {
    return jsonError(400, "Can't delete the last remaining site-owner account.");
  }
  usersDoc.users = usersDoc.users.filter(function (u) { return u.id !== body.id; });
  await saveUsers(env, usersDoc);
  return new Response(JSON.stringify({ status: "ok" }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
