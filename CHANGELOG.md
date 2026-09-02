# Changelog

## 2026-09-02 — Journey, form and record consolidation

### What changed

- Replaced entity-specific timing layouts with one Journey component for destination, activity, transport and accommodation records while retaining their existing persisted field names.
- Added separate date and time cards, a journey rail, live duration summary, segmented duration strip and destination-aware local-time labels.
- Added same-day defaults, one-night accommodation defaults, overnight ranges and persistent inline chronology validation.
- Standardised generated forms as Essentials followed by optional disclosure sections and a sticky action footer; transport booking and payment details now use progressive disclosure.
- Preserved field values, expanded sections and keyboard focus when reactive transport fields re-render.
- Added a shared ItemRow view model and renderer across Timeline, all Plan lists, route popovers and marker popovers with canonical metadata order and centralised row actions.
- Added category, location, check-in, check-out, continuation, all-day and warning icons to the semantic SVG registry.
- Added integrated regression coverage for the three shared UI systems.

### Verification

- `npm test` — passed, including security, tokens, icons, accessibility, responsive shell and UI-consolidation checks.
- Map range and route-arc regression checks passed.
- All inline and referenced JavaScript parsed successfully.

## 2026-09-02 — Responsive application shell

### What changed

- Added a compact sticky mobile trip header containing Back, trip name and dates while leaving the richer desktop header unchanged.
- Consolidated narrow-screen navigation into four persistent destinations: Overview, Plan, People and More.
- Kept Timeline and Map prominent as an Overview segmented control; Plan and People expose contextual child navigation and remember the last child used.
- Added a normal More directory page for Expenses and Settings, with Expenses still omitted for scoped roles that cannot access financial data.
- Replaced narrow-screen account actions with an anchored avatar menu supporting outside-click dismissal, Escape, focus entry and explicit menu semantics.
- Added semantic Overview, Plan, People, More and Logout icons to the local WayPoint asset registry.
- Preserved the complete grouped desktop navigation and shared all panel rendering, permissions and actions between breakpoints.
- Added responsive-shell regression coverage and updated the application navigation documentation.

### Verification

- `npm test` — passed, including security, design-token, icon-system, accessibility and responsive-shell regression checks.
- Map range and route-arc regression checks passed.
- All inline and referenced JavaScript parsed successfully.

## 2026-09-02 — Critical accessibility consolidation

### What changed

- Added skip navigation and semantic header, main, navigation, section and table structure, with focus moved to the relevant heading or panel after in-app navigation.
- Made every modal a named dialog with initial focus, contained Tab order, Escape support, an inert background and focus restoration to its trigger.
- Associated generated form labels and hints with their controls, made required state visible, grouped activity timing in a fieldset, and replaced toast-only validation with persistent summaries and inline field errors.
- Converted trip cards to native keyboard-operable buttons and added a consistent high-visibility focus ring without suppressing browser outlines.
- Completed ARIA combobox behaviour for suggestion fields, including expanded state, active option tracking and polite result-count announcements.
- Added live announcements for save state, lookups, location search and errors; icon-only controls retain explicit accessible names.
- Strengthened muted text, accent-button and form-border contrast in both themes, raised small copy targets to 24px, kept touch controls at 44px and honoured reduced-motion preferences.
- Added source-level accessibility regression coverage, including WCAG contrast calculations for the updated token pairs.

### Verification

- `npm test` — passed, including security, design-token, icon-system and accessibility regression checks.
- `node test-map-route-arcs.js` — passed.
- All inline and referenced JavaScript parsed successfully.
- Automated browser interaction testing remains unavailable in this workspace because Chromium is not installed.

## 2026-09-01 — Consolidated icon system

### What changed

- Added a local, dependency-free semantic SVG registry with a consistent 24×24 grid, 1.75px rounded stroke and visible diagnostic fallback for unsupported names.
- Introduced five icon-size tokens and migrated navigation, lists, tags, timelines, map markers, actions and empty states away from one-off dimensions.
- Replaced the activity form's text-character date/time symbols and disclosure plus/minus characters with accessible SVG artwork.
- Gave activities and booking references distinct symbols, added a dedicated generic-route icon, and replaced the map's arrow with an expand symbol.
- Kept rotated map-pin containers while correcting their internal glyphs to remain upright.
- Fixed the reversed Back icon and moved the WayPoint compass mark into the shared registry.
- Added accessible names to modal close, edit, delete, copy, companion-management and map icon buttons, with 44px targets on touch pointers.
- Added inline comments documenting the icon architecture, semantic aliases, security restrictions, map rotation and sizing decisions.

### Verification

- `npm test` — passed, including security, design-token and icon-system regression checks.
- `node test-map-route-arcs.js` — passed.
- All application script blocks and the new icon asset parsed successfully.

## 2026-09-01 — Global design tokens and typography

### What changed

- Replaced ambiguous legacy colour variables with a two-layer primitive and semantic token system used throughout the application.
- Preserved WayPoint's approved light and dark palettes while giving canvas, surface, text, border, action, location and state colours explicit roles.
- Tokenised destination, transport, accommodation and activity map colours, including softer chip treatments, and routed JavaScript-owned Leaflet styling through the same CSS source of truth.
- Consolidated user-facing typography into six roles: Display, Heading, Body, Label, Meta and Micro. Body text and editable fields now use a 16px baseline, with a 32px mobile Display variant.
- Replaced the remaining settings heading one-offs and assigned avatar/control glyphs to named asset-size tokens.
- Added a design-token regression test to prevent legacy variables and arbitrary text sizes from returning.

### Verification

