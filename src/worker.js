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
 *      (a simple key/value store, think of it like a small set of shared
 *      files, one per trip — see "How trips are stored" below) and send
 *      them back as JSON, or take a JSON body from the page and merge it
 *      safely into KV so it's there next time (see "Saving safely" below
 *      for why this is a merge, not a plain overwrite).
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
 *      how all of this fits together. NONE of this changed in this
 *      storage-restructuring pass — accounts/sessions are left completely
 *      untouched on purpose (see "How trips are stored" below).
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
 * account is special" (except a response describing your OWN account, e.g.
 * after logging in — see handleLogin() further down) — every place that
 * matters just sees the SAME `{ role: "superuser" }` a real owner would
 * see, so there's no separate code path (and no separate flag on anyone
 * ELSE's account) that could leak this account's status.
 *
 * Accounts live in KV under a fixed key, USERS_KEY ("users") — a small
 * JSON document listing everyone and their (hashed, never plain-text)
 * password. An account record itself carries almost nothing — just who
 * they are and whether they're the uber-user — because every actual
 * permission lives on the TRIP (its `ownerId` and `grants[]`), not on the
 * account. See permissionForTrip() further down for exactly how a trip + an
 * account resolve into what that account may do. NONE of this — the
 * account system, password hashing, or session cookies — changed in this
 * storage-restructuring pass. Only WHERE and HOW trip data itself is
 * stored changed (see below); who's allowed to do what with it did not.
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
 * HOW TRIPS ARE STORED (this is what changed in this pass)
 * ----------------------------------------------------------------------------
 * Earlier versions of this file kept EVERY trip in one single KV value
 * under the key "state" — the whole thing read on every visit, and the
 * whole thing rewritten on every save, no matter how small the change.
 * That has two real problems as the number (and size) of trips grows:
 *
 *   1. Cloudflare KV caps a single value at 25 MiB. A long way off today,
 *      but a single blob holding every trip forever is the wrong shape
 *      regardless of how close to that ceiling it actually gets.
 *   2. Cloudflare KV allows at most ONE write per second to the same key.
 *      Because every save rewrote the ENTIRE "state" value, two people
 *      saving two DIFFERENT trips within the same second could still
 *      collide on that one shared key — one save silently losing to the
 *      other, even though neither of them touched what the other was
 *      editing. That's not a future scaling problem, it's a real
 *      correctness gap that existed from the very first version of the
 *      per-trip permissions system.
 *
 * So trip data now lives in TWO kinds of KV entry instead of one:
 *
 *   - TRIP_INDEX_KEY ("trip_index") — one small document listing every
 *     trip that exists: just enough to render the dashboard (name, dates,
 *     currency) and to resolve permissions (ownerId, grants) WITHOUT
 *     loading any trip's actual content. This is the one and only place
 *     `ownerId`/`grants` are stored — see loadTripIndex()/saveTripIndex().
 *   - "trip:<tripId>" — one KV key PER TRIP, holding that trip's actual
 *     content (destinations, activities, transport, accommodation,
 *     contacts, expenses, companions, notes, currency rates, geocode
 *     cache). See loadTripContent()/saveTripContent()/deleteTripContent().
 *
 * The payoff: opening the dashboard only ever reads the small index, never
 * every trip's full content. Saving a trip only reads/writes THAT trip's
 * own "trip:<id>" key — a save to Trip A never touches Trip B's key at
 * all, so two people saving two different trips at the same moment can no
 * longer collide. The trip index itself is still a single shared key, so
 * renaming a trip or changing who it's shared with (both of which touch
 * the index) retains a narrow version of the old collision window — see
 * the comment on saveTripIndex() for why that's an acceptable, much
 * smaller trade-off rather than something worth over-engineering away.
 *
 * OLD DATA: anything saved under the old "state" key before this change
 * shipped is picked up automatically — see migrateFromLegacyState()
 * below. That old key is left in place afterwards (never deleted) purely
 * as an inert backup; nothing in this file reads it again once migration
 * has run.
 *
 * ----------------------------------------------------------------------------
 * SCHEMA NOTE: every item's own id field is now named for what it is
 * ----------------------------------------------------------------------------
 * Trip/destination/activity/transport/accommodation/contact/expense/
 * companion objects used to all just have a generic `id` field — fine when
 * you're deep in one item's own object, confusing the moment you're looking
 * at raw JSON with several item types mixed together (exactly the situation
 * hand-editing KV data in the Cloudflare dashboard puts you in). Each now
 * has its own clearly-named id instead: `tripId`, `destinationId`,
 * `activityId`, `transportId`, `accommodationId`, `contactId`, `expenseId`,
 * `companionId`. Fields that were already references to one of these (e.g.
 * an activity's `destinationId`, a booking's `contactId`, a grant's
 * `companionId`) don't change at all — they already used exactly this
 * naming, which is what this rename is bringing everything else in line
 * with. Account/login records are DELIBERATELY left alone (still a plain
 * `id`) — the account/session system is working, well-tested, and not
 * worth the extra risk of touching again right after it just went through
 * a rocky first real deploy.
 * ----------------------------------------------------------------------------
 * SAVING SAFELY (the part of this file that matters most to get right)
 * ----------------------------------------------------------------------------
 * The frontend still works the simple way it always has: it keeps the
 * trips it knows about in one `state` object and POSTs the whole thing
 * back to /api/data whenever something changes — the WIRE FORMAT to and
 * from the browser hasn't changed in this pass at all, only what happens
 * to it on this end. The wrinkle is that, because trips are private-by-
 * default, any one account's copy of `state.trips` is only ever a SUBSET —
 * whatever GET handed them (see buildResponseState() below). If this
 * Worker just took that subset and wrote it straight into storage, it
 * would silently DELETE every trip that account couldn't see. That would
 * be a disaster the very first time a "user"-role account (who can only
 * see one trip) saved anything.
 *
 * So handlePost() below never does that. Instead, for every save, it:
 *   1. Loads the REAL, full, currently-stored trip index (not what the
 *      client sent) — ownerId/grants always come from here, never from
 *      the client.
 *   2. Works out — from that real stored data — exactly what this account
 *      is allowed to change: the whole trip (Superuser/admin), just their
 *      own tagged items ("user"), or nothing at all (no access, or
 *      "viewer").
 *   3. Applies ONLY that, trip by trip, loading and rewriting a trip's own
 *      "trip:<id>" content key only when that trip actually changed —
 *      everything else (every OTHER trip, and the index itself, unless a
 *      trip was renamed/created/deleted) is left completely untouched.
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

