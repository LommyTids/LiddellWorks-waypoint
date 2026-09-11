# Changelog

## 2026-09-11 — Timeline notes, flight labels, and opening on today

### What changed

- Timeline notes clamp to **two** lines rather than three.
- Pressing a Timeline card opens its full note in place; pressing again closes
  it. Only cards whose note is actually cut off get the control.
- Flights read as airport codes on the Timeline — `Flight BA005: LHR → HND`
  instead of the full airport names.
- The Timeline opens on today while a trip is under way, and at the start
  otherwise.
- The Map's range now starts on today while a trip is under way, and shows the
  whole trip otherwise. **Reset** returns to that same view.
- A Map popup with a long note is bounded and scrolls, with a fade that stays
  visible to say the text continues.

### Technical details

Expandable notes are a model capability, not context knowledge in the shared
card: `eventRowHtml()` sets `model.expandableNote`, and the card only honours
it. A `context === 'timeline'` check in the renderer would have undone the
layout table that replaced exactly that, and `test-card-system.js` fails on one.

`markTruncatedNotes()` measures after layout, because CSS cannot report whether
a clamp bit. Only a note that is really cut off gets a control, so a short one
never advertises an action that would do nothing.

The whole card is pressable through one delegated action. The nearest
`[data-action]` wins, so the edit, delete and add controls inside are
unaffected; the handler additionally ignores presses on the people scroller,
the metadata disclosure, a copy button or a link, each of which is its own
gesture.

`transportEndpointLabel()` shortens a flight endpoint to a leading IATA code
and leaves everything else alone: a rail or ferry endpoint is a place name, not
a code. This applies to the Timeline only — the Transport tab still shows full
airport names, where there is room and where you are checking details.

`tripFocusDay()` is shared by both views and takes an injectable `today`, for
the same reason `timelineDayExpanded()` does: a date-dependent default is only
testable if the date can be supplied. Opening at the start scrolls to the top
of the page rather than to the first day card — arriving from a scrolled tab
would otherwise leave the reader part-way down, and scrolling the card itself
into view hides the trip header.

Map popups take a bounded `maxHeight`, which is what gives Leaflet a scroll
region at all; before this a long note simply grew the popup past the height of
a phone. The affordance, not the scrolling, was the missing part: touch
platforms draw overlay scrollbars that appear only while a scroll is already
under way, so a styled scrollbar is invisible at rest. The cue is a sticky
fade inside the scroller — no `:has()`, and independent of Leaflet's own inline
sizing. `overscroll-behavior: contain` keeps the gesture in the note instead of
panning the map underneath.

### Verification

- `npm test` — passes, 12 suites. `test-map-route-arcs.js` was only in the
  merge gate and is now in the default suite.
- Rendered in Chromium at 390px with touch emulation, both halves of each rule:
  - Under way: Timeline opens with today centred (scrollY 357), Map range
    starts on today.
  - Not under way: Timeline opens at the top (scrollY 0), Map shows the whole
    trip.
  - Notes clamp at 2; pressing a card takes it 135px → 342px and back, with the
    control reading More then Less and `aria-expanded` following.
  - Pressing Edit still opens the editor and does **not** toggle the note.
  - A popup with a long note scrolls (398px of content in a 279px box) and
    contains its own overscroll.

### Not verified

`npm run test:merge-gate` still needs Playwright Chromium **and** WebKit. The
popup fade and the card press are both touch behaviours worth confirming on a
real iPad.

## 2026-09-11 — One card component for every list

### What changed

- Every list in the app — the four Plan tabs, the Timeline, the Map popovers,
  Contacts, Companions and Manage accounts — now renders from one card
  component driven by a layout table. A context is an entry in
  `ITEM_CARD_LAYOUTS`, not a branch in the renderer.
- Cards are stacked lines everywhere, so a title is never squeezed between a
  fixed icon column and the record actions.
- Metadata flows as one wrapping run instead of one row per group, and chips
  past a cap move behind a `+N more` disclosure.
- People moved to their own line along the bottom of a card, scrolling
  sideways rather than wrapping.
- A record's cost moved out of the metadata chips and onto the card's first
  line, in the trip's home currency.
- Contacts, Companions and Manage accounts stopped hand-building their own
  markup, which had drifted: a contact's role was an `.item-sub` where a
  companion's access level was a tag, and neither list got a category stripe.
- Category stripes and the heavier transport title, added to the Timeline last
  week, now apply in every context.
