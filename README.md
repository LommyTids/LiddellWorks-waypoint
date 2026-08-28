# Waypoint — self-hosted on liddellworks.com/WayPoint

This repo holds the whole Waypoint travel planner: a static single-file web
app (`public/WayPoint/index.html`) plus a small Cloudflare Worker
(`src/worker.js`) that saves your trip data to Cloudflare KV so it's still
there the next time you visit.

## How it's put together

- **`public/WayPoint/index.html`** — the entire app: markup, styles, and
  JavaScript in one file, no build step, no framework. It keeps all your
  trips in one in-memory `state` object and re-draws the page from that
  object whenever something changes. On load it fetches your saved data
  from `/WayPoint/api/data`; every time you add/edit/delete something, it
  POSTs the updated data back to that same endpoint.
- **`public/WayPoint/data/`** — a handful of small `.js` files, each just
  a plain list: `currencies.js`, `timezones.js`, `countries.js`,
  `cities.js`, `airports.js`. These feed the autocomplete suggestions on
  various form fields (e.g. typing a currency code or a country name).
  They used to live inline inside `index.html` as large arrays, which
  made that one file unwieldy to edit/upload as a single piece — they're
  loaded via a few `<script src="/WayPoint/data/...">` tags near the top
  of `index.html` instead, same as the vendored Leaflet library. Each
  entry in `airports.js` also carries the airport's city, country, and
  a real lat/lng coordinate — that coordinate is what makes a Flight
  leg's "From"/"To" resolve reliably on the Map tab: the app matches
  the airport code straight against this list at save time and uses
  the coordinate directly, rather than asking OpenStreetMap's free
  geocoder to correctly interpret text like "SFO — San Francisco,
  United States" (which it sometimes just can't).
- **`public/WayPoint/data/airports-full.js`** — the same idea as
  `airports.js`, scaled way up: a coordinate for essentially every
  airport with an IATA code worldwide (~7,900 of them), built from the
  `airportsdata` Python package (PyPI), which bundles a comprehensive,
  actively-maintained database sourced from OurAirports. It's a
  background lookup table, not a visible suggestion list — when a
  Flight leg's airport isn't one of `airports.js`'s ~126 curated major
  hubs, this is checked next, before falling back to whatever AeroDataBox
  itself returns from a "Look up" click, and only then to the
  OpenStreetMap geocoder. Loaded with `defer` (it's the one sizeable
  file in `data/`, ~550KB) since, unlike the others, nothing needs it
  until a Flight leg is actually saved.
- **Airport field suggestions and the live "resolved" hint.** The
  From/To fields on a Flight leg are still a single plain text box
  (not a two-step city-then-airport picker) — typing starts you off
  with the ~126 curated major hubs as suggestions, the same list as
  always. Once you've typed 2+ characters, though, the suggestion list
  quietly widens to search the full ~7,900-airport `airports-full.js`
  database by code, city, or name, capped to the best 30 matches — so
  a secondary airport like Birmingham (BHX) or a less common city
  spelling still shows up, without ever rendering thousands of options
  into the page (that would be slow, especially on a phone or tablet).
  Underneath the field, a small hint updates live as you type: "✓
  Mapped precisely for the Map tab" once what you've typed resolves to
  a real airport coordinate, or "No exact airport match yet" if it
  doesn't (yet) — so you always know whether that leg will place
  accurately on the Map tab before you
  even hit Save. The suggestion list itself is a small app-rendered
  dropdown, not a native browser `<datalist>` popup — an earlier
  version used a datalist, but real-world testing found two problems
  with that: its popup can't be repositioned with CSS at all (it ended
  up covering part of the input on a narrow screen), and swapping its
  options live was interrupting mid-word typing on at least one real
  device. The custom dropdown sits flush under the input, never over
  it, and rebuilding it never touches the input itself, so typing is
  never interrupted. It supports arrow-key navigation and Enter to
  select, same as the native version did, plus click-to-select. The
  ~7,900-airport search itself is also a bit faster now: it builds a
  lowercased search index once on first use instead of redoing that
  work on every keystroke, which was the main source of the typing lag
  some devices were seeing.
