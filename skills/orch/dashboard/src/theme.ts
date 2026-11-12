import { THEME_KEY } from "./constants";

type Theme = "dark" | "light";

const THEME_ATTR: string = "data-theme";

function applyTheme(theme: Theme, button: HTMLButtonElement): void {
  document.documentElement.setAttribute(THEME_ATTR, theme);
  button.setAttribute("aria-label", theme === "dark" ? "Switch to light mode" : "Switch to dark mode");
  // The icon shows the theme a click switches to. Toggled by attribute, not by a theme selector.
  const sun = button.querySelector<SVGElement>(".icon-sun");
  const moon = button.querySelector<SVGElement>(".icon-moon");
  sun?.toggleAttribute("hidden", theme !== "dark");
  moon?.toggleAttribute("hidden", theme !== "light");
}

// With no saved choice the OS decides (theme-boot.js set the attribute before first paint).
function storedOrSystem(): Theme {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === "light" || saved === "dark") {
    return saved;
  }
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function applyStoredTheme(button: HTMLButtonElement): void {
  applyTheme(storedOrSystem(), button);
}

export function toggleTheme(button: HTMLButtonElement): void {
  const next: Theme = document.documentElement.getAttribute(THEME_ATTR) === "dark" ? "light" : "dark";
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next, button);
}
