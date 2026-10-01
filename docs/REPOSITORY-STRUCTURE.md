# Web, backend and native development

This repository keeps the existing browser/Cloudflare deployment layout and adds the native iOS app in `apps/ios/`. Open `apps/ios/WayPoint.xcodeproj` on a Mac. Read its README for staging login, demo, build/test and signing instructions.

| Path | Responsibility |
| --- | --- |
| `public/` | Browser app and assets |
| `src/` | Cloudflare Worker and shared D1 API |
| `migrations/` | D1 schema |
| `apps/ios/` | SwiftUI app, local core package and native tests |
| `docs/backend-v1/` | Shared sync API and migration instructions |
| `apps/ios/docs/` | Native architecture, validation and Claude review |

Keep one canonical backend protocol with platform-specific interfaces. Native structured data syncs through the Cloudflare API, not CloudKit. The iOS app currently targets the isolated D1 staging deployment; production remains KV until the separate migration gates pass.

Use a new feature branch for each task. A coordinated feature may change web, backend and iOS in one PR. Merge reviewed work into main; deploy/release clients independently. Backend changes must retain compatibility with installed older native versions or introduce an explicit protocol version. Do not deploy production as a side effect of a native-only change.

The iOS checks workflow runs native package tests, an unsigned simulator build, and app-hosted API/storage tests on macOS when native files or the workflow change. The `iOS gate` job always reports a result, including when native checks are unnecessary. If configuring branch protection, require that gate rather than a path-filtered workflow that can be absent. Existing web/backend checks remain independent.

Keep credentials in GitHub/Cloudflare/Xcode's signing configuration. Do not commit API tokens, passwords, private migration exports, provisioning profiles, DerivedData or personal Xcode state. Different agents should use separate feature branches and coordinate when they change the same API contract.
