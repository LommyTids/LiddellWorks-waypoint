# Waypoint — self-hosted on liddellworks.com/WayPoint

This repo holds the whole Waypoint travel planner: a static single-file web
app (`public/WayPoint/index.html`) plus a small Cloudflare Worker
(`src/worker.js`) that saves your trip data to Cloudflare KV so it's still
there the next time you visit.

## Trip navigation and timeline

Each trip is organised around four jobs: **View** (Timeline and Map),
**Plan** (Destinations, Transport, Accommodation and Activities),
**People** (Companions and Contacts), and **Manage** (Expenses and
Settings). The groups remain fully visible and wrap on narrow screens;
none are hidden behind an overflow menu.

The Timeline is the primary itinerary editing view. Every existing
activity, transport leg and accommodation event can be edited there
directly, subject to the same per-trip permissions as its Plan-tab row.
On each day a full-scope editor can add an **Activity**, **Stay**, or
**Travel** entry: the date is prefilled from that day, a Stay defaults to
one night, and a single unambiguous active destination is selected as the
area automatically. The normal forms remain the source of truth, so the
Timeline does not introduce a duplicate data model.

New **Activities** use a category dropdown: Dining & drinks, Tour /
experience, Show / performance, Culture & sights, Outdoor / active,
Shopping, Wellness, Nightlife, or Other. New **Accommodation** records
use a type dropdown: Hotel / hostel, Apartment / holiday rental,
Guesthouse / B&B, Resort, Camping / glamping, Friends / family, Cruise
ship, or Other. Both default to Other so older records and unusual plans
remain valid. Their forms use progressive disclosure: Essentials are
shown first; Booking and contact, Cost and receipt, and People and notes
remain available in labelled expandable sections and reopen automatically
when editing a record that already has data there.

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
  `/api/account/avatar` and `/api/companions/link` — the self-service
  avatar picker and companion-to-account linking, see "Companions &
  Avatars" below; answers `/WayPoint/api/flight-lookup` by proxying a flight number +
  date to the [AeroDataBox](https://aerodatabox.com/) API (via RapidAPI)
  and handing back the airline, airports, and scheduled local
  departure/arrival date+time — used by the "Look up" button next to
  Flight number on the transport form, needs the `AERODATABOX_API_KEY`
  secret set up (optional step 6 below); answers the authenticated
  `/api/location-search` and `/api/location-boundary*` endpoints for the
  shared location picker, keeping the `LOCATIONIQ_API_KEY` secret out of
  the browser; and hands off every other request (the
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
  non-transferable owner, with full read/write on it, and — the one
  thing only they can do — grant or revoke Admin access. Ownership can't
  be handed to someone else.
- **Admin** *(a role the owner can grant)* — full read/write on that one
  trip, same as the owner, and (as of the Companions/Avatars feature,
  below) can also share it themselves — but only as User or Viewer,
  never as another Admin, and can revoke a User/Viewer grant but never
  another Admin's. Only the trip's actual owner can touch an admin-role
  grant at all, in either direction. An Admin can also do everything the
  owner can with **Guests and Companions** (see below) — add either
  kind, and link or unlink a Guest to/from an account — that bar is
  "Superuser or Admin" throughout, not "Superuser only".
- **User** *(a role the owner or an Admin can grant, scoped to one
  companion)* — can see and edit only the items on that trip already
  tagged with the one
  companion they've been linked to (see "Guests and Companions", below)
  — their own accommodation, their own flights, that kind of thing. They
  can change details on those items, but can't create new items, delete
  anything, retag anything, or touch the trip's own name/dates/notes,
  its contacts, or an existing companion — they may only add a new
  Guest of their own.
- **Viewer** *(a role the owner can grant, scoped to one companion)* —
  the same scoping as User, but read-only, including for companions:
  a Viewer can't add anyone at all.

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

A trip's owner or Admin shares it from that trip's own **Companions**
tab — who's tagged as a companion and who can log in and see the trip
turned out to be one and the same "who's on this trip" question, so
they're managed together there (Settings just has a one-line pointer
left behind for anyone who remembers sharing living somewhere else).
There's no separate "share this trip" step at all any more: adding
someone as a Companion, or upgrading an existing Guest into one by
linking a username, is what grants access — the same form that links
the account also asks which privilege level to give them (or "No trip
access", if they should just get their own avatar without being able
to see or edit the trip). The account has to already exist (create it
from Manage accounts first if it doesn't). An Admin's own privilege
dropdown simply doesn't offer "Admin" as an option — only the owner can
grant that, and only the owner can change or remove another Admin's
access once granted. A person can be a different companion on different
trips, or have a completely different role, or no access at all — it's
all per trip. See "Guests and Companions" below for the full mechanics.

## Companions & Avatars

**Guests and Companions** (Destinations/Activities/Accommodation/
Transport tabs each gained this) — a per-trip list of the people
actually on the trip, managed from its own Companions tab, which shows
them as two clearly separate lists — **Companions** (people with their
own login) above, **Guests** (people without one) below — rather than
one mixed list. Any destination, activity, accommodation booking or
transport leg can be tagged with any number of them (a small row of
checkboxes on that item's form), and the tags show up right on that
item in the list. This is more than a label — it's also literally what
a User/Viewer grant's visibility is scoped to (see above), so tagging
accurately matters if you're planning to share a trip with anyone.

"Guest" and "Companion" are the two kinds of person this list can hold
— it's the same underlying record either way (just a name, an optional
smiley colour, and an optional account link), and which section you see
them in is purely whether that link is set:

- A **Guest** has no Waypoint login. Anyone who can add a person at all
  — including a **User** grant, who may only ever append (see below) —
  can add one: just a name and a smiley colour, nothing else. The "Add
  guest" button is the plain grey one.
- A **Companion** has their own login. Only the trip's owner or an Admin
  can create one directly (the "Add companion" button — deliberately
  the coloured one, next to "Add guest", matching the coloured marker a
  Companion gets), or upgrade an existing Guest into one afterwards via
  the link icon next to their name. **Either way, this same form also
  asks what privilege level to give them** — Admin, User or Viewer, or
  "No trip access" if they should just get their own avatar without
  being able to see or edit the trip — and grants it automatically.
  There's no separate sharing step any more: "Add companion" is "add a
  Guest, link them to a username, and share the trip with them" chained
  into one form, and the link icon on an existing Companion doubles as
  the place to change their username or privilege level later. Changing
  the username moves the grant to the new account so the old account no
  longer retains hidden access; choosing "No trip access" revokes it
  while leaving the account link in place, so their avatar still resolves
  correctly.

A **User** grant may add a brand-new Guest of their own (just a name and
a smiley colour) from the Companions tab — but, like everything else a
User grant can do, only append: they can't edit, delete, retag, or link
one that already exists (so they never see the "Add companion" button,
only "Add guest"), and there's deliberately no Notes field on their
version of the form, since a User's submission would never keep one
anyway.

The **New trip** form itself also has a quick "Who's coming with you?"
box — a plain multi-line text box, one name per line (a comma also
works as a separator), that turns straight into a set of brand-new
Guests the moment the trip is created, so you don't have to immediately
jump to the Companions tab afterwards just to type the same names in
again. It's deliberately name-only (no smiley colour, no account
linking) to keep trip creation itself quick — everything else (colours,
notes, upgrading someone to a Companion) is still just a trip away on
the Companions tab. This box only appears when creating a trip, never
when editing an existing one (see `TRIP_FIELDS_NEW` vs `TRIP_FIELDS`,
and `parseCompanionNamesBox()`, in `public/WayPoint/index.html`).

A Companion who also has some level of access to THIS trip — because
they're its owner, the site's uber-user, or hold a grant — gets an
extra tag showing that access level right on their row: **Super**
(owner or uber-user), **Admin**, **User**, or **Viewer**. A Companion
who's linked but genuinely has no access to this trip (linked purely so
their avatar shows correctly, never actually shared — see "Linking"
below) gets a plain generic "Companion" tag instead, since there's no
specific level to show. Unlike the `grants` list itself — which a
scoped User/Viewer is deliberately never sent, so they can't learn who
else has access to a trip they can barely see into themselves — this
access-level tag IS sent to every role that can see the trip at all, by
design: it's a much narrower disclosure (a role level per companion, no
`accountId` or username attached) than the full sharing list, and the
tradeoff was made deliberately so that "how much can this person here
do" is visible to everyone on the trip, not just its owner and Admins.
See `resolveCompanionAccessLevels()` in `src/worker.js` for exactly what
it does and doesn't reveal, and why it's safe to send that widely even
though `grants` isn't.

