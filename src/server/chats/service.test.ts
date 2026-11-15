import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hostname } from "node:os";

import { orchPaths } from "../files/paths";
import { TempHome } from "../test-support/temp-home";
import { digestToken } from "../http/auth";
import type { ServerContext } from "../types/server-context";
import { ChatService, type ChatEvent, HttpError } from "./service";
import { ChatStore } from "./store";

const FAKE_CLAUDE = resolve(import.meta.dir, "testing/fake-claude.sh");
const FAKE_DISPATCH = resolve(import.meta.dir, "testing/fake-dispatch.sh");

const PROFILES = {
  models: {
    "m-a": { slug: "alpha", harnesses: ["claude", "copilot"] },
    "m-b": { slug: "beta", harnesses: ["claude"], behaves_as: "claude-haiku-4-5" },
  },
  profiles: {
    main: { harness: "claude", model: "m-a", flags: ["--dangerously-skip-permissions"], env: { ANTHROPIC_MODEL: "${PROFILE_MODEL}" } },
    cp: { harness: "copilot", model: "m-a" },
  },
};

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) {
    await fn();
  }
  delete process.env.ORCH_CHAT_CLAUDE_BIN;
  delete process.env.ORCH_CHAT_DISPATCH;
  delete process.env.FAKE_AGENT_LOG;
});

function ctxFor(home: string): ServerContext {
  return {
    paths: orchPaths(home), bindHost: "127.0.0.1", hostname: hostname(), tokenDigest: digestToken("t"), requireToken: true,
    requireRemoteToken: true, harnesses: ["claude", "copilot"], outcomes: [],
  };
}

function setup(idleMs?: number): { service: ChatService; home: TempHome; log: string; lines: () => Array<Record<string, any>> } {
  const home = TempHome.create();
  home.write("profiles.json", JSON.stringify(PROFILES));
  const log = home.resolve("agent.log");
  writeFileSync(log, "");
  process.env.ORCH_CHAT_CLAUDE_BIN = FAKE_CLAUDE;
  process.env.ORCH_CHAT_DISPATCH = FAKE_DISPATCH;
  process.env.FAKE_AGENT_LOG = log;
  const service = new ChatService(ctxFor(home.path), { idleMs });
  cleanup.push(() => service.dispose());
  const lines = (): Array<Record<string, any>> => readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { service, home, log, lines };
}

function collect(service: ChatService, chatId: string, last: string | null = null): { events: ChatEvent[]; replay: ChatEvent[] } {
  const events: ChatEvent[] = [];
  const { replay } = service.subscribe(chatId, last, (e) => events.push(e));
  return { events, replay };
}

async function turn(service: ChatService, chatId: string, content: string, attachment_ids?: string[]): Promise<{ user: string; assistant: string }> {
  const r = service.sendMessage(chatId, { content, attachment_ids });
  await service.settled(chatId);
  return { user: r.user_message_id, assistant: r.assistant_message_id };
}

