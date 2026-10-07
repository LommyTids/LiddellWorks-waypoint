# Atlas web flow

The trip workspace supports friends travelling on separate legs and sharing only parts of an itinerary. It uses the existing WayPoint mark as a subtle background watermark and a blue/turquoise palette in both themes. Selected controls share a turquoise outline/fill; Add, Edit and Save use a contrasting amber outline, also applied to editor boxes.

## Navigation and hierarchy

Desktop uses a left rail for Itinerary, Plan, People, Expenses and Trip settings. Phones use Itinerary, Plan, People and More in the bottom navigation. The same stored section keys, permissions and record editors serve both layouts.

The content column stacks trip identity, Add to trip, people selection, section controls and the current panel. From Add to trip down to the section controls, one floating bar stays below the app header and connection banner while scrolling. On smaller screens it is bounded and can scroll internally, with a compact horizontal people selector. Identity uses the available width for the title, dates, access and whole-trip recorded costs. Agenda and Map are prominent neighbouring controls. Plan contains Areas, Travel, Stays and Activities; People contains Travellers and Contacts.

## People and bookings

All people is the initial view. Selecting one person narrows the itinerary; selecting more matches any selected person. Deselecting the final person restores All. Unassigned plans remain visible within the account's authorized data. Filtering never rewrites assignments. Scoped users see their authorized tagged plans without an all-trip people selector.

Named assignments wrap on cards and remain visible in the main editor under “Who is this for?”. An unassigned itinerary record says “No people assigned”. Cards combine title, time, cost and actions into a compact header, followed by the relevant context and people.

Expenses labels its filtered total “Visible recorded costs”; linked costs follow the view filter. Standalone expenses remain included, and shared costs remain whole amounts rather than being split per person. The trip header's cost remains the whole-trip total.

## Agenda

Days collapse independently, with summary counts and named participants still visible. Expand/Collapse all and Jump to date remain keyboard operable. A date jump expands and focuses its day; its selected date is remembered for that trip in the current session.

Two or more departures from the same origin within an anchored 60-minute window form a compact list. Each journey is an independent native disclosure with its own flight, participants, booking and edit identity. Grouping compares resolved instants when timezones are available. Unknown local times are labelled; ambiguous DST times and mixed known/unknown timezone comparisons are not grouped. Groups never combine saved bookings or broaden account access. Each journey's disclosure state is remembered per trip in the current session.

All applicable overnight stays and journeys are shown with their participants, so different accommodation is visible on the same night.

## Map

A single map fills the content column and retains its sliding date range, layer controls and location popups. Locations needing review are an optional collapsed disclosure below the map, kept in step with the date range and people filter. Leaving or remounting the map cleans up its Leaflet instance and pending refresh.

## iOS continuity

Keep the same four primary destinations, Agenda/Map choice, named assignments, independent booking disclosures and collapsible days. Use shared view-filter semantics and compact card information order. The desktop rail adapts to the phone bottom navigation; no database migration is required for this flow.

## Validation

The merge gate covers source/security regressions, static asset loading, save/reload and real Leaflet mounting in Chromium and WebKit. Responsive browser checks exercise 390, 768 and 1440 widths, both themes and four roles, plus six separate CDG departures, original booking/edit identities, filter scoping, keyboard disclosures, day collapse/date jump band/panel geometry, consistent selection/amendment colors, floating-header offsets and unobscured focus. The backend browser suite separately exercises phone sign-in and actual D1 create/edit/reload and paused-write protection.
