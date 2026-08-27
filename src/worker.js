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
 *   2. `/WayPoint/api/flight-lookup` proxies a flight number (e.g. "BA15")
 *      to the free adsbdb.com public API and hands back just its usual
 *      carrier and origin/destination airports — used to auto-fill the
 *      transport form when adding a flight. See handleFlightLookup() below
 *      for why this is a small server-side proxy rather than the page
 *      calling adsbdb directly.
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
      return handleFlightLookup(url);
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

// Only ever forward something that looks like a real flight/callsign
// number to the upstream service — letters and digits only, a
// sensible length. This isn't really a security boundary (the value
// gets URL-encoded either way) so much as a cheap way to fail fast
// with a clear message instead of sending obvious junk out to a
// third party and waiting on its response.
const FLIGHT_NUMBER_PATTERN = /^[A-Z0-9]{2,8}$/;

/**
 * Reverse-looks-up a flight number (e.g. "BA15") into its operating
 * airline and usual origin/destination airports, by proxying to the
 * free, keyless adsbdb.com public API (https://www.adsbdb.com/). This
 * lives server-side rather than being called straight from the page
 * for two reasons: it keeps every outbound call to a third party in
 * one place (so it's easy to swap providers later without touching
 * the frontend), and it means a flaky/slow upstream response can be
 * turned into a clean, friendly error instead of a raw browser fetch
 * failure landing in the form.
 *
 * Note this only returns the flight's *usual* route — adsbdb builds
 * it from real ADS-B traffic it has observed, not from an airline's
 * official schedule — so there's no date parameter here, and no
 * guarantee a specific day's flight matches exactly (codeshares,
 * seasonal route changes, etc. can differ). Good enough for
 * auto-filling "carrier" and "from/to" as a starting point that's
 * still easy to correct by hand.
 */
async function handleFlightLookup(url) {
  const raw = (url.searchParams.get("flightNumber") || "").trim().toUpperCase();
  if (!raw) {
    return jsonError(400, "No flight number given.");
  }
  if (!FLIGHT_NUMBER_PATTERN.test(raw)) {
    return jsonError(400, "That doesn't look like a flight number (letters and digits only, e.g. BA15).");
  }

  // adsbdb occasionally takes a moment to respond; don't let a slow
  // upstream hang the Worker (and the person's form) indefinitely.
  const controller = new AbortController();
  const timeout = setTimeout(function () { controller.abort(); }, 8000);

  let upstreamResponse;
  try {
    upstreamResponse = await fetch("https://api.adsbdb.com/v0/callsign/" + encodeURIComponent(raw), {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
  } catch (err) {
    return jsonError(502, "Couldn't reach the flight lookup service — try again in a moment.");
  } finally {
    clearTimeout(timeout);
  }

  if (upstreamResponse.status === 404) {
    return jsonError(404, "No route found for that flight number.");
  }
  if (!upstreamResponse.ok) {
    return jsonError(502, "The flight lookup service had a problem — try again in a moment.");
  }

  let data;
  try {
    data = await upstreamResponse.json();
  } catch (err) {
    return jsonError(502, "The flight lookup service returned something unexpected.");
  }

  const route = data && data.response && data.response.flightroute;
  if (!route || !route.origin || !route.destination) {
    return jsonError(404, "No route found for that flight number.");
  }

  // Reshape into just what the form needs, rather than passing
  // adsbdb's full response straight through — keeps the frontend
  // decoupled from the exact shape of whichever provider is behind
  // this endpoint.
  const result = {
    airline: (route.airline && route.airline.name) || "",
    origin: airportSummary(route.origin),
    destination: airportSummary(route.destination),
  };

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function airportSummary(airport) {
  return {
    code: airport.iata_code || airport.icao_code || "",
    name: airport.name || "",
    municipality: airport.municipality || "",
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