describe("persistent claude session", () => {
  test("one process streams every turn; the message is written as it goes with usage and the session id", async () => {
    const { service, lines } = setup();
    const chat = service.createChat({ harness: "claude", profile: "main", model_id: "m-b" });
    const { events } = collect(service, chat.id);
    const { assistant } = await turn(service, chat.id, "hello world");
    const second = await turn(service, chat.id, "two");
    expect(service.store.getMessage(second.assistant)?.content).toContain("(turn 2,");
    const spawns = lines().filter((l) => l.args);
    expect(spawns).toHaveLength(1);
    const args = spawns[0]?.args as string[];
    expect(args).toEqual(expect.arrayContaining(["--include-partial-messages", "--dangerously-skip-permissions", "--settings"]));
    expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual(["--model", "beta"]);
    expect(spawns[0]?.env.ANTHROPIC_MODEL).toBe("beta");
    const row = service.store.getMessage(assistant);
    expect(row?.status).toBe("done");
    expect(row?.content).toMatch(/^echo: hello world \(turn 1, session [0-9a-f-]{36}\)$/);
    expect([row?.input_tokens, row?.output_tokens, row?.cost_usd, row?.model_used]).toEqual([11, 7, 0.0123, "fake-model"]);
    const names = events.map((e) => e.event);
    expect(names.slice(0, 3)).toEqual(["message", "message", "status"]);
    expect(names.filter((n) => n === "delta")).toHaveLength(6);
    const firstDone = names.indexOf("done");
    expect(names.slice(firstDone, firstDone + 2)).toEqual(["done", "status"]);
    const deltas = events.filter((e) => e.event === "delta" && e.data.message_id === assistant).map((e) => e.data.text).join("");
    expect(deltas).toBe(row?.content as string);
    expect(events.filter((e) => e.event === "usage")).toHaveLength(2);
    const last = events.filter((e) => e.event === "delta" && e.data.message_id === assistant).at(-1);
    expect(last?.id).toBe(`${assistant}.${row?.content.length}`);
    const after = service.chat(chat.id);
    expect([after.status, after.session_id !== null, after.title]).toEqual(["idle", true, "hello world"]);
    expect(events.at(-1)?.data).toEqual({ chat_id: chat.id, status: "idle" });
  });

  test("a stopped reply keeps its text; the next message resumes the stored session", async () => {
    const { service, lines } = setup();
    const chat = service.createChat({ harness: "claude", profile: "main" });
    await turn(service, chat.id, "first");
    const sessionId = service.chat(chat.id).session_id as string;
    const { events } = collect(service, chat.id);
    const r = service.sendMessage(chat.id, { content: "SLOW please" });
    await Bun.sleep(300);
    expect(service.chat(chat.id).status).toBe("running");
    expect(service.store.getMessage(r.assistant_message_id)?.content).toContain("tick");
    expect(await service.stop(chat.id)).toBe(true);
    const stopped = service.store.getMessage(r.assistant_message_id);
    expect([stopped?.status, stopped?.error]).toEqual(["stopped", null]);
    expect(stopped?.content.length).toBeGreaterThan(4);
    expect(events.filter((e) => e.event === "done").at(-1)?.data.status).toBe("stopped");
    expect(service.chat(chat.id).status).toBe("idle");
    expect(await service.stop(chat.id)).toBe(false);
    const next = await turn(service, chat.id, "after stop");
    expect(service.store.getMessage(next.assistant)?.status).toBe("done");
    const spawns = lines().filter((l) => l.args);
    expect(spawns).toHaveLength(2);
    expect(spawns[1]?.args.slice(spawns[1]?.args.indexOf("--resume"), spawns[1]?.args.indexOf("--resume") + 2)).toEqual(["--resume", sessionId]);
  });

  test("an idle session is disposed and resumed from the stored session id", async () => {
    const { service, lines } = setup(60);
    const chat = service.createChat({ harness: "claude", profile: "main" });
    await turn(service, chat.id, "one");
    expect(service.manager.size()).toBe(1);
    await Bun.sleep(250);
    expect(service.manager.size()).toBe(0);
    await turn(service, chat.id, "two");
    const spawns = lines().filter((l) => l.args);
    expect(spawns).toHaveLength(2);
    expect(spawns[1]?.args).toContain("--resume");
    expect(spawns[1]?.args).not.toContain("--session-id");
  });

  test("a crash ends the message as an error and the next message starts a new process", async () => {
    const { service } = setup();
    const chat = service.createChat({ harness: "claude", profile: "main" });
    const crashed = await turn(service, chat.id, "CRASH now");
    const row = service.store.getMessage(crashed.assistant);
    expect(row?.status).toBe("error");
    expect(row?.error).toContain("agent exited (code 3)");
    const ok = await turn(service, chat.id, "fine");
    expect(service.store.getMessage(ok.assistant)?.status).toBe("done");
  });

  test("a second message while one runs is 409; an unknown attachment is 400", async () => {
    const { service } = setup();
    const chat = service.createChat({ harness: "claude", profile: "main" });
    service.sendMessage(chat.id, { content: "SLOW" });
    expect(() => service.sendMessage(chat.id, { content: "x" })).toThrow(expect.objectContaining({ status: 409 }));
    await service.stop(chat.id);
    expect(() => service.sendMessage(chat.id, { content: "x", attachment_ids: ["att-nope"] })).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => service.sendMessage(chat.id, { content: "  " })).toThrow(HttpError);
  });

});

describe("one long chat", () => {
  test("tool calls, error results, attachments, the working directory and replay", async () => {
    const { service, home, lines } = setup();
    const dir = join(home.path, "proj");
    mkdirSync(dir);
    const project = service.store.createProject({ name: "p", path: dir });
    const chat = service.createChat({ harness: "claude", profile: "main", project_id: project.id });

    await turn(service, chat.id, "TOOL");
    expect(service.store.messagesAfter(chat.id, null).filter((m) => m.role === "tool").map((m) => m.content)).toEqual(["Read: /tmp/x"]);

    const failed = await turn(service, chat.id, "FAIL");
    const bad = service.store.getMessage(failed.assistant);
    expect([bad?.status, bad?.error]).toEqual(["error", "model exploded"]);

    const att = service.store.addAttachment({ chat_id: chat.id, filename: "a.txt", mime: "text/plain", size: 1, sha256: "ab".repeat(32), rel_path: "x" });
    const withFile = await turn(service, chat.id, "look", [att.id]);
    const prompt = lines().filter((l) => l.prompt).at(-1)?.prompt as string;
    expect(prompt).toContain("Attached files");
    expect(prompt).toMatch(/- \/.*\/chats\/links\/att-[0-9a-z]+\/a\.txt/);
    expect(service.store.getAttachment(att.id)?.message_id).toBe(withFile.user);
    expect(() => service.sendMessage(chat.id, { content: "again", attachment_ids: [att.id] })).toThrow(/already attached/);

    expect(lines().find((l) => l.cwd)?.cwd).toContain("proj");
    expect(lines().filter((l) => l.args)).toHaveLength(1);

    const full = service.store.getMessage(withFile.assistant)?.content as string;
    const { replay } = collect(service, chat.id, `${withFile.assistant}.5`);
    expect(replay.map((e) => e.event)).toEqual(["delta", "done", "status"]);
    expect(replay[0]?.data.text).toBe(full.slice(5));
    const next = await turn(service, chat.id, "after");
    const missed = collect(service, chat.id, `${withFile.assistant}.${full.length}`).replay;
    expect(missed.filter((e) => e.event === "message").map((e) => (e.data.message as { id: string }).id)).toEqual([next.user, next.assistant]);
    expect(collect(service, chat.id).replay).toEqual([{ event: "status", data: { chat_id: chat.id, status: "idle" } }]);
  });
});

