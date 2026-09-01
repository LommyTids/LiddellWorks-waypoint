import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./src/worker.js", import.meta.url), "utf8");
const worker = (await import("data:text/javascript;base64," + Buffer.from(source + "\n//# sourceURL=waypoint-worker.mjs").toString("base64"))).default;

class MemoryKV {
  constructor(seed) { this.values = new Map(Object.entries(seed || {})); }
  async get(key) { return this.values.has(key) ? this.values.get(key) : null; }
  async put(key, value) { this.values.set(key, String(value)); }
  async delete(key) { this.values.delete(key); }
}

function environment(seed) {
  return {
    WAYPOINT_KV: new MemoryKV(seed),
    WAYPOINT_PASSWORD: "setup-secret",
    WAYPOINT_SESSION_SECRET: "a-long-test-session-secret",
    ASSETS: { fetch: async () => new Response("asset") },
  };
}

async function call(env, path, options) {
  return worker.fetch(new Request("https://example.test" + path, options), env, {});
}

async function jsonCall(env, path, method, body, cookie) {
  const headers = { "Content-Type": "application/json" };
  if (cookie) headers.Cookie = cookie;
  return call(env, path, { method, headers, body: JSON.stringify(body) });
}

function cookieFrom(response) {
  const value = response.headers.get("set-cookie");
  return value && value.split(";")[0];
}

// Malformed account data must never reopen first-run setup.
{
  const env = environment({ users: "{broken", users_initialized: "1" });
  const response = await jsonCall(env, "/WayPoint/api/setup", "POST", {
    setupKey: "setup-secret", username: "attacker", password: "password123",
  });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /corrupt/i);
}

const env = environment();
const setup = await jsonCall(env, "/WayPoint/api/setup", "POST", {
  setupKey: "setup-secret", username: "owner", password: "password123",
});
assert.equal(setup.status, 200);
const owner = await setup.json();
const ownerCookie = cookieFrom(setup);

// Arbitrary fields and executable currencies cannot cross the storage boundary.
const malicious = await jsonCall(env, "/WayPoint/api/data", "POST", { trips: [{
  tripId: "id_trip", name: "Trip", startDate: "", endDate: "", homeCurrency: "GBP", notes: "",
  currencyRates: {}, destinations: [], transport: [], accommodation: [], contacts: [], expenses: [], companions: [], geocodeCache: {},
  activities: [{ activityId: "id_activity", title: "Test", date: "2026-08-29", companions: [], costCurrency: "<img src=x onerror=alert(1)>", arbitraryHtml: "<script>alert(1)</script>" }],
  arbitraryTopLevel: "must not persist",
}] }, ownerCookie);
assert.equal(malicious.status, 400);

