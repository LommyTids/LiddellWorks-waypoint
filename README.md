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
- **`src/worker.js`** — the server side. It answers `/WayPoint/api/data`
  (GET to read your saved trips, POST to save them) by reading/writing a
  single JSON blob in Cloudflare KV; answers `/WayPoint/api/flight-lookup`
  by proxying a flight number + date to the [AeroDataBox](https://aerodatabox.com/)
  API (via RapidAPI) and handing back the airline, airports, and scheduled
  local departure/arrival date+time — used by the "Look up" button next to
  Flight number on the transport form. Needs the `AERODATABOX_API_KEY`
  secret set up (step 4 below); and hands off every other request to
  Cloudflare's static file serving for the HTML file above.
- **`wrangler.toml`** — Cloudflare configuration: which route
  (`liddellworks.com/WayPoint*`) reaches this Worker, which KV namespace it
  uses, and where the static files live. Heavily commented — worth a skim.

The login gate is a single shared password, checked in `src/worker.js` via
plain HTTP Basic Auth — the browser's own built-in username/password
prompt, no custom login page to build. Anyone who knows the password gets
in; there's no per-person account, which matches "share it with a few
friends" rather than a strictly single-user gate. The password is never
committed to this repo — it's stored as a Worker *secret* in the
Cloudflare dashboard (step 3 below) and read at runtime as
`env.WAYPOINT_PASSWORD`. Everyone who knows it shares the same one set of
trips (see `src/worker.js` for more on that trade-off).

## One-time setup in the Cloudflare dashboard

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

3. **Set the shared password.**
   Workers & Pages → **waypoint-app** → **Settings** → **Variables and
   Secrets** → **Add** → name it exactly `WAYPOINT_PASSWORD`, type
   **Secret** (not plain text, so it's encrypted and never shown again in
   the dashboard), value: whatever password you want to share → **Save**.
   That's the whole login setup — no separate identity provider or
   per-person accounts to configure. To change the password later, edit
   this same secret and save again; no code change or redeploy needed.

4. **Set the flight-lookup API key (optional — only needed for the "Look
   up" button on the transport form).**
   Sign up free at [RapidAPI's AeroDataBox page](https://rapidapi.com/aedbx-aedbx/api/aerodatabox)
   and subscribe to its free plan to get an API key, then: Workers & Pages
   → **waypoint-app** → **Settings** → **Variables and Secrets** → **Add**
   → name it exactly `AERODATABOX_API_KEY`, type **Secret**, value: the
   key RapidAPI gave you → **Save**. Same "never committed to this repo,
   never shown again once saved" model as the password above — if this
   secret is missing, the "Look up" button just shows a clear "not set up
   yet" message instead of the rest of the app breaking.

Same as with the password, none of these secret values live anywhere in
this repo's code — `src/worker.js` only ever reads them at runtime as
`env.WAYPOINT_PASSWORD` / `env.AERODATABOX_API_KEY`.

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
