// Runs before first paint so a saved or system theme never flashes the wrong one.
(function () {
  var saved = null;
  try { saved = localStorage.getItem("orch-theme"); } catch (e) { /* storage blocked: use the system theme */ }
  var theme = saved === "light" || saved === "dark" ? saved : (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  document.documentElement.setAttribute("data-theme", theme);
})();
