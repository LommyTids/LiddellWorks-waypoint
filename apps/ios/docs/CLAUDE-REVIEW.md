# Claude review brief

Review this complete native Xcode project after the owner has run it on their Mac. Begin with README and VALIDATION, run the Mac build/test script, then inspect D1Sync, D1RecordPatch, AppModel and the platform services. Prefer concrete runtime/test evidence to source-only confidence.

The project was updated on 1 October 2026 from a legacy read-only SwiftUI foundation to an isolated staging D1 client. It has not been compiled with Xcode in the authoring workspace. Review SDK compatibility, SwiftData/Keychain behavior, generated test-host settings, asynchronous HTTP testing and cancellation, identity validation/offline reopening, immutable receipts, canonical server data after acknowledgements, permission quarantine and schema migrations.

Backend repository: https://github.com/LommyTids/LiddellWorks-waypoint. Source inspected through f56b8c7 (#32); pull latest before comparing its actual contracts. Backend itself is not included in this archive. Staging origin is pinned in WayPointAPI; production remains KV. Do not turn this review into an automatic production deployment/migration.

Production rehearsal last failed validate_source/source_or_verification_error with sourceWrites0 and productionSwitchfalse. Its specific private-data validation cause remains unknown. A passing synthetic native test does not resolve it.

Work in a feature branch. Keep unrelated edits, preserve legacy offline drafts, never call the whole-trip legacy upload API, and never bundle Cloudflare credentials. Provide a PR/change summary plus actual build/test results and remaining blockers. Photos and Android remain deferred.
