# WayPoint UI implementation exceptions

The consolidated UI uses semantic tokens, shared form structure, `ItemRow`,
the Journey date/time control, and reusable status/empty-state components.
The remaining inline styles are intentional data-driven exceptions:

- Avatar background and smiley colours come from the allowlisted local avatar
  palette. They represent stored user choices and cannot be expressed by one
  fixed semantic component token.
- Map range percentages are live values from the two range controls and are
  passed to CSS custom properties on the slider.
- Map category colours are semantic light/dark tokens, but Leaflet-generated
  marker and route HTML receives their resolved value because it is mounted
  outside the normal component render tree.
- Transport-arrow rotation is computed from projected map geometry at the
  current zoom, so it remains a runtime transform.

Any new exception should be added here with the reason it cannot use a shared
class or semantic token. Static spacing, sizing, colour, and typography styles
are not exceptions.
