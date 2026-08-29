# Waypoint security fixes

This document describes the changes on the `security-fixes` branch. “BLUF” means “bottom line up front.”

## High — stored XSS and privilege escalation

**BLUF:** Client-controlled trip data is now validated and rebuilt from explicit field allowlists before storage, and currency labels are escaped before HTML rendering.

**Layman’s explanation:** A limited user could previously hide browser code inside an unusual field, currency, or identifier. That code could run later when the trip owner opened the affected page. The server now accepts only the fields and formats Waypoint actually uses, while the browser treats currency text as text rather than markup.

**Technical explanation:** `sanitizeTripContent()` and `sanitizeItem()` enforce entity-specific schemas, safe identifier/date/time/currency formats, finite numeric ranges, collection caps, and string-length limits. Response-only and arbitrary properties are discarded. Scoped merges pass through the same item schemas instead of `Object.assign()`-ing hostile objects. `money()` escapes currency output. Existing stored content is normalized again on read to protect upgraded deployments.

## High — KV lost updates and write-rate failures

**BLUF:** Saves are serialized and spaced, `429` responses are retried with backoff, and server-owned per-trip revisions reject stale browser snapshots with `409 Conflict`.

**Layman’s explanation:** Two tabs or users could save older copies over newer work, and rapid edits could exceed KV’s write limit. Waypoint now waits between saves, retries temporary rate-limit failures, and refuses to overwrite a trip when the browser is editing an outdated copy.

**Technical explanation:** Each stored trip has a server-owned `_revision`; GET responses expose it as `revision`, POST preflight compares it before any mutation, and successful responses return updated revision mappings so queued client snapshots stay current. The client enforces a 1.1-second minimum save interval and bounded retry of `429` responses.

**Residual architectural limitation:** Cloudflare KV is eventually consistent and cannot atomically update a trip plus the shared trip index. The changes substantially reduce and detect lost updates, but the complete fix is to move authoritative writes to D1 transactions or a Durable Object and use KV only as a cache. That migration requires provisioning and deployment work outside this repository and is deliberately not represented here as complete.

## Medium — scoped response privacy leak

**BLUF:** User/viewer responses are now constructed from an explicit response shape and exclude hidden geocode and contact data.

**Layman’s explanation:** A restricted traveller could inspect the raw API response and find addresses or contact notes for itinerary items they were not allowed to see. Restricted responses now contain only their visible items and the contacts those items reference.

**Technical explanation:** The scoped branch of `buildVisibleTrip()` no longer clones full trip content. It filters tagged entity lists, derives referenced contact IDs from visible records, returns only those contacts, empties `geocodeCache`, strips companion `accountId` values, and omits grants and ownership metadata.

## Medium — password resets did not revoke sessions

**BLUF:** Resetting a password now invalidates every previously issued session for that account.

**Layman’s explanation:** If someone had copied an old login cookie, changing the password would not previously log them out. Password resets now make all old cookies unusable.

**Technical explanation:** Account records carry `sessionVersion`, signed session payloads carry `sv`, and `getCurrentUser()` compares them on every authenticated request. A password reset increments the stored version. Legacy users and sessions default to version zero for a non-disruptive rollout.

## Medium — login enumeration and brute-force exposure

**BLUF:** Unknown usernames now take the expensive password-check path, oversized credentials are rejected, and repeated failures are throttled.

**Layman’s explanation:** Login timing could reveal whether a username existed, and one client could make unlimited guesses. Unknown accounts now take roughly the same work as real accounts, excessively large input is rejected, and repeated attempts receive `429 Too Many Requests`.

**Technical explanation:** `handleLogin()` performs dummy PBKDF2 verification for unknown users, uses the same error response for both failure types, caps username/password lengths, and applies an eight-attempt/five-minute per-IP-and-username in-isolate throttle with `Retry-After`.

**Deployment note:** Because isolate memory is not global, add a Cloudflare zone-level rate-limit rule for `/WayPoint/api/login` for comprehensive distributed enforcement.

## Medium — corrupt account storage reopened setup

**BLUF:** Corrupt or unexpectedly missing account storage now fails closed with HTTP 503 and can never be interpreted as a fresh installation.

**Layman’s explanation:** Damaged account data could previously make Waypoint think nobody had ever set it up, reopening the first-owner registration screen. It now stops login and setup until the storage problem is repaired.

**Technical explanation:** `loadUsers()` distinguishes a genuinely absent first-run key from malformed data, validates the stored schema, and checks a separate `users_initialized` marker. It throws `UsersStorageError`, which the Worker converts to a generic 503 response without exposing storage details.

## Medium — arbitrary and derived fields were persisted

**BLUF:** Trip content is now reconstructed from server-owned schemas rather than copied wholesale from the request.

**Layman’s explanation:** A modified browser could add secret, fake, or unexpected properties that normal Waypoint screens never create. Those properties are now discarded at the server boundary.

**Technical explanation:** `stripClientOwnershipFields()` now delegates to `sanitizeTripContent()`. Ownership, grants, UI permission objects, derived avatar/access maps, revisions, and all unknown properties are excluded. Protected companion-account links continue to be reasserted from stored server truth.

## Medium — missing production security tests

**BLUF:** A dependency-free security regression suite now exercises the real Worker module.

**Layman’s explanation:** The previous browser tests relied heavily on a separate mock server, so the tests could pass while production behaved differently. The new tests call the actual Worker code with an in-memory KV substitute.

**Technical explanation:** `test-security.mjs` covers fail-closed setup, malicious stored payload rejection, unknown-field removal, preservation of transport/accommodation schemas, optimistic-concurrency conflicts, scoped geocode/contact privacy, password-reset session revocation, and the escaped currency rendering guard. Run it with `npm test` or `npm run test:security`.
