import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { newId } from "./ids";
import { MIGRATIONS } from "./migrations";
import { ChatStore, ftsQuery } from "./store";

const dir = mkdtempSync(join(tmpdir(), "chat-store-"));
afterAll(() => Bun.spawnSync(["trash", dir]));

describe("ids", () => {
  test("sort in creation order, also within one millisecond", () => {
    const ids = Array.from({ length: 500 }, () => newId("msg", 1_700_000_000_000));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(500);
  });
});

describe("migrations", () => {
  test("run once and reopening keeps the data", () => {
    const path = join(dir, "a.db");
    const first = new ChatStore(path);
    expect(first.schemaVersion()).toBe(MIGRATIONS.length);
    const project = first.createProject({ name: "p" });
    first.close();
    const second = new ChatStore(path);
    expect(second.schemaVersion()).toBe(MIGRATIONS.length);
    expect(second.getProject(project.id)?.name).toBe("p");
    second.close();
  });
});

describe("history", () => {
  const store = new ChatStore(join(dir, "b.db"));
  const chat = store.createChat({ title: "t", harness: "claude", profile: "p" });

  test("the store has no delete: archiving hides, data stays", () => {
    const msg = store.addMessage({ chat_id: chat.id, role: "user", content: "keep me", status: "done" });
    store.setChatArchived(chat.id, true);
    expect(store.listChats({}).items.map((c) => c.id)).not.toContain(chat.id);
    expect(store.listChats({ archived: true }).items.map((c) => c.id)).toContain(chat.id);
    expect(store.getMessage(msg.id)?.content).toBe("keep me");
    expect(Object.getOwnPropertyNames(ChatStore.prototype).filter((n) => /delete|remove|prune/i.test(n))).toEqual([]);
    store.setChatArchived(chat.id, false);
  });

  test("messages page newest first by cursor without gaps or repeats", () => {
    const c = store.createChat({ title: "paged", harness: "claude", profile: "p" });
    const ids = Array.from({ length: 7 }, (_, i) => store.addMessage({ chat_id: c.id, role: "user", content: `m${i}`, status: "done" }).id);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = store.listMessages(c.id, { limit: 3, cursor });
      seen.push(...page.items.map((m) => m.id));
      cursor = page.next_cursor;
    } while (cursor !== null);
    expect(seen).toEqual([...ids].reverse());
  });

  test("chats order by last activity and page by cursor", () => {
    const s = new ChatStore(":memory:");
    const a = s.createChat({ title: "a", harness: "h", profile: "p" });
    const b = s.createChat({ title: "b", harness: "h", profile: "p" });
    const c = s.createChat({ title: "c", harness: "h", profile: "p" });
    Bun.sleepSync(3);
    s.updateChat(a.id, { title: "a2" });
    const first = s.listChats({ limit: 2 });
    expect(first.items.map((x) => x.id)).toEqual([a.id, c.id]);
    expect(s.listChats({ limit: 2, cursor: first.next_cursor }).items.map((x) => x.id)).toEqual([b.id]);
  });

  test("project filter, including chats without a project", () => {
    const s = new ChatStore(":memory:");
    const p = s.createProject({ name: "p" });
    const inP = s.createChat({ title: "in", harness: "h", profile: "p", project_id: p.id });
    const out = s.createChat({ title: "out", harness: "h", profile: "p" });
    expect(s.listChats({ projectId: p.id }).items.map((x) => x.id)).toEqual([inP.id]);
    expect(s.listChats({ projectId: "none" }).items.map((x) => x.id)).toEqual([out.id]);
  });

  test("streamed content appends; recovery marks a hanging message as interrupted and keeps what is in `keep`", () => {
    const s = new ChatStore(":memory:");
    const c = s.createChat({ title: "x", harness: "h", profile: "p" });
    s.updateChat(c.id, { status: "running" });
    const m = s.addMessage({ chat_id: c.id, role: "assistant", status: "streaming" });
    s.appendContent(m.id, "par");
    s.appendContent(m.id, "tial");
    expect(s.recoverStreaming()).toBe(1);
    const row = s.getMessage(m.id);
    expect([row?.content, row?.status, row?.error?.startsWith("interrupted:")]).toEqual(["partial", "error", true]);
    expect(s.getChat(c.id)?.status).toBe("idle");
    expect(s.recoverStreaming()).toBe(0);
  });
});

describe("search", () => {
  const s = new ChatStore(":memory:");
  const c = s.createChat({ title: "Kubernetes talk", harness: "h", profile: "p" });
  s.addMessage({ chat_id: c.id, role: "user", content: "How do I restart a deployment in kubernetes?", status: "done" });
  s.addMessage({ chat_id: c.id, role: "assistant", content: "Use rollout restart.", status: "done" });
  const streaming = s.addMessage({ chat_id: c.id, role: "assistant", status: "streaming" });
  s.appendContent(streaming.id, "unfinished zebra");

  test("finds words and prefixes, with a snippet", () => {
    const hits = s.search("kuber", {});
    expect(hits).toHaveLength(1);
    expect(hits[0]?.snippet).toContain("[[kubernetes]]");
    expect(hits[0]?.chat_title).toBe("Kubernetes talk");
    expect(s.search("rollout restart", {})).toHaveLength(1);
  });

  test("punctuation cannot break the query", () => {
    expect(() => s.search('"deploy*" OR (', {})).not.toThrow();
    expect(ftsQuery("   ")).toBeNull();
    expect(s.search("???", {})).toEqual([]);
  });

  test("a streaming message is indexed once it is final", () => {
    expect(s.search("zebra", {})).toHaveLength(0);
    s.finalizeMessage(streaming.id, { status: "done" });
    expect(s.search("zebra", {})).toHaveLength(1);
  });

  test("project filter", () => {
    expect(s.search("kubernetes", { projectId: "prj-none" })).toEqual([]);
  });
});