- Added `package-lock.json`, so `wrangler` and `playwright` resolve to the
  versions the merge gate was validated against rather than re-resolving on
  each install.

### Technical details

`ITEM_CARD_LAYOUTS` maps a context to a list of lines, each a list of slot
names. Two rules let one layout serve a bare record and a fully populated one:
a slot with nothing to show renders nothing, and a line whose slots are all
empty does not render. `spacer` pushes what follows to the right edge and never
keeps a line alive by itself.

A metadata group named anywhere in a layout drops out of the catch-all
`metadata` slot automatically, which is what lets `people` move to its own line
without rendering twice and without an exclusion list to keep in sync.

`itemMetaBlockHtml()` is the single metadata renderer; `itemMetadataHtml()` is
that function with every group and no cap, so its existing signature and
regression coverage are unchanged. `ITEM_META_ORDER` and the four per-record
model builders are unchanged in shape — this changes how a model is drawn, not
how it is built.

Cost is reported by `recordCostLabel()` in the home currency so a column of
them compares and reconciles with the trip total; an unconvertible amount shows
its original currency and is flagged. It sits on line one because the metadata
run is capped, and a price behind `+N more` is worse than no price. The
Timeline still suppresses it on the days that would bill a record twice.

The people line uses `overscroll-behavior-x: contain` so flicking it on a phone
does not drag the page, carries `tabindex="0"` with a group label so it can be
panned from the keyboard, and is the only part of a card allowed to scroll
horizontally.

### Verification

- `npm test` — passes, 11 suites including a new `test-card-system.js`.
- `node test-map-route-arcs.js` — passes.
- Rendered in Chromium across seven tabs at 390px and 1440px in both themes:
  no page errors, and no horizontal overflow anywhere.
- Transport card at 390px: **517px → 241px**, of which metadata is **384px →
  97px**. Desktop 221px → 149px.
- The people line holds its height at 34px with ten companions forced in
  (scrollWidth 1222 against a 330px box) and page overflow stays 0.

### Not verified

`npm run test:merge-gate` still needs an environment with Playwright Chromium
and WebKit. No WebKit, real-device touch, VoiceOver or full WCAG pass is
claimed — and the horizontal people scroller in particular is worth checking on
a real iPad.

## 2026-09-10 — Timeline day context, navigation and card layout

### What changed

- Restored the day spine so it stays continuous across collapsed days; it
  previously measured 0px on every one of them.
- Gave collapsed days a summary line — event count, and the day's spend —
  instead of an empty 38px row that made a packed day look like an empty one.
- Marked today with an accented date badge and a **Today** flag, and marked
  days that fall outside the trip's own start and end dates.
- Named each day's area again, including both areas on a transfer day. This
  reverses part of the 2026-09-02 condensing, which read well on a one-city
  trip and left a multi-city trip with no sense of place.
- Added a per-day spend figure in the home currency, and a converted cost on
  each event card that carries one.
- Rebuilt Timeline cards as three rows — a control strip, the title at full
  card width, then supporting detail clamped to three lines. The title had
  84px on a 390px phone and wrapped hotel names over four lines.
- Replaced the three per-day add buttons with one **Add** menu, taking a
  fortnight's Timeline from 42 permanent controls to 14.
- Made the whole day heading the disclosure control rather than the 34px date
  circle, and brought the Timeline's controls up to the 44px coarse-pointer
  minimum the rest of the app already used.
- Added a Timeline toolbar with trip progress, **Jump to today** and expand or
  collapse all, for trips long enough to need navigating.
- Gave each card a category stripe in its existing map colour, with a faint
  tint and heavier title on transport.

### Technical details

Timeline event cards remain the shared `ItemRow` component; `itemRowHtml()`
now selects a stacked layout for the `timeline` context rather than a second
renderer being introduced. The condensed card still discards ItemRow metadata,
so addresses, companions and commerce tags stay on the Plan lists and Map
popovers.

The day spine is an absolutely positioned `.day-rail::before` rather than a
`flex: 1` sibling, which took its height from the day body and so collapsed to
nothing whenever a day was closed.

Per-day spend is aggregated once per render from `allCostLines()` — the same
lines as the Expenses ledger and the trip total — so a day reconciles with the
header. A record's cost is attributed to exactly one day (departure for a leg,
check-in for a stay, start for an activity), so a return leg or a checkout
cannot show the same money twice.

