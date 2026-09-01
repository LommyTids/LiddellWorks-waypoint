/* WayPoint icon system -------------------------------------------------
   A deliberately small, local SVG registry keeps the private app free of
   icon-font/CDN dependencies. Every glyph shares a 24px coordinate grid,
   rounded geometry and the same optical stroke weight. Application code uses
   semantic names ("destination", "stay", "action.edit") so artwork can be
   refined later without changing every caller. */
(function (global) {
  'use strict';

  var GLYPHS = {
    brand: '<circle cx="12" cy="12" r="9"/><path d="m15 9-2 6-6 2 2-6 6-2Z"/>',
    destination: '<path d="M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>',
    activity: '<path d="M2 9a3 3 0 0 0 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 0 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M13 5v2M13 17v2M13 11v2"/>',
    route: '<circle cx="6" cy="19" r="3"/><path d="M9 19h4.5a4.5 4.5 0 0 0 0-9H11a4 4 0 0 1 0-8h5"/><circle cx="18" cy="2" r="2"/>',
    flight: '<path d="M22 2 9.5 14.5"/><path d="m22 2-7 20-4-9-9-4 20-7Z"/>',
    rail: '<rect width="16" height="16" x="4" y="3" rx="2"/><path d="M4 11h16M8 19l-2 3M16 19l2 3M8 7h.01M16 7h.01"/>',
    bus: '<path d="M8 6v6M16 6v6M2 12h20M7 18h10M18 21l2-3V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v12l2 3"/><circle cx="7" cy="16" r="1"/><circle cx="17" cy="16" r="1"/>',
    car: '<path d="m5 17-2-1V9l2-4h14l2 4v7l-2 1"/><path d="M5 9h14M7 17v2M17 17v2"/><circle cx="7.5" cy="13" r="1"/><circle cx="16.5" cy="13" r="1"/>',
    ferry: '<path d="M4 16 6 6h12l2 10M12 6V2M9 2h6M3 20c1.5 1 3 1 4.5 0s3-1 4.5 0 3 1 4.5 0 3-1 4.5 0"/><path d="M5 16h14"/>',
    stay: '<path d="M2 20v-9a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v9M2 17h20M6 9V5h5a3 3 0 0 1 3 3v1"/>',
    person: '<circle cx="12" cy="8" r="4"/><path d="M4 22a8 8 0 0 1 16 0"/>',
    contacts: '<path d="M16 2v4M8 2v4M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/><circle cx="12" cy="11" r="2.5"/><path d="M7.5 19a4.5 4.5 0 0 1 9 0"/>',
    companions: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    expenses: '<path d="M20 7V5a2 2 0 0 0-2-2H5a3 3 0 0 0 0 6h15v12H5a3 3 0 0 1-3-3V6"/><path d="M16 13h4"/>',
    receipt: '<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1-2-1Z"/><path d="M16 8h-6M16 12h-6M13 16h-3"/>',
    booking: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>',
    overnight: '<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z"/>',
    points: '<path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8-6.2-3.2L5.8 21 7 14.2 2 9.3l6.9-1L12 2Z"/>',
    timeline: '<rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"/>',
    date: '<rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    time: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    map: '<path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3Z"/><path d="M9 3v15M15 6v15"/>',
    settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.51a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z"/><circle cx="12" cy="12" r="3"/>',
    add: '<path d="M12 5v14M5 12h14"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    delete: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 16H6L5 6M10 11v6M14 11v6"/>',
    close: '<path d="m18 6-12 12M6 6l12 12"/>',
    forward: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    back: '<path d="m15 18-6-6 6-6"/>',
    download: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M16 8V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4"/>',
    expand: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
    collapse: '<path d="m6 9 6 6 6-6"/>',
    unknown: '<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 1 1 5.8 1c0 2-3 2-3 4M12 18h.01"/>'
  };

  // Compatibility aliases let older stored/rendering paths migrate safely;
  // new UI code should always request the semantic name on the left above.
  var ALIASES = {
    pin: 'destination', ticket: 'activity', plane: 'flight', train: 'rail',
    bed: 'stay', user: 'person', users: 'contacts', companion: 'companions',
    wallet: 'expenses', moon: 'overnight', star: 'points', calendar: 'timeline',
    clock: 'time', gear: 'settings', compass: 'brand', plus: 'add', trash: 'delete',
    arrowRight: 'forward'
  };
  var warned = {};

  function resolve(name) {
    return ALIASES[name] || name;
  }

  function render(name, extraClass) {
    var resolved = resolve(name);
    if (!GLYPHS[resolved]) {
      if (!warned[name] && global.console && global.console.warn) {
        global.console.warn('WayPoint icon not found:', name);
        warned[name] = true;
      }
      resolved = 'unknown';
    }
    // Class input is developer-authored, but still restricted so the helper
    // cannot accidentally become an HTML-attribute injection surface.
    var safeClass = String(extraClass || '').replace(/[^A-Za-z0-9_-\s]/g, '');
    return '<svg class="icon' + (safeClass ? ' ' + safeClass : '') + '" data-icon="' + resolved + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + GLYPHS[resolved] + '</svg>';
  }

  global.WayPointIcons = { render: render, resolve: resolve, names: Object.keys(GLYPHS) };
})(window);
