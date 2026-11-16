import { GRAPH_FOLLOW_KEY, GRAPH_HIDE_DONE_KEY } from "./constants";

/** The run-graph toggles that carry over from one run to the next. */
export interface GraphPrefs {
  follow: boolean;
  hideDone: boolean;
}

export const DEFAULT_GRAPH_PREFS: GraphPrefs = { follow: true, hideDone: false };

type PrefStorage = Pick<Storage, "getItem" | "setItem">;

function readFlag(storage: PrefStorage, key: string, fallback: boolean): boolean {
  try {
    const raw = storage.getItem(key);
    return raw === "1" ? true : raw === "0" ? false : fallback;
  } catch {
    return fallback;
  }
}

function writeFlag(storage: PrefStorage, key: string, value: boolean): void {
  try {
    storage.setItem(key, value ? "1" : "0");
  } catch {
    // A blocked or full localStorage must not break the toggle for the session.
  }
}

function defaultStorage(): PrefStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Unset or unreadable values fall back to the default, field by field. */
export function loadGraphPrefs(storage: PrefStorage | null = defaultStorage()): GraphPrefs {
  if (storage === null) {
    return { ...DEFAULT_GRAPH_PREFS };
  }
  return {
    follow: readFlag(storage, GRAPH_FOLLOW_KEY, DEFAULT_GRAPH_PREFS.follow),
    hideDone: readFlag(storage, GRAPH_HIDE_DONE_KEY, DEFAULT_GRAPH_PREFS.hideDone),
  };
}

export function saveGraphFollow(follow: boolean, storage: PrefStorage | null = defaultStorage()): void {
  if (storage !== null) {
    writeFlag(storage, GRAPH_FOLLOW_KEY, follow);
  }
}

export function saveGraphHideDone(hideDone: boolean, storage: PrefStorage | null = defaultStorage()): void {
  if (storage !== null) {
    writeFlag(storage, GRAPH_HIDE_DONE_KEY, hideDone);
  }
}
