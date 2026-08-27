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
 *   2. For every other request (loading the page itself, any future CSS/JS/
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