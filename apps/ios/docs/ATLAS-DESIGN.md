# Native Atlas update

7 October 2026

## Design and login

Native semantic colours match `public/WayPoint/styles/base.css`: blue identity/text, turquoise selection, amber amendments, pale blue canvas and adaptive dark surfaces. The existing WayPoint mark is bundled in the asset catalog. Serif headings and system body type respect Dynamic Type. Cards have a shared border and surface treatment; editors, settings and pending-change review use the same canvas.

The welcome screen keeps Log in and Demo actions within reach while its content scrolls. Login retains the website’s single “Enter login code here” field and registered-phone API. It provides keyboard dismissal, a disabled empty-input state, busy feedback and inline errors without discarding the entered value. Login help explains the existing account flow and site-owner support. No self-registration, password reset or new verification-code service is introduced.

## Trip workspace

Itinerary, Plan, People and More stay available in the bottom navigation. Itinerary offers Agenda and Apple Maps. Owner/Admin have an amber Add strip and multiple named traveller filters. Shared records match either selected person once; full-scope unassigned records remain visible. Plan and Map use the same filtered, already-authorized snapshot. Contributor/Viewer have no full-trip filter or broader access.

Agenda days collapse independently. Expand/Collapse all and Jump to date operate on visible days. Collapsed summaries retain visible plan counts and participant names. Cards show local times, saved timezone, route/arrival context and flight number where available, plus named participants or “No people assigned”. Each record keeps its original booking/edit identity.

New records capture the current named selection, or start unassigned under All people. Destination changes retain the explicit assignments. The main editor contains “Who is this for?”, All current travellers and Clear people; Contributor/Viewer assignment controls remain locked. Unavailable participant IDs are retained and labelled on cards instead of silently removed.

At accessibility text sizes, the header can scroll within a bounded area and agenda actions stack. Bottom navigation uses native tab-bar scale limits and retains explicit VoiceOver labels/selection; main content keeps the full accessibility type size.

## Verification

Validated using Xcode 27.0 (27A266a), Swift 6.4 and the iOS 27 simulator SDK. Deployment target remains iOS 17.

- Core package: 45 tests passed, including any-selected-person filtering, duplicate prevention, unassigned visibility, unchanged assignments and scoped snapshots.
- Simulator app build succeeded. App-hosted API/storage tests: 11 passed.
- iPhone 17e: login/help, disabled/enabled input, demo navigation, collapse/expand, Agenda/Map, all four destinations and selected-participant editor default passed.
- iPad mini: the login/help and trip/editor UI flows passed; screenshots reviewed.
- Signed iPhone dark mode: both normal flows passed and screenshots reviewed. The largest accessibility text category passed after the header/action/navigation refinements.
- Generator/app/test source membership matches; scheme/workspace XML parses; Python scripts compile; shell syntax and diff whitespace checks pass.

UI tests use fictional demo content and do not submit login credentials. Unsigned simulator builds report Keychain −34018; ad hoc simulator signing resolves it. The test script and CI test step now use simulator signing without an Apple development team. Xcode’s optional diagnostic collection warned about its subprocess tool path in some runs; the test suites and screenshots were still produced.

## Scope still requiring separate work

Authenticated production login/sync with a real account and physical-device validation remain manual acceptance gates. Traveller/contact administration, expenses, grouped transport disclosures, spanning overnight agenda entries and map date-range controls remain web features or later native work. Current cards continue sorting saved local start strings; this update does not claim multi-zone instant ordering or a new timezone editor.

No deployment, migration, release signing or distribution was performed.
