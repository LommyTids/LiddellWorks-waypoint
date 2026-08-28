/**
 * ============================================================================
 * Waypoint — Cloudflare Worker
 * ----------------------------------------------------------------------------
 * This is the tiny "server" half of the Waypoint travel planner. The other
 * half is the single HTML file in public/WayPoint/index.html, which is a
 * normal static web page (no build step, no framework) that runs entirely
 * in your browser.
 *
 * What this Worker actually does, in plain English:
 *
 *   1. If the request is for our JSON API (`/WayPoint/api/data`), handle it
 *      here directly — either read the saved trips out of Cloudflare KV
 *      (a simple key/value store, think of it like a single shared file)
 *      and send them back as JSON, or take a JSON body from the page and
 *      merge it safely into KV so it's there next time (see "Saving safely"
 *      below for why this is a merge, not a plain overwrite).
 *   2. `/WayPoint/api/flight-lookup` proxies a flight number + date (e.g.
 *      "BA15" on 2026-09-03) to the AeroDataBox API (via RapidAPI) and
 *      hands back its carrier, origin/destination airports, and scheduled
 *      local departure/arrival date+time — used to auto-fill the transport
 *      form when adding a flight. Requires the `AERODATABOX_API_KEY`
 *      secret (see handleFlightLookup() below for setup and for why this
 *      is a small server-side proxy rather than the page calling
 *      AeroDataBox directly with the key embedded in its public JS).
 *   3. `/WayPoint/api/login`, `/api/logout`, `/api/whoami` and `/api/setup`
 *      are the account/session system; `/api/trip-grants` and
 *      `/api/trip-grants/revoke` are how a trip gets shared with someone;
 *      `/api/users*` is the (site-owner-only) "create/delete a login"
 *      screen — see the big "Who is allowed in" section right below for
 *      how all of this fits together.
 *   4. For every other request (loading the page itself, any future CSS/JS/
 *      image files), just hand it off to Cloudflare's static asset serving
 *      (the `env.ASSETS` binding below) — that's what actually serves
 *      public/WayPoint/index.html. This is DELIBERATELY left open with no
 *      password check at all — see "Who is allowed in" for why that's fine
 *      (and in fact necessary for the login screen to even appear).
 *
 * ----------------------------------------------------------------------------
 * WHO IS ALLOWED IN (read this if you're new to this file)
 * ----------------------------------------------------------------------------
 * Permissions in Waypoint are PER TRIP, not one global role for an account.
 * Every trip has exactly one owner — whoever created it — who automatically
 * becomes that trip's "Superuser". A Superuser can then choose to share
 * their trip with other existing accounts, picking a role for each:
 *
 *   - Superuser (the owner; not something you can be "granted" — see
 *     ownerId below) — full read/write on the trip, AND the only one who
 *     can decide who else gets access to it (the "Share this trip" panel).
 *   - "admin"  — full read/write on that one trip, same as the Superuser,
 *                EXCEPT they can't grant or revoke anyone else's access —
 *                sharing stays the owner's call alone.
 *   - "user"   — can see and edit only the items on that trip already
 *                tagged with the one companion they've been linked to (see
 *                the Companions tab and the "tag-picker" fields in
 *                index.html) — e.g. their own accommodation, their own
 *                flights. They can change details on those items, but
 *                can't create new items, delete anything, retag anything,
 *                or touch the trip's own fields (name/dates/notes) or its
 *                companions/contacts list.
 *   - "viewer" — the same scoping as "user" (their own tagged items only),
 *                but read-only.
 *
 * A trip nobody has shared with you doesn't exist as far as you can tell —
 * it's left out of your data entirely, not just hidden in the UI.
 *
 * On top of all that, there is ALSO one single, undisclosed "uber-user"
 * account (the site owner's own login, set up once — see handleSetup()
 * below) that has full Superuser-equivalent access to EVERY trip, without
 * ever needing to be added to any trip's sharing list. This exists purely
 * so the site owner can always get in to fix something, even a trip they
 * didn't create and nobody thought to share with them. It's "undisclosed"
 * in the sense that nothing in the API response ever tells a browser "this
 * account is special" — every place that matters just sees the SAME
 * `{ role: "superuser" }` a real owner would see, so there's no separate
 * code path (and no separate flag) that could leak this account's status.
 *
 * Accounts live in KV under a second fixed key, USERS_KEY ("users") — a
 * small JSON document listing everyone and their (hashed, never
 * plain-text) password. An account record itself carries almost nothing —
 * just who they are and whether they're the uber-user — because every
 * actual permission lives on the TRIP (its `ownerId` and `grants[]`), not
 * on the account. See permissionForTrip() further down for exactly how a
 * trip + an account resolve into what that account may do.
 *
 * Passwords are never stored as typed: see hashPassword()/verifyPassword()
 * below for how PBKDF2 (a standard, slow-by-design hashing algorithm)
 * turns a password into something safe to keep in KV.
 *
 * Logging in (handleLogin) checks a username/password against that list
 * and, on success, hands back a signed *session cookie* — a small blob of
 * data (just "which account, and when this expires") that's cryptographically
 * signed with the WAYPOINT_SESSION_SECRET secret so it can't be forged or
 * edited by whoever's holding it. Every later request re-checks that
 * signature (see getCurrentUser()) and looks the account up fresh in KV,
 * and every trip's permissions are re-resolved fresh from KV too — so if
 * an owner revokes someone's access, or deletes their account, that takes
 * effect on their very next request, not just whenever their cookie
 * happens to expire.
 *
 * BOOTSTRAP PROBLEM: with no accounts yet, how does the very first account
 * (the site owner's, i.e. the uber-user) get created? This repurposes the
 * WAYPOINT_PASSWORD secret you already have set (from the old
 * single-password days) as a one-time "setup key" — see handleSetup()
 * below. Visit /WayPoint/api/setup once with that key to create your own
 * account; after that, the setup endpoint refuses to run again (there's
 * now at least one account), so WAYPOINT_PASSWORD isn't a standing
 * password for the app anymore — it's only ever used for that one
 * bootstrap step. You can leave it set (it's inert afterwards) or remove
 * it later; either is fine.
 *
 * IMPORTANT — this is still NOT a commercial-grade auth system. There's no
 * self-service signup, no "forgot password" email flow, no rate-limiting
 * on login attempts. That's a deliberate choice, matching how this was
 * described when this feature was requested: a personal app for a small,
 * trusted group (family/friends, expected to top out around 20 people),
 * where the site owner sets up and hands out every LOGIN themselves (see
 * /api/users below), and trip owners decide who gets to see/edit their own
 * trips from among those logins.
 *
 * Static files (the page itself, its CSS/JS, the vendored map library, the
 * airport/city/country data files) are served with NO auth check at all —
 * none of them contain any trip data or secrets; the actual data only ever
 * comes back through /api/data, which IS gated. Serving the shell openly
 * is what lets the page load far enough to show its own login form in the
 * first place.
 *
 * ----------------------------------------------------------------------------
 * SAVING SAFELY (the part of this file that matters most to get right)
 * ----------------------------------------------------------------------------
 * The frontend still works the simple way it always has: it keeps the
 * trips it knows about in one `state` object and POSTs the whole thing
 * back to /api/data whenever something changes. The wrinkle is that,
 * because trips are private-by-default now, any one account's copy of
 * `state.trips` is only ever a SUBSET — whatever GET handed them (see
 * buildResponseState() below). If this Worker just took that subset and
 * wrote it straight into KV, it would silently DELETE every trip that
 * account couldn't see. That would be a disaster the very first time a
 * "user"-role account (who can only see one trip) saved anything.
 *
 * So handlePost() below never does that. Instead, for every save, it:
 *   1. Loads the REAL, full, currently-stored state (not what the client
 *      sent).
 *   2. Works out — from that real stored data, never from anything the
 *      client claims — exactly what this account is allowed to change:
 *      the whole trip (Superuser/admin), just their own tagged items
 *      ("user"), or nothing at all (no access, or "viewer").
 *   3. Applies ONLY that, trip by trip, leaving everything else exactly
 *      as it was already stored.
 * See the big comment on handlePost() itself for the trip-by-trip rules in
 * full detail. The one thing this design guarantees is: no matter what an
 * account's browser sends, an account can never affect a trip (or, for a
 * "user" grant, an item) beyond what its OWN permissions on that trip
 * allow — the save endpoint enforces exactly the same boundaries the GET
 * endpoint does, just in reverse.
 * ============================================================================
 */

