import {
  GRAPH_ACTIVITY_EXPANDED_KEY,
  GRAPH_FOLLOW_KEY,
  GRAPH_HIDE_DONE_KEY,
  GRAPH_MODE_KEY,
  GRAPH_SCALE_KEY,
  ZOOM_MAX,
  ZOOM_MIN,
} from "./constants";

/** How the run graph is sized: fitted to the screen, at 100%, or at the user's own zoom. */
export type GraphViewMode = "fit" | "original" | "manual";

/** The run-page toggles that carry over from one run to the next, for all runs. */
export interface GraphPrefs {
  follow: boolean;
  hideDone: boolean;
  /** Zoom scale factor, clamped to ZOOM_MIN..ZOOM_MAX. */
  scale: number;
  mode: GraphViewMode;
  /** The activity list shows every row instead of the preview. */
  activityExpanded: boolean;
}

export const DEFAULT_GRAPH_PREFS: GraphPrefs = {
  follow: true,
  hideDone: false,
  scale: 1,
  mode: "fit",
  activityExpanded: false,
};

type PrefStorage = Pick<Storage, "getItem" | "setItem">;

const VIEW_MODES: readonly GraphViewMode[] = ["fit", "original", "manual"];

export const clampZoom = (scale: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale));

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

/** A finite number, clamped to the zoom bounds; anything else falls back. */
function readScale(storage: PrefStorage, fallback: number): number {
  try {
    const raw = storage.getItem(GRAPH_SCALE_KEY);
    if (raw === null || raw.trim() === "") {
      return fallback;
    }
    const value = Number(raw);
    return Number.isFinite(value) ? clampZoom(value) : fallback;
  } catch {
    return fallback;
  }
}

function readMode(storage: PrefStorage, fallback: GraphViewMode): GraphViewMode {
  try {
    const raw = storage.getItem(GRAPH_MODE_KEY);
    return VIEW_MODES.find((mode) => mode === raw) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeValue(storage: PrefStorage, key: string, value: string): void {
  try {
    storage.setItem(key, value);
  } catch {
    // A blocked or full localStorage must not break the control for the session.
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
    scale: readScale(storage, DEFAULT_GRAPH_PREFS.scale),
    mode: readMode(storage, DEFAULT_GRAPH_PREFS.mode),
    activityExpanded: readFlag(storage, GRAPH_ACTIVITY_EXPANDED_KEY, DEFAULT_GRAPH_PREFS.activityExpanded),
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

export function saveGraphScale(scale: number, storage: PrefStorage | null = defaultStorage()): void {
  if (storage !== null && Number.isFinite(scale)) {
    writeValue(storage, GRAPH_SCALE_KEY, String(clampZoom(scale)));
  }
}

export function saveGraphMode(mode: GraphViewMode, storage: PrefStorage | null = defaultStorage()): void {
  if (storage !== null && VIEW_MODES.includes(mode)) {
    writeValue(storage, GRAPH_MODE_KEY, mode);
  }
}

export function saveGraphActivityExpanded(expanded: boolean, storage: PrefStorage | null = defaultStorage()): void {
  if (storage !== null) {
    writeFlag(storage, GRAPH_ACTIVITY_EXPANDED_KEY, expanded);
  }
}
