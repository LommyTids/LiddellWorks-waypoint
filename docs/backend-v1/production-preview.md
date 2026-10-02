# Review real trips through the read-only D1 preview

Backup recovery has been verified locally. This release adds a **manual live
browser switch to the prepared D1 database**, with saving disabled in code.
It does not activate editing, migrate credentials, or connect the native app.

## Exact destination

- Worker: `waypoint-app`; route: `liddellworks.com/WayPoint*`.
- Database ID: `28e4ca98-6e8a-46d3-a45a-6fc1f6352b5e`.
- Source hash: `65835a54ffb391b76d3e099e02857194e76004fde67867450b52494a1bd6b6d4`.
- Freeze marker: `waypoint-final-20261002-attempt1`.
- Expected counts: 4 trips, 92 records, 9 grants, 211 participant tags.

`config/backend-production.json` pins the candidate and retained encrypted
backup. The workflow accepts no alternate database, hash or freeze marker.
It fails before deployment if the source or candidate changed, the backup
cannot be read and verified, or the candidate is not marked verified.
It only issues SELECT queries against D1; no migrations/imports are run.

## Before running anything

1. Review and merge this PR after its checks pass. The normal deployment adds
   the inactive D1 binding and router; the browser continues on paused KV
   until the separate manual workflow sets production mode. Let that deployment
   finish, then keep every other deployment and source writer stopped.
2. In GitHub **Settings → Environments → waypoint-production**, update
   `CLOUDFLARE_API_TOKEN` if needed. Alongside KV and D1 permissions, deployment
   needs **Account → Workers Scripts: Edit** and **Zone → Workers Routes: Edit**
   for `liddellworks.com`. Keep the existing Worker session secret and API keys;
   do not replace them with staging credentials.
3. Keep the recovered private export and private key securely on your Mac,
   with a second secure copy. Neither is uploaded by this workflow.
4. The public status endpoint must still say `storage: kv`, `writesPaused: true`
   and the exact freeze marker above. Do not resume KV editing.
5. The earlier GitHub runner requests were challenged by Bot Fight Mode.
   If it is enabled, temporarily turn it off for this run, as you did for
   preparation. Restore it after the workflow completes. This workflow does
   not alter Cloudflare security settings.

## Manual deployment (only after approving the live preview)

GitHub → **Actions → Deploy read-only production D1 preview → Run workflow**:

- Branch: **main**.
- Confirmation: **DEPLOY READ ONLY D1**.
- Check **backup recovery verified** after matching the successful local hash.
- Check **other writers paused** while that remains true.
- Run the workflow.

The preflight summary is not a deployment result. Both the deployment and
public status verification steps must pass. A failure after deployment may
leave the preview deployed; do not assume KV is still serving the browser.
The workflow never automatically rolls back or releases the pause.

Open <https://liddellworks.com/WayPoint/api/migration-status>. The new response
must contain `storage: d1`, `writesPaused: true`, and the pinned hash/marker.
Then open <https://liddellworks.com/WayPoint/>, refresh, and sign in with your
existing account. Review each trip, people, activities, transport, accommodation
and sharing visibility. A banner says **Migration preview · Saving is paused**.
Account changes, sharing changes and trip saves are blocked; login/logout work.
Provider lookups that need to cache a result may fail during this pause.
The staging dummy-trip setup page is unavailable on production.

Send the status and review result back before activating editing. Native iOS
still uses staging and will need its own reviewed endpoint and cache/session
isolation change. Production capabilities deliberately report
`productionReady: false` until the editing release is reviewed.

## Subsequent deployments and recovery

Root Wrangler keeps the same prepared D1 binding. `keep_vars = true` preserves
production mode and freeze/hash variables on later GitHub deployments. An
unknown mode, missing pause, wrong candidate marker, or a removed production
mode with a surviving source-hash marker fails closed. Do not deploy an older
legacy-only branch or remove these variables to force editing.

This preview cannot write D1 or source KV. If abandoning it, first explicitly
review a rollback to the legacy Worker while keeping the source paused; verify
live `storage: kv` before resuming any KV writer. Never resume KV while the live
browser reports D1. After the later activation allows D1 edits, this original
KV snapshot is stale and must not be used as an automatic rollback target.
