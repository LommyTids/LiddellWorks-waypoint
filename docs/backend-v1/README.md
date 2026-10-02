# Shared backend foundation and migration

Status: isolated staging implementation, September 2026. The live website still
uses its existing Worker and KV data. This branch does not switch production.

## What this change provides

- A separate Worker with a versioned API for iOS, the browser and later Android.
- D1 trip metadata, individual itinerary records, grants, tombstones, change
  sequence and successful mutation receipts. Record revisions replace whole-trip
  snapshot overwrites. Data, change events and receipts commit atomically.
- Server-enforced owner/admin/user/viewer permissions. A scoped user can edit
  existing tagged itinerary items, but cannot create, delete or retag them.
  Contacts are visible only through accessible itinerary references. Expenses
  remain owner/admin-only. Sharing changes are owner-only in this initial API.
- Paginated bootstrap and incremental sync, signed account-bound cursors,
  explicit revision conflicts and retry-safe successful mutations.
- Read-only KV export and deterministic, validated D1 import planning.
- Tests against SQLite and Cloudflare's local workerd/D1 runtime; GitHub checks
  and a manually triggered staging deployment workflow.

Accounts and password hashes remain in a separate staging KV store for now.
Authentication reuses the existing cookie implementation. Immediate globally
consistent account/session revocation is not provided by that KV implementation;
deciding and implementing the final account store is a production gate.

## What I need from the owner

Nothing else is needed to write and test this foundation. To deploy staging:

The owner-supplied account, D1 and KV IDs are now recorded in
`config/backend-staging.json`. The generator uses these defaults; GitHub
environment variables below are optional overrides. Tokens and runtime secrets
are still required. The IDs have been checked locally for format and separation
from the production configuration, but resource ownership and access have not
yet been verified against Cloudflare.

| Input | Where it belongs |
| --- | --- |
| Cloudflare account ID | GitHub `waypoint-staging` environment variable `CLOUDFLARE_ACCOUNT_ID` |
| New D1 database named `waypoint-backend-staging`; its database ID | Environment variable `WAYPOINT_STAGING_D1_ID` |
| New empty KV namespace named `waypoint-backend-staging-accounts`; its ID | Environment variable `WAYPOINT_STAGING_KV_ID` |
| Cloudflare API token for deployment and D1 migrations in this account | Environment secret `CLOUDFLARE_API_TOKEN` |
| New random signing secret, different from production | Staging Worker secret `WAYPOINT_SESSION_SECRET` |
| New private one-time account setup key | Staging Worker secret `WAYPOINT_PASSWORD` |

The first three IDs are configuration, not passwords, and can be shared here.
Enter API tokens and signing/setup secrets directly in GitHub or Cloudflare;
do not paste them into chat, source files or workflow logs. The deploy token needs
Workers Scripts edit and D1 edit in the chosen account; add Workers KV Storage
read if required for binding lookup. This workflow does not create resources or
edit domain routes. Use a dedicated token rather than a global API key.

Before the eventual migration, we need:

1. A private complete source backup and successful import rehearsal. Existing
   production KV is already identified by `wrangler.toml`; no need to find its ID
   again. Export uses a separate read-only KV token scoped to the source account.
2. A production D1 database chosen for cutover, separate from staging.
3. An agreed short window with all web/native writes paused for the final export,
   verification and switch. The actual duration will follow the rehearsal.
4. Confirmation of the intended production account/session approach. The default
   migration intent is to retain all accounts, password hashes, trips, permissions,
   participant tags, booking details and expenses; no password reset is planned.

No production data needs to be placed in this public repository. Start staging
with synthetic accounts and trips. Keep production caches and source backup
until cutover validation and rollback planning are complete.

## Deploy from an iPad

1. Review this branch and authorize a commit/push when ready. No direct main
   commit is part of this work. Merge through a PR when ready. The manual
   workflow's Run workflow button becomes available once the workflow is on the
   repository's default branch; it can then target the desired branch. Merging
   this foundation does not make the live Worker use D1.
