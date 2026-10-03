# Claude review brief

Review this complete native Xcode project after the owner has run it on their Mac. Begin with README and VALIDATION, run the Mac build/test script, then inspect D1Sync, D1RecordPatch, AppModel and the platform services. Prefer concrete runtime/test evidence to source-only confidence.

The project now uses the production D1 API, following the initial isolated staging implementation. GitHub macOS CI builds the simulator app and runs tests; local authoring validation does not use Xcode. Review SDK compatibility, SwiftData/Keychain behavior, generated test-host settings, asynchronous HTTP testing and cancellation, identity validation/offline reopening, immutable receipts, canonical server data after acknowledgements, permission quarantine and schema migrations.

Backend repository: https://github.com/LommyTids/LiddellWorks-waypoint. Pull latest main before comparing its actual contracts. Backend source lives in the same repository. Production origin is pinned in WayPointAPI; production credentials remain in KV while trip records use D1. Do not turn this review into an automatic production deployment/migration.

The cleaned-source rehearsal and retained-backup recovery passed, and the owner reviewed the production D1 preview. Follow the backend activation guide for editing authorization. Synthetic native tests do not prove live login or two-way sync; verify those with the owner on the actual device.

Work in a feature branch. Keep unrelated edits, preserve legacy offline drafts, never call the whole-trip legacy upload API, and never bundle Cloudflare credentials. Provide a PR/change summary plus actual build/test results and remaining blockers. Photos and Android remain deferred.
