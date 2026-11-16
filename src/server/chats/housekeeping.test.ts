import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";

import { digestToken } from "../http/auth";
import { orchPaths } from "../files/paths";
import { startTestServer } from "../test-support/test-server";
import { TempHome } from "../test-support/temp-home";
import type { ServerContext } from "../types/server-context";
import type { TestServerHandle } from "../types/test-server-handle";
import { ChatService } from "./service";
import { blobPath, deleteUnattached, sweepUnattached } from "./uploads";

const FAKE_CLAUDE = resolve(import.meta.dir, "testing/fake-claude.ts");
const PROFILES = { models: { "m-a": { slug: "alpha", harnesses: ["claude"] } }, profiles: { main: { harness: "claude", model: "m-a" } } };
const DAY = 24 * 60 * 60 * 1000;

const servers: TestServerHandle[] = [];
const services: ChatService[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.stop();
  }
  for (const s of services.splice(0)) {
    await s.dispose();
  }
  delete process.env.ORCH_CHAT_CLAUDE_BIN;
});

function service(): { svc: ChatService; home: string } {
  const home = TempHome.create();
  home.write("profiles.json", JSON.stringify(PROFILES));
  const ctx: ServerContext = {
    paths: orchPaths(home.path), bindHost: "127.0.0.1", hostname: hostname(), tokenDigest: digestToken("t"), requireToken: true,
    requireRemoteToken: true, harnesses: ["claude"], outcomes: [],
  };
  const svc = new ChatService(ctx);
  services.push(svc);
  return { svc, home: home.path };
}

const backdate = (svc: ChatService, table: "attachments" | "chats", id: string, ms: number): void => {
  (svc.store as unknown as { db: { query: (s: string) => { run: (...a: unknown[]) => void } } }).db
    .query(`UPDATE ${table} SET created_at = ? WHERE id = ?`).run(new Date(Date.now() - ms).toISOString(), id);
};

function attach(svc: ChatService, home: string, chatId: string, sha: string, name: string) {
  const row = svc.store.addAttachment({ chat_id: chatId, filename: name, mime: "text/plain", size: 1, sha256: sha, rel_path: `chats/files/${sha.slice(0, 2)}/${sha}` });
  return row;
}