- `npm test` — passed, including security and design-token regression checks.
- `node test-map-route-arcs.js` — passed.
- All inline and referenced script blocks parsed successfully; all referenced CSS custom properties are defined.
- Browser interaction tests could not start in this workspace because the configured Chromium executables are not installed.

## 2026-09-01 — Destination people defaults

### What changed

- Destination forms now use a **People** picker that includes the trip owner as an explicit **Superuser** tag alongside Guests and Companions.
- New activities preselect the people tagged on their chosen destination. Timeline quick-add activities inherit the same defaults when the active destination is unambiguous.
- Inherited people are ordinary checked selections: they are shown immediately and can be adjusted for the individual activity before saving.
- The Superuser is represented by a reserved virtual participant id and resolved from server-owned account data, avoiding a duplicate Companion record or trust in client-supplied identity data.

### Verification

- `npm test` — passed, including Worker persistence, response-shape and scoped-response coverage for the Superuser participant.
- `node test-map-route-arcs.js` — passed.
- Worker, mock server, inline frontend JavaScript and new Playwright test syntax checks — passed.
- The new end-to-end browser test could not run in this workspace because Chromium is not installed and its download timed out.

## 2026-08-31 — Map timeline UI

### What changed

#### Dual-handle date range

**Layman’s explanation**

- The old one-day-at-a-time map selector is now a sliding date range. Drag the start and end handles independently to show any part of a trip, from one day to the full itinerary.
- The map responds while the handles move, and the selected number of days is always visible.

**Technical details**

- Replaced the single `day` / `wholeTrip` state with inclusive `rangeStart` and `rangeEnd` dates.
- Added two accessible native range inputs, keyboard labels, a selected-track fill and direct DOM updates during drag.
- Entries now use inclusive date-overlap filtering, so multi-day destinations, stays and overnight transport remain visible whenever they intersect the selected period.
- Map layers update on `requestAnimationFrame` without rebuilding the Leaflet instance or discarding the user’s current viewport.

#### Larger, responsive map workspace

**Layman’s explanation**

- The map now has room to breathe on larger screens and uses more of the phone or tablet screen without becoming awkwardly tall.
- An expand button opens the map in full-screen mode where the browser supports it.

**Technical details**

- The Map tab can grow to 1,240px wide while the rest of Waypoint retains its reading-focused layout.
- Map height uses responsive `dvh` sizing with desktop and mobile bounds.
- Full-screen changes trigger Leaflet’s `invalidateSize()` so tiles, markers and travel arrows are repositioned correctly.

#### Layer filter chips and contextual status

**Layman’s explanation**

- Destinations, activities, transport and stays are now clear, tappable filter chips rather than small checkboxes.
- Each chip shows how many relevant items are in the selected date range. The map also gives a concise warning when something still needs a location.

**Technical details**

- Replaced checkbox controls with icon-based buttons that expose their state with `aria-pressed`.
- Layer visibility remains local view state and updates the existing Leaflet layer group in place.
- Filter counts and range labels update without a full application render.

#### Clearer map markers

**Layman’s explanation**

- Different kinds of place now look different on the map: pins for destinations, tickets for activities and beds for accommodation.
- Several same-type entries at the same location collapse into one marker with a count, avoiding a stack of indistinguishable dots.

**Technical details**

- Replaced generic `circleMarker` pins with category-specific Leaflet `divIcon` markers using Waypoint’s existing SVG icon set.
- Marker popups list every grouped entry, retain stale-location warnings, and use both icons and colour rather than relying on colour alone.
- Markers at the same category and rounded coordinate are grouped; different categories remain independently filterable.

#### Curved transport routes and date-line handling

**Layman’s explanation**

- Long journeys now follow a natural arc across the world instead of an implausible straight diagonal.
- Routes crossing the Pacific no longer draw a line across the entire map, and each route has a direction arrow.

**Technical details**

- Added great-circle interpolation with 12–96 sampled points per transport leg.
- Route segments split at the international date line, preventing Leaflet from joining +180° to -180° across the world.
- Flights, ferries and ground transport receive distinct line styles; transport popups include locations, timing and an explicit schematic-route note.
- Direction arrows use adjacent points along the curve and are recalculated after zoom and resize events.
- Bounds fitting now chooses the smallest wrapped longitude window, keeping Pacific routes compact.

#### Seam-aware Pacific route wrapping

**Layman’s explanation**

- Flights and other journeys across the Pacific now remain visibly connected instead of appearing to stop at one side of the map and restart at the other.
- As the map is panned around the world, the route follows the nearest copy of the map so it stays in view as one continuous journey.

**Technical details**

- Great-circle points now retain an unwrapped longitude sequence across the international date line (for example, Los Angeles is represented as 242°E when following a route from Tokyo).
- Replaced date-line segment splitting with a single Leaflet polyline that selects its ±360° world copy from the current map centre.
- Routes and direction arrows are recalculated after `moveend`, ensuring the vector layer stays aligned with Leaflet’s repeated map tiles.

#### Map control order and startup reliability

**Layman’s explanation**

- The map loads reliably again and Pacific routes remain visible as continuous arcs.
- The map controls now place destinations, transport, accommodation and activities first, with the date slider directly beneath them.

**Technical details**

- Removed the incompatible one-world tile/bounds mode and restored Leaflet’s standard wrapped map lifecycle.
- Restored the unwrapped, nearest-world polyline for all map zoom levels, including route direction arrows.
- Reordered `MAP_LAYER_META` and changed the toolbar structure to render the filter/action row before the dual-handle date-range controls.

### Verification

- `node test-security.mjs` — passed.
- `node test-map-route-arcs.js` — passed.
- Inline JavaScript syntax check — passed.
- `test-map.js` could not run in this workspace because its hard-coded Chromium executable is unavailable before the browser opens.
