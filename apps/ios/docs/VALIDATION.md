# Validation and first Mac run

Updated 3 October 2026 for production D1 native sync.

## Checked in the authoring workspace

- Swift source syntax parsed with the tree-sitter Swift grammar.
- Generated Xcode project parsed as OpenStep; app source membership checked against files.
- Shared scheme and workspace XML parsed; app-hosted test target included.
- Python project/validation scripts compile; Mac build script passes shell syntax checks.
- Legacy whole-trip upload remains absent; production network isolation checks pass.
- Independent source review of cursor handling, durable outbox, lost receipts, canonical payloads, permissions, and project integration.

The authoring workspace checks are static. GitHub macOS CI runs the core tests, unsigned simulator app build and app-hosted tests using Xcode 16.4. Review the latest workflow for the specific revision you build. These checks do not prove live authentication or device sync; perform the manual checks below with the production website account.
## Tests supplied

The core tests cover original decoder/demo queue behavior plus D1 record revisions, patches preserving unknown fields, immutable retries, unrelated vs same-record conflicts, explicit reapply, complete bootstrap, quarantine on access changes, scoped permissions, trip/child dependency order, local creation cancellation and mutation wire shape. App-hosted tests cover login cookie parsing, unauthorized/permission-epoch errors, escaped cursors, mutation conflict results, account-isolated storage, retained legacy store and corrupt-file recovery.

Run `bash scripts/check-mac.sh` for core tests and simulator build, then its `--test` option with an installed simulator destination for app tests. Record exact Xcode/SDK versions and results. Resolve compiler/SDK/runtime errors before treating this as a validated app.

## Manual production acceptance

1. Launch demo on iPhone and iPad simulators. Browse timeline/map/plan, edit each kind and relaunch; verify storage and queue survive.
2. Sign in with your existing website account. Confirm Settings shows `liddellworks.com` and visible trips/roles match `https://liddellworks.com/WayPoint/`. Confirm that previous staging snapshots and queued edits do not appear in production.
3. Create a trip and activity; sync. Check the browser sees them. Edit in the browser and sync iOS; check it sees the change.
4. Disconnect after a complete download. Browse/edit, force quit/reopen, reconnect and sync. Verify one committed edit and no lost drafts.
5. Interrupt a request after a possible server commit; retry. Confirm unchanged mutation IDs/bodies, no duplicate records and durable receipt acknowledgement.
6. Edit the same item on both clients; review local/server conflict values. Explicitly reapply/discard. An unrelated item's change should not create a record conflict.
7. Narrow/revoke access while offline drafts exist; reconnect. Hidden records must not be restored by an overlay. Quarantined drafts must not auto-upload. A failed permission-reset bootstrap must leave the invalid authorized view hidden.
8. Sign out, sign in as a different account, verify no previous account's records. Expire a session; reauthentication must be required. Offline revocation cannot be discovered until connectivity returns.
9. Check new activity/accommodation destination selection and inherited participant defaults; existing records must not be silently retagged. Contributor/viewer roles cannot gain broader edit rights.
10. Edit transport departure/arrival separately and preserve booking details. Test all-day, blank dates, overnight/cross-zone travel, address changes clearing stale pins, rapid search cancellation and manual coordinates.
11. Check stale editors after a refresh, Dynamic Type, VoiceOver, dark mode, iPad rotation and unavailable/corrupt storage.

## Remaining gates

Successful Mac build/test execution; actual production end-to-end native sync; device Keychain/file-protection checks; full timezone/expense/account-admin workflows as separately scoped; release icon/privacy/signing/distribution. The native app does not run migration workflows or authorize production editing. See the backend activation guide for those controls.
