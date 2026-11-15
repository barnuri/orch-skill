(function () {
  var q = new URLSearchParams(location.search).get("theme");
  document.documentElement.setAttribute("data-theme", q === "light" ? "light" : "dark");
})();
