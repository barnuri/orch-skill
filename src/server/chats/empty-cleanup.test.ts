import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./store";
import { archiveEmptyDefaultChats, emptyCleanupMarker, runEmptyCleanupOnce } from "./empty-cleanup";

const stores: ChatStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) {
    s.close();
  }
});

const MIN = 60_000;
function setup() {
  const home = mkdtempSync(join(tmpdir(), "orch-empty-"));
  const store = new ChatStore(":memory:");
  stores.push(store);
  const make = (over: { title?: string; manual?: boolean; ageMin?: number } = {}) => {
    const chat = store.createChat({ title: over.title ?? "New chat", harness: "claude", profile: "main", title_manual: over.manual === true });
    return { chat, ageMin: over.ageMin ?? 30 };
  };
  const age = (id: string, min: number): void => {
    const at = new Date(Date.now() - min * MIN).toISOString();
    (store as unknown as { db: { query: (s: string) => { run: (...a: unknown[]) => void } } }).db.query("UPDATE chats SET created_at = ? WHERE id = ?").run(at, id);
  };
  return { home, store, make, age };
}
const archived = (store: ChatStore, id: string): boolean => store.getChat(id)?.archived_at != null;

describe("one-time cleanup of empty New chat rows", () => {
  test("archives empty default-titled chats older than 10 minutes, keeps everything else, deletes nothing", () => {
    const { store, make, age } = setup();
    const old = make().chat;
    const young = make().chat;
    const renamed = make({ title: "Mine", manual: true }).chat;
    const customEmpty = make({ title: "Plan" }).chat;
    const used = make().chat;
    store.addMessage({ chat_id: used.id, role: "user", content: "hi", status: "done" });
    for (const c of [old, renamed, customEmpty, used]) {
      age(c.id, 30);
    }
    age(young.id, 5);
    expect(archiveEmptyDefaultChats(store)).toBe(1);
    expect(archived(store, old.id)).toBe(true);
    expect(archived(store, young.id)).toBe(false);
    expect(archived(store, renamed.id)).toBe(false);
    expect(archived(store, customEmpty.id)).toBe(false);
    expect(archived(store, used.id)).toBe(false);
    expect(store.getChat(old.id)).not.toBeNull();
  });

  test("runs once per home: a marker file stops the second run", () => {
    const { home, store, make, age } = setup();
    const a = make().chat;
    age(a.id, 30);
    expect(existsSync(emptyCleanupMarker(home))).toBe(false);
    expect(runEmptyCleanupOnce(store, home)).toBe(1);
    expect(existsSync(emptyCleanupMarker(home))).toBe(true);
    const b = make().chat;
    age(b.id, 30);
    expect(runEmptyCleanupOnce(store, home)).toBe(0);
    expect(archived(store, b.id)).toBe(false);
  });

  test("handles more chats than one page", () => {
    const { store, make, age } = setup();
    const ids = Array.from({ length: 130 }, () => make().chat.id);
    for (const id of ids) {
      age(id, 20);
    }
    expect(archiveEmptyDefaultChats(store)).toBe(130);
  });
});