// The old, single-blob storage key from before this restructuring. Only
// ever READ, by migrateFromLegacyState() below, to pick up anything
// saved before this change shipped — never written to again afterwards.
const LEGACY_STATE_KEY = "state";

// The lightweight "list of every trip" document — see the big "HOW TRIPS
// ARE STORED" comment above. This is the one and only place a trip's
// ownerId/grants live.
const TRIP_INDEX_KEY = "trip_index";

// Every trip's actual content lives under its own key, "trip:<tripId>".
function tripContentKey(tripId) {
  return "trip:" + tripId;
}

// The fixed KV key the account list lives under — a separate document from
// the trip data above, so listing/editing accounts never touches (or risks
// corrupting) anyone's trips, and vice versa. Unchanged by this pass.
const USERS_KEY = "users";
const USERS_INITIALIZED_KEY = "users_initialized";

// An empty index/trip shape, for a brand-new install (or a trip/account
// list that's never been written to yet) — so nothing else in this file
// has to special-case "not set up yet" versus "something went wrong".
const EMPTY_INDEX = JSON.stringify({ trips: [] });

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

// Best-effort per-isolate throttle. A Cloudflare zone-level rate-limit rule
// should also cover this route because separate isolates do not share memory.
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 8;
const loginAttempts = new Map();

// The only roles that can be GRANTED to someone on a trip (via
// /api/trip-grants below). "superuser" is deliberately not in this list —
// you can't grant Superuser status to someone, it only ever comes from
// having created the trip (trip.ownerId) — see permissionForTrip().
const GRANT_ROLES = ["admin", "user", "viewer"];

/* ============================================================================
 * COMPANIONS & AVATARS
 * ----------------------------------------------------------------------------
 * Every account gets a self-picked coloured circle + animal face (e.g.
 * green circle, penguin). Every COMPANION who ISN'T linked to an account
 * gets a fixed grey circle + a smiley in a colour whoever added them
 * picked. The two looks are deliberately different — the marker itself
 * tells you at a glance whether that person can log in. See
 * claude/waypoint-companions-plan.md for the full design discussion.
 *
 * The account<->companion link lives on the COMPANION record, as an
 * `accountId` field — not on the grant. This was a deliberate, debated
 * choice (see the plan doc): it means a person's avatar is the same
 * everywhere they show up on a trip, resolved by one simple local lookup
 * (see resolveCompanionAvatars() below) rather than cross-referencing the
 * grants array. If they haven't been added to a particular trip as a
 * companion, they simply don't appear on it at all — there's no
 * in-between "partially linked" state to worry about.
 *
 * That convenience comes with exactly one real risk, which is why
 * `accountId` gets handled so carefully everywhere it's touched below:
 * a companion is part of a trip's regular CONTENT (the same "trip:<id>"
 * document as destinations/activities/etc), and content is something
 * even a scoped "user" grant gets to submit changes to (see
 * mergeUserScopedTrip() further down, extended in this pass to let a
 * "user" grant append a brand-new companion). If `accountId` were just
 * another plain field on that object, a "user" grant's own submitted
 * content — or, for that matter, a bug anywhere else in this file — could
 * self-assign or overwrite the link and make some companion look like a
 * different, arbitrary account. So `accountId` is treated as a
 * server-computed, PROTECTED field, exactly the way `ownerId`/`tripId`
 * already are for the trip itself: it is NEVER taken from anything a
 * client submits through the normal save endpoint (POST /api/data), no
 * matter which role is saving — see reconcileCompanionAccountLinks()
 * below, which every content-writing code path in handlePost() runs
 * every companion through. The ONLY way it's ever actually set is
 * through the two small, dedicated, permission-gated actions below
 * (handleTripGrantsUpsert's auto-link when sharing a trip as a specific
 * companion, and handleCompanionLink()'s standalone link/unlink action) —
 * both restricted to a trip's Superuser or Admin, same as sharing itself.
 *
 * A colour or animal is always one of a small set of ALLOWLISTED tokens
 * (e.g. "green", "penguin") — see AVATAR_COLOR_TOKENS/AVATAR_ANIMAL_TOKENS
 * just below. The Worker validates every incoming token against its own
 * copy of this list (never trusting the page's copy, even though the two
 * are meant to always match — see public/WayPoint/data/avatars.js, which
 * holds the matching hex/emoji values the FRONTEND needs to actually draw
 * a marker). Storing anything outside this allowlist would open a path
 * to a CSS-injection-style bug down the line if a raw stored value were
 * ever interpolated into a style attribute — keeping the server strict
 * about it means that mistake can never happen even if the frontend
 * later got careless about it.
 * ==========================================================================*/