2. In Cloudflare's dashboard create the staging D1 and KV resources above. In
   GitHub Settings → Environments create `waypoint-staging` and add the variables
   and secret. Restrict that environment's deployable branches as appropriate.
3. In GitHub Actions run **Deploy isolated backend staging**. It runs backend
   tests, applies schema to the selected staging D1, and deploys the separate
   `waypoint-backend-staging` Worker on its workers.dev address. It has no custom
   domain routes, production asset binding or production KV binding.
4. In that new Worker's settings add `WAYPOINT_SESSION_SECRET` and
   `WAYPOINT_PASSWORD` as secrets. Requests fail closed until configured. These
   secrets stay in Cloudflare across later deploys.
5. Open the staging Worker URL in Safari to create a synthetic
   staging account and exercise the API. The staging root URL now provides the setup and test page described below. No Xcode or macOS is required for backend deployment or testing.

If Cloudflare's existing GitHub build integration is configured to build feature
branches, verify it does not deploy this branch onto the production Worker.
The existing production `wrangler.toml` is intentionally unchanged. This staging
workflow always passes its separate generated configuration explicitly.

For a Codespace/local terminal (Node 24):

```sh
npm ci
npm run test:backend
npm run test:backend:runtime
npm test
# Owner-supplied staging IDs are defaults; environment variables can override them.
npm run backend:staging-config
npx wrangler d1 migrations apply WAYPOINT_DB --local --config wrangler.backend-staging.generated.json
npx wrangler dev --config wrangler.backend-staging.generated.json
```

Local auth secrets belong in ignored `.dev.vars`. Never reuse production secrets.
The generator checks ID formats and rejects resource IDs found in the production
configuration; it cannot infer whether an arbitrary supplied D1 ID contains live
data. Supply only the newly created staging database ID.

## API contract

All paths start at `/WayPoint/api`. Sign in through `/login`; `/setup` creates
the first staging account from `{setupKey,username,password}`. Retain the secure
HttpOnly `wp_session` cookie. Native clients need a cookie-aware HTTP session.
Cross-origin browser writes are rejected; a future web client should use the
same origin or an explicitly designed authenticated proxy. Do not put secrets
in a WebView JavaScript bridge. Existing `/data` routes are unavailable here.

| Method and v1 path | Purpose |
| --- | --- |
| `GET /v1/sync/capabilities` | Protocol limits; explicitly reports not production-ready |
| `GET /v1/trips?limit=50&after=ID` | Authorized trip summaries |
| `POST /v1/trips` | One trip create mutation |
| `GET /v1/sync/bootstrap?limit=50` | Authorized snapshot; use returned `nextCursor` for subsequent pages |
| `GET /v1/sync/changes?cursor=CURSOR&limit=50` | Authorized incremental changes |
| `POST /v1/sync/mutations` | Up to 20 mutations, each independently atomic |
| `POST /v1/trips/ID/grants` | Owner sets/revokes access using accountId, role and companionId |

Example body for `/v1/sync/mutations` after a trip exists:

```json
{
  "protocolVersion": 1,
  "mutations": [{
    "mutationId": "a-client-generated-uuid",
    "tripId": "trip-id",
    "kind": "activity",
    "recordId": "another-client-generated-uuid",
    "operation": "create",
    "baseRevision": 0,
    "data": {"title": "Museum", "companions": []}
  }]
}
```

Kinds are trip, destination, activity, transport, accommodation, companion,
contact and expense. Create uses revision 0; update/delete use the last observed
record revision. Update is a field patch; delete has no `data`. IDs are stable,
and tombstoned IDs cannot be reused. Record references must exist and be visible
to the caller. Create referenced participants/contacts/destinations first.

