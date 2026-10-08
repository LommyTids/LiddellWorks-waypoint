# WayPoint iOS — production D1 sync

Native SwiftUI app for iPhone and iPad, iOS 17+, with Apple Maps, account-isolated offline storage and record-level sync. The app connects to **https://liddellworks.com/WayPoint**. Choose **Log in to WayPoint** on the welcome screen, then enter your registered phone number in the single “Enter login code here” field. Existing account IDs and permissions, including UberUser, are retained.

## Atlas interface

The native app follows the web app’s blue/turquoise design language, with the existing WayPoint mark, serif headings, adaptive light/dark surfaces and amber Add/Edit/Save actions. Welcome, login and login help include loading, disabled and inline error states; account setup remains with the site owner.

Trips use the **Floating glass** layout: title and dates scroll away, while **People, Agenda/Map and Add** stay in a pinned toolbar. A small floating **Itinerary, Plan, People and More** dock uses the WayPoint mark for Itinerary. Cards keep time, title, location/route context and named assignments; tap for complete dates, addresses, timezone and notes, then choose Edit. Day collapse and date jump live in the calendar menu beside each day.

Owner/Admin can select multiple travellers; either selected person matches, shared plans appear once, and unassigned plans stay visible. The same filter feeds Plan and Map. Scoped accounts keep their server-authorized snapshot. New records start with the selected people, or unassigned for Everyone, and changing destination preserves that choice. Participant controls include All current travellers and Clear people. Traveller/contact administration and expenses remain in the web app.

Fraunces, Work Sans and IBM Plex Mono are bundled for offline use, with their Open Font Licences. With Xcode 26+, navigation uses native Liquid Glass on iOS 26+, regular material on iOS 17–25, and opaque surfaces when Reduce Transparency is enabled. Older Xcode toolchains compile the material fallback. Content retains full Dynamic Type; the toolbar stacks at accessibility sizes. See [Floating glass implementation](docs/FLOATING-GLASS.md).

The earlier Atlas implementation and simulator evidence remain in [the Atlas design notes](docs/ATLAS-DESIGN.md).

## Update and open on your Mac

An app built from an old checkout can still connect to the separate staging backend and accept only its test accounts. Updating the website does not update an installed iOS app: rebuild the app from the current repository.

Close Xcode. In Terminal, update the checkout you intend to build. If your fresh checkout is `~/WayPoint-migration`, run:

```sh
cd "$HOME/WayPoint-migration"
git status --short
git switch main
git pull --ff-only origin main
open apps/ios/WayPoint.xcodeproj
```

If Git reports local changes or refuses the update, retain those changes and resolve them before proceeding. Do not discard them to update the app. If your checkout is elsewhere, use that directory in the first command. Opening the project by this path avoids Xcode reopening a different old copy.

1. Select the **WayPoint** scheme and your iPhone/iPad or an installed iOS 17+ simulator.
2. For a physical device, select your Apple development team in **Signing & Capabilities**. Change the bundle identifier only if your team requires it.
3. Select **Product → Clean Build Folder**, then **Run**. This installs the newly built app on the selected device or simulator.
4. Sign in with your existing website account. The login screen describes the website account, and Settings shows **Server: liddellworks.com**.
5. Use **Sync now** to send saved changes and download server changes. Review conflicts in Settings. Save a temporary item, verify it in the website, edit it there, then sync iOS to check both directions.

If login still fails, send the exact app error and confirm the Server field or login screen text. A Cloudflare challenge is a network/security response and does not mean your password is wrong.

No Cloudflare API token, setup key or signing secret belongs in Xcode. Native authentication uses the end-user's secure `wp_session` cookie, stored in Keychain. Production sessions, downloaded trips and queued changes have a separate environment namespace from staging. Staging drafts are retained locally and are never uploaded to production. Do not uninstall the old app to fix the endpoint if you need its unsynced drafts.

## Build and test

From `apps/ios` in Terminal:

```sh
bash scripts/check-mac.sh
```

This runs core package tests and an unsigned simulator build. For app-hosted tests, select an actual installed simulator:

```sh
xcrun simctl list devices available
WAYPOINT_TEST_DESTINATION='platform=iOS Simulator,name=YOUR EXACT SIMULATOR NAME' \
  bash scripts/check-mac.sh --test
```

The shared scheme includes font/permission and API/storage tests, plus native UI tests for login/help, demo navigation, traveller defaults, compact details, pinned actions and accessibility text. Test runs use ad hoc simulator signing: an unsigned simulator app cannot access Keychain and reports error −34018. Core tests also run independently with `swift test`. This project has no third-party Swift dependencies. GitHub macOS CI builds the simulator app and runs the tests; device signing and authenticated live sync also need an actual Mac/device check.

## App icon

The selected W-shaped travel route is installed in `WayPointApp/Assets.xcassets/AppIcon.appiconset`. Its opaque 1024×1024 master supplies the iPhone/iPad icon through the iOS asset catalog; the system applies the rounded corner mask. The project generator includes the catalog and selects `AppIcon`, so regeneration preserves it.

## Source layout

- `Sources/WayPointCore`: legacy-compatible models/demo plus D1 protocol, reducer and outbox.
- `Tests/WayPointCoreTests`: core regression tests.
- `WayPointApp/App`: state orchestration and lifecycle.
- `WayPointApp/Services`: production API, Keychain, SwiftData/demo and durable D1 cache, Apple place search.
- `WayPointApp/Views`: trips, timeline/map/plan, editor and pending-change review.
- `WayPointAppTests`: HTTP service and storage tests.
- `scripts/generate_project.py`: regenerate target membership after adding/removing app/test files.
- `docs/VALIDATION.md`: validation and manual acceptance checks.
- `docs/ARCHITECTURE.md`: storage/sync behavior.

## Scope and remaining work

The app edits itinerary fields and preserves the server's unrelated raw data. People/sharing administration, complete expense workflows, photos and Android remain later work. Map imagery/place lookup need a connection; downloaded itinerary and coordinates remain available offline. Foreground/manual sync is implemented; background execution is not promised.

Production D1 editing is authorized separately through the [activation workflow](../../docs/backend-v1/production-activation.md). This app requires a ready production sync server and does not perform migration or cutover. Give Claude this entire folder for review, with actual Xcode errors/results and any live sync failures.
