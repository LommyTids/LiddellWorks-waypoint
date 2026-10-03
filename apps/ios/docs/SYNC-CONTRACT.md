# Implemented production v1 integration

Authoritative backend: `LommyTids/LiddellWorks-waypoint`, production connection introduced in PR #39. Read its `docs/backend-v1/README.md`, `src/backend-v1/protocol.js`, `store.js`, `worker.js` and tests when changing this client.

Origin: https://liddellworks.com. Authentication routes use `/WayPoint/api`; sync routes use `/WayPoint/api/v1`. Capabilities must report the production environment and `productionReady: true`.

Bootstrap returns paginated entities, `complete`, `nextCursor`, and final `syncCursor`. Changes return entities, `hasMore`, and cursor. Cursors are opaque and account/dataset/permission-bound. On `bootstrap_required`, invalidate authorized state before replacing it with a complete snapshot. Do not replay old drafts without current authorization.

Mutations are create/update/delete, with client UUID, tripId, kind, recordId and baseRevision. Create uses zero; update/delete use the latest observed record revision. Update is a field patch. Delete has no data. Trip record identity equals trip identity. Successful receipts make unchanged retries safe; a reused ID with changed contents conflicts. HTTP 200 batches can contain conflicts/rejections. Earlier operations may succeed before a later service error.

Server supports trip plus destination/activity/transport/accommodation/companion/contact/expense entities. UI primarily edits the four itinerary categories while keeping the other authorized entities. The server enforces roles and field allowlists; no client can grant itself permission.

The old LocalWorkspace queue is a legacy/demo model, not a v1 request encoder. The D1 workspace/outbox owns live production mutations. Existing legacy drafts must be manually reviewed/migrated, never uploaded with whole-trip revisions.