// Store a valid trip with visible and hidden location/contact data.
const saved = await jsonCall(env, "/WayPoint/api/data", "POST", { trips: [{
  tripId: "id_trip", name: "Trip", startDate: "", endDate: "", homeCurrency: "GBP", notes: "",
  currencyRates: {},
  destinations: [
    { destinationId: "id_visible_dest", name: "Visible", country: "KR", arriveDate: "", departDate: "", timezone: "", companions: ["id_alice"], notes: "", lat: 37.57, lng: 126.98, locationRef: "liq:R123", locationMethod: "selected", locationGranularity: "area", locationStale: false, locationKindLabel: "City", bbox: [37.4, 126.7, 37.7, 127.2], boundaryRef: "liq:R123", boundaryQuality: "exact_simplified" },
    { destinationId: "id_nominatim_dest", name: "Seoul", country: "KR", arriveDate: "", departDate: "", timezone: "", companions: [], notes: "", lat: 37.57, lng: 126.98, locationRef: "liq:R124", locationMethod: "selected", locationGranularity: "area", locationStale: false, locationKindLabel: "City", bbox: [37.4, 37.7, 126.7, 127.2], boundaryRef: "liq:R124", boundaryQuality: "exact_simplified" },
    { destinationId: "id_cairo_dest", name: "Cairo", country: "EG", arriveDate: "", departDate: "", timezone: "", companions: [], notes: "", lat: 30.04, lng: 31.24, locationRef: "liq:R125", locationMethod: "selected", locationGranularity: "area", locationStale: false, locationKindLabel: "City", bbox: [29.8, 30.2, 31.1, 31.5], boundaryRef: "liq:R125", boundaryQuality: "exact_simplified" },
    { destinationId: "id_canonical_dest", name: "New York", country: "US", arriveDate: "", departDate: "", timezone: "", companions: [], notes: "", lat: 40.72, lng: -74.01, locationRef: "liq:R126", locationMethod: "selected", locationGranularity: "area", locationStale: false, locationKindLabel: "City", bbox: [-74.3, 40.4, -73.6, 40.9], boundaryRef: "liq:R126", boundaryQuality: "exact_simplified" },
    { destinationId: "id_unknown_bbox_dest", name: "Fallback point", country: "MN", arriveDate: "", departDate: "", timezone: "", companions: [], notes: "", lat: 47.92, lng: 106.92, locationRef: "liq:R127", locationMethod: "selected", locationGranularity: "area", locationStale: false, locationKindLabel: "City", bbox: [47.5, 48.3, 106.2, 999], boundaryRef: "", boundaryQuality: "none" },
    { destinationId: "id_hidden_dest", name: "Secret address", country: "US", arriveDate: "", departDate: "", timezone: "", companions: ["id_other"], notes: "" },
  ],
  activities: [
    { activityId: "id_visible_activity", title: "Visible activity", destinationId: "id_visible_dest", date: "1999-01-01", startDate: "2026-08-29", endDate: "2026-08-31", allDay: true, startTime: "09:00", endTime: "17:00", contactId: "id_visible_contact", companions: ["id_alice"], location: "Museum note", address: "1 Example Street", addressLat: 51.52, addressLng: -0.14, addressLocationRef: "liq:N457", addressLocationMethod: "selected", addressLocationGranularity: "address", addressLocationKindLabel: "Address", addressLocationStale: false },
    { activityId: "id_hidden_activity", title: "Hidden activity", destinationId: "id_hidden_dest", date: "2026-08-29", address: "Hidden street", contactId: "id_hidden_contact", companions: ["id_other"] },
  ],
  transport: [{ transportId: "id_transport", mode: "Flight", fromLocation: "LHR", toLocation: "JFK", departDateTime: "2026-09-01T10:30", arriveDateTime: "2026-09-01T13:30", companions: ["id_alice"], fromLat: 51.47, fromLng: -0.45, toLat: 40.64, toLng: -73.78, fromLocationRef: "local:airport:LHR", toLocationRef: "local:airport:JFK", fromLocationMethod: "selected", toLocationMethod: "selected", fromLocationGranularity: "airport", toLocationGranularity: "airport", fromLocationKindLabel: "Airport", toLocationKindLabel: "Airport", fromLocationStale: false, toLocationStale: false }],
  accommodation: [{ accommodationId: "id_hotel", name: "Hotel", checkIn: "2026-09-01T15:00", checkOut: "2026-09-03T11:00", companions: ["id_alice"], lat: 40.7, lng: -74, locationMethod: "manual", locationGranularity: "unknown", locationKindLabel: "Place", locationStale: false }],
  expenses: [], arbitraryTopLevel: "drop me",
  contacts: [
    { contactId: "id_visible_contact", name: "Visible contact" },
    { contactId: "id_hidden_contact", name: "Hidden contact", notes: "private" },
  ],
  companions: [{ companionId: "id_alice", name: "Alice" }, { companionId: "id_other", name: "Other" }],
  geocodeCache: { "Hidden street": { lat: 1, lng: 2 }, "Visible": { lat: 3, lng: 4 } },
}] }, ownerCookie);
assert.equal(saved.status, 200);
const rawStoredTrip = JSON.parse(env.WAYPOINT_KV.values.get("trip:id_trip"));
assert.equal(Object.hasOwn(rawStoredTrip, "arbitraryTopLevel"), false);
assert.equal(rawStoredTrip.transport[0].departDateTime, "2026-09-01T10:30");
assert.equal(rawStoredTrip.accommodation[0].checkIn, "2026-09-01T15:00");
assert.equal(rawStoredTrip.destinations[0].boundaryRef, "liq:R123");
assert.deepEqual(rawStoredTrip.destinations[0].bbox, [126.7, 37.4, 127.2, 37.7]);
assert.deepEqual(rawStoredTrip.destinations[1].bbox, [126.7, 37.4, 127.2, 37.7]);
assert.deepEqual(rawStoredTrip.destinations[2].bbox, [31.1, 29.8, 31.5, 30.2]);
assert.deepEqual(rawStoredTrip.destinations[3].bbox, [-74.3, 40.4, -73.6, 40.9]);
assert.deepEqual(rawStoredTrip.destinations[4].bbox, []);
assert.equal(rawStoredTrip.activities[0].lat, undefined);
assert.equal(rawStoredTrip.activities[0].addressLocationRef, "liq:N457");
assert.equal(rawStoredTrip.activities[0].date, "2026-08-29");
assert.equal(rawStoredTrip.activities[0].startDate, "2026-08-29");
assert.equal(rawStoredTrip.activities[0].endDate, "2026-08-31");
assert.equal(rawStoredTrip.activities[0].allDay, true);
assert.equal(rawStoredTrip.activities[0].startTime, "");
assert.equal(rawStoredTrip.activities[0].endTime, "");
assert.equal(rawStoredTrip.transport[0].toLocationRef, "local:airport:JFK");
assert.equal(rawStoredTrip.accommodation[0].locationMethod, "manual");

