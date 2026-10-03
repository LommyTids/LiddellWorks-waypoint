> Production connection update: after [D1 activation](../../docs/backend-v1/production-activation.md), this app uses the production origin and a separate production session/cache/outbox. Sign in with your existing web account. Earlier staging instructions below describe the foundation stage.

# WayPoint iOS — D1 staging project

Native SwiftUI project for iPhone and iPad, iOS 17+, with Apple Maps, account-isolated offline storage and record-level sync to the isolated Cloudflare D1 staging backend. Production still uses KV and is not changed by this app.

## Open on your Mac

1. Clone this repository and switch to the iOS feature branch, then open `apps/ios/`. For a standalone archive, unzip the complete folder and keep its package, source and test folders beside the Xcode project.
2. Open **WayPoint.xcodeproj** in Xcode. Select the **WayPoint** scheme and an installed iPhone or iPad simulator running iOS 17 or newer.
3. Press **Run**. Use **Explore a demo trip** first; it requires no account.
4. For shared staging trips, sign in with the account you created at https://waypoint-backend-staging.tomhaliddell.workers.dev. Your production website credentials are separate.
5. Use **Sync now** to send saved changes and download server changes. Review conflicts in Settings. The staging web app is at `/WayPoint/app` on that same origin.
6. To run on a physical device, select your Apple development team in **Signing & Capabilities** and change the bundle identifier if your team requires it.

No Cloudflare API token, setup key or signing secret belongs in Xcode. Native authentication uses the end-user account's secure `wp_session` cookie, stored in Keychain. The development endpoint is pinned to staging; no production write switch is supplied.

## Build and test

In Terminal, from this folder:

```sh
bash scripts/check-mac.sh
```

This runs core package tests and an unsigned simulator build. For app-hosted tests, select an actual installed simulator:

```sh
xcrun simctl list devices available
WAYPOINT_TEST_DESTINATION='platform=iOS Simulator,name=YOUR EXACT SIMULATOR NAME' \
  bash scripts/check-mac.sh --test
```

The shared scheme includes the app-hosted service tests. Core tests also run independently with `swift test`. This project has no third-party Swift dependencies.

## Source layout

- `Sources/WayPointCore`: legacy-compatible models/demo plus D1 protocol, reducer and outbox.
- `Tests/WayPointCoreTests`: core regression tests.
- `WayPointApp/App`: state orchestration and lifecycle.
- `WayPointApp/Services`: staging API, Keychain, SwiftData/demo and durable D1 cache, Apple place search.
- `WayPointApp/Views`: trips, timeline/map/plan, editor and pending-change review.
- `WayPointAppTests`: HTTP service tests.
- `scripts/generate_project.py`: regenerate target membership after adding/removing app/test files.
- `docs/VALIDATION.md`: what has and has not been verified.
- `docs/ARCHITECTURE.md`: current storage/sync behavior.

## Scope and remaining work

The app edits itinerary fields and preserves the server's unrelated raw data. People/sharing administration, complete expense workflows, photos and Android remain later work. Map imagery/place lookup need a connection; saved itinerary and coordinates remain available offline. Foreground/manual sync is implemented; background execution is not promised.

The production KV-to-D1 rehearsal last reported `validate_source` failure. That separate migration blocker remains unresolved; the native app uses synthetic staging data and does not perform migration or cutover.

GitHub macOS CI runs the package tests, simulator build and app-hosted tests. Check the latest PR run for results; local authoring checks alone do not prove an Apple SDK build. Device behavior and authenticated end-to-end staging sync still need verification. Give Claude this entire folder for review; include actual Xcode errors/results rather than only the handover document.
