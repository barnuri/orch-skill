/** Chat preferences that carry over from one chat to the next, kept in localStorage under one key. */
export const CHAT_PREFS_KEY: string = "orch.chat.prefs";

export interface ChatPrefs {
  /** The settings row above the composer (harness, profile, model, effort) is open. Closed by default. */
  settingsOpen: boolean;
}

export const DEFAULT_CHAT_PREFS: ChatPrefs = { settingsOpen: false };

type PrefStorage = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): PrefStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function readChatPrefs(storage: PrefStorage | null = defaultStorage()): ChatPrefs {
  if (storage === null) {
    return DEFAULT_CHAT_PREFS;
  }
  try {
    const parsed: unknown = JSON.parse(storage.getItem(CHAT_PREFS_KEY) ?? "null");
    if (typeof parsed === "object" && parsed !== null) {
      const open = (parsed as { settingsOpen?: unknown }).settingsOpen;
      return { settingsOpen: open === true };
    }
  } catch {
    // unreadable or blocked storage: use the defaults
  }
  return DEFAULT_CHAT_PREFS;
}

export function writeChatPrefs(prefs: ChatPrefs, storage: PrefStorage | null = defaultStorage()): void {
  if (storage === null) {
    return;
  }
  try {
    storage.setItem(CHAT_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // quota or privacy mode: the choice just does not persist
  }
}
