# Changelog

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