// A safety valve so a runaway request (or a bug in the frontend) can never
// fill up the KV namespace with an enormous payload. 5 MB is far more than
// even a very detailed set of trips should ever need as JSON text.
const MAX_BODY_BYTES = 5 * 1024 * 1024;

// The one fixed KV key everything is stored under. See the comment above —
// this is deliberately a single blob, not one key per trip.
const STATE_KEY = "state";

// The fixed KV key the account list lives under — a separate document from
// the trip data above, so listing/editing accounts never touches (or risks
// corrupting) anyone's trips, and vice versa.
const USERS_KEY = "users";

// A brand-new install has nothing in KV yet. Rather than the frontend
// having to guess what an "empty" trip list looks like, we hand back the
// same shape it would otherwise save: one object with an empty trips array.
const EMPTY_STATE = JSON.stringify({ trips: [] });

// Cap on how many accounts can exist, purely as a sanity backstop (this
// app was built for a friends-and-family group expected to top out around
// 20 people) — not a hard business rule, just cheap insurance against a
// runaway script or a mistake creating hundreds of accounts by accident.
const MAX_USERS = 200;

// The cookie that carries a signed session, and how long one lasts before
// needing to log in again. 30 days is generous on purpose — this is a
// low-stakes personal app on a handful of trusted people's own devices,
// not something that needs to force frequent re-logins.
const SESSION_COOKIE_NAME = "wp_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

