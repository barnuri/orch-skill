import { DRAFT_PREFIX, loadDraft } from "./chat-logic";

/** A first message that is not sent yet, per project (`none` without one). Stored in localStorage; no chat exists for it. */
export const NEW_DRAFT_PREFIX: string = `${DRAFT_PREFIX}new:`;
export const DRAFT_EVENT: string = "orch-chat-draft";
export const NO_PROJECT_SCOPE: string = "none";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const draftScope = (projectId: string | null): string => projectId === null || projectId === "" ? NO_PROJECT_SCOPE : projectId;

/** The id the composer saves the draft under: its key is `DRAFT_PREFIX + id`. */
export const draftChatId = (scope: string): string => `new:${scope}`;

function defaultStore(): Store | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function announce(): void {
  try {
    window.dispatchEvent(new Event(DRAFT_EVENT));
  } catch {
    // no window (server render): nobody listens
  }
}

/**
 * A storage for the composer that keeps the text only. A file picked on the start page is held in memory and is gone after a
 * reload, so a restored draft must not list it. Every write tells the sidebar to re-read the draft hints.
 */
export function textOnlyStorage(base: Store | null = defaultStore()): Store {
  return {
    getItem: (key) => base?.getItem(key) ?? null,
    setItem: (key, value) => {
      let out = value;
      try {
        const parsed = JSON.parse(value) as { text?: unknown };
        out = JSON.stringify({ text: typeof parsed.text === "string" ? parsed.text : "", attachments: [] });
      } catch {
        // keep as is
      }
      try {
        base?.setItem(key, out);
      } catch {
        // storage full or blocked: a draft is a convenience
      }
      announce();
    },
    removeItem: (key) => {
      try {
        base?.removeItem(key);
      } catch {
        // ignore
      }
      announce();
    },
  };
}

export function draftText(scope: string, store: Store | null = defaultStore()): string {
  return store === null ? "" : loadDraft(store, draftChatId(scope)).text;
}

export function setDraftText(scope: string, text: string, store: Store | null = defaultStore()): void {
  if (store === null) {
    return;
  }
  try {
    if (text === "") {
      store.removeItem(DRAFT_PREFIX + draftChatId(scope));
    } else {
      store.setItem(DRAFT_PREFIX + draftChatId(scope), JSON.stringify({ text, attachments: [] }));
    }
  } catch {
    // ignore
  }
  announce();
}

export function clearDraft(scope: string, store: Store | null = defaultStore()): void {
  setDraftText(scope, "", store);
}

/** Moves a draft to another project's scope (the project picker on the start page); the target is replaced. */
export function moveDraft(from: string, to: string, store: Store | null = defaultStore()): void {
  if (from === to) {
    return;
  }
  const text = draftText(from, store);
  clearDraft(from, store);
  setDraftText(to, text, store);
}

/** Scopes that hold unsent text. */
export function draftScopes(store: Store | null = defaultStore()): string[] {
  const out: string[] = [];
  try {
    const s = store as Storage | null;
    if (s === null || typeof s.length !== "number") {
      return out;
    }
    for (let i = 0; i < s.length; i += 1) {
      const key = s.key(i);
      if (key !== null && key.startsWith(NEW_DRAFT_PREFIX)) {
        const scope = key.slice(NEW_DRAFT_PREFIX.length);
        if (draftText(scope, s).trim() !== "") {
          out.push(scope);
        }
      }
    }
  } catch {
    // unreadable storage: no hints
  }
  return out;
}
