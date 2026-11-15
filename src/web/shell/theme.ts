import { useCallback, useState } from "react";
import { THEME_KEY } from "../lib/constants";

export type Theme = "dark" | "light";

const THEME_ATTR = "data-theme";

// With no saved choice the OS decides (theme-boot.js set the attribute before first paint).
export function storedOrSystem(): Theme {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(THEME_KEY);
  } catch {
    saved = null;
  }
  if (saved === "light" || saved === "dark") {
    return saved;
  }
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function currentTheme(): Theme {
  const attr = document.documentElement.getAttribute(THEME_ATTR);
  return attr === "light" || attr === "dark" ? attr : storedOrSystem();
}

export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(currentTheme);
  const toggle = useCallback(() => {
    const next: Theme = currentTheme() === "dark" ? "light" : "dark";
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Blocked storage: the choice still applies for this page view.
    }
    document.documentElement.setAttribute(THEME_ATTR, next);
    setTheme(next);
  }, []);
  return { theme, toggle };
}
