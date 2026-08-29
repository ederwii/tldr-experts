/**
 * The dashboard's entire script, inlined.
 *
 * Read-only by construction: it filters what is already on the page and does
 * nothing else. No fetch, no storage, no buttons that act — the concept is
 * explicit that the dashboard watches and never launches (§12).
 */
export const DASHBOARD_JS = `
(function () {
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
})();
`.trim();