// The real allowlist — see the big comment above. Keep this in sync with
// public/WayPoint/data/avatars.js's AVATAR_COLORS list (the frontend's
// copy, which also carries each token's hex value — the Worker only ever
// needs the token itself, to validate, never the hex).
const AVATAR_COLOR_TOKENS = ["red", "orange", "amber", "green", "teal", "cyan", "blue", "indigo", "purple", "pink"];

// Same idea, for the account-holder circle's animal. Keep in sync with
// public/WayPoint/data/avatars.js's AVATAR_ANIMALS list.
const AVATAR_ANIMAL_TOKENS = ["penguin", "lion", "fox", "owl", "panda", "koala", "tiger", "elephant", "giraffe", "rabbit", "bear", "wolf", "cat", "dog", "monkey", "dolphin"];

function isValidAvatarColor(token) {
  return AVATAR_COLOR_TOKENS.indexOf(token) !== -1;
}

function isValidAvatarAnimal(token) {
  return AVATAR_ANIMAL_TOKENS.indexOf(token) !== -1;
}

// A stable "which colour would this default to if nobody's picked one
// yet" index, purely so a marker never renders blank before an account
// holder opens the avatar picker or before a companion's adder picks a
// smiley colour — see this file's frontend counterpart,
// deterministicAvatarIndex() in public/WayPoint/data/avatars.js, which
// this deliberately matches so a not-yet-chosen avatar looks the same
// wherever it's computed. Not cryptographic — it only ever picks an
// array index.
function deterministicIndex(seed, listLength) {
  let hash = 0;
  const text = String(seed || "");
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  }
  return hash % listLength;
}

// Resolves ONE account's avatar: whatever it has saved, if both parts are
// still valid allowlisted tokens (a colour/animal could in principle be
// retired from the allowlist later; falling back rather than trusting a
// stale value keeps that safe), otherwise a deterministic default from
// the account's own id — see deterministicIndex() above. Always returns a
// real, renderable `{ color, animal }`, never null/undefined, so callers
// never need their own "what if nobody's picked yet" fallback.
function resolveAccountAvatar(account) {
  const saved = account && account.avatar;
  const color = (saved && isValidAvatarColor(saved.color)) ? saved.color : AVATAR_COLOR_TOKENS[deterministicIndex(account && account.id, AVATAR_COLOR_TOKENS.length)];
  const animal = (saved && isValidAvatarAnimal(saved.animal)) ? saved.animal : AVATAR_ANIMAL_TOKENS[deterministicIndex((account && account.id) + ":animal", AVATAR_ANIMAL_TOKENS.length)];
  return { color: color, animal: animal };
}

// Resolves EVERY companion on a trip to what marker it should show, from
// server-side truth only — see the big COMPANIONS & AVATARS comment above
// for why this is a plain local lookup rather than anything involving
// `grants`. Returns a map keyed by companionId so the frontend never has
// to re-derive this itself, and — critically — never hands out a raw
// `accountId`: only a colour and an animal (or a colour alone, for a
// smiley), which identifies nothing on their own. This is sent to EVERY
// role that can see the trip at all, including a scoped "user"/"viewer"
// grant, exactly because it's already been reduced to something that
// safe to show them (compare buildVisibleTrip(), which strips the raw
// `accountId` field itself out of what a scoped role's own companions
// list carries, for the same underlying reason).
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
      // Linked account has since been deleted -- fall through to the
      // ordinary smiley resolution below, same "dangling reference just
      // degrades gracefully" philosophy as everywhere else in this file.
    }
    const savedSmiley = c.avatar && c.avatar.smiley;
    const color = isValidAvatarColor(savedSmiley) ? savedSmiley : AVATAR_COLOR_TOKENS[deterministicIndex(c.companionId, AVATAR_COLOR_TOKENS.length)];
    map[c.companionId] = { type: "smiley", color: color };
  });
  return map;
}

