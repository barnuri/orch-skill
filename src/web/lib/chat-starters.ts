/** The starter chips on the empty start page. The person can edit them; they live in localStorage under one key. */
export const STARTERS_KEY: string = "orch.chat.starters";

export const DEFAULT_STARTERS: readonly string[] = [
  "Explain how this project is organised",
  "Find and fix a bug in the code I point you to",
  "Review my latest changes and list what to improve",
  "Write a plan for the feature I describe next",
];

export const MAX_STARTERS = 4;
const MAX_LEN = 200;

type PrefStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStorage(): PrefStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function cleanStarters(list: readonly unknown[]): string[] {
  return list
    .filter((s): s is string => typeof s === "string")
    .map((s) => s.trim().slice(0, MAX_LEN))
    .filter((s) => s !== "")
    .slice(0, MAX_STARTERS);
}

export function readStarters(storage: PrefStorage | null = defaultStorage()): string[] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(STARTERS_KEY) ?? "null");
    if (Array.isArray(parsed)) {
      const list = cleanStarters(parsed);
      if (list.length > 0) {
        return list;
      }
    }
  } catch {
    // unreadable storage: the defaults
  }
  return [...DEFAULT_STARTERS];
}

/** An empty list resets to the defaults. */
export function writeStarters(list: readonly string[], storage: PrefStorage | null = defaultStorage()): void {
  try {
    const clean = cleanStarters(list);
    if (clean.length === 0) {
      storage?.removeItem(STARTERS_KEY);
    } else {
      storage?.setItem(STARTERS_KEY, JSON.stringify(clean));
    }
  } catch {
    // a blocked or full storage: the edit only lasts for this page
  }
}