const locationUnauthenticated = await call(env, "/WayPoint/api/location-search?q=London&context=destination&kind=area");
assert.equal(locationUnauthenticated.status, 401);
const locationNotConfigured = await call(env, "/WayPoint/api/location-search?q=London&context=destination&kind=area", { headers: { Cookie: ownerCookie } });
assert.equal(locationNotConfigured.status, 501);
const emptyBoundaries = await jsonCall(env, "/WayPoint/api/location-boundaries", "POST", { refs: [] }, ownerCookie);
assert.equal(emptyBoundaries.status, 200);
assert.deepEqual((await emptyBoundaries.json()).boundaries, {});

// Location provider calls are authenticated and bounded per account, so a
// retry loop cannot silently burn through the free provider allowance.
const locationEnv = env;
locationEnv.LOCATIONIQ_API_KEY = "test-location-key";
const realFetch = globalThis.fetch;
let providerCalls = 0;
globalThis.fetch = async function (url) {
  if (String(url).startsWith("https://api.locationiq.com/")) {
    providerCalls++;
    return new Response(JSON.stringify([{ osm_type: "node", osm_id: "42", name: "Example", display_name: "Example place", lat: "51.5", lon: "-0.12", class: "amenity", type: "restaurant" }]), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return realFetch(url);
};
try {
  for (let i = 0; i < 36; i++) {
    const response = await call(locationEnv, "/WayPoint/api/location-search?q=Example&context=activity&kind=point", { headers: { Cookie: ownerCookie } });
    assert.equal(response.status, 200);
  }
  const rateLimited = await call(locationEnv, "/WayPoint/api/location-search?q=Example&context=activity&kind=point", { headers: { Cookie: ownerCookie } });
  assert.equal(rateLimited.status, 429);
  assert.equal(providerCalls, 36);
} finally {
  globalThis.fetch = realFetch;
  delete locationEnv.LOCATIONIQ_API_KEY;
}
const staleSave = await jsonCall(env, "/WayPoint/api/data", "POST", {
  trips: [{ ...rawStoredTrip, tripId: "id_trip", revision: 0 }],
}, ownerCookie);
assert.equal(staleSave.status, 409);
const currentSave = await jsonCall(env, "/WayPoint/api/data", "POST", {
  trips: [{ ...rawStoredTrip, tripId: "id_trip", revision: 1 }],
}, ownerCookie);
assert.equal(currentSave.status, 200);

const createAlice = await jsonCall(env, "/WayPoint/api/users", "POST", { username: "alice", password: "password123" }, ownerCookie);
assert.equal(createAlice.status, 200);
const grant = await jsonCall(env, "/WayPoint/api/trip-grants", "POST", {
  tripId: "id_trip", username: "alice", role: "user", companionId: "id_alice",
}, ownerCookie);
assert.equal(grant.status, 200);

const aliceLogin = await jsonCall(env, "/WayPoint/api/login", "POST", { username: "alice", password: "password123" });
assert.equal(aliceLogin.status, 200);
const aliceCookie = cookieFrom(aliceLogin);
const scopedResponse = await call(env, "/WayPoint/api/data", { headers: { Cookie: aliceCookie } });
assert.equal(scopedResponse.status, 200);
const scopedTrip = (await scopedResponse.json()).trips[0];
assert.deepEqual(scopedTrip.geocodeCache, {});
assert.deepEqual(scopedTrip.contacts.map((contact) => contact.contactId), ["id_visible_contact"]);
assert.equal(JSON.stringify(scopedTrip).includes("Hidden street"), false);
assert.equal(JSON.stringify(scopedTrip).includes("Hidden contact"), false);

// Resetting a password increments sessionVersion and revokes old cookies.
const reset = await jsonCall(env, "/WayPoint/api/users", "POST", {
  id: owner.id, username: "owner", password: "new-password123",
}, ownerCookie);
assert.equal(reset.status, 200);
const revoked = await call(env, "/WayPoint/api/data", { headers: { Cookie: ownerCookie } });
assert.equal(revoked.status, 401);

const html = await readFile(new URL("./public/WayPoint/index.html", import.meta.url), "utf8");
assert.match(html, /return esc\(currency \|\| ''\)/);

console.log("security regression tests passed");
