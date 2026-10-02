# Final migration preparation: KV → D1

The real-data rehearsal has passed. This workflow prepares the final imported
candidate and retains a recoverable encrypted source backup. **It does not
switch production, deploy a Worker, connect iOS, or release the write pause.**
The current browser remains on KV until a separate reviewed cutover.

## Merge order

1. Merge PR #34 (`rehearsal-validation-diagnostics`) into `main`.
2. Merge the final migration preparation PR (`production-migration-workflow`)
   after its checks pass. It includes the diagnostics changes so it also works
   before PR #34 is merged; GitHub will reduce the diff once #34 is merged.
3. PR #33 (`ios-d1-staging-foundation`) is independent. It may be merged after
   reviewing its green Mac build/test checks, but the native app stays pinned
   to staging. Its merge is not a production data connection or cutover.

The preparation PR adds an inactive write-pause guard to the existing production
Worker. Let the ordinary Cloudflare production build deploy this merged version
**before enabling the pause**. Its normal routes and KV data remain unchanged.
The `keep_vars` setting preserves dashboard pause variables on later deployments.
Do not deploy any other code during the migration window.

## One-time setup, before pausing anyone

In GitHub → repository **Settings → Environments**, create `waypoint-production`.
In that environment:

- Add secret `CLOUDFLARE_API_TOKEN` scoped to this account with **Workers KV
  Storage: Edit** (create/write/read the separate backup namespace) and **D1:
  Edit** (create/query the new database). This workflow needs no Worker deploy
  permission. Never post the token in chat or commit it.
- Optionally add a source-only KV-read secret `CLOUDFLARE_KV_READ_TOKEN`.
  Without it the script uses the first token for read-only source requests.
- Optionally set variable `CLOUDFLARE_ACCOUNT_ID` to the existing account ID.
  The checked-in staging account ID is the default; resource IDs stay separate.
- Add variable `WAYPOINT_BACKUP_PUBLIC_KEY`, using the entire public PEM below.

On your Mac, in the updated repository, generate the backup keys:

```sh
node scripts/backend-v1/backup-tools.mjs generate-keys ../waypoint-backup-keys
```

Keep `../waypoint-backup-keys/private.pem` locally, with a second secure copy.
Copy only the full contents of `public.pem` into the environment variable,
including its BEGIN/END lines. **Do not upload the private key to GitHub,
Cloudflare, chat or the repository.** Losing it makes the encrypted backup
unrecoverable. `.pem` and private migration exports are ignored by git.

The script requires Node 24 (also used by Actions). Generating keys creates a
new directory and refuses to replace existing files.

## Pause the live KV app

Arrange a short maintenance window: everyone stops editing, closes old browser
tabs, and avoids KV dashboard/API edits. Pause external scripts and deployments
that write source KV. The Worker guard cannot stop direct administrative API
writes, so this manual step is required.

In **Cloudflare → Workers & Pages → waypoint-app → Settings → Variables and
Secrets**, add these **text variables** and deploy/save the changes:

| Variable | Value |
| --- | --- |
| `WAYPOINT_WRITES_PAUSED` | `true` (lowercase text) |
| `WAYPOINT_FREEZE_ID` | A unique marker, e.g. `waypoint-final-20261002-attempt1` |

Open `https://liddellworks.com/WayPoint/api/migration-status`. It must return:

```json
{"storage":"kv","writesPaused":true,"freezeId":"waypoint-final-20261002-attempt1"}
```

All non-read API requests return 503 before auth or KV access, including saves,
account/password changes, sharing, login and logout. Existing signed-in sessions
can still read trips. GET routes cannot lazily migrate legacy data or write
provider caches while paused. Provider requests needing a cache write may fail.
Users should refresh after the pause is released; never save from stale tabs.

Actions verifies this exact marker repeatedly, waits two minutes for in-flight
requests and caches, and checks source stability before and after import. KV is
still eventually consistent: waiting and stable reads are precautions, not a
mathematical snapshot guarantee. Keep all other writers paused throughout.

## Run the final preparation

In GitHub → **Actions → Prepare final KV to D1 migration → Run workflow**:

1. Select **main**, after the preparation PR has been merged and deployed.
2. Enter confirmation `PREPARE FROZEN MIGRATION`.
3. Check the all-other-writers-paused box only once that is true.
4. Enter the exact freeze marker from Cloudflare.
5. Paste `sourceHash` from the latest passing rehearsal of the cleaned source.

The previously passing rehearsal hash was:

```text
65835a54ffb391b76d3e099e02857194e76004fde67867450b52494a1bd6b6d4
```

Use the latest hash, not this example if data changed. A changed hash fails
before backup/candidate creation. Run the rehearsal against the still-paused
source, review its passing summary, then retry with that new hash. Hashes cover
all exported KV values, including provider caches; even cache changes require
this new rehearsal. Never bypass a mismatch.

The workflow:

