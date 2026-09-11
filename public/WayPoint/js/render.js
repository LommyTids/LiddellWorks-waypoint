/* ---------- 23. Top-level render dispatcher ------------------------------------ */

var pendingRenderFocus = null;

function render() {
  var app = document.getElementById('app');
  document.body.classList.toggle('is-trip-view', currentView === 'trip' && !!currentTripId);
  if (currentView === 'manage-users') {
    app.innerHTML = renderManageUsersView();
  } else if (currentView === 'site-settings') {
    app.innerHTML = renderSiteSettingsView();
  } else {
    app.innerHTML = (currentView === 'trip' && currentTripId) ? renderTripView() : renderDashboard();
  }
  enhanceAccessibility(app);

  if (pendingRenderFocus) {
    var focusSelector = pendingRenderFocus;
    pendingRenderFocus = null;
    requestAnimationFrame(function () {
      var target = document.querySelector(focusSelector) || document.getElementById('main-content');
      if (target) target.focus();
    });
  }

  if (currentView === 'trip' && currentTab === 'timeline') {
    // Through the same lens the Timeline was just drawn with -- otherwise
    // this scrolls to a day whose only events the lens filtered out.
    var timelineTrip = scopedTripForRender(currentTrip());
    if (timelineTrip) {
      requestAnimationFrame(function () {
        markTruncatedNotes();
        focusTimelineOpeningDay(timelineTrip);
      });
    }
  }

  if (currentView === 'trip' && currentTab === 'map') {
    // The Map tab's HTML (including a fresh, empty #map-canvas div) was
    // just drawn above — mount the actual Leaflet map into it. See the Map
    // section (19b) for why this can't just be part of the HTML string
    // like everything else on the page.
    // Same lens as the panel above: Leaflet draws from its own pass over
    // the trip, so without this the map would show pins for items the
    // list beside it is hiding.
    var trip = scopedTripForRender(currentTrip());
    if (trip) initMap(trip);
  } else if (mapState.instance) {
    // Left the Map tab (or the trip): tear down the Leaflet instance
    // rather than leaving it running against a #map-canvas element that
    // innerHTML just replaced out from under it.
    mapState.instance.remove();
    mapState.instance = null;
    mapState.layers = null;
  }
}

