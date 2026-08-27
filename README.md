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
