import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { hostname } from "node:os";

import { orchPaths } from "../files/paths";
import { digestToken } from "../http/auth";
import { TempHome } from "../test-support/temp-home";
import type { ServerContext } from "../types/server-context";
import { ChatService, HttpError } from "./service";
import { blobPath } from "./uploads";

const PROFILES = { models: { "m-a": { slug: "alpha", harnesses: ["claude"] } }, profiles: { main: { harness: "claude", model: "m-a" } } };

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) {
    await fn();
  }
  delete process.env.ORCH_CHAT_CLAUDE_BIN;
  delete process.env.ORCH_CHAT_DISPATCH;
  delete process.env.FAKE_AGENT_LOG;
});

function service(): ChatService {
  const home = TempHome.create();
  home.write("profiles.json", JSON.stringify(PROFILES));
  const log = home.resolve("agent.log");
  writeFileSync(log, "");
  process.env.ORCH_CHAT_CLAUDE_BIN = resolve(import.meta.dir, "testing/fake-claude.sh");
  process.env.ORCH_CHAT_DISPATCH = resolve(import.meta.dir, "testing/fake-dispatch.sh");
  process.env.FAKE_AGENT_LOG = log;
  const ctx: ServerContext = {
    paths: orchPaths(home.path), bindHost: "127.0.0.1", hostname: hostname(), tokenDigest: digestToken("t"), requireToken: true,
    requireRemoteToken: true, harnesses: ["claude"], outcomes: [],
  };
  const svc = new ChatService(ctx);
  cleanup.push(() => svc.dispose());
  return svc;
}

async function send(svc: ChatService, chatId: string, content: string): Promise<void> {
  svc.sendMessage(chatId, { content });
  await svc.settled(chatId);
}

describe("chat titles", () => {
  test("a manual rename sticks: the first message does not replace it, even when the user typed `New chat`", async () => {
    const svc = service();
    const chat = svc.createChat({ harness: "claude", profile: "main" });
    expect(svc.renameChat(chat.id, "  My plan  ").title).toBe("My plan");
    await send(svc, chat.id, "hello world");
    expect(svc.chat(chat.id).title).toBe("My plan");

    const again = svc.createChat({ harness: "claude", profile: "main" });
    svc.renameChat(again.id, "New chat");
    await send(svc, again.id, "first words");
    expect(svc.chat(again.id).title).toBe("New chat");
  });

  test("an untouched chat still takes its title from the first message, and a later rename wins", async () => {
    const svc = service();
    const chat = svc.createChat({ harness: "claude", profile: "main" });
    await send(svc, chat.id, "hello   world");
    expect(svc.chat(chat.id).title).toBe("hello world");
    svc.renameChat(chat.id, "Renamed");
    await send(svc, chat.id, "second");
    expect(svc.chat(chat.id).title).toBe("Renamed");
  });

  test("a title given at creation is manual; empty and over-long titles are refused", () => {
    const svc = service();
    const named = svc.createChat({ harness: "claude", profile: "main", title: "Given" });
    expect(svc.chat(named.id).title_manual).toBe(1);
    expect(() => svc.renameChat(named.id, "   ")).toThrow(HttpError);
    expect(() => svc.renameChat(named.id, "x".repeat(201))).toThrow("longer than 200");
    expect(svc.renameChat(named.id, "x".repeat(200)).title).toHaveLength(200);
  });

  test("an attachment-only first message takes a title from the filename, capped like a typed one", async () => {
    const svc = service();
    const chat = svc.createChat({ harness: "claude", profile: "main" });
    const name = `${"f".repeat(250)}.txt`;
    const blob = blobPath(svc.home, "ab".repeat(32));
    mkdirSync(dirname(blob), { recursive: true });
    writeFileSync(blob, "x");
    const att = svc.store.addAttachment({ chat_id: chat.id, filename: name, mime: "text/plain", size: 1, sha256: "ab".repeat(32), rel_path: "x" });
    svc.sendMessage(chat.id, { content: "", attachment_ids: [att.id] });
    await svc.settled(chat.id);
    expect(svc.chat(chat.id).title).toBe(name.slice(0, 60));
  });
});