- **Every other suggestible field uses that same dropdown too.**
  Currency, country, city, and timezone fields — everywhere they
  appear, including the Home currency field on the Settings tab, which
  is hand-built outside the normal form system but still wired into
  the same mechanism — used to still be native `<datalist>` popups even
  after airport moved off them, which meant the app had two different
  autocomplete behaviors depending on which field you were in. They now
  all render through the same `suggestInputHtml()` helper and the same
  generic dropdown code (a `data-suggest-type` attribute on the input —
  "currency", "country", "city", "timezone", or "airport" — tells the
  shared dropdown logic which list/search to use), so every one of them
  looks and behaves identically: opens on focus, narrows as you type,
  never covers the field, supports arrow keys + Enter and click to
  select. There's no native `<datalist>` element left anywhere in the
  app. The plain-string fields (currency/country/city/timezone) use one
  small shared substring search (a "starts with" match ranked above a
  mere "contains" match) rather than airport's own richer scored search
  — their lists are only tens to a couple hundred entries each, so
  nothing fancier is needed.
- **The transport ("flight") form's layout and "Paid with" section.**
  Cleaned up from its original one-column-per-field version: seat/coach
  numbers were dropped entirely (unused clutter), and From/To, Depart
  date/Arrive date, Depart time/Arrive time, and Booking reference/
  Contact are each paired onto one row instead of stacking one field
  per line. Cost tracking is now behind a "Paid with" selector — Cash,
  Points, Combo, or Free — rather than always showing a currency+amount
  pair whether or not the leg actually cost cash: Cash shows currency
  and amount on one row plus a checkbox for using a different exchange
  rate than the trip's fixed one (the override input itself only
  appears once that's ticked, instead of always sitting there mostly
  unused); Points shows a points-program box and a points-count box
  instead; Combo shows both sections at once (for a leg part-paid each
  way); Free shows neither, since there's nothing to record. Saving
  only keeps whichever section is actually visible for the chosen
  option — switching an already-priced leg to Free clears its old cost
  rather than silently keeping data nothing on screen still shows.
  Editing a leg saved before this existed infers Cash (if it has a
  cost) or Free (if it doesn't) the first time it's opened, so existing
  cost data stays visible rather than disappearing behind a blank
  selector. Mode ("Flight"/"Train"/...), "Paid with", and the
  exchange-rate checkbox are all "reactive" fields (see `reactiveKey`
  in `openForm()`/`fieldsHtml()`) — changing any of them re-renders
  just the field list to match, without discarding anything else
  already typed into the form.
- **`src/worker.js`** — the server side. It answers `/WayPoint/api/data`
  (GET to read your saved trips — filtered per trip and, for a scoped
  grant, per item, see "Accounts and permissions" below — POST to save
  them, via a safe per-trip merge rather than a plain overwrite) by
  reading/writing a lightweight trip index plus one Cloudflare KV entry
  per trip (see "How trip data is stored" below) — the request/response
  shape the browser sees hasn't changed at all, only what happens on
  this end when it does; answers
  `/WayPoint/api/login`, `/api/logout`, `/api/whoami`, `/api/setup` and
  `/api/users*` — the account/session system; `/api/trip-grants` and
  `/api/trip-grants/revoke` — sharing a trip, see "Accounts and
  permissions" below and the big comment at the top of this file;
  answers `/WayPoint/api/flight-lookup` by proxying a flight number +
  date to the [AeroDataBox](https://aerodatabox.com/) API (via RapidAPI)
  and handing back the airline, airports, and scheduled local
  departure/arrival date+time — used by the "Look up" button next to
  Flight number on the transport form, needs the `AERODATABOX_API_KEY`
  secret set up (step 5 below); and hands off every other request (the
  page itself, its CSS/JS) to Cloudflare's static file serving, with no
  auth check at all — see this file's own comment for why serving that
  shell openly is fine and in fact necessary.
- **`wrangler.toml`** — Cloudflare configuration: which route
  (`liddellworks.com/WayPoint*`) reaches this Worker, which KV namespace it
  uses, and where the static files live. Heavily commented — worth a skim.

**Accounts and permissions.** Logging in used to be one shared password
via the browser's own Basic Auth prompt — that's gone now, replaced with
real per-person accounts and a signed login session (a cookie). There's
no self-signup or "forgot password" email flow (this still isn't a
commercial-grade auth system, just a proper one for a small trusted
group) — you create every LOGIN yourself from **Manage accounts** (top
bar; only the site owner's account sees this button). Creating an
account just gives someone somewhere to log in — on its own it doesn't
grant them access to anything.

Permissions are **per trip**, not a single global role on the account:

- **Superuser** — whoever creates a trip becomes its permanent,
  non-transferable owner, with full read/write on it and — the one power
  nobody else gets — control over who else has access (the "Share this
  trip" panel on that trip's Settings tab). Ownership can't be handed to
  someone else.
- **Admin** *(a role the owner can grant)* — full read/write on that one
  trip, same as the owner, except they can't grant or revoke anyone
  else's access — sharing stays the owner's call alone.
- **User** *(a role the owner can grant, scoped to one companion)* — can
  see and edit only the items on that trip already tagged with the one
  companion they've been linked to (see "Companions", below) — their own
  accommodation, their own flights, that kind of thing. They can change
  details on those items, but can't create new items, delete anything,
  retag anything, or touch the trip's own name/dates/notes, its
  companions list, or its contacts.
- **Viewer** *(a role the owner can grant, scoped to one companion)* —
  the same scoping as User, but read-only.

A trip nobody's shared with you is genuinely absent from what the server
sends back — not hidden in the UI, invisible. Expenses are always left
out entirely for a User/Viewer grant (there's no per-companion split for
those, and they often show what OTHER people spent).

On top of all that there's **one** additional, undisclosed account — the
site owner's own login, created during the one-time setup below — with
full access to every trip on the whole site, whether it was shared with
them or not, purely so you (as the person who runs this) can always get
in to fix something. Nothing in the app ever tells anyone else that this
account is special; every place permissions matter just treats it
exactly like a trip's real owner would be treated, and it never appears
in any trip's own sharing list.

A trip's owner shares it from that trip's own **Settings** tab: type the
username of an existing account, pick a role, and — for User/Viewer —
which companion they are on this trip. The account has to already exist
(create it from Manage accounts first if it doesn't). A person can be a
different companion on different trips, or have a completely different
role, or no access at all — it's all per trip.

**Companions** (Destinations/Activities/Accommodation/Transport tabs
each gained this) — a per-trip list of the people actually on the trip,
managed from its own Companions tab. Any destination, activity,
accommodation booking or transport leg can be tagged with any number of
them (a small row of checkboxes on that item's form), and the tags show
up right on that item in the list. This is more than a label — it's
also literally what a User/Viewer grant's visibility is scoped to (see
above), so tagging accurately matters if you're planning to share a trip
with anyone.

See the big "WHO IS ALLOWED IN" and "SAVING SAFELY" comments at the top
of `src/worker.js` for the full design (password hashing, session
cookies, the bootstrap problem and how `WAYPOINT_PASSWORD` solves it, and
— the trickiest part — how the save endpoint safely merges a save without
ever letting one account's request affect a trip or item outside what
they're actually allowed to touch) — worth a read before touching any of
it.

## How trip data is stored

Earlier versions kept every trip in one single KV value under the key
`state` — the whole thing read on every visit and rewritten on every
save, no matter how small the change. That has two real problems as the
number (and size) of trips grows: Cloudflare KV caps a single value at
25 MiB, and it allows at most **one write per second to the same key** —
so two people saving two *different* trips within the same second could
still silently collide on that one shared key, even though neither of
them touched what the other was editing. That was a real correctness
gap, not just a future scaling worry.

Trip data now lives in two kinds of KV entry instead of one:

- **`trip_index`** — one small document listing every trip that exists:
  just enough to render the dashboard (name, dates, currency) and
  resolve permissions (`ownerId`, `grants`) without loading any trip's
  actual content. This is the only place `ownerId`/`grants` are stored.
- **`trip:<tripId>`** — one KV key *per trip*, holding that trip's own
  content (destinations, activities, transport, accommodation, contacts,
  expenses, companions, notes, currency rates, geocode cache).

Saving a trip now only reads/writes that trip's own `trip:<id>` key — a
save to Trip A never touches Trip B's key at all, so two people saving
different trips at the same moment can no longer collide. The trip
index is still one shared key, so renaming a trip or changing who it's
shared with (both of which touch the index) keeps a much narrower
version of the old collision window — see the comment on
`saveTripIndex()` in `src/worker.js` for why that's an accepted,
much-smaller trade-off rather than something worth over-engineering away
for an app this size.

### Two guards against losing trips

Because a trip is deleted by being **left out** of what the browser sends
back (there's no separate delete endpoint — see "SAVING SAFELY" in
`src/worker.js`), anything that makes the browser's copy of your trips
incomplete is dangerous: the next save would tell the server to delete
whatever's missing. For the site owner's account, which can see every
trip, that's potentially the whole site's data — from one failed request
followed by one ordinary click. Two independent guards now prevent that,
either of which is enough on its own:

1. **The browser refuses to save data it never loaded.** If the initial
   load fails for any reason, the app marks its own state untrustworthy,
   shows "Not saved — refresh" in the top bar, and blocks every save
   until you reload. Previously it silently fell back to "no trips at
   all" and would happily save that over the top.
2. **The server refuses a save that would delete more than one trip at
   once.** The app only ever deletes one trip at a time, behind a
   confirmation dialog — so a request that would remove two or more is
   never something the real UI produces, and is rejected wholesale with
   nothing changed. It also never treats a trip whose stored content it
   couldn't read as "deleted", since that trip was left out of the
   response the browser was working from in the first place (Cloudflare
   KV is eventually consistent, so a just-written key genuinely can read
   as missing for a moment).

`test-storage-safety.js` covers both, and — importantly — has been
checked to actually fail when either guard is removed.

**Upgrading from an older deploy: nothing to do.** The very first time
the Worker runs after this update ships, it checks for `trip_index`; if
it isn't there yet, it reads the old `state` key, splits it into the new
shape, and writes it out — automatically, once, on that first request.
The old `state` key is left in place afterwards, untouched, purely as an
inert backup (nothing reads it again once the index exists) — safe to
ignore, and safe to delete later once you've confirmed everything looks
right, though there's no need to.

**Schema rename.** Every item's own id field used to just be called
`id` — fine deep inside one item's own object, confusing the moment
you're looking at raw JSON with several item types mixed together
(exactly the situation hand-editing a KV value in the Cloudflare
dashboard puts you in). Each item type now has its own clearly-named id
field instead:

| Item | Old field | New field |
| --- | --- | --- |
| Trip | `id` | `tripId` |
| Destination | `id` | `destinationId` |
| Activity | `id` | `activityId` |
| Transport leg | `id` | `transportId` |
| Accommodation | `id` | `accommodationId` |
| Contact | `id` | `contactId` |
| Expense | `id` | `expenseId` |
| Companion | `id` | `companionId` |

Fields that already *referenced* one of these (an activity's
`destinationId`, a booking's `contactId`, a grant's `companionId`)
didn't change at all — they already used exactly this naming, which is
what this rename brings everything else in line with. **Account/login
records are deliberately left alone** — still a plain `id` — to avoid
touching the auth/session system again right after it went through its
first real production incident. If you ever hand-edit a trip's KV value
directly in the Cloudflare dashboard again (as you did once already,
reassigning a trip's owner), use the new field names above and remember
you're now editing the `trip:<tripId>` key for that one trip, not a
`state` blob with every trip in it.

## One-time setup in the Cloudflare dashboard

**If you already completed all five steps below for an earlier version
of Waypoint, there's nothing new to do here** — this update reuses the
same `waypoint-data` KV namespace and the same three secrets
(`WAYPOINT_PASSWORD`, `WAYPOINT_SESSION_SECRET`, `AERODATABOX_API_KEY`).
Just push the updated code (step 1's auto-deploy picks it up) and the
storage migration above happens on its own. These steps are kept here
for a fresh install.

None of this repo's code can do these steps for you — they're dashboard
actions Cloudflare requires a person to click through:

1. **Connect this repo for auto-deploy.**
   Cloudflare dashboard → **Workers & Pages** → **Create** → **Import a
   repository** → pick this repo → leave the detected build settings as-is
   (it reads `wrangler.toml` automatically) → **Save and Deploy**.

2. **Confirm the route landed correctly.**
   Your zone **liddellworks.com** → **Workers Routes**. You should see
   `liddellworks.com/WayPoint*` pointing at the `waypoint-app` Worker,
   alongside whatever route already serves the rest of the site. Cloudflare
   always matches the more specific route first, so this shouldn't disturb
   anything else — but if the route isn't listed after step 1's deploy, add
   it manually there.

3. **Set the two auth secrets.**
   Workers & Pages → **waypoint-app** → **Settings** → **Variables and
   Secrets** → **Add**, twice:
   - `WAYPOINT_PASSWORD` — if you're upgrading from the old single-password
     version this already exists; keep it, it's been repurposed as a
     **one-time setup key** (see step 4). If this is a fresh install, set
     it now to any value you'll remember for the next five minutes — type
     **Secret**, not plain text.
   - `WAYPOINT_SESSION_SECRET` — new. This signs everyone's login session
     cookie, so it needs to be a long, random, unguessable value (e.g.
     generate one with `openssl rand -hex 32` in any terminal, or a
     password manager's "generate password" feature set to 40+ characters)
     — type **Secret**. Don't reuse `WAYPOINT_PASSWORD`'s value here.

   Both are read at runtime as `env.WAYPOINT_PASSWORD` /
   `env.WAYPOINT_SESSION_SECRET` — neither ever lives in this repo's code.

4. **Create your own account (one-time) — this becomes the site owner.**
   Visit `liddellworks.com/WayPoint` — since no accounts exist yet, you'll
   land on a "Set up Waypoint" screen instead of a login form. Enter the
   `WAYPOINT_PASSWORD` value from step 3 as the setup key, choose your own
   username and password, and submit — you're logged straight in. This
   first account is the one that gets full, undisclosed access to
   everything on the whole site forever after (see "Accounts and
   permissions" above) — there's exactly one of these, and it's whoever
   completes this step. That setup screen refuses to run a second time
   once any account exists, so it's safe to leave `liddellworks.com/WayPoint`
   reachable afterwards; there's nothing more to do with
   `WAYPOINT_PASSWORD` after this one step (leave it set or remove it,
   either is fine — it's inert either way). From here on, create a LOGIN
   for each family/friend yourself from **Manage accounts** (top bar,
   only visible to you) — there's no self-signup. Creating a login is
   just that: a login. Whoever creates a trip becomes ITS owner and
   decides from there who gets to see or edit it, and as what role — you
   don't need to do anything else to give someone access to a specific
   trip unless you're the one creating it.

5. **Set the flight-lookup API key (optional — only needed for the "Look
   up" button on the transport form).**
   Sign up free at [RapidAPI's AeroDataBox page](https://rapidapi.com/aedbx-aedbx/api/aerodatabox)
   and subscribe to its free plan to get an API key, then: Workers & Pages
   → **waypoint-app** → **Settings** → **Variables and Secrets** → **Add**
   → name it exactly `AERODATABOX_API_KEY`, type **Secret**, value: the
   key RapidAPI gave you → **Save**. Same "never committed to this repo,
   never shown again once saved" model as the secrets above — if this one
   is missing, the "Look up" button just shows a clear "not set up yet"
   message instead of the rest of the app breaking.

The KV namespace the Worker reads/writes (`waypoint-data`) already exists in
your Cloudflare account and is wired up in `wrangler.toml` — no separate
step needed for that.

## Developing locally

```
npm install
npm run dev      # runs the Worker + static app locally via wrangler
```

To deploy by hand instead of waiting for a Git push (rarely needed once
step 1 above is set up):

```
npm run deploy
```

## Testing

A handful of Playwright suites live outside this repo's deployed contents
(not part of what gets deployed):

- The original app-logic tests (trip/destination/transport CRUD, the
  overnight timeline, currency conversion, CSV export) still apply
  unchanged, since none of that logic changed.
- A dedicated test for this self-hosted adaptation spins up a tiny mock
  server standing in for the real Worker/KV, and checks that loading,
  saving, a full page reload, and CSV export all work the same way they
  will against the real deployment.
- A dedicated test for the Map tab, mocking the Nominatim/tile-server
  calls it makes.
- A dedicated test for the "Look up" flight-number button, mocking
  `/WayPoint/api/flight-lookup` itself — it checks the frontend's side
  (button only shows in Flight mode, requires a depart date, fields
  populate on success including an overnight flight's next-day arrival
  date, a clear message on a not-found/error response). The Worker's own
  call out to AeroDataBox is exercised against the real service once this
  is deployed with `AERODATABOX_API_KEY` set.
- A dedicated test for Flight legs resolving on the Map tab via real
  coordinates instead of free-text geocoding — the fix for routes like
  SFO–ICN not showing up. It mocks Nominatim to fail every request and
  checks the leg still draws (proving the coordinate came from
  `COMMON_AIRPORTS` or AeroDataBox's own location data, never from
  Nominatim), and separately checks that flight details from a "Look
  up" click (aircraft, terminal, gate) land in the leg's Notes field
  instead of just flashing in the status line and vanishing.
- A dedicated test for the From/To field's custom suggestion dropdown
  and resolve-hint — checks it opens on focus seeded with the curated
  ~126, widens to surface a secondary airport (e.g. BHX, or Chongqing
  by city name) once typed, shows the "✓ Mapped precisely" hint for a
  real match and "No exact airport match yet" for a city name/made-up
  text, never renders more than 30 suggestions at once even when a
  broad search term (e.g. "london") matches more airports than that,
  and — the specific bug this replaced a native `<datalist>` to fix —
  that typing a full word never gets interrupted partway through, and
  the dropdown always renders below the input rather than covering it.
  Also checks click-to-select and arrow-key-plus-Enter selection both
  fill the field and close the dropdown.
- A dedicated test for the transport form's layout and "Paid with"
  section — checks seat/coach is gone from every mode; From/To, Depart/
  Arrive date, Depart/Arrive time, and Booking reference/Contact each
  land on one row; a new leg defaults to "Free" with no cost/points
  fields showing; Cash/Points/Combo/Free each show exactly the right
  fields (including the exchange-rate checkbox only revealing its
  override input once ticked); saving a Cash or a Points leg persists
  the right data and leaves the other section blank; and editing a
  leg saved before "Paid with" existed correctly infers Cash and shows
  its existing cost data rather than hiding it.
- A dedicated test for the suggestion dropdown being consistent across
  every field that has one, not just airport — checks there's no native
  `<datalist>` element left anywhere on the page, that country/city/
  timezone fields on the destination form all carry the right
  `data-suggest-type` and sit in a `.suggest-input-wrap`, that each
  opens on focus with a seeded list and narrows to the expected match
  as you type, that clicking a suggestion fills the field, and that the
  Settings tab's hand-built Home currency field — the one field of this
  kind not built through the normal fieldHtml()/openForm() system —
  behaves identically to the rest.
- A dedicated test for the Companions feature — adding companions,
  tagging them onto a destination/activity/accommodation/transport leg
  via the "tag-picker" checkbox row, the tag showing up on that item's
  card, editing an item re-showing its saved tags checked correctly,
  renaming a companion updating their tag everywhere it appears (tags
  are stored as a companionId and resolved to a name at render time), and
  deleting a tagged companion leaving the item itself intact with the
  tag just quietly gone (no crash, no stale reference).
- A dedicated test for the per-trip ownership + grants permission system
  — the first-run "set up Waypoint" screen (including a wrong setup key
  being rejected, and setup refusing to run again once an account
  exists); that creating a trip makes you its permanent Superuser
  automatically; sharing it from the Settings tab's "Share this trip"
  panel with an Admin, a User (scoped to one companion) and a Viewer
  (scoped to a different companion); that an Admin grant gets full
  read/write but the server itself refuses a direct attempt to manage
  sharing (not just hides the panel); that a User grant sees and can
  edit only their own tagged items (with the Companions tag-picker
  locked on their edit form), never sees an Add or Delete control, and
  never sees the Expenses tab at all; that a Viewer grant is fully
  read-only even for their own tagged items; that an account with no
  grant on a trip doesn't see it at all; that the site's one uber-user
  account gets full access to a trip it was never shared on and never
  appears in that trip's own sharing list; that revoking someone's
  access actually removes their visibility; that the last remaining
  site-owner account can't be deleted; and — the most important check in
  this file — a raw `fetch()` from a "user"-scoped session, bypassing the
  UI entirely, hand-crafting a save request that tries to rename the
  trip, retag an item outside their scope, delete their own tagged item,
  sneak in a brand-new item, and overwrite a completely different trip
  they have zero access to — proving the safe per-trip merge-save
  genuinely rejects every single one of those, not just the ones the UI
  happens to prevent. This test (and this one alone) runs the mock
  server with `--empty-users` (see mock-server.js) to exercise the true
  first-run state; every other test uses mock-server.js's normal
  pre-seeded uber-user account (`admin` / `testpass123`) via the
  `loginAsAdmin()` helper in `test-helpers.js`, since they don't care
  about the bootstrap flow itself and would otherwise all need to repeat
  it.

`mock-server.js` (the small Node HTTP server every test above runs
against, standing in for the real Worker/KV) implements this same
per-trip permission-resolution and safe-merge-save logic in parallel to
`src/worker.js` — same endpoints, same request/response shapes, same
rules, same index-plus-per-trip-content storage split and the same
renamed id fields (`tripId`/`destinationId`/etc.) — since `src/worker.js`
is written as a Cloudflare Worker module (Web Crypto, KV bindings) and
isn't meant to run under plain Node. Its own comment block spells out
the deliberate differences from the real Worker (no `Secure` cookie
attribute, since it runs over plain local http; plain-text password
comparison instead of PBKDF2, since there's no real secret at stake in a
throwaway in-memory test server; and it never runs the old-format
migration, since an in-memory test server has no old data to migrate) —
none of these are bugs, they're there so nobody "fixes" this file to
match `worker.js` exactly and breaks every test.

- A dedicated test for the per-trip storage split and its safety guards
  (`test-storage-safety.js`) — checks that editing one trip writes only
  that trip's storage key and leaves every other trip's alone (the whole
  point of the restructuring, and otherwise invisible from outside, so
  `mock-server.js` keeps write counters and exposes them at a test-only
  `/api/__writes` endpoint); that re-saving unchanged data writes nothing
  at all; that renaming a trip does update the shared index; that
  deleting a single trip still works; that a save which would delete
  every trip is rejected with a 409 and changes nothing; that omitting
  exactly one trip still deletes just that one; that a failed data load
  leaves the app refusing to save rather than overwriting real data; and
  that a trip whose stored content can't be read is hidden rather than
  destroyed, coming back intact once the content is readable again
  (simulated via a second test-only endpoint, `/api/__hide-content`).
  Both `/api/__*` endpoints exist only in the mock — the real Worker has
  no equivalent and needs none.

Every suite above has been run against the per-trip storage restructuring
and schema rename described in "How trip data is stored" and passes (166
assertions across 11 suites) — including a full end-to-end pass of the
permissions test's hostile `fetch()` attack scenario against the new
`trip_index`/`trip:<id>` shape. The two data-loss guards were each
verified by deliberately removing them and confirming the relevant test
fails: with both removed, one failed load followed by creating a single
trip destroys every existing trip while the UI reports "Saved".