/* ---- Guest vs Companion, and the access-level tag ----------------------
 * "Guest" and "Companion" are frontend/product vocabulary, not a new
 * field: a companion record with no `accountId` IS a Guest, and one with
 * an `accountId` IS a Companion — see the terminology note in the big
 * COMPANIONS & AVATARS comment above. What's new here is telling the
 * frontend WHAT LEVEL OF ACCESS a Companion actually has on this trip —
 * "Super" (this trip's owner, or the site's uber-user), "Admin", "User",
 * or "Viewer" — so it can show that as a tag next to their name.
 *
 * That access level is exactly what permissionForTrip() already computes
 * for the account making a request — the only thing new here is calling
 * it for the LINKED account instead of the caller, once per linked
 * companion, and collecting the results into a map (companionId -> role
 * string) the same shape as resolveCompanionAvatars() above. Reusing
 * permissionForTrip() rather than re-deriving "who owns this trip / do
 * they have a grant" by hand means this can never quietly drift out of
 * sync with the ACTUAL permission logic that decides what that account
 * can really do.
 *
 * A companion who's linked but has no resolvable access at all (e.g.
 * linked purely for their avatar via the standalone link action, never
 * actually shared this trip — see handleCompanionLink()'s own comment on
 * why linking deliberately does NOT imply access) simply gets no entry
 * in this map; the frontend falls back to a generic "Companion" tag for
 * that case rather than a specific access level, since there genuinely
 * isn't one to show.
 *
 * Unlike `grants` (which lists every account with access, and is
 * deliberately kept from scoped User/Viewer roles so they can't learn
 * who else has access — see buildVisibleTrip() below), this map is sent
 * to EVERY role that can see the trip at all. It only ever reveals a
 * ROLE LEVEL per companion that's already visible in the companion list
 * itself, never an accountId or username — so unlike `grants`, there's
 * nothing here that identifies WHICH account a companion who isn't
 * already showing their own username is linked to.
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

// Strips (or reasserts, from the trip's REAL stored content) `accountId`
// on every companion in `incomingCompanions` -- see the big COMPANIONS &
// AVATARS comment above for why this has to run on every save, for every
// role, not just a scoped one. The rule: a companion keeps EXACTLY the
// accountId it already has in storage, no matter what the client sent
// for it -- a brand-new companion (one with no matching stored
// companionId yet) can never arrive pre-linked, since linking only ever
// happens through the two dedicated actions below. This is deliberately
// a "reassert the real value" rather than a "delete the field" strip:
// simply deleting it would mean an ordinary, honest save (e.g. someone
// tweaking the trip's currency on the Settings tab, which resubmits the
// whole trip including its companions list exactly as it was last read)
// would silently erase every existing account link the next time anyone
// saved anything -- a data-loss bug in the same family as the ones the
// storage-safety pass already fixed once this file.
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
// `companionId` is linked to, enforcing that an account can only ever be
// linked to ONE companion on a given trip -- if it's currently linked to
// a DIFFERENT companion here, that older link is cleared automatically
// first, so the data can never end up with the same account claimed by
// two companions on one trip at once (which would make
// resolveCompanionAvatars() above arbitrarily inconsistent about which
// one wins). Mutates `content` in place and returns it; the caller is
// responsible for actually saving it back to KV. Shared by
// handleTripGrantsUpsert() (auto-links when sharing a trip AS a specific
// companion) and handleCompanionLink() (the standalone link/unlink
// action) so this rule only has to be gotten right once.
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

      // ---- Linking (or unlinking) a companion to an account -- see the
      // big COMPANIONS & AVATARS comment near AVATAR_COLOR_TOKENS. Same
      // owner-or-Admin permission bar as sharing a trip. ----------------
      if (path === "/WayPoint/api/companions/link" && request.method === "POST") {
        return handleCompanionLink(request, env, user);
      }

      // ---- Self-service avatar picker -- ANY logged-in account may set
      // their OWN avatar (never anyone else's: handleAccountAvatarUpdate()
      // always writes to `user`, from the session, never to a body-
      // supplied account id). No isUberUser gate here on purpose -- this
      // is one of the few things every account, however it's scoped on
      // whatever trips it can see, gets to do for itself. -------------
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
 * from the old "state" key first if this install hasn't been migrated yet.
 * Always resolves to a valid { trips: [] } shape, same trick loadUsers()
 * plays for accounts, for the same reason.
 *
 * Note the deliberate shape here: the index is read ONCE in the normal
 * (already-migrated) case. An earlier version called ensureMigrated()
 * first and then read the index separately, which meant every single
 * request read the same KV key twice forever, just to answer a question
 * ("has migration run?") the first read already answers.
 */
