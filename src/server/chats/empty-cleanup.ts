import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ChatStore } from "./store";

/** The default title of a chat nobody has renamed. The start page now creates a chat only with its first message, so these rows are leftovers. */
const DEFAULT_TITLE = "New chat";
export const EMPTY_CLEANUP_AGE_MS = 10 * 60 * 1000;

export function emptyCleanupMarker(home: string): string {
  return join(home, "chats", ".empty-cleanup-v1");
}

/** Archives every active chat that has no message and no attachment, still has the default title and is older than 10 minutes. Never deletes a row. */
export function archiveEmptyDefaultChats(store: ChatStore, nowMs: number = Date.now()): number {
  const cutoff = new Date(nowMs - EMPTY_CLEANUP_AGE_MS).toISOString();
  let archived = 0;
  let cursor: string | null = null;
  for (;;) {
    const page = store.listChats({ archived: false, limit: 100, cursor });
    for (const chat of page.items) {
      if (chat.title === DEFAULT_TITLE && chat.title_manual !== 1 && chat.status === "idle" && chat.created_at < cutoff && store.chatIsEmpty(chat.id)) {
        store.setChatArchived(chat.id, true);
        archived += 1;
      }
    }
    if (page.next_cursor === null) {
      return archived;
    }
    cursor = page.next_cursor;
  }
}

/** Runs the cleanup once per home: a marker file records that it ran. Returns how many chats it archived (0 when it already ran). */
export function runEmptyCleanupOnce(store: ChatStore, home: string, nowMs: number = Date.now()): number {
  const marker = emptyCleanupMarker(home);
  if (existsSync(marker)) {
    return 0;
  }
  const archived = archiveEmptyDefaultChats(store, nowMs);
  mkdirSync(dirname(marker), { recursive: true });
  writeFileSync(marker, `${new Date(nowMs).toISOString()}\n`);
  return archived;
}