// PBKDF2 password hashing parameters. 100,000 iterations of SHA-256 is a
// widely-used, comfortably-slow-enough setting for this kind of app (slow
// enough to make guessing passwords expensive, fast enough that logging in
// yourself is still instant) — see hashPassword()/verifyPassword() below.
const PBKDF2_ITERATIONS = 100000;
const PBKDF2_HASH_BYTES = 32; // 256 bits
const SALT_BYTES = 16;

// The only roles that can be GRANTED to someone on a trip (via
// /api/trip-grants below). "superuser" is deliberately not in this list —
// you can't grant Superuser status to someone, it only ever comes from
// having created the trip (trip.ownerId) — see permissionForTrip().
const GRANT_ROLES = ["admin", "user", "viewer"];

export default {
  async fetch(request, env, ctx) {
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

      // ---- Sharing a trip (grant/revoke) -- owner (or the uber-user)
      // only; enforced inside these handlers against the REAL stored
      // ownerId, never against anything the client claims. ----------------
      if (path === "/WayPoint/api/trip-grants") {
        if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
        return handleTripGrantsUpsert(request, env, user);
      }
      if (path === "/WayPoint/api/trip-grants/revoke" && request.method === "POST") {
        return handleTripGrantsRevoke(request, env, user);
      }

      // ---- Flight lookup (reverse: flight number -> carrier + route) --
      if (path === "/WayPoint/api/flight-lookup") {
        if (request.method !== "GET") {
          return new Response("Method not allowed", { status: 405, headers: { Allow: "GET" } });
        }
        return handleFlightLookup(url, env);
      }

      // ---- Account management (site-owner / uber-user only) -----------
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
  },
};

/**
 * Loads the real, full, currently-stored trip data straight out of KV —
 * the "server truth" that both handleGet() and handlePost() build on.
 * Never filtered, never trimmed — filtering only ever happens afterwards,
 * per-account, in buildResponseState().
 */
async function loadFullState(env) {
  const saved = await env.WAYPOINT_KV.get(STATE_KEY);
  return saved !== null ? JSON.parse(saved) : JSON.parse(EMPTY_STATE);
}

async function saveFullState(env, state) {
  await env.WAYPOINT_KV.put(STATE_KEY, JSON.stringify(state));
}

/* ============================================================================
 * Permission resolution — the one function that decides what an account
 * may do with a trip, from server-side truth only.
 * ==========================================================================*/

function findGrant(trip, accountId) {
  return (trip.grants || []).find(function (g) { return g.accountId === accountId; }) || null;
}

/**
 * Resolves what `user` may do with `trip`, right now — purely from
 * `trip.ownerId` / `trip.grants` / `user.isUberUser`, NEVER from anything
 * the client claims. Returns `null` if this account has no access to this
 * trip at all (treat it as if it doesn't exist), or one of:
 *
 *   { role: "superuser" }                 — the owner, or the uber-user.
 *                                            Full read/write, AND can
 *                                            manage this trip's sharing.
 *   { role: "admin" }                     — full read/write, but can't
 *                                            manage sharing.
 *   { role: "user",   companionId: "..." } — read/write, but only items
 *                                            already tagged with that
 *                                            companion.
 *   { role: "viewer", companionId: "..." } — same scoping as "user", but
 *                                            read-only.
 */
function permissionForTrip(trip, user) {
  if (user.isUberUser) return { role: "superuser" };
  if (trip.ownerId === user.id) return { role: "superuser" };
  const grant = findGrant(trip, user.id);
  if (!grant) return null;
  if (grant.role === "admin") return { role: "admin" };
  if (grant.role === "user") return { role: "user", companionId: grant.companionId || "" };
  if (grant.role === "viewer") return { role: "viewer", companionId: grant.companionId || "" };
  return null; // Unrecognised role on the stored grant -- fail closed.
}

