# Enable production D1 editing and connect iOS

The real-trip browser preview was reviewed successfully. This release requires
**two guards** to enable saving: a verified D1 authorization marker and an
explicit operator unpause. Merging or deploying this code alone leaves saving
paused. Old whole-trip KV save routes remain disabled.

## Release steps

1. Merge this PR after backend/browser and native Mac checks pass. Wait for the
   normal Cloudflare deployment. Keep every legacy KV trip writer stopped.
2. Check <https://liddellworks.com/WayPoint/api/migration-status?check=activation>.
   It must report `storage: d1`, `writesPaused: true`, `activationSupported: true`,
   and the same source hash and freeze marker as the reviewed preview.
3. Temporarily turn Bot Fight Mode off for the GitHub runner check if necessary,
   as during migration preparation.
4. GitHub → **Actions → Authorize production D1 editing → Run workflow**.
   Select **main**, enter **AUTHORIZE D1 EDITING**, and tick the two review/pause
   acknowledgements only while they are true. Run it.
5. Require `status: editing_authorized`. The workflow rechecks frozen source,
   retained encrypted backup, exact candidate, all trip records and permissions.
   It changes only the candidate's control marker to `active`; saving stays
   paused. It does not deploy, import or create another database.
6. Cloudflare → **Workers & Pages → waypoint-app → Settings → Variables and
   Secrets**: change only the Text variable **WAYPOINT_WRITES_PAUSED** to
   **false** and click **Deploy**. Keep `WAYPOINT_ENV=production`, the source hash,
   freeze marker, D1 binding, credentials and other settings unchanged.
7. Open a fresh status URL, e.g. the status path with `?check=editing-enabled`.
   Require `storage: d1`, `writesPaused: false`, `editingAuthorized: true` and
   `activationSupported: true`. Restore Bot Fight Mode after the workflow.
8. Refresh all browser tabs. Create a small temporary test trip, add/edit one
   activity, refresh to check persistence, then delete that temporary trip.
   Do not modify real trip records merely to test saving.

A failed authorization leaves the pause unchanged. If a marker update response
was lost, rerunning reconciles the unchanged candidate before permitting a
retry. Once any actual D1 edit occurs, this initial activation workflow cannot
be rerun against the frozen source. Do not bypass that refusal.

## iOS on your Mac

Update your current working repository to merged **main**, then open
`apps/ios/WayPoint.xcodeproj`, scheme **WayPoint**, and build/run in Xcode. Retain
any uncommitted local work before pulling. Sign in with the same existing
WayPoint account as the browser. No Cloudflare API token is put in the app.

The native origin is pinned to `https://liddellworks.com`, with production D1
capability verification before loading/syncing. A paused preview or staging
server is rejected. Production uses a new Keychain service and separate durable
workspace/outbox directory, so staging sessions and queued dummy-trip mutations
are not replayed into production. Sign in again; staging data remains isolated.
The offline demo still works without login.

After the temporary web test passes, create a temporary trip in the browser,
sync it to iOS, edit its activity on iOS, tap **Sync now**, and refresh the browser.
Then change that activity in the browser and sync iOS again. Use the temporary
trip to check offline queued edits; delete it afterwards. If native requests
receive a Cloudflare challenge or redirect, stop and report that error. Mac CI
verifies build and API behavior with test responses; it cannot prove live-device
network acceptance through site security settings.

## Storage and recovery after activation

Trips, grants, per-record revisions and sync history are authoritative in D1.
KV continues to hold account credentials and integration caches, so the old
freeze hash is historical after normal account/cache changes resume. Keep the
retained encrypted pre-migration backup and recovery key; it does not contain
new D1 edits. Arrange D1 backups before later schema/storage changes.

Keep legacy KV trip writers disabled permanently. Do not roll back to the old
KV-only Worker, delete production mode variables, or rerun the initial import.
If a problem appears, set **WAYPOINT_WRITES_PAUSED=true** and deploy to pause
D1/account edits while investigating. The app continues reading D1; it never
falls back to stale KV. New production snapshots and queued edits remain
account/environment isolated. Refresh stale browser tabs before resuming.