async function loadTripIndex(env) {
  let saved = await env.WAYPOINT_KV.get(TRIP_INDEX_KEY);
  if (saved === null) {
    // No index yet: either a brand-new install, or an existing one still
    // holding its data in the old single "state" blob. migrateFromLegacyState()
    // handles both (it writes an empty index for a new install).
    await migrateFromLegacyState(env);
    saved = await env.WAYPOINT_KV.get(TRIP_INDEX_KEY);
  }
  return saved !== null ? JSON.parse(saved) : JSON.parse(EMPTY_INDEX);
}

/**
 * Writes the trip index back. This is the one piece of trip storage that's
 * STILL a single shared key across every trip, so — unlike a single trip's
 * own content — two DIFFERENT index-touching changes (renaming two
 * different trips, say) landing in the same second can still collide,
 * same as the old design did for everything. That's a much narrower
 * window than before (it only matters for renames/date changes/creating/
 * deleting a trip or changing its sharing — not for ordinary editing of a
 * trip's own content, which never touches the index at all), and a proper
 * fix would mean a retry-with-fresh-read loop here. Given how rarely two
 * people rename or re-share two DIFFERENT trips in the same second on an
 * app built for a small family/friends group, that extra complexity isn't
 * worth it right now — this is a known, accepted, narrow trade-off rather
 * than something silently swept under the rug.
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

// The full list of a trip's own CONTENT fields — everything except its
// index-level bookkeeping (tripId/ownerId/grants, which live only in the
// trip index) and the response-only convenience fields a GET adds (see
// stripClientOwnershipFields() further down). This is what the migration
// below copies across into a "trip:<id>" document, and it deliberately
// does NOT include tripId: a trip's id lives in the index and in its own
// KV key name, never duplicated inside its content (see
// stripClientOwnershipFields(), which strips it back out of every save
// for exactly the same reason).
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
const MAX_ITEMS_PER_LIST = 1000;

const ITEM_FIELDS = {
  destinations: ["destinationId", "name", "country", "arriveDate", "departDate", "timezone", "companions", "notes"],
  activities: ["activityId", "title", "destinationId", "date", "startTime", "endTime", "location", "address", "bookingRef", "contactId", "costAmount", "costCurrency", "costRate", "receiptRef", "companions", "notes"],
  transport: ["transportId", "mode", "carrier", "flightNumber", "licensePlate", "fromLocation", "toLocation", "departDateTime", "arriveDateTime", "paymentType", "costCurrency", "costAmount", "costRate", "pointsProgram", "pointsAmount", "bookingRef", "contactId", "receiptRef", "companions", "notes", "fromLat", "fromLng", "toLat", "toLng"],
  accommodation: ["accommodationId", "name", "destinationId", "address", "checkIn", "checkOut", "bookingRef", "contactId", "costAmount", "costCurrency", "costRate", "receiptRef", "companions", "notes"],
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

function sanitizeItem(listKey, item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid item in trip data.");
  const output = {};
  ITEM_FIELDS[listKey].forEach(function (key) {
    if (!Object.prototype.hasOwnProperty.call(item, key)) return;
    const value = item[key];
    if (key === ITEM_ID_FIELDS[listKey]) output[key] = safeId(value, false);
    else if (/Id$/.test(key)) output[key] = safeId(value, true);
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
 * index + per-trip-key shape. Only ever called by loadTripIndex() above,
 * and only when there's no index yet — so on an already-migrated install
 * it never runs at all.
 *
 * Safe to retry if it's ever interrupted partway through: each per-trip
 * content key is written independently, and the index — which is what
 * loadTripIndex() checks to decide "has this already run?" — is only
 * written LAST, once every trip's content has been written successfully.
 * So a retry after a partial failure just harmlessly rewrites the same
 * per-trip content again before finishing the job. Two requests racing to
 * migrate at the same moment is likewise harmless: both write identical
 * content and an identical index.
 *
 * This also applies the id-field rename described in the big "SCHEMA
 * NOTE" comment near the top of this file (trip.id -> tripId,
 * destination.id -> destinationId, etc.) to every trip it migrates.
 * Reference fields (activity.destinationId, transport.contactId,
 * grant.companionId) already used the typed name before this change, so
 * only each object's OWN id field needs rewriting. The old "state" key is
 * left in place afterwards, untouched, purely as an inert backup —
 * nothing reads it again once the index exists.
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
      ownerId: oldTrip.ownerId || null, // null = not yet claimed by anyone (see the big auth comment: only the uber-user can see/reach it until someone opens it and it's re-owned via a save, or it's shared out).
      grants: oldTrip.grants || [],
    });
  }
  await saveTripIndex(env, index);
}

// Renames the generic `id` field on a trip and every item inside it to its
// typed name (tripId/destinationId/activityId/...), for a trip object
// coming out of the OLD storage format during migration. Every reference
// field (activity.destinationId, transport.contactId, grant.companionId,
// etc.) already used the typed name before this change, so those are left
// completely alone — only each object's OWN id needs renaming.
function renameIdFieldsForMigration(oldTrip) {
  const content = {};
  TRIP_CONTENT_FIELDS.forEach(function (key) {
    content[key] = oldTrip[key];
  });
  // Deliberately no content.tripId -- see TRIP_CONTENT_FIELDS' comment.
  // Writing it here would mean a migrated trip's stored content carried a
  // field that every subsequent save strips back out, so the very first
  // save after migration would always look like a change even when
  // nothing was actually edited.
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

// Copies `item`, replacing its generic `id` field with one named
// `newIdField` — used only during migration (see above). Items saved by
// the NEW code already come out of the frontend with the typed name
// directly, so this renaming only ever needs to run once per trip, the
// first time it's read after this change ships.
function renamedIdCopy(item, newIdField) {
  const copy = Object.assign({}, item);
  if (Object.prototype.hasOwnProperty.call(copy, "id") && !Object.prototype.hasOwnProperty.call(copy, newIdField)) {
    copy[newIdField] = copy.id;
    delete copy.id;
  }
  return copy;
}

/* ============================================================================
 * Permission resolution — the one function that decides what an account
 * may do with a trip, from server-side truth only. Unchanged in spirit
 * from before this pass — only WHERE `trip.ownerId`/`trip.grants` come
 * from changed (the trip index now, instead of the trip object itself).
 * ==========================================================================*/

