/** How the chat sidebar is shown on a wide screen, kept in localStorage under one key for all chats. */
export const SIDEBAR_MODE_KEY: string = "orch.chat.sidebar";

export type SidebarMode = "open" | "rail" | "hidden";

const MODES: readonly SidebarMode[] = ["open", "rail", "hidden"];

/** From this width the sidebar can collapse; below it the sidebar is the drawer (hamburger). */
export const SIDEBAR_WIDE_QUERY: string = "(min-width: 900px)";

type PrefStorage = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): PrefStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function readSidebarMode(storage: PrefStorage | null = defaultStorage()): SidebarMode {
  if (storage === null) {
    return "open";
  }
  try {
    const raw = storage.getItem(SIDEBAR_MODE_KEY);
    return MODES.find((m) => m === raw) ?? "open";
  } catch {
    return "open";
  }
}

export function writeSidebarMode(mode: SidebarMode, storage: PrefStorage | null = defaultStorage()): void {
  if (storage === null || !MODES.includes(mode)) {
    return;
  }
  try {
    storage.setItem(SIDEBAR_MODE_KEY, mode);
  } catch {
    // a blocked or full storage: the choice only lasts for this page
  }
}

/** Cmd or Ctrl+B, with no other modifier. */
export function isSidebarShortcut(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): boolean {
  return e.key.toLowerCase() === "b" && (e.metaKey !== e.ctrlKey) && !e.altKey && !e.shiftKey;
}

/** The shortcut: an open sidebar folds to the rail, a folded or hidden one opens. */
export function toggledMode(mode: SidebarMode): SidebarMode {
  return mode === "open" ? "rail" : "open";
}
