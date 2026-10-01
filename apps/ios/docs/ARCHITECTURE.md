# Native staging architecture

Cloudflare D1 is the canonical trip-data store for the isolated staging deployment. The production website still uses KV. iOS talks to the versioned D1 API through a staging-only HTTP client and uses a local account-isolated cache and durable outbox. CloudKit is disabled. Android can implement the same server protocol later.

The app retains the original legacy model/decoder and SwiftData workspace for demo and compatibility. D1 state has a separate versioned, environment/account-isolated durable store. Legacy drafts are never automatically uploaded with their whole-trip base revisions. They remain in the legacy store.

The pure core reducer handles entity identity, record revisions, authorized snapshots, tombstones, queued mutations, retry receipts and explicit conflicts. The AppModel persists state before publication and freezes/persists a submitted mutation before sending it. Local editing is disabled during sync. The UI is a projection of server base plus allowed pending edits.

Bootstrap is collected in temporary memory and published only when complete. Permission/history invalidation clears the authorized view and requires another bootstrap. Incremental entity application and cursor advancement persist together. Submitted requests retain their original IDs and bodies across ambiguous transport failures. Conflict resolution requires a deliberate user action and a new mutation identity.

Authentication uses the server's signed host-only HttpOnly cookie, not bearer tokens. Keychain uses a staging-specific service and device-only accessibility. Request redirects, shared cookies and shared response caches are disabled. Session claims are local shape/expiry checks only; permissions come from the server.

MapKit is display/discovery, not record identity or sync storage. Venue text and address/pin coordinates are distinct. Travel values stay local wall-clock/date-only strings; they are not silently converted to UTC. Imported fields outside the editor are retained, and server patches use supported field names.

Offline account/session revocation cannot be observed until the device reconnects. A connected permission reset must hide the stale authorized cache before obtaining another snapshot. Background sync, offline basemap coverage, photos and production migration are outside this milestone.