**Avatars** — every account gets a small coloured circle with an animal
face, self-picked from the topbar (click your own name/swatch) — 10
colours × 16 animals, both fixed allowlists (see `AVATAR_COLOR_TOKENS`/
`AVATAR_ANIMAL_TOKENS` in `src/worker.js`, and their frontend twin in
`public/WayPoint/data/avatars.js`). Nobody's forced to pick one — until
you do, you get a stable, deterministic default (always the same one,
computed from your account id, never random) rather than a blank
circle. A Guest gets a different look on purpose — a fixed grey circle
with a smiley in a colour whoever added them chose (or, again, a
deterministic default if nobody ever did) — so a marker tells you at a
glance whether that person can log in at all. These markers show up
next to a companion's name everywhere one appears: item rows, the
tag-picker, the Timeline, and — new — each trip card on the dashboard
now shows a small row of everyone on that trip (capped, with a "+N"
bubble for the overflow).

**Linking** a Guest to an account turns them into a Companion — their
marker becomes that account's own coloured circle + animal instead of
the grey smiley, and (once they also have some access, see the
access-level tags above) they pick up a role tag too. It happens two
ways: automatically, whenever a trip's owner or an Admin shares that
trip with someone AS a specific companion — sharing already implies
"this companion is that account", so it links itself; or explicitly,
via the "Add companion" button (for a brand-new person) or the small
link icon next to an existing Guest or Companion (owner/Admin only
either way), which takes a username and a privilege level rather than
exposing any account-id list, and an empty username unlinks (reverting
a Companion back to a Guest). Linking on its own never grants trip
access — picking "No trip access" in that same form links without
sharing — and it only changes what marker (and, if applicable, tag)
shows up; revoking someone's trip access (setting their privilege level
back to "No trip access" without touching the username) deliberately
does **not** clear the link either (they're independent: one is "can
this account see this trip", the other is "whose face is this
companion's marker").

A companion's link (`accountId`) is treated as a protected,
server-computed field, the same as a trip's `ownerId` — nothing a
client submits for it is ever trusted, for **any** role, including an
ordinary Superuser/Admin save of the trip's own content. Every save
re-asserts each companion's real, currently-stored link rather than
simply stripping the field, which matters more than it might sound:
stripping would silently wipe out every existing link the next time
*anyone* made an unrelated change (renaming the trip, adding an
expense) — exactly the kind of quiet data-loss bug the storage
restructuring further up this file exists to guard against. See the big
"COMPANIONS & AVATARS" comment near `AVATAR_COLOR_TOKENS` in
`src/worker.js` for the full reasoning, and
`reconcileCompanionAccountLinks()` for the actual guard.

Two small new endpoints support all this: `POST
/WayPoint/api/account/avatar` (any logged-in account sets only its own
colour/animal, rejecting anything outside the two allowlists) and
`POST /WayPoint/api/companions/link` (owner/Admin only, links or
unlinks one companion by username — this is also what the one-step "Add
companion" form calls, right after adding the person as an ordinary
Guest). Neither is reachable by a scoped User/Viewer grant.

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

**If you already completed the earlier setup steps for a previous version
of Waypoint, there's nothing new to do here** — this update reuses the
same `waypoint-data` KV namespace and existing auth secrets. Add the
`LOCATIONIQ_API_KEY` secret in step 5 to enable address and place search;
the flight-lookup secret remains optional in step 6. These steps are kept
here for a fresh install.

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

5. **Set the location-search API key.**
   Create a free [LocationIQ](https://locationiq.com/) account, then in
   Workers & Pages → **waypoint-app** → **Settings** → **Variables and
   Secrets** → **Add**, create `LOCATIONIQ_API_KEY` as a **Secret** with
   the key from LocationIQ. This enables the explicit **Find location**
   workflow for destinations, activities, accommodation and transport
   hubs. If it is not set, existing saved pins still work and each form
   offers typed-location and manual-pin fallbacks; searches show a clear
   setup message. Never put this key in `wrangler.toml` or the repository.

6. **Set the flight-lookup API key (optional — only needed for the "Look
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
- A dedicated test for the Map tab: saved pins, transport endpoints and
  cached destination boundaries render without any browser geocoding call;
  the map day-stepper keeps overnight transport on both relevant days and
  accommodation visible through checkout day.
- A dedicated test for the "Look up" flight-number button, mocking
  `/WayPoint/api/flight-lookup` itself — it checks the frontend's side
  (button only shows in Flight mode, requires a depart date, fields
  populate on success including an overnight flight's next-day arrival
  date, a clear message on a not-found/error response). The Worker's own
  call out to AeroDataBox is exercised against the real service once this
  is deployed with `AERODATABOX_API_KEY` set.
- A dedicated test for Flight legs resolving on the Map tab via stored
  coordinates — the fix for routes like SFO–ICN not showing up. It checks
  the leg still draws when no text-geocoding service is available (proving
  the coordinate came from `COMMON_AIRPORTS`, the shared picker or
  AeroDataBox's own location data), and separately checks that flight details from a "Look
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
  are stored as a companionId and resolved to a name at render time),
  deleting a tagged companion leaving the item itself intact with the
  tag just quietly gone (no crash, no stale reference); and, added for
  the Companions/Avatars feature: picking a smiley colour when adding a
  companion, linking a companion to an account (and the marker switching
  from a smiley to that account's own avatar), that link surviving an
  unrelated save untouched, a hand-crafted accountId on a different,
  never-linked companion being refused even from a full-scope session
  (while a real, legitimate link in that same request survives
  untouched), unlinking reverting the marker back to a smiley, and the
  dashboard trip card showing one avatar marker per companion; and,
  added for the Guest/Companion terminology update: the one-step "Add
  companion" form (create a brand-new person already linked to a
  username, right next to "Add guest") creating them genuinely linked —
  correct marker, correct access-level tag — verified against the
  server's own stored copy, not just the optimistic render; and, added
  for the New trip form's "Who's coming with you?" box: the box only
  shows up while creating a trip (never editing one); typing several
  names — one per line, plus a comma-separated pair on one line, with a
  blank line in between — turns into that many brand-new Guests the
  moment the trip is created (verified server-side, none carrying an
  `accountId`); and leaving the box empty creates a trip with no
  companions at all, same as before this feature existed.
- A dedicated test for the avatar half of the Companions/Avatars feature
  (`test-avatars.js`) — the colour/animal palette allowlists rejecting
  anything not on either list; the self-service avatar picker (topbar
  swatch button, live two-grid preview, save) working end to end and
  round-tripping through the server; a brand-new account already having
  a real, deterministic default avatar before ever picking one; that
  picking your own avatar never touches another account's; and
  `resolveCompanionAvatars()`'s three real shapes — linked to an account
  (inherits that account's own avatar), unlinked with an explicit smiley
  colour chosen, and unlinked with nothing ever chosen (a stable
  deterministic default, not re-randomised on every request) — including
  that a SCOPED (Viewer) role's own response carries the exact same
  resolved map as the full-scope one.
- A dedicated test for the per-trip ownership + grants permission system
  — the first-run "set up Waypoint" screen (including a wrong setup key
  being rejected, and setup refusing to run again once an account
  exists); that creating a trip makes you its permanent Superuser
  automatically; granting access via the Companions tab's "Add
  companion" (create-and-link-and-share, one form) and the link icon's
  privilege-level select (upgrade-and-share an existing Guest) with an
  Admin, a User (scoped to one companion) and a Viewer (scoped to a
  different companion); that an Admin grant gets full read/write, and
  (as of the Companions/Avatars feature) can share the trip itself as
  User/Viewer — with that share auto-linking the chosen companion's
  avatar — but is refused (403) granting Admin access even via a raw
  request, and refused revoking an admin-role grant (even their own);
  that on a trip THEY own, an Admin's link-form privilege-level select
  does offer Admin, but not on a trip where they're merely an Admin
  grant themselves; that a User grant sees and can edit only their own
  tagged items (with the Companions tag-picker locked on their edit
  form), never sees an Add/Delete control on an EXISTING item, and never
  sees the Expenses tab at all — but (Phase 3) DOES see an "Add guest"
  button of their own, limited to a name and smiley colour with no Notes
  field, and can never edit/delete/retag/link a companion (so it never
  sees the separate "Add companion" create-and-link button either, that
  being Superuser/Admin only), including one they just added themselves;
  that a Viewer grant is fully read-only even for their own tagged
  items, with no "Add guest" or "Add companion" button either; that —
  for the Guest/Companion terminology update — a scoped User AND a
  scoped Viewer grant both correctly see every companion's access-level
  tag (Super/Admin/User/Viewer, or a generic "Companion" fallback for a
  link that's outlived its own grant), for companions other than their
  own, proving that tag really is sent to every role and not just
  derived from something only a full-scope role can see; that revoking
  a companion's access back to "No trip access" through that same
  link-form select removes their visibility while leaving them linked
  (their avatar still resolves to the account's own); that an account
  with no grant on a trip doesn't see it at all; that the site's
  one uber-user account gets full access to a trip it was never shared
  on and never appears in that trip's own sharing list; that the last
  remaining site-owner account can't be deleted; and — the most important
  check in this file — a raw `fetch()` from a "user"-scoped session,
  bypassing the UI entirely, hand-crafting a save request that tries to
  rename the trip, retag an item outside their scope, delete their own
  tagged item, sneak in a brand-new item, overwrite a completely
  different trip they have zero access to, rename or delete an EXISTING
  companion, and smuggle a protected `accountId` onto one — proving the
  safe per-trip merge-save genuinely rejects every single one of those
  (while the companion that account legitimately appended earlier
  survives untouched), not just the ones the UI happens to prevent. This
  test (and this one alone) runs the mock server with `--empty-users`
  (see mock-server.js) to exercise the true first-run state; every other
  test uses mock-server.js's normal pre-seeded uber-user account
  (`admin` / `testpass123`) via the `loginAsAdmin()` helper in
  `test-helpers.js`, since they don't care about the bootstrap flow
  itself and would otherwise all need to repeat it.

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

Every suite above has been run — including against the Companions/
Avatars feature described earlier in this file, its later
Guest/Companion terminology update (the "Add companion" one-step
create-and-link form, and access-level tags sent to every role), the
New trip form's "Who's coming with you?" quick-add box, and the
privilege-level-on-link update that retired the standalone "Share
access" panel (granting/changing/revoking access now happens through
the same link form that manages a Companion's account, and the
Companions tab shows Companions and Guests as two segregated lists) —
and passes (over 200 assertions across 12 suites), covering a full
end-to-end pass of the
permissions test's hostile `fetch()` attack scenario (now extended to
also cover companion rename/delete/accountId-smuggling attempts) against
the `trip_index`/`trip:<id>` storage shape. The two data-loss guards
around trip deletion were each verified by deliberately removing them
and confirming the relevant test fails: with both removed, one failed
load followed by creating a single trip destroys every existing trip
while the UI reports "Saved". The equivalent guard for a companion's
account link (`reconcileCompanionAccountLinks()` re-asserting the real
stored value rather than stripping the field) was verified the same
way: swapping it for a plain "always strip accountId" version makes
`test-companions.js`'s "unrelated save leaves the link intact" check
fail immediately.