describe("DELETE of an unsent upload (POST /api/attachments/{id}/delete)", () => {
  test("200 removes row and file; shared content stays until the last row goes; 404 and 409", async () => {
    process.env.ORCH_CHAT_CLAUDE_BIN = FAKE_CLAUDE;
    const srv = startTestServer();
    servers.push(srv);
    srv.home.write("profiles.json", JSON.stringify(PROFILES));
    const chat = (await (await srv.api("/api/chats", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ harness: "claude", profile: "main" }) })).json()) as { id: string };
    const upload = async (): Promise<{ id: string }> => {
      const res = await srv.api(`/api/chats/${chat.id}/attachments`, { method: "POST", body: "same bytes", headers: { "X-Filename": "a.txt" } });
      return ((await res.json()) as { items: Array<{ id: string }> }).items[0] as { id: string };
    };
    const a = await upload();
    const b = await upload();
    const del = (id: string): Promise<Response> => srv.api(`/api/attachments/${id}/delete`, { method: "POST" });
    expect((await del(a.id)).status).toBe(200);
    expect((await srv.api(`/api/attachments/${a.id}`)).status).toBe(404);
    expect(await (await srv.api(`/api/attachments/${b.id}`)).text()).toBe("same bytes");
    expect((await del(a.id)).status).toBe(404);
    const sent = await srv.api(`/api/chats/${chat.id}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "hi", attachment_ids: [b.id] }) });
    expect(sent.status).toBe(202);
    const refused = await del(b.id);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toContain("belongs to a message");
    expect((await srv.api(`/api/attachments/${b.id}`)).status).toBe(200);
    expect((await srv.api(`/api/attachments/${a.id}/delete`, {}, false)).status).toBe(401);
    expect((await srv.api(`/api/attachments/${a.id}/delete`)).status).toBe(405);
  });

  test("the blob file is removed with its last row", () => {
    const { svc, home } = service();
    const chat = svc.createChat({ harness: "claude", profile: "main" });
    const sha = "ab".repeat(32);
    const one = attach(svc, home, chat.id, sha, "x.txt");
    const two = attach(svc, home, chat.id, sha, "y.txt");
    const file = blobPath(home, sha);
    return Bun.write(file, "x").then(() => {
      expect(deleteUnattached(svc.store, home, one.id)).toBe(true);
      expect(existsSync(file)).toBe(true);
      expect(deleteUnattached(svc.store, home, two.id)).toBe(true);
      expect(existsSync(file)).toBe(false);
    });
  });
});

describe("startup sweep", () => {
  test("removes unattached uploads older than 24 hours only", () => {
    const { svc, home } = service();
    const chat = svc.createChat({ harness: "claude", profile: "main" });
    const old = attach(svc, home, chat.id, "cd".repeat(32), "old.txt");
    const fresh = attach(svc, home, chat.id, "ef".repeat(32), "fresh.txt");
    const sentRow = attach(svc, home, chat.id, "01".repeat(32), "sent.txt");
    const msg = svc.store.addMessage({ chat_id: chat.id, role: "user", content: "x", status: "done" });
    svc.store.linkAttachments([sentRow.id], msg.id);
    backdate(svc, "attachments", old.id, 25 * 60 * 60 * 1000);
    backdate(svc, "attachments", sentRow.id, 30 * DAY);
    expect(sweepUnattached(svc.store, home)).toBe(1);
    expect(svc.store.getAttachment(old.id)).toBeNull();
    expect(svc.store.getAttachment(fresh.id)).not.toBeNull();
    expect(svc.store.getAttachment(sentRow.id)).not.toBeNull();
  });

  test("the service constructor runs it and archives empty chats older than 24 hours", async () => {
    const first = service();
    const empty = first.svc.createChat({ harness: "claude", profile: "main" });
    const young = first.svc.createChat({ harness: "claude", profile: "main" });
    const used = first.svc.createChat({ harness: "claude", profile: "main" });
    first.svc.store.addMessage({ chat_id: used.id, role: "user", content: "x", status: "done" });
    const withFile = first.svc.createChat({ harness: "claude", profile: "main" });
    attach(first.svc, first.home, withFile.id, "23".repeat(32), "f.txt");
    for (const c of [empty, used, withFile]) {
      backdate(first.svc, "chats", c.id, 2 * DAY);
    }
    await first.svc.dispose();
    services.pop();
    const ctx: ServerContext = {
      paths: orchPaths(first.home), bindHost: "127.0.0.1", hostname: hostname(), tokenDigest: digestToken("t"), requireToken: true,
      requireRemoteToken: true, harnesses: ["claude"], outcomes: [],
    };
    const again = new ChatService(ctx);
    services.push(again);
    const archived = (id: string): string | null => again.store.getChat(id)?.archived_at ?? null;
    expect(archived(empty.id)).not.toBeNull();
    expect(archived(young.id)).toBeNull();
    expect(archived(used.id)).toBeNull();
    expect(archived(withFile.id)).toBeNull();
  });
});

describe("empty flag in the chat list", () => {
  test("empty is true only without messages and attachments", async () => {
    process.env.ORCH_CHAT_CLAUDE_BIN = FAKE_CLAUDE;
    const srv = startTestServer();
    servers.push(srv);
    srv.home.write("profiles.json", JSON.stringify(PROFILES));
    const post = (path: string, body: unknown): Promise<Response> => srv.api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const a = (await (await post("/api/chats", { harness: "claude", profile: "main" })).json()) as { id: string };
    const b = (await (await post("/api/chats", { harness: "claude", profile: "main" })).json()) as { id: string };
    await post(`/api/chats/${b.id}/messages`, { content: "hello" });
    const list = (await (await srv.api("/api/chats")).json()) as { items: Array<{ id: string; empty: boolean }> };
    expect(Object.fromEntries(list.items.map((c) => [c.id, c.empty]))).toEqual({ [a.id]: true, [b.id]: false });
  });
});