/**
 * Turns a trip's raw `grants` array (just account ids + roles) into
 * something a browser can actually show, by resolving each accountId to
 * its current username via `usersDoc`. An entry whose account has since
 * been deleted is quietly left out — same "dangling reference just
 * vanishes, nothing crashes" philosophy as a deleted companion's tags.
 */
function resolveGrants(trip, usersDoc) {
  return (trip.grants || [])
    .map(function (g) {
      const account = usersDoc.users.find(function (u) { return u.id === g.accountId; });
      if (!account) return null;
      return { accountId: g.accountId, username: account.username, role: g.role, companionId: g.companionId || "" };
    })
    .filter(function (g) { return g !== null; });
}

/**
 * Builds the per-account response for GET /api/data: every trip `user` has
 * ANY access to, each one annotated with `myGrant` (so the frontend never
 * has to duplicate this permission logic, and never has to guess whether
 * an optimistic UI update is still valid) --- see permissionForTrip()
 * above for what `myGrant` can be.
 *
 * A full-scope trip (Superuser or "admin") comes back complete, PLUS who
 * currently owns it (`ownerUsername`) and its full sharing list
 * (`grants`) so a Superuser can run the "Share this trip" panel and an
 * "admin" can at least see who else has access.
 *
 * A scoped trip ("user"/"viewer") comes back trimmed to just that
 * account's own tagged items, with expenses stripped entirely (no
 * per-companion split exists for those, and they often show what OTHER
 * people spent) and NO `ownerId`/`grants` at all -- a scoped account has
 * no business knowing who else has access to a trip they can barely see
 * into themselves.
 */
