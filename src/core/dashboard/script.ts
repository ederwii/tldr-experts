/**
 * The dashboard's scripts, inlined. Two of them, and both are read-only.
 *
 * `DASHBOARD_JS` ships in every page, static export included: it filters what is
 * already on the screen and does nothing else. No fetch, no storage, no button
 * that acts — the concept is explicit that the dashboard watches and never
 * launches (§12). It is a named function rather than an IIFE because the live
 * page replaces the markup and has to wire the filter up again.
 *
 * `liveScript()` ships only when the watching server serves the page. It listens
 * on the server's `/events` stream, re-fetches `/model.json` when a file under
 * `.tldrx/` or `tldrx-work/` changes, and re-renders with the SAME template
 * functions the server used (`clientRenderer()` in `render.ts`). Its only two
 * network calls are same-origin, relative, and both are GETs.
 */
export const DASHBOARD_JS = `
function tldrxWireFilter() {
  var box = document.getElementById('run-filter');
  if (!box) return;
  box.addEventListener('input', function () {
    var needle = box.value.trim().toLowerCase();
    var rows = document.querySelectorAll('[data-run-row]');
    for (var i = 0; i < rows.length; i++) {
      var haystack = (rows[i].getAttribute('data-run-row') || '').toLowerCase();
      rows[i].classList.toggle('hidden', needle !== '' && haystack.indexOf(needle) === -1);
    }
  });
}
tldrxWireFilter();
`.trim();

/** Path constants the server and the live page must agree on. */
export const MODEL_PATH = "/model.json";
export const EVENTS_PATH = "/events";
export const RELOAD_EVENT = "reload";

export function liveScript(appElementId = "app"): string {
  return `
(function () {
  var app = document.getElementById(${JSON.stringify(appElementId)});
  if (!app || typeof EventSource === 'undefined') return;
  var busy = false;

  function repaint() {
    if (busy) return;
    busy = true;
    fetch(${JSON.stringify(MODEL_PATH)}, { cache: 'no-store' })
      .then(function (response) { return response.json(); })
      .then(function (model) {
        app.innerHTML = dashApp(model);
        document.title = dashTitle(model);
        tldrxWireFilter();
      })
      .catch(function () { /* the server went away; EventSource will reconnect */ })
      .then(function () { busy = false; });
  }

  var stream = new EventSource(${JSON.stringify(EVENTS_PATH)});
  stream.addEventListener(${JSON.stringify(RELOAD_EVENT)}, repaint);
  window.addEventListener('beforeunload', function () { stream.close(); });
})();
`.trim();
}