describe("restart recovery", () => {
  test("a message still streaming when the server started is marked an error", () => {
    const home = TempHome.create();
    home.write("profiles.json", JSON.stringify(PROFILES));
    const store = new ChatStore(join(home.path, "chats.db"));
    const chat = store.createChat({ title: "t", harness: "claude", profile: "main" });
    store.updateChat(chat.id, { status: "running" });
    const m = store.addMessage({ chat_id: chat.id, role: "assistant", status: "streaming" });
    store.appendContent(m.id, "half an ans");
    store.close();
    const service = new ChatService(ctxFor(home.path));
    cleanup.push(() => service.dispose());
    expect(service.recovered).toBe(1);
    const row = service.store.getMessage(m.id);
    expect([row?.status, row?.error, row?.content]).toEqual(["error", "server restarted", "half an ans"]);
    expect(service.chat(chat.id).status).toBe("idle");
  });
});

describe("rules on create and configure", () => {
  test("a model outside the profile, a foreign profile and an unknown project are 400", () => {
    const { service } = setup();
    expect(() => service.createChat({ harness: "claude", profile: "main", model_id: "nope" })).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => service.createChat({ harness: "copilot", profile: "main" })).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => service.createChat({ harness: "claude", profile: "main", project_id: "prj-x" })).toThrow(expect.objectContaining({ status: 404 }));
  });

  test("harness, profile and model change only before the first message", async () => {
    const { service } = setup();
    const chat = service.createChat({ harness: "claude", profile: "main" });
    expect(service.configureChat(chat.id, { harness: "copilot", profile: "cp", model_id: "m-a" }).harness).toBe("copilot");
    await turn(service, chat.id, "hi");
    expect(() => service.configureChat(chat.id, { harness: "claude", profile: "main", model_id: null })).toThrow(expect.objectContaining({ status: 409 }));
  });

  test("a profile disabled after chat creation stops sending with 400", () => {
    const { service, home } = setup();
    const chat = service.createChat({ harness: "claude", profile: "main" });
    home.write("profiles.json", JSON.stringify({ ...PROFILES, profiles: { ...PROFILES.profiles, main: { ...PROFILES.profiles.main, enabled: false } } }));
    expect(() => service.sendMessage(chat.id, { content: "x" })).toThrow(expect.objectContaining({ status: 400 }));
  });
});

describe("one-process-per-turn fallback (copilot)", () => {
  test("mints a session id on the first turn, resumes it on the next, passes the model id", async () => {
    const { service, lines } = setup();
    const chat = service.createChat({ harness: "copilot", profile: "cp", model_id: "m-a" });
    const first = await turn(service, chat.id, "ping");
    expect(service.store.getMessage(first.assistant)?.content).toBe("turn-echo: ping");
    const id = service.chat(chat.id).session_id as string;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    await turn(service, chat.id, "pong");
    const calls = lines().filter((l) => l.profile);
    expect([calls[0]?.session, calls[0]?.resume, calls[0]?.model_id]).toEqual([id, "", "m-a"]);
    expect([calls[1]?.session, calls[1]?.resume]).toEqual(["", id]);
  });

  test("a non-zero exit is an error message with stderr; stop ends a running turn", async () => {
    const { service } = setup();
    const chat = service.createChat({ harness: "copilot", profile: "cp" });
    const bad = await turn(service, chat.id, "FAIL");
    expect(service.store.getMessage(bad.assistant)?.error).toContain("code 4: boom");
    const r = service.sendMessage(chat.id, { content: "SLOW" });
    await Bun.sleep(400);
    await service.stop(chat.id);
    expect(service.store.getMessage(r.assistant_message_id)?.status).toBe("stopped");
  });
});