Keep a mutation's ID and payload unchanged across transport retries. Applied
results return the new revision; successful IDs are durable. Reusing an ID with
different content conflicts. Rejected/conflicting attempts do not store a
receipt; resolving a draft should create a new mutation ID. Batch HTTP 200 is
not blanket success: inspect every result's applied/conflict/rejected status.
A service error can follow earlier successful mutations in the same batch;
retrying unchanged IDs safely retrieves those successes.

Clients must collect bootstrap pages in a temporary cache and publish only a
complete snapshot with its final `syncCursor`. If anything changes between
pages, bootstrap restarts. No persisted snapshot is held server-side; this is
suitable for the small invited group, but a continuously busy database may need
a snapshot materialization strategy later. Change pages carry current entity
state, so an identity may appear more than once; apply by identity and revision.

On `bootstrap_required`, hide/discard the old authorized cache and replace it
from a fresh complete bootstrap. Grants, participant scope and contact visibility
changes invalidate cursors using a conservative global epoch. Pending local
drafts should be quarantined for review, never blindly replayed after access
changes. Existing iOS whole-trip draft revisions are incompatible with this
record protocol and need an explicit client upgrade.

Limits: 100 entities/page, 20 mutations/batch, 256 KiB mutation request and
32 KiB merged record. No history or receipt pruning is enabled yet. Imported
legacy fields are preserved but clients cannot introduce unknown fields.

## Export and import planning

Run these in a private Codespace/terminal with a read-only Cloudflare token in
the environment. Paths below are gitignored, but files still contain private
trip information and account password hashes. Do not upload them as Actions
artifacts or include them in issue comments.

```sh
mkdir -p private-migration
# Set CLOUDFLARE_ACCOUNT_ID, WAYPOINT_SOURCE_KV_ID and CLOUDFLARE_API_TOKEN.
node scripts/backend-v1/export-kv.mjs private-migration/source.kv-export.private.json
node scripts/backend-v1/plan-import.mjs private-migration/source.kv-export.private.json private-migration/import.d1-plan.private.json
```

The export reads every source key, checks for observed drift and never mutates
KV. Because KV reads are eventually consistent, drift checks do not establish a
point-in-time snapshot. A final export requires every writer paused and source
reads settled; repeated stable exports and hashes are part of the cutover check.

The planner requires the current `users`, `trip_index`, `trip:ID` layout. It fails
on missing trips/accounts, duplicate identities, dangling participant tags or
unindexed trip keys. It normalizes numeric IDs to strings, retains all record
fields and keeps non-API trip/index extensions privately in D1. Original KV
values remain in the backup. Imported record revisions start at 1, distinct from
legacy trip revisions; timestamps use an explicit epoch placeholder because
the source has no trustworthy record modification time.

The planner outputs a deterministic parameterized SQL plan and source hash.
The rehearsal executor described below now applies that plan to a fresh isolated
D1 database, using bounded batches and resumable checkpoints, then independently
compares the stored data and checks authorized visibility. Unmapped provider
caches and account credentials stay in KV. It is not a production cutover tool.

## Remaining production gates

1. Validate the now-connected staging browser against representative real data
   in a controlled rehearsal. Multi-record UI edits remain individually atomic,
   and failures can leave an explicitly reported partial save.
2. Decide and implement production account/session consistency; isolate staging
   accounts, secrets and permission mappings throughout rehearsal.
3. Complete a successful remote rehearsal and prepare the final private retained
   backup, write freeze, production routing and rollback procedure. After D1
   accepts new writes, reverting to stale KV would lose edits: pause writers and
   reconcile or restore D1 first.
4. Confirm provider configuration in production. The staging web Worker already
   exposes the existing location/flight helpers; R2 photos remain a later feature.
5. Upgrade iOS caches/outbox to record revisions, IDs, conflict outcomes and cache
   invalidation; test cookie authentication and offline retry. Android can reuse
   the same API later. Run real-device/Xcode validation when available.