function findGrant(trip, accountId) {
  return (trip.grants || []).find(function (g) { return g.accountId === accountId; }) || null;
}

/**
 * Resolves what `user` may do with `indexEntry` (one entry from the trip
 * index — has ownerId/grants, NOT the trip's actual content), right now —
 * purely from `indexEntry.ownerId` / `indexEntry.grants` / `user.isUberUser`,
 * NEVER from anything the client claims. Returns `null` if this account has
 * no access to this trip at all (treat it as if it doesn't exist), or one of:
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
 * Turns a trip's raw `grants` array (just account ids + roles) into
 * something a browser can actually show, by resolving each accountId to
 * its current username via `usersDoc`. An entry whose account has since
 * been deleted is quietly left out — same "dangling reference just
 * vanishes, nothing crashes" philosophy as a deleted companion's tags.
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
 * can see, combining the index entry's bookkeeping (ownerId/grants, or a
 * scoped view of neither) with that trip's own content loaded from its
 * "trip:<id>" key. Mirrors exactly what the old single-blob
 * buildResponseState() used to do per trip — see that function's
 * description below for the full shape.
 */
function buildVisibleTrip(indexEntry, content, perm, usersDoc) {
  const revision = Number.isInteger(content && content._revision) ? content._revision : 0;
  // Normalize stored data again on the way out. This protects upgraded
  // deployments from values written by an older, less strict Worker.
  content = sanitizeTripContent(content);
  // Resolved once, shared by both branches below -- see the big
  // COMPANIONS & AVATARS comment near AVATAR_COLOR_TOKENS for why this is
  // safe to hand to EVERY role: it's already been reduced to just a
  // colour + an animal (or a colour alone), never a raw accountId.
  const companionAvatars = resolveCompanionAvatars(content, usersDoc);
  // Same "safe to hand to everyone" reasoning as companionAvatars just
  // above -- see resolveCompanionAccessLevels()'s own big comment for why
  // this is sent to every role, unlike `grants` below it.
  const companionAccessLevels = resolveCompanionAccessLevels(indexEntry, content, usersDoc);

  if (perm.role === "superuser" || perm.role === "admin") {
    const ownerAccount = usersDoc.users.find(function (u) { return u.id === indexEntry.ownerId; });
    return Object.assign({ tripId: indexEntry.tripId }, content, {
      ownerId: indexEntry.ownerId,
      myGrant: perm,
      ownerUsername: ownerAccount ? ownerAccount.username : "",
      grants: resolveGrants(indexEntry, usersDoc),
      companionAvatars: companionAvatars,
      companionAccessLevels: companionAccessLevels,
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
  // No ownerId/grants added at all for a scoped account -- see the class
  // comment on the old buildResponseState() this replaces: a scoped
  // account has no business knowing who else has access to a trip they
  // can barely see into themselves.
}

/**
 * Builds the whole GET /api/data response: every trip `user` has ANY
 * access to (from the index), each one loaded and annotated exactly as
 * buildVisibleTrip() above describes. This does one extra KV read per
 * visible trip compared to the old single-blob design (which had
 * everything in memory already) -- a fine trade-off for an app with a
 * handful of trips per account, in exchange for never having to load
 * every trip that exists just to show the ones you can see.
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
 * Saves the page's current `state.trips` -- safely. See the big
 * "SAVING SAFELY" comment near the top of this file for why a plain
 * overwrite would be dangerous now that trips are private-by-default.
 *
 * The rule, trip by trip, computed from the REAL currently-stored index
 * (never from the client):
 *
 *   - No access, or a "viewer" grant: this trip is left completely
 *     untouched -- its content key isn't even read, whatever (if
 *     anything) the client sent for it.
 *   - Superuser (owner, or the uber-user) or an "admin" grant: the whole
 *     trip's CONTENT is replaced with what they submitted -- leaving it
 *     out entirely means they deleted it (its content key is deleted and
 *     its index entry removed). `ownerId` and `grants` always come from
 *     the stored index, NEVER from the client -- even a Superuser can't
 *     change who owns/shares a trip through this endpoint, only through
 *     /api/trip-grants (see below), which checks that specifically.
 *   - A "user" grant: only fields on items that already existed AND were
 *     tagged with their companion both before and after get updated (see
 *     mergeUserScopedTrip()). They can't add or remove items, retag
 *     anything, or touch the trip's own fields, companions or contacts --
 *     all of that comes back exactly as stored.
 *   - Anything in the submitted body whose tripId ISN'T an existing trip
 *     is a brand-new trip: any logged-in account may create one, and
 *     becomes its permanent Superuser (owner) automatically.
 *
 * A trip's own content key is only written when its content actually
 * changed (a plain JSON-string comparison against what's currently
 * stored) -- editing Trip A never touches Trip B's key at all, even if
 * Trip B happened to be included in what the browser submitted (which it
 * normally is, since the frontend still keeps and resubmits its whole
 * local `state`). The index is only rewritten if a trip was created,
 * deleted, or had its name/dates/currency changed -- ordinary item edits
 * never touch it.
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
   * writing a single thing. ---------------------------------------------
   * A trip is deleted by being LEFT OUT of what the browser sends (there's
   * no "delete" endpoint -- see the rules in this function's doc comment).
   * That's fine when the browser genuinely has the full picture, and
   * dangerous when it doesn't, so this pass catches the two ways it might
   * not:
   *
   *   1. A trip whose content key couldn't be read. buildResponseState()
   *      SKIPS such a trip when building the GET response, so the browser
   *      never had it to send back -- treating that absence as "delete it"
   *      would destroy a trip purely because a read failed. Cloudflare KV
   *      is eventually consistent (a just-written key can briefly read as
   *      missing from another location, and misses are cached), so this
   *      is a real, reachable state, not a hypothetical one.
   *   2. More than one trip missing at once. The UI only ever deletes ONE
   *      trip at a time, behind a confirmation dialog -- so a request that
   *      would delete two or more is never something the real app
   *      produces. It means the browser is working from a stale or empty
   *      copy of the data (e.g. a failed load that fell back to "no trips
   *      at all"), and applying it would wipe out everything that account
   *      can see. Rejecting the whole request and changing nothing is the
   *      only safe answer.
   *
   * This is deliberately a separate pass rather than a check inside the
   * main loop below: it has to be able to reject the request having
   * written NOTHING, and the main loop starts writing as it goes.
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
      // A companion's accountId is protected exactly like ownerId/tripId
      // above -- see the big COMPANIONS & AVATARS comment near
      // AVATAR_COLOR_TOKENS for why even a full-scope Superuser/admin
      // save can't be trusted to carry it through unmodified, and why
      // this has to REASSERT the real stored value rather than just
      // deleting the field (deleting it would erase every existing
      // account link the next time anyone saved anything at all).
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

// Never let a client-submitted trip object smuggle its own idea of who
// owns it, who it's shared with, or (for a scoped account) what its
// permission even is into storage -- these fields only ever exist in a
// GET response as a convenience for the UI, and are always recomputed
// server-side before anything is written back. See handlePost() above.
// Also strips tripId itself -- that lives in the index/KV key, never
// inside a trip's own content document.
function stripClientOwnershipFields(trip) {
  return sanitizeTripContent(trip);
}

/**
 * Applies a "user" grant's edits to a trip's CONTENT: only fields on items
 * that already existed AND were tagged with `companionId` in BOTH the
 * stored and the submitted version get updated. Everything else -- the
 * trip's own name/dates/notes, its contacts, other people's items -- comes
 * back exactly as it was stored, no matter what the client sent. This is
 * what makes a "user" grant genuinely safe to give write access to: even a
 * compromised or buggy client can't use it to reach outside their own
 * tagged items. (ownerId/grants aren't part of a trip's content at all any
 * more -- they live only in the index, which a "user" grant never touches
 * regardless.)
 *
 * ONE exception, added for Phase 3 of the Companions/Avatars feature: the
 * companions list. A "user" grant may APPEND a brand-new companion (see
 * mergeUserScopedCompanions() below) but still can't rename, delete or
 * retag an EXISTING one -- and can never set an accountId on any
 * companion, new or old (see the big COMPANIONS & AVATARS comment near
 * AVATAR_COLOR_TOKENS for why that specifically matters).
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

// The Phase-3 half of mergeUserScopedTrip() above: lets a "user" grant
// APPEND a brand-new companion, but nothing more. Every existing
// companion in `storedCompanions` is carried through completely
// untouched -- there is no way for a "user" grant to rename, delete,
// add notes to, re-colour, or (especially) link an account to one that
// already exists, no matter what `incomingCompanions` contains for it.
// A genuinely NEW companion (a companionId not already in storage) gets
// rebuilt from scratch out of only the two fields a "user" grant is
// allowed to specify -- `name` and an optional smiley colour -- rather
// than trusting the submitted object's other fields at all. This is
// deliberately stricter than mergeUserScopedList() above (which merges
// most fields of an item they already own): a "user" grant doesn't OWN
// the companion they're adding the way they own their own tagged items,
// so there's no "their own data" to trust here, only a name to accept.
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

/* ---- Route handlers: sharing a trip (grant / revoke) ---------------------
 * A trip's Superuser (its owner, or the uber-user) can grant ANY role,
 * including Admin. As of Phase 2 of the Companions/Avatars feature, an
 * "admin" grant can ALSO share the trip -- but only as User or Viewer,
 * never Admin -- so creating another Admin stays the owner's call alone,
 * exactly as originally asked for ("Admin grants may share as User/Viewer
 * only"). Both handlers check this against the REAL stored `ownerId`/
 * `grants` (on the trip's INDEX entry, not the trip object itself), never
 * anything the client claims. ---------------------------------------- */

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

  // Upsert: replace any existing grant for this account, or add a new one.
  indexEntry.grants = (indexEntry.grants || []).filter(function (g) { return g.accountId !== targetAccount.id; });
  indexEntry.grants.push({ accountId: targetAccount.id, role: role, companionId: role === "admin" ? "" : companionId });
  await saveTripIndex(env, index);

  // Sharing a trip AS a specific companion (User/Viewer) is also how that
  // companion's account link gets set -- see the big COMPANIONS & AVATARS
  // comment near AVATAR_COLOR_TOKENS. assignCompanionAccountId() takes
  // care of clearing this account off any OTHER companion on this trip
  // it might already be linked to, so the two can never both claim it at
  // once. This is a second, separate KV write (the grant itself lives in
  // the index, the link lives in the trip's own content) -- if it fails
  // partway through, the grant still exists and the avatar simply falls
  // back to the ordinary "not linked yet" smiley until this is retried
  // (e.g. by sharing again), rather than the whole share failing.
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
  // Deliberately does NOT clear the revoked account's companion.accountId
  // link -- see the big COMPANIONS & AVATARS comment. Revoking access
  // just means this account can no longer see/edit the trip; it says
  // nothing about whether the person is still a genuine companion on
  // it, so their avatar keeps showing correctly for everyone else who
  // can still see this trip. Use the dedicated "unlink" action
  // (handleCompanionLink() below, accountId: null) if the link itself
  // was wrong and needs undoing too.
  return new Response(JSON.stringify({ status: "ok" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Standalone action for linking (or, with an empty `username`, unlinking)
 * a companion to an account WITHOUT necessarily granting that account any
 * access to the trip -- e.g. giving an already-Admin account (who has
 * full access some other way, or doesn't need edit access to this trip
 * at all) their own avatar as a companion, or fixing a companion that got
 * linked to the wrong account by handleTripGrantsUpsert() above. Same
 * permission bar as sharing itself (Superuser or Admin) -- linking alone
 * grants no new access, but it's still identity data about a real
 * account, not something a scoped role should be able to touch.
 *
 * Takes a `username` to look up, exactly like /api/trip-grants above,
 * rather than a raw accountId -- so this endpoint never needs the full
 * account list handed to the page just so an Admin (who, unlike the site
 * owner, can't open "Manage accounts") has something to pick from.
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
 * Accounts, password hashing, and sessions — completely unchanged by this
 * storage-restructuring pass. See the "SCHEMA NOTE" comment near the top
 * of this file for why account records deliberately keep their plain `id`
 * field rather than being renamed to `accountId` alongside everything else.
 * ==========================================================================*/

/**
 * Reads the account list out of KV. A brand-new install has none yet, so
 * this always resolves to a valid { users: [] } shape rather than null —
 * exactly the same trick loadTripIndex() plays for trip data, and for the
 * same reason (nothing else in this file has to special-case "not set up
 * yet" versus "something went wrong").
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
  // isUberUser is included here (and in handleWhoami/handleSetup below)
  // deliberately, unlike publicUser() further down — this response only
  // ever describes the CALLER'S OWN account, never anyone else's, so
  // there's no "undisclosed uber-user" leak to worry about. The frontend
  // needs this one bit to decide whether to show the "Manage accounts"
  // button (see applyAuthUI() in public/WayPoint/index.html).
  // `avatar` is always resolved (never null -- see resolveAccountAvatar())
  // so the topbar has something real to draw the moment you log in, even
  // before you've ever opened the avatar picker.
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
  return new Response(JSON.stringify({ loggedIn: true, id: user.id, username: user.username, isUberUser: !!user.isUberUser, avatar: resolveAccountAvatar(user) }), {
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
 * Self-service avatar picker's save action -- see the big COMPANIONS &
 * AVATARS comment near AVATAR_COLOR_TOKENS. `user` always comes from the
 * current session (getCurrentUser(), via fetch()'s auth check above),
 * never from anything in the request body, so there is no way for this
 * endpoint to be used to change anyone ELSE's avatar -- every account can
 * only ever set its own.
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
