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

The output is a deterministic parameterized SQL plan and source hash, not an
executed migration. Applying the same plan twice fails rather than duplicating
data. No remote data import executor is supplied in this first change. The final
executor must enforce an empty destination, handle D1 size/statement limits,
support restart/checkpoints where needed, and compare reconstructed data and
permissions against the source before enabling writes. Unmapped KV caches stay
in KV. Account credentials are not inserted into the new D1 tables.

## Remaining production gates

1. Build and test the legacy browser read/write compatibility adapter or upgrade
   the web client to v1. A compatibility write must check revisions and apply
   per-record changes atomically; a second writable KV copy is not a sync plan.
2. Decide and implement production account/session consistency; isolate staging
   accounts, secrets and permission mappings throughout rehearsal.
3. Implement the private import executor, full-data reconciliation and rehearsed
   cutover/rollback procedure. After D1 accepts new writes, reverting to stale KV
   would lose those edits: pause writers and reconcile or restore D1 first.
4. Add provider/location endpoints required by the browser and iOS; the staging
   API currently serves account and trip sync routes only. R2 photo upload and
   image processing remain a later feature, with no bucket required now.
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
