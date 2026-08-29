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
    { destinationId: "id_visible_dest", name: "Visible", country: "GB", arriveDate: "", departDate: "", timezone: "", companions: ["id_alice"], notes: "" },
    { destinationId: "id_hidden_dest", name: "Secret address", country: "US", arriveDate: "", departDate: "", timezone: "", companions: ["id_other"], notes: "" },
  ],
  activities: [
    { activityId: "id_visible_activity", title: "Visible activity", destinationId: "id_visible_dest", date: "2026-08-29", contactId: "id_visible_contact", companions: ["id_alice"] },
    { activityId: "id_hidden_activity", title: "Hidden activity", destinationId: "id_hidden_dest", date: "2026-08-29", address: "Hidden street", contactId: "id_hidden_contact", companions: ["id_other"] },
  ],
  transport: [{ transportId: "id_transport", mode: "Flight", fromLocation: "LHR", toLocation: "JFK", departDateTime: "2026-09-01T10:30", arriveDateTime: "2026-09-01T13:30", companions: ["id_alice"] }],
  accommodation: [{ accommodationId: "id_hotel", name: "Hotel", checkIn: "2026-09-01T15:00", checkOut: "2026-09-03T11:00", companions: ["id_alice"] }],
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