Keep production gated until these pass. GitHub sync here means source control
and deployment; personal trip data synchronizes through Cloudflare, not GitHub.

## iPad staging setup and test page

After deploying this change, open the staging Worker's root URL in Safari. It
shows account setup when no accounts exist, otherwise sign-in. Enter the private
`WAYPOINT_PASSWORD` value as the setup key and choose a separate username/login
password. Never enter the signing secret. Credentials are posted to the same
Worker and cleared from the form after submission; the page uses no browser
storage for them and loads no third-party scripts.

Once signed in, tap **Run dummy-trip tests**. This explicitly creates a uniquely
named dummy trip and activity, reads the snapshot, edits/retries the activity,
checks stale-revision rejection and incremental sync, and deletes the dummy
trip. Sync history retains tombstones and receipts. Failed cleanup reports the
specific test-trip ID for follow-up. Existing trips are not edited. Send the
visible pass/fail results back; secrets are never displayed in test results.

The page exists only in the staging Worker. Deployment and production migration
remain separate actions. This test checks server round-trips and replay behavior,
not real-device offline reconnection or production migration correctness.

## Web app connected to D1 (staging)

Deploy the staging workflow, then open `/WayPoint/app` on the staging Worker.
The setup page now links there. Use the same staging login created during setup.
The main production domain continues to use KV. No real trips are imported by
this change; add test trips to staging.

The staging Worker serves the existing web assets and injects a staging-only
persistence adapter before app startup. It loads a complete authorized v1
snapshot plus presentation metadata at the same database sequence. On save it
diffs against its last successful snapshot and sends only changed fields and
record IDs with their base revisions. It never posts `/api/data` and never
writes a KV trip snapshot. Successful saves reload canonical server values.

Writes are serialized and controls lock during a save. Reference records are
created first. Each record change is atomic, but a UI operation touching several
records is not one transaction: on any failure the page explicitly reports that
some earlier records may have saved, clears stale state and requires a refresh.
Transport retries reuse the exact mutation ID and payload. Idle pages refresh
other-device changes every 30 seconds and on focus, except while a form or save
is active. Offline editing remains locked, matching the existing browser policy;
this does not implement a persistent offline outbox.

Participant account links and sharing are handled together in a guarded D1
transaction. Staging owners can link existing staging usernames and assign
admin/user/viewer access. Admins can edit trips but sharing remains owner-only.
Users can edit existing tagged itinerary records; viewers cannot write. The
browser cannot add companions with a scoped user role. A participant referenced
by tags/grants must be untagged/unshared before deletion. Raw grants and account
IDs are withheld from scoped users. Accounts/passwords and provider caches
remain in isolated staging KV.

Avatar, location-search/boundary, flight-lookup and integration-status routes
reuse the existing authenticated helpers against staging configuration. Optional
`LOCATIONIQ_API_KEY` and `AERODATABOX_API_KEY` must be configured separately on
the staging Worker for provider lookups; manual locations and coordinates work
without those keys. This change does not copy production secrets.

Validation includes two independent web clients, concurrent edits, lost-response
retry, explicit partial failure, scoped visibility, sharing rollback, and a real
browser creating/reloading a trip and activity without any KV trip-data request.
Production cutover and the private import executor are still separate work.


## Run the private migration rehearsal from an iPad

In GitHub **Actions → Rehearse KV to D1 migration → Run workflow**, select
`main`. This is a new workflow, separate from staging deployment. No Worker is
changed, no domain is switched, and no KV key is written or deleted.

The job uses the existing `waypoint-staging` environment:

- `CLOUDFLARE_API_TOKEN`: requires D1 write/edit to create and query the rehearsal
  database (the existing staging deployment token normally already has this).
- Source export requires Workers KV Storage **Read** in the source Cloudflare
  account. If the existing token has it, nothing needs adding. Otherwise create
  a separate read-only token and save it as the environment secret
  `CLOUDFLARE_KV_READ_TOKEN`. The exporter uses it only for reads.