The add menu is a native `<details>`, closed on outside click and on Escape,
and explicitly closed when one of its items opens a modal so it cannot sit
behind the dialog and swallow the first Escape. The day disclosure still
updates in place rather than re-rendering, to keep the reader's scroll
position; the expand/collapse-all control is resynced alongside it. **Jump to
today** honours `prefers-reduced-motion` explicitly, since that media query
governs CSS scrolling rather than `scrollIntoView`'s option.

The add control recedes by dropping its outline rather than its opacity: an
`opacity: 0` control is a target a pointer can land on without seeing.

### Verification

- `npm test` — passed, including a rewritten `test-timeline-condensed.js`. Two
  of its assertions encoded the "no destinations in day headings" decision and
  are deliberately inverted rather than deleted.
- New executable coverage for day flags, area labels including transfer days,
  per-day spend aggregation, cost attribution, and `daysBetween`.
- 16 representative new assertions were confirmed to fail against the previous
  `public/WayPoint/index.html`, so they are regressions rather than tautologies.
- `node test-map-route-arcs.js` — passed.
- Rendered in Chromium against a 14-day, three-city trip at 390px and 1440px in
  both themes: the spine measures 68px on collapsed days (0px before), phone
  titles 286px with none wrapping past two lines (84px and up to four before),
  14 add controls (42 before), the day disclosure 56px tall (34px before), and
  no horizontal overflow. Dark theme resolves entirely through tokens.

### Not verified

`npm run test:merge-gate` still needs an environment with Playwright Chromium
and WebKit configured. No WebKit, real-device touch, VoiceOver or full WCAG
pass is claimed.

## 2026-09-09 — Astra UI review

- Fixed cancelled location search controls, accidental zero-coordinate pins, preview-to-placement switching, stale destination boundaries and picker cleanup.
- Preserved reviewed same-airport pins during flight refresh; changed airports update both labels and coordinates, and obsolete lookup responses are ignored.
- Restored expense editing in desktop/mobile views without exposing deletion of linked itinerary records from the ledger.
- Improved inline validation, FX-rate precision, hidden/disclosure focus handling, nested Escape behavior and suggestion change notifications.
- Corrected phone-width form layout, modal action visibility, map stacking, sticky offsets and offline Save/status behavior.
- Added phone-accessible trip settings, a shared Settings currency combobox and collapsed dependency inventory.
- Added executable production-function regressions and expanded browser QA cases. See `UI-REVIEW-20260909.md` for technical notes, verification limitations and pre-merge checks.

## 2026-09-03 — Record editor and map recovery hotfix

### What changed

- Restored Edit actions for destination, travel, accommodation and activity cards.
- Restored the Map tab's **Find location / Set pin** recovery action, which opens the same record editors.
- Changed **Locations needing attention** into an accessible disclosure that starts collapsed and retains its visible warning and record count.

### Technical details

- Fixed the shared People tag-picker renderer referencing an undefined `full` variable instead of the established `fullClass` value. The resulting `ReferenceError` prevented every form containing that shared picker from mounting.
- Used native `<details>` and `<summary>` semantics for the collapsed map-attention panel, including a rotating disclosure icon.
- Added an executable regression that renders the shared tag picker both with and without companions, plus source guards for the recovery action and collapsed default.

## 2026-09-02 — Condensed, collapsible Timeline

### What changed

- Reduced Timeline event cards to their time, icon, title, useful arrival/overnight context and record actions.
- Removed addresses, destination references and all metadata tag pills from Timeline cards while retaining the full details in Plan lists and Map popovers.
- Removed destination chips from Timeline day headings.
- Converted each black date circle into an accessible disclosure button with an explicit expanded state and controlled day-content region.
- Defaulted dates before the viewer's current local date to collapsed, while today and future dates remain open.
- Preserved manual expand/collapse choices as local session state without modifying saved trip data.
- Added regression coverage for compact cards, disclosure wiring, date defaults and manual overrides.

## 2026-09-02 — Populated trip render hotfix

### What changed

- Fixed the shared ItemRow metadata renderer referencing a callback-local variable after the callback had finished.
- Restored Timeline rendering for trips containing destinations, activities, transport or accommodation records; empty trips were unaffected.
- Added an executable populated-trip regression test so this data-dependent failure cannot be hidden by source-pattern checks.

### Verification

- Reproduced the production exception against a populated trip before applying the fix.
- `npm test` — passed, including the new executable populated-trip renderer test.

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
