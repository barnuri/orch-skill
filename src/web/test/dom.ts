import { Window } from "happy-dom";

const KEYS = ["window", "document", "navigator", "localStorage", "HTMLElement", "HTMLDialogElement", "Node", "Element", "MutationObserver", "Event", "KeyboardEvent", "MouseEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const;

let installed = false;

/**
 * Installs one happy-dom window per process. Modules such as @testing-library bind to the first
 * document they see and stay cached across test files, so the window is never torn down; the
 * returned function is a no-op kept for the existing afterAll hooks.
 */
export function installDom(): () => void {
  if (installed) return () => {};
  installed = true;
  const win = new Window({ url: "http://localhost/" });
  const g = globalThis as Record<string, unknown>;
  for (const key of KEYS) {
    Object.defineProperty(g, key, { value: (win as unknown as Record<string, unknown>)[key], configurable: true, writable: true });
  }
  g["IS_REACT_ACT_ENVIRONMENT"] = true;
  return () => {};
}