function buildResponseState(fullState, user, usersDoc) {
  const trips = [];
  (fullState.trips || []).forEach(function (trip) {
    const perm = permissionForTrip(trip, user);
    if (!perm) return; // Invisible entirely.

    if (perm.role === "superuser" || perm.role === "admin") {
      const ownerAccount = usersDoc.users.find(function (u) { return u.id === trip.ownerId; });
      trips.push(Object.assign({}, trip, {
        myGrant: perm,
        ownerUsername: ownerAccount ? ownerAccount.username : "",
        grants: resolveGrants(trip, usersDoc),
      }));
      return;
    }

    // "user" / "viewer": scoped to their own tagged items only.
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

async function handleGet(env, user) {
  const fullState = await loadFullState(env);
  const usersDoc = await loadUsers(env);
  const responseState = buildResponseState(fullState, user, usersDoc);
  return new Response(JSON.stringify(responseState), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Saves the page's current `state.trips` -- safely. See the big
 * "SAVING SAFELY" comment near the top of this file for why a plain
 * overwrite would be dangerous now that trips are private-by-default.
 *
 * The rule, trip by trip, computed from the REAL currently-stored data
 * (never from the client):
 *
 *   - No access, or a "viewer" grant: this trip is left completely
 *     untouched, whatever (if anything) the client sent for it.
 *   - Superuser (owner, or the uber-user) or an "admin" grant: the whole
 *     trip is replaced with what they submitted -- leaving it out entirely
 *     means they deleted it. Either way, `ownerId` and `grants` always
 *     come from the stored trip, NEVER from the client -- even a
 *     Superuser can't change who owns/shares a trip through this
 *     endpoint, only through /api/trip-grants (see below), which checks
 *     that specifically.
 *   - A "user" grant: only fields on items that already existed AND were
 *     tagged with their companion both before and after get updated (see
 *     mergeUserScopedTrip()). They can't add or remove items, retag
 *     anything, or touch the trip's own fields, companions or contacts --
 *     all of that comes back exactly as stored.
 *   - Anything in the submitted body whose id ISN'T an existing trip is a
 *     brand-new trip: any logged-in account may create one, and becomes
 *     its permanent Superuser (owner) automatically.
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

  const storedState = await loadFullState(env);
  const storedTrips = storedState.trips || [];
  const storedById = {};
  storedTrips.forEach(function (t) { storedById[t.id] = t; });

  const submittedById = {};
  submitted.trips.forEach(function (t) { if (t && t.id) submittedById[t.id] = t; });

  const resultTrips = [];

  // ---- Every EXISTING trip: apply exactly what this account's REAL
  // permission on it (from the stored version) allows. ----
  storedTrips.forEach(function (storedTrip) {
    const perm = permissionForTrip(storedTrip, user);
    const incoming = submittedById[storedTrip.id];

    if (!perm || perm.role === "viewer") {
      // No access, or read-only: completely untouched.
      resultTrips.push(storedTrip);
      return;
    }

    if (perm.role === "superuser" || perm.role === "admin") {
      if (!incoming) return; // Left out by a full-scope account -> deleted.
      resultTrips.push(Object.assign({}, stripClientOwnershipFields(incoming), {
        id: storedTrip.id,
        ownerId: storedTrip.ownerId,
        grants: storedTrip.grants || [],
      }));
      return;
    }

    // perm.role === "user": scoped read/write.
    if (!incoming) {
      // A "user" grant can't delete the trip -- if it's missing from what
      // they sent (shouldn't happen, the UI never offers it), the safe
      // thing is to just keep it exactly as it was.
      resultTrips.push(storedTrip);
      return;
    }
    resultTrips.push(mergeUserScopedTrip(storedTrip, incoming, perm.companionId));
  });

  // ---- Anything submitted that ISN'T an existing trip id is brand new --
  // any logged-in account may create one, becoming its Superuser. ----
  submitted.trips.forEach(function (incoming) {
    if (!incoming || !incoming.id) return;
    if (storedById[incoming.id]) return; // Already handled above.
    resultTrips.push(Object.assign({}, stripClientOwnershipFields(incoming), {
      ownerId: user.id,
      grants: [],
    }));
  });

  await saveFullState(env, { trips: resultTrips });
  return new Response(JSON.stringify({ status: "ok" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// Never let a client-submitted trip object smuggle its own idea of who
// owns it, who it's shared with, or (for a scoped account) what its
// permission even is into storage -- these fields only ever exist in a
// GET response as a convenience for the UI, and are always recomputed
// server-side before anything is written back. See handlePost() above.
function stripClientOwnershipFields(trip) {
  const copy = Object.assign({}, trip);
  delete copy.ownerId;
  delete copy.grants;
  delete copy.myGrant;
  delete copy.ownerUsername;
  return copy;
}

/**
 * Applies a "user" grant's edits to a trip: only fields on items that
 * already existed AND were tagged with `companionId` in BOTH the stored
 * and the submitted version get updated. Everything else -- the trip's
 * own name/dates/notes, its companions list, its contacts, other people's
 * items, and of course who owns/shares it -- comes back exactly as it was
 * stored, no matter what the client sent. This is what makes a "user"
 * grant genuinely safe to give write access to: even a compromised or
 * buggy client can't use it to reach outside their own tagged items.
 */
function mergeUserScopedTrip(storedTrip, incomingTrip, companionId) {
  const merged = Object.assign({}, storedTrip); // Start from stored truth.
  ["destinations", "activities", "accommodation", "transport"].forEach(function (listKey) {
    merged[listKey] = mergeUserScopedList(storedTrip[listKey] || [], incomingTrip[listKey] || [], companionId);
  });
  // Trip-level fields, companions, contacts, expenses, ownerId, grants:
  // deliberately left as `storedTrip`'s values (from Object.assign above)
  // -- a "user" grant never touches any of those.
  return merged;
}

function mergeUserScopedList(storedList, incomingList, companionId) {
  const incomingById = {};
  incomingList.forEach(function (item) { if (item && item.id) incomingById[item.id] = item; });
  const taggedTo = function (item) { return (item.companions || []).indexOf(companionId) !== -1; };

  return storedList.map(function (storedItem) {
    if (!taggedTo(storedItem)) return storedItem; // Not theirs -- untouched.
    const incomingItem = incomingById[storedItem.id];
    if (!incomingItem) return storedItem; // Can't delete -- keep it.
    if (!taggedTo(incomingItem)) return storedItem; // Can't un-tag themselves -- ignore the attempt.
    // Apply their edits, but id/companions always stay as stored -- a
    // "user" grant can change an item's OTHER fields, never which item it
    // is or who it's tagged to.
    return Object.assign({}, incomingItem, { id: storedItem.id, companions: storedItem.companions });
  });
  // Any id present in `incomingList` but not in `storedList` (a brand-new
  // item) is silently dropped here -- a "user" grant can't create items,
  // only edit ones that already exist and are already theirs.
}

/* ---- Route handlers: sharing a trip (grant / revoke) ---------------------
 * Only a trip's Superuser (its owner) or the uber-user may change who has
 * access to it -- deliberately not even an "admin" grant, so "full
 * read/write" and "decides who else gets in" stay two separate powers,
 * exactly as asked for. Both handlers check this against the REAL stored
 * `ownerId`, never anything the client claims. ---------------------------- */

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
  if (!tripId) return jsonError(400, "No trip specified.");
  if (!username) return jsonError(400, "Enter the username to share this trip with.");
  if (GRANT_ROLES.indexOf(role) === -1) return jsonError(400, "Role must be admin, user or viewer.");
  if ((role === "user" || role === "viewer") && !companionId) {
    return jsonError(400, "Pick which companion this person is, so their access is scoped correctly.");
  }

  const state = await loadFullState(env);
  const trip = (state.trips || []).find(function (t) { return t.id === tripId; });
  if (!trip) return jsonError(404, "That trip no longer exists.");
  if (!(user.isUberUser || trip.ownerId === user.id)) {
    return jsonError(403, "Only this trip's owner can decide who has access to it.");
  }

  const usersDoc = await loadUsers(env);
  const targetAccount = usersDoc.users.find(function (u) { return u.username.toLowerCase() === username.toLowerCase(); });
  if (!targetAccount) return jsonError(404, "No account with that username exists yet — ask the site owner to create one first.");
  if (targetAccount.id === trip.ownerId) return jsonError(400, "That account already owns this trip.");
  if (targetAccount.isUberUser) return jsonError(400, "That account already has full access to everything.");
  if (role === "user" || role === "viewer") {
    const companionExists = (trip.companions || []).some(function (c) { return c.id === companionId; });
    if (!companionExists) return jsonError(400, "That companion isn't on this trip.");
  }

  // Upsert: replace any existing grant for this account, or add a new one.
  trip.grants = (trip.grants || []).filter(function (g) { return g.accountId !== targetAccount.id; });
  trip.grants.push({ accountId: targetAccount.id, role: role, companionId: role === "admin" ? "" : companionId });

  await saveFullState(env, state);
  return new Response(JSON.stringify({ status: "ok", grants: resolveGrants(trip, usersDoc) }), {
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

  const state = await loadFullState(env);
  const trip = (state.trips || []).find(function (t) { return t.id === tripId; });
  if (!trip) return jsonError(404, "That trip no longer exists.");
  if (!(user.isUberUser || trip.ownerId === user.id)) {
    return jsonError(403, "Only this trip's owner can decide who has access to it.");
  }

  trip.grants = (trip.grants || []).filter(function (g) { return g.accountId !== accountId; });
  await saveFullState(env, state);
  return new Response(JSON.stringify({ status: "ok" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// Only ever forward something that looks like a real flight number to
// the upstream service — letters and digits only, a sensible length —
// and a real calendar date. Neither check is really a security
// boundary (both values get URL-encoded either way) so much as a
// cheap way to fail fast with a clear message instead of sending
// obvious junk out to a third party and waiting on its response.
const FLIGHT_NUMBER_PATTERN = /^[A-Z0-9]{2,8}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// AeroDataBox is accessed the same way for everyone who signs up
// through RapidAPI: this fixed host, plus their own personal API key.
const AERODATABOX_HOST = "aerodatabox.p.rapidapi.com";

/**
 * Reverse-looks-up a flight number + date (e.g. "BA15" on 2026-09-03)
 * into its operating airline, origin/destination airports, and
 * scheduled local departure/arrival date+time, by proxying to the
 * AeroDataBox API (https://aerodatabox.com/) via RapidAPI. This lives
 * server-side — rather than being called straight from the page — for
 * three reasons: it's the only place the RapidAPI key ever needs to
 * exist (see AERODATABOX_API_KEY below — the page's JavaScript is
 * fully public, so a key embedded there would be visible to anyone
 * who opened dev tools); it keeps every outbound call to a third
 * party in one place, so it's easy to swap providers later without
 * touching the frontend; and it means a flaky/slow upstream response,
 * or a plan/quota problem, can be turned into a clean, friendly error
 * instead of a raw browser fetch failure landing in the form.
 *
 * Requires the WAYPOINT_PASSWORD-style secret `AERODATABOX_API_KEY`
 * to be set in the Cloudflare dashboard (Workers & Pages →
 * waypoint-app → Settings → Variables and Secrets) — this file never
 * contains the actual key. Sign up free at
 * https://rapidapi.com/aedbx-aedbx/api/aerodatabox to get one; the
 * free tier is generous enough for personal, occasional use (a
 * handful of flights per trip is nowhere near its monthly allowance).
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

  // AeroDataBox occasionally takes a moment to respond; don't let a
  // slow upstream hang the Worker (and the person's form) indefinitely.
  const controller = new AbortController();
  const timeout = setTimeout(function () { controller.abort(); }, 8000);

  let upstreamResponse;
  try {
    // withLocation=true asks AeroDataBox to include each airport's
    // lat/lon — the frontend uses that as a fallback source of real map
    // coordinates for airports outside its own curated shortlist (see
    // COMMON_AIRPORTS in data/airports.js, and index.html's
    // airportCoordsFromText()/lastFlightLookupCoords). Everything else
    // stays off (aircraft image, flight plan) since nothing here uses
    // them and there's no reason to make AeroDataBox do the extra work.
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

// `country` is read defensively — AeroDataBox's exact field name for
// this isn't pinned down here (it may come back as `country.name`, or
// just a `countryCode`, depending on the endpoint/response shape), so
// this tries the friendlier shape first and falls back to the code
// rather than throwing if neither is present. Worst case it's just an
// empty string, same as if this whole field didn't exist — the
// frontend's airportDisplay() (index.html) already treats a missing
// country as optional.
//
// `location` (present since the request now passes withLocation=true)
// is this airport's real lat/lon — reshaped to {lat, lng} to match
// what the frontend's Map tab expects everywhere else (Leaflet/
// Nominatim both use "lng", AeroDataBox uses "lon"). This is what lets
// index.html fall back to a real coordinate for an airport OUTSIDE its
// own curated COMMON_AIRPORTS shortlist (see lastFlightLookupCoords in
// index.html) instead of asking Nominatim to guess at free text like
// "XYZ — Some Airport, Some City, Some Country" — which is exactly the
// kind of query Nominatim sometimes can't resolve at all.
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

// Pulls the scheduled local date+time and terminal/gate out of one
// side (departure or arrival) of an AeroDataBox flight. AeroDataBox's
// "local" time strings look like "2026-09-03 14:35+01:00" (a space,
// not a "T", before the time, plus a UTC-offset suffix) — rather than
// trust every browser's Date parser to handle that non-standard
// format consistently (Safari in particular is fussy about this), the
// date and time-of-day are pulled out directly with a simple pattern
// match, and just those two plain strings are sent to the frontend —
// they drop straight into a <input type="date">/<input type="time">
// with no parsing needed on that end at all.
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

/* ============================================================================
 * Accounts, password hashing, and sessions
 * ==========================================================================*/

/**
 * Reads the account list out of KV. A brand-new install has none yet, so
 * this always resolves to a valid { users: [] } shape rather than null —
 * exactly the same trick loadFullState() plays for trip data, and for the
 * same reason (nothing else in this file has to special-case "not set up
 * yet" versus "something went wrong").
 */
async function loadUsers(env) {
  const saved = await env.WAYPOINT_KV.get(USERS_KEY);
  if (!saved) return { users: [] };
  try {
    const parsed = JSON.parse(saved);
    if (!parsed || !Array.isArray(parsed.users)) return { users: [] };
    return parsed;
  } catch (err) {
    // Shouldn't happen (we're the only writer, and always write valid
    // JSON) but fail safe rather than throwing if it ever does.
    return { users: [] };
  }
}

async function saveUsers(env, usersDoc) {
  await env.WAYPOINT_KV.put(USERS_KEY, JSON.stringify(usersDoc));
}

// Strips everything sensitive (passwordSalt/passwordHash) before a user
// record is ever sent back to a browser. Every response in this file that
// includes account info goes through this — never the raw stored record.
// Deliberately does NOT include `isUberUser` — see the "undisclosed"
// explanation at the top of this file: the client never needs to know
// which account (if any) has that status, since every place permissions
// matter already resolves to the same `{ role: "superuser" }` a genuine
// trip owner would get.
function publicUser(u) {
  return { id: u.id, username: u.username, createdAt: u.createdAt || "" };
}

// A short random-ish id for a new account. Not cryptographically
// meaningful on its own (that's what the password hash and session
// signature are for) — just needs to be unique enough to key one KV
// document's array by, which crypto.randomUUID() comfortably is.
function newAccountId() {
  return "u_" + crypto.randomUUID();
}

/* ---- Password hashing (PBKDF2 via the Web Crypto API) --------------------
 * Cloudflare Workers don't have Node's `crypto` module, but they DO have
 * the standard Web Crypto API (the same `crypto.subtle` your browser has) —
 * that's what all of this is built on. PBKDF2 turns a password into a
 * fixed-length block of "random-looking" bytes, DELIBERATELY slowly (see
 * PBKDF2_ITERATIONS above), using a random "salt" mixed in so two people
 * with the same password don't end up with the same stored hash. Only the
 * salt + resulting hash are ever stored — never the password itself — and
 * there's no way to reverse a hash back into the original password; the
 * only way to check a guess is correct is to hash IT the same way and
 * compare the results, which is exactly what verifyPassword() does.
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
// timing attack can't slowly narrow down a correct hash byte-by-byte.
// (Overkill for a 20-person friends-and-family app, but it costs nothing
// to do properly.)
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
 * A session cookie is just `<payload>.<signature>`, both base64url-encoded.
 * The payload is only ever `{ uid, exp }` — WHICH account, and WHEN this
 * expires. Nothing else travels in the cookie, on purpose: every request
 * re-reads the account's CURRENT record out of KV, and re-resolves EVERY
 * trip's permissions fresh from KV too (see getCurrentUser() and
 * permissionForTrip()) rather than trusting anything decided at login
 * time — so revoking someone's access to a trip, or deleting their
 * account outright, takes effect immediately, not just whenever their
 * cookie happens to expire. The signature is an HMAC-SHA256 over the
 * payload, keyed by the WAYPOINT_SESSION_SECRET Worker secret — without
 * that secret, nobody can forge a payload claiming to be a different
 * account, because they can't produce a signature that'll verify.
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
 * account (if any) this request belongs to, right now, by verifying the
 * session cookie and then re-reading that account fresh out of KV — see
 * the "Signed session cookies" comment above for why it's re-read rather
 * than trusted from the cookie itself. Returns the FULL account record
 * (including passwordSalt/passwordHash/isUberUser) for this file's own
 * internal use; always pass it through publicUser() before it goes
 * anywhere near a response body.
 */
async function getCurrentUser(request, env) {
  const token = getCookie(request, SESSION_COOKIE_NAME);
  if (!token) return null;
  const payload = await verifySession(token, env);
  if (!payload) return null;
  const usersDoc = await loadUsers(env);
  const user = usersDoc.users.find(function (u) { return u.id === payload.uid; });
  return user || null; // null if the account was deleted since the cookie was issued.
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

  const usersDoc = await loadUsers(env);
  const user = usersDoc.users.find(function (u) { return u.username.toLowerCase() === username; });
  // Deliberately the same generic message whether the username doesn't
  // exist or the password's wrong — doesn't help an attacker narrow down
  // which one they got wrong, at basically no cost to a genuine user.
  const genericError = function () { return jsonError(401, "Incorrect username or password."); };
  if (!user) return genericError();
  const passwordOk = await verifyPassword(password, user.passwordSalt, user.passwordHash);
  if (!passwordOk) return genericError();

  const token = await signSession({ uid: user.id, exp: Date.now() + SESSION_MAX_AGE_SECONDS * 1000 }, env);
  return new Response(JSON.stringify({ status: "ok", id: user.id, username: user.username }), {
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

// Always 200 — the response body's `loggedIn` field carries whether
// there's a real session, rather than using the HTTP status for it. That
// keeps the frontend's "am I logged in?" check to one plain fetch + read,
// with no need to treat a 401 specially just for this one endpoint. When
// not logged in, `setupNeeded` tells the frontend whether to show an
// ordinary login form or the one-time "create your account" screen
// instead (see handleSetup()) — true only when NO account exists yet
// anywhere, so this is a cheap KV read that's only ever "true" for the
// very first visit to a fresh install.
async function handleWhoami(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user) {
    const usersDoc = await loadUsers(env);
    return new Response(JSON.stringify({ loggedIn: false, setupNeeded: usersDoc.users.length === 0 }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return new Response(JSON.stringify({ loggedIn: true, id: user.id, username: user.username }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * One-time bootstrap: creates the very first account — the site owner's
 * own login, which becomes the undisclosed "uber-user" with full access
 * to everything — gated by the WAYPOINT_PASSWORD secret (repurposed from
 * the old single-password days — see the big comment at the top of this
 * file). Refuses to run at all once any account already exists, so this
 * can safely be left reachable rather than needing to be removed after
 * first use.
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
    isUberUser: true, createdAt: new Date().toISOString(),
  };
  usersDoc.users.push(user);
  await saveUsers(env, usersDoc);

  const token = await signSession({ uid: user.id, exp: Date.now() + SESSION_MAX_AGE_SECONDS * 1000 }, env);
  return new Response(JSON.stringify({ status: "ok", id: user.id, username: user.username }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Set-Cookie": buildSessionCookieHeader(token) },
  });
}

/* ---- Route handlers: account management (site-owner / uber-user only,
   enforced in fetch() before any of these are ever called) -----------------
   Deliberately minimal now that roles/links live on trips, not accounts:
   just create a login, reset its password, or delete it. No role, no
   trip links -- sharing a specific trip with someone is now entirely the
   job of that trip's own Superuser, via /api/trip-grants above. --------- */

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
    isUberUser: false, createdAt: new Date().toISOString(),
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
