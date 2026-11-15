import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmdirSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";

import { digestToken } from "../http/auth";
import { orchPaths } from "../files/paths";
import { TempHome } from "../test-support/temp-home";
import type { ServerContext } from "../types/server-context";
import { ChatService } from "./service";

const FAKE_CLAUDE = resolve(import.meta.dir, "testing/fake-claude.sh");
const PROFILES = { models: { "m-a": { slug: "alpha", harnesses: ["claude"] } }, profiles: { main: { harness: "claude", model: "m-a" } } };

const services: ChatService[] = [];
afterEach(async () => {
  for (const s of services.splice(0)) {
    await s.dispose();
  }
  delete process.env.ORCH_CHAT_CLAUDE_BIN;
});

function setup(): { svc: ChatService; home: string } {
  const home = TempHome.create();
  home.write("profiles.json", JSON.stringify(PROFILES));
  process.env.ORCH_CHAT_CLAUDE_BIN = FAKE_CLAUDE;
  const ctx: ServerContext = {
    paths: orchPaths(home.path), bindHost: "127.0.0.1", hostname: hostname(), tokenDigest: digestToken("t"), requireToken: true,
    requireRemoteToken: true, harnesses: ["claude"], outcomes: [], 
  };
  const svc = new ChatService(ctx);
  services.push(svc);
  return { svc, home: home.path };
}

describe("replay from a tool message (F2)", () => {
  test("a Last-Event-ID naming a tool row still replays the assistant's text and its done", async () => {
    const { svc } = setup();
    const chat = svc.createChat({ harness: "claude", profile: "main" });
    svc.sendMessage(chat.id, { content: "TOOL hello" });
    await svc.settled(chat.id);
    const rows = svc.store.messagesAfter(chat.id, null);
    const tool = rows.find((m) => m.role === "tool");
    const assistant = rows.find((m) => m.role === "assistant");
    expect(tool && assistant).toBeTruthy();
    expect((tool?.id as string) > (assistant?.id as string)).toBe(true);
    const { replay, unsubscribe } = svc.subscribe(chat.id, `${tool?.id}.${tool?.content.length}`, () => {});
    unsubscribe();
    const snap = replay.find((e) => e.event === "message" && (e.data.message as { id: string }).id === assistant?.id);
    const message = snap?.data.message as { content: string; status: string };
    expect(message.content).toContain("echo:");
    expect(message.status).toBe("done");
    expect(replay.map((e) => e.event)).toContain("done");
  });

  test("replay from the user row and from the assistant offset still work", async () => {
    const { svc } = setup();
    const chat = svc.createChat({ harness: "claude", profile: "main" });
    const { user_message_id, assistant_message_id } = svc.sendMessage(chat.id, { content: "TOOL hi" });
    await svc.settled(chat.id);
    const user = svc.store.getMessage(user_message_id);
    const full = svc.store.getMessage(assistant_message_id);
    const fromUser = svc.subscribe(chat.id, `${user_message_id}.${user?.content.length}`, () => {});
    fromUser.unsubscribe();
    const ids = fromUser.replay.filter((e) => e.event === "message").map((e) => (e.data.message as { id: string }).id);
    expect(ids).toContain(assistant_message_id);
    const half = svc.subscribe(chat.id, `${assistant_message_id}.2`, () => {});
    half.unsubscribe();
    const delta = half.replay.find((e) => e.event === "delta");
    expect(delta?.data.text as string).toBe(full?.content.slice(2) ?? "");
  });
});

describe("project moves and missing directories (F6, F7)", () => {
  test("moving a chat to another project drops its live session", async () => {
    const { svc, home } = setup();
    const dir = join(home, "p1");
    mkdirSync(dir);
    const project = svc.store.createProject({ name: "p", path: dir });
    const chat = svc.createChat({ harness: "claude", profile: "main" });
    svc.sendMessage(chat.id, { content: "hi" });
    await svc.settled(chat.id);
    expect(svc.manager.has(chat.id)).toBe(true);
    svc.setChatProject(chat.id, project.id);
    expect(svc.manager.has(chat.id)).toBe(false);
    svc.sendMessage(chat.id, { content: "again" });
    await svc.settled(chat.id);
    expect(svc.manager.has(chat.id)).toBe(true);
    svc.setChatProject(chat.id, project.id);
    expect(svc.manager.has(chat.id)).toBe(true);
  });

  test("a project whose directory vanished gives the chat a visible warning", () => {
    const { svc, home } = setup();
    const dir = join(home, "gone");
    mkdirSync(dir);
    const project = svc.store.createProject({ name: "p", path: dir });
    const chat = svc.createChat({ harness: "claude", profile: "main", project_id: project.id });
    expect(svc.warningFor(chat)).toBeNull();
    rmdirSync(dir);
    expect(svc.warningFor(chat)).toContain(`${dir} no longer exists`);
    expect(svc.warningFor(svc.createChat({ harness: "claude", profile: "main" }))).toBeNull();
  });
});