- Account and source namespace IDs are taken from the checked-in configuration.
  There is no destination database ID input to accidentally aim at production.

The job first exports the source privately and rehearses the import in local
SQLite. Only after that passes does it create a new D1 database named
`waypoint-rehearsal-DATE-RANDOM`. It rejects a nonempty destination and excludes
known staging/production IDs. This new database is never bound to any Worker or
made available through a public URL. It contains private trip data; account
password hashes are not copied into D1.

Import requests are limited to 20 statements and approximately 250 KB per batch.
A record exceeding the rehearsal request-size limit fails validation before
creating a remote database. D1 imports keep deterministic IDs and never overwrite
existing records. Checkpoints let transient import failures resume automatically
within the run, including when a response was lost after commit. Data is marked
verified only after all rows, tags, grants and change counts match and the real
sync query returns the expected records for every source account and an outsider.
Dates, bookings, expenses and extension fields are compared as part of the full
payload. Collection order is not retained; records are compared by identity.

The source is read again after import to detect observed changes. For a smooth
rehearsal, choose a quiet period and avoid editing trips during the run. You do
not need to disable the live website. KV's eventual consistency means matching
reads are evidence for this rehearsal, not proof of a point-in-time production
snapshot. Final cutover still requires paused writers and a durable private backup.

Open the completed run's **Summary**. It reports pass/fail, counts, a source hash,
account-visibility results, and the new database name/ID. These may be shared back
in chat. Do not share trip payloads, password hashes, keys, or private exports.
No source file, SQL plan, password hashes or trip payloads are uploaded as GitHub
artifacts or written into logs. The temporary export is removed after the run;
it is not a retained migration backup. The private rehearsal D1 remains in your
Cloudflare account for review.

If it fails, the summary reports a safe phase and code:

| Phase/code | What to do |
| --- | --- |
| `read_only_source_export` / `cloudflare_token_permissions` | Add the KV read token described above, then rerun |
| `source_changed` | Retry when no one is editing the source trips/accounts |
| `validate_source` / `missing_*`, `invalid_*`, `duplicate_*`, `owner_grant`, or `reserved_source_field` | Use the safe `location` positions to inspect the affected source entry privately before any repair |
| `validate_source` / `unindexed_trip_keys` | Review the reported count of trip keys absent from the index; preserve them until their ownership is understood |
| `source_or_verification_error` | Unexpected failure; stop and investigate without posting the private export or raw errors |
| `verification_*_mismatch` | Stop; the import did not match the source and is not ready for cutover |
| `import_interrupted` | Automatic retries were exhausted; retain the database ID for diagnosis |
| `cloudflare_request_failed` during creation | Check account permissions and available D1 database capacity |

Source validation reports fixed labels and one-based positions: `tripNumber`
refers to the trip index order, `recordNumber` to the named collection order,
`grantNumber` to the trip grant order, and `accountNumber` to the account list.
The report contains no source IDs, names, credentials or record contents. Share
only the JSON summary for diagnosis. Validation does not repair, discard or
remap data and runs before an isolated remote database is created.

To try a diagnostics branch before merging it, open GitHub **Actions → Rehearse
KV to D1 migration → Run workflow**, select that branch, and run it. A Worker
staging deployment is not needed for these script changes.

Each new workflow run starts with a new export and a new database. It never
resumes a different export into an old rehearsal database. Old rehearsal copies
can be deleted manually in Cloudflare D1 after review; they count toward your
account's database/storage limits (Free has 10 databases). Do not delete the
staging database or an eventual production database when cleaning up rehearsals.

For a private local export, the same checks can run without Cloudflare access:

```sh
npm run test:rehearsal
npm run backend:rehearse -- --local private-migration/source.kv-export.private.json
```

The production cutover remains deliberately unavailable from this workflow.
