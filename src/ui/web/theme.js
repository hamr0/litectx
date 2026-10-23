// Theme (auto / light / dark) shared by the search page and the file viewer. Loaded in <head>, so the
// saved choice applies before first paint.
(function () {
  var t = null;
  try { t = localStorage.getItem("litectx-ui-theme"); } catch (e) { /* storage blocked: stay on auto */ }
  if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
  // viewer: scroll the highlighted range into view (the URL fragment does the same when present)
  document.addEventListener("DOMContentLoaded", function () {
    var on = document.querySelector(".ln.on");
    if (on && !location.hash) on.scrollIntoView({ block: "center" });
  });
})();
