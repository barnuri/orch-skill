import { THEME_KEY } from "./constants";

type Theme = "dark" | "light";

const THEME_ATTR: string = "data-theme";

function applyTheme(theme: Theme, button: HTMLButtonElement): void {
  document.documentElement.setAttribute(THEME_ATTR, theme);
  button.setAttribute("aria-label", theme === "dark" ? "Switch to light mode" : "Switch to dark mode");
}

// Dark is the default; only an explicit "light" choice is persisted and honoured.
export function applyStoredTheme(button: HTMLButtonElement): void {
  applyTheme(localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark", button);
}

export function toggleTheme(button: HTMLButtonElement): void {
  const next: Theme = document.documentElement.getAttribute(THEME_ATTR) === "dark" ? "light" : "dark";
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next, button);
}
