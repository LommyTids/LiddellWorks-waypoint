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
 *      write it into KV so it's there next time.
 *   2. `/WayPoint/api/flight-lookup` proxies a flight number + date (e.g.
 *      "BA15" on 2026-09-03) to the AeroDataBox API (via RapidAPI) and
 *      hands back its carrier, origin/destination airports, and scheduled
 *      local departure/arrival date+time — used to auto-fill the transport
 *      form when adding a flight. Requires the `AERODATABOX_API_KEY`
 *      secret (see handleFlightLookup() below for setup and for why this
 *      is a small server-side proxy rather than the page calling
 *      AeroDataBox directly with the key embedded in its public JS).
 *   3. For every other request (loading the page itself, any future CSS/JS/
 *      image files), just hand it off to Cloudflare's static asset serving
 *      (the `env.ASSETS` binding below) — that's what actually serves
 *      public/WayPoint/index.html.
 *
 * Who is allowed in is decided right here, with the simplest thing that
 * could possibly work: a single shared password, checked via ordinary
 * HTTP Basic Auth (see checkPassword() below). There's no per-person
 * account and no email/identity provider involved — anyone who knows the
 * one password gets in, which is exactly the "share it with a few
 * friends" model this was built for rather than a strictly locked-down
 * single-user gate. The password itself is never written into this file
 * or committed to the repo — it's set as a Cloudflare Worker *secret*
 * (Workers & Pages → waypoint-app → Settings → Variables and Secrets),
 * which is how this code reads it as `env.WAYPOINT_PASSWORD`.
 *
 * There is exactly one saved "document" for the whole app: one JSON blob
 * containing every trip, stored under the fixed KV key "state". Every
 * visitor who knows the password shares that same one blob — that
 * matches how the app already worked (a single `state` object holding
 * all trips) and keeps this Worker as simple as possible, but it does
 * mean friends you share this with will all see (and can all edit) the
 * same trips, not separate private ones each.
 * ============================================================================
 */

// A safety valve so a runaway request (or a bug in the frontend) can never
// fill up the KV namespace with an enormous payload. 5 MB is far more than
// even a very detailed set of trips should ever need as JSON text.
const MAX_BODY_BYTES = 5 * 1024 * 1024;

// The one fixed KV key everything is stored under. See the comment above —
// this is deliberately a single blob, not one key per trip.
const STATE_KEY = "state";

// A brand-new install has nothing in KV yet. Rather than the frontend
// having to guess what an "empty" trip list looks like, we hand back the
// same shape it would otherwise save: one object with an empty trips array.
const EMPTY_STATE = JSON.stringify({ trips: [] });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ---- Password gate ------------------------------------------------------
    // Checked before anything else, for every request under /WayPoint (the
    // page itself, its static assets, and the API alike) — so nobody can
    // reach the app OR read/write trip data without the shared password.
    if (!checkPassword(request, env)) {
      return new Response("A password is required to view this page.", {
        status: 401,
        // This header is what makes the browser pop up its own native
        // username/password prompt — no login form of our own to build or
        // style. The browser then remembers it (for that browser/device)
        // and sends it automatically on every later request, so visitors
        // only see the prompt once.
        headers: { "WWW-Authenticate": 'Basic realm="Waypoint", charset="UTF-8"' },
      });
    }

    // ---- Our JSON API -----------------------------------------------------
    if (url.pathname === "/WayPoint/api/data") {
      if (request.method === "GET") {
        return handleGet(env);
      }
      if (request.method === "POST") {
        return handlePost(request, env);
      }
      // Any other HTTP method (PUT, DELETE, etc.) on this path isn't
      // something the frontend ever sends — reject it plainly rather than
      // silently doing nothing.
      return new Response("Method not allowed", {
        status: 405,
        headers: { Allow: "GET, POST" },
      });
    }

    // ---- Flight lookup (reverse: flight number -> carrier + route) --------
    if (url.pathname === "/WayPoint/api/flight-lookup") {
      if (request.method !== "GET") {
        return new Response("Method not allowed", {
          status: 405,
          headers: { Allow: "GET" },
        });
      }
      return handleFlightLookup(url, env);
    }

    // ---- Everything else: hand off to the static file server --------------
    // `env.ASSETS` is configured in wrangler.toml to serve whatever's in the
    // public/ folder. Because this Worker's route (see wrangler.toml) only
    // matches liddellworks.com/WayPoint*, this never touches any other page
    // on the site — a request for e.g. liddellworks.com/blog never reaches
    // this Worker at all, Cloudflare routes it to whatever normally serves
    // the rest of the site instead.
    return env.ASSETS.fetch(request);
  },
};

/**
 * Reads the saved trips out of KV and returns them as a JSON HTTP response.
 * If nothing has been saved yet (first-ever visit), returns the empty
 * shape instead of an error, so the frontend never has to special-case
 * "no data yet" versus "something went wrong".
 */
async function handleGet(env) {
  const saved = await env.WAYPOINT_KV.get(STATE_KEY);
  return new Response(saved !== null ? saved : EMPTY_STATE, {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Takes the JSON body the page POSTed (its whole current `state` object)
 * and writes it into KV, overwriting whatever was there before. A few
 * basic checks first, so a broken request can't silently corrupt the
 * saved data or blow past sensible size limits.
 */
async function handlePost(request, env) {
  // Reject anything absurdly large before we even try to read/parse it.
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_BODY_BYTES) {
    return jsonError(413, "Request body too large.");
  }

  const bodyText = await request.text();
  if (bodyText.length > MAX_BODY_BYTES) {
    return jsonError(413, "Request body too large.");
  }
  if (!bodyText) {
    return jsonError(400, "Request body was empty.");
  }

  // Make sure what we're about to store is at least valid JSON. We don't
  // need to understand the shape in detail (that's the frontend's job) —
  // just confirm it will parse back out cleanly, so a network hiccup or a
  // bug can never leave KV holding something the app can't load again.
  try {
    JSON.parse(bodyText);
  } catch (err) {
    return jsonError(400, "Request body was not valid JSON.");
  }

  await env.WAYPOINT_KV.put(STATE_KEY, bodyText);
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

/**
 * Checks the request's HTTP Basic Auth credentials against the one shared
 * password stored in the WAYPOINT_PASSWORD secret. Only the password part
 * matters — Basic Auth always sends a "username:password" pair, but since
 * there's no concept of separate accounts here, any username is accepted
 * and only the password after the colon is actually compared.
 *
 * If WAYPOINT_PASSWORD hasn't been set at all (e.g. it was forgotten
 * during setup), this deliberately fails closed — every request gets
 * rejected — rather than silently leaving the app wide open.
 */
function checkPassword(request, env) {
  const expected = env.WAYPOINT_PASSWORD;
  if (!expected) return false;

  const authHeader = request.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Basic ")) return false;

  let decoded;
  try {
    // atob() turns the base64 Basic Auth value back into "username:password"
    // plain text. A malformed header just means "not authenticated" rather
    // than a crash.
    decoded = atob(authHeader.slice("Basic ".length));
  } catch (err) {
    return false;
  }

  const separatorIndex = decoded.indexOf(":");
  const suppliedPassword = separatorIndex === -1 ? decoded : decoded.slice(separatorIndex + 1);
  return suppliedPassword === expected;
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
