// Theme (auto / light / dark) shared by the search page and the file viewer. Loaded in <head>, so the
// saved choice applies before first paint.
(function () {
  var t = null;
  try { t = localStorage.getItem("litectx-ui-theme"); } catch (e) { /* storage blocked: stay on auto */ }
  if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
  // viewer: scroll the highlighted range into view (the URL fragment does the same when it names an element;
  // the formatted markdown view has no #L<n> ids, so a fragment that matches nothing falls through to here)
  document.addEventListener("DOMContentLoaded", function () {
    var on = document.querySelector(".ln.on, .blk.on");
    var h = location.hash.slice(1), named = false;
    try { named = !!h && !!document.getElementById(decodeURIComponent(h)); } catch (e) { /* bad escape: not a target */ }
    if (on && !named) on.scrollIntoView({ block: "center" });
  });
})();
