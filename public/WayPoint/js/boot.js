/* ---------- 25. Init ------------------------------------------------------------
   Restore whatever trip/tab the viewer was last looking at (stashed in
   sessionStorage right before a save-triggered reload), then draw the
   page for the first time. */

(async function init() {
  if (typeof ResizeObserver !== 'undefined') {
    var shellObserver = new ResizeObserver(updateStickyShellOffsets);
    shellObserver.observe(document.querySelector('.topbar'));
    shellObserver.observe(document.getElementById('system-banner'));
  }
  // Find out who (if anyone) is already logged in on this browser, then
  // hand off to renderBoot() to decide what to actually show — the login
  // screen, or (once state is loaded) the normal app. See section 4b,
  // "Auth", further up for both of these.
  await checkAuth();
  await renderBoot();
})();