- Validates the frozen source and completes a local SQLite import/reconciliation.
- Creates a separate, uniquely named KV namespace for this attempt's backup.
- Encrypts the complete export (including credentials) with AES-256-GCM and
  wraps its random key using RSA-OAEP-SHA256 and your 3072-bit public key.
- Stores only ciphertext and a safe manifest in that backup namespace, with
  no expiry. Splits large encrypted exports into 4 MiB chunks; independently
  reads back the manifest and every chunk and verifies their hashes.
- Only after successful retention creates a fresh, empty production-candidate
  D1 database. It never accepts an existing destination ID.
- Imports using guarded resumable batches, checks independent record/grant/tag
  reconstruction and all account visibility, and rechecks the source freeze.
- Marks the candidate verified only after all checks pass, then reports
  `status: prepared` and `productionSwitch: false`.

The source KV namespace is read-only to the script. There is no deployment or
routing change. Account credentials stay in live KV; no hashes enter D1.
The candidate has no bound public Worker and is not available to clients yet.

## Recover and verify the retained backup before cutover

Download the `waypoint-encrypted-backup-<run ID>` artifact from the workflow
run page. It contains `source.encrypted.json` and a safe JSON migration summary,
**never plaintext data or your private key**. GitHub retains this download for
90 days; the encrypted Cloudflare KV backup has no automatic expiry.

In the updated repository on your Mac:

```sh
node scripts/backend-v1/backup-tools.mjs decrypt \
  /absolute/path/to/source.encrypted.json \
  ../waypoint-backup-keys/private.pem \
  ../source.kv-export.private.json
```

The command refuses to overwrite an existing output and reports only the hash
and counts after authenticating, decrypting and validating the restored source.
Verify its hash matches the workflow summary. Keep the restored export privately
and retain the encrypted copy plus keys separately. It includes password hashes
and private trip records; do not commit or upload it.

If the artifact is unavailable, use the Cloudflare retained copy. Set
`CLOUDFLARE_ACCOUNT_ID` and a KV-read `CLOUDFLARE_API_TOKEN` locally, without
printing the token. Use the summary's `backup.namespaceId` and
`backup.manifestKey`:

```sh
node scripts/backend-v1/backup-tools.mjs download \
  BACKUP_NAMESPACE_ID MANIFEST_KEY ../source.encrypted.json
```

Then decrypt as above. The recovery command only reads backup KV; it never
writes or restores into live KV automatically.

## After a pass or failure

**Do not run Deploy isolated backend staging to connect this candidate.** That
workflow targets the dummy-trip database, not the production candidate.

Send the final preparation summary and the safe `backup_recovery_verified`
result for cutover review. Keep source writers paused if proceeding immediately.
Production activation and the iOS production endpoint remain a separate change
with a concrete reviewed destination, routing plan and release approval.

If abandoning the attempt, set `WAYPOINT_WRITES_PAUSED` to `false` on the legacy
`waypoint-app` Worker and deploy/save. Refresh browsers before editing. This is
safe only while the live app remains on KV. Once KV edits resume, this candidate
is stale and must not be activated; run a new rehearsal and new preparation
when ready. There is **no automatic unfreeze on success, failure or cancellation**.

Failure summaries retain known backup/database IDs for diagnosis. No raw errors,
source IDs, credentials, SQL or payloads are printed. Creating an API resource
can have an ambiguous response: inspect uniquely named resources in Cloudflare
before retrying; the script never deletes resources automatically. Each fresh
run creates another backup namespace and database. Delete abandoned candidate
D1 databases manually after review, and keep the retained backup until an
independent recovery copy is verified. Do not remove staging or live resources.

This workflow cannot apply a different source snapshot to an old database.
Within one run an ambiguous import batch is retried against the same hash and
checkpoint, then reconciled. On failure the backup remains even if importing
stopped; a new run takes a new frozen export and creates a new destination.

## If the pause endpoint works in your browser but Actions cannot read it

The script checks the public pause endpoint from the GitHub runner and never
logs response bodies, redirect targets or raw network errors. Use the safe code:

| Code | Meaning / next check |
| --- | --- |
| `source_pause_http_403` | The runner request is forbidden; inspect Cloudflare security events for the exact migration-status path before making a narrow access change |
| `source_pause_http_404` | The runner received not found; verify the production deployment and route |
| `source_pause_http_503` | The runner received service unavailable; inspect the Worker deployment/status |
| `source_pause_redirect` | The endpoint redirects; review the canonical domain/path routing; the script refuses to follow redirects |
| `source_pause_invalid_response` | HTTP succeeded but the response was not JSON; inspect route handling or challenge responses |
| `source_pause_timeout` / `source_pause_network_error` | The request did not complete; retry and inspect connectivity if it persists |
| `source_not_paused` | JSON was returned but its storage, pause flag or freeze marker did not match |

These failures stop before export or import. A working browser response alone
is not substituted for the runner check. Keep the pause guard and do not disable
site-wide protection or follow unverified redirects to force the migration.
