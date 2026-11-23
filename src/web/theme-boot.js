// Runs before first paint so a saved theme never flashes the wrong one. Dark is the default.
(function () {
  var saved = null;
  try { saved = localStorage.getItem("orch-theme"); } catch (e) { /* storage blocked: use the dark default */ }
  document.documentElement.setAttribute("data-theme", saved === "light" ? "light" : "dark");
})();
