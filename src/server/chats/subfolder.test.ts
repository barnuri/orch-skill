import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { orchPaths } from "../files/paths";
import { digestToken } from "../http/auth";
import { TempHome } from "../test-support/temp-home";
import type { ServerContext } from "../types/server-context";
import { ChatService, HttpError } from "./service";
import { ChatStore } from "./store";
import { ensureSubfolder, normaliseSubfolder, SubfolderError } from "./subfolder";

const FAKE_CLAUDE = resolve(import.meta.dir, "testing/fake-claude.ts");
const base = realpathSync(mkdtempSync(join(tmpdir(), "chat-subfolder-")));
const root = join(base, "root");
mkdirSync(join(root, "proj"), { recursive: true });
mkdirSync(join(root, "proj2"), { recursive: true });
mkdirSync(join(base, "out"), { recursive: true });
symlinkSync(join(base, "out"), join(root, "proj/escape"));

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) {
    await fn();
  }
  delete process.env.ORCH_CHAT_CLAUDE_BIN;
  delete process.env.FAKE_AGENT_LOG;
});

function setup(): { service: ChatService; home: TempHome; spawns: () => string[] } {
  const home = TempHome.create();
  home.write("profiles.json", JSON.stringify({
    settings: { chat_roots: [root] },
    models: { "m-a": { slug: "alpha", harnesses: ["claude"] } },
    profiles: { main: { harness: "claude", model: "m-a" } },
  }));
  const log = home.resolve("agent.log");
  writeFileSync(log, "");
  process.env.ORCH_CHAT_CLAUDE_BIN = FAKE_CLAUDE;
  process.env.FAKE_AGENT_LOG = log;
  const ctx: ServerContext = {
    paths: orchPaths(home.path), bindHost: "127.0.0.1", hostname: hostname(), tokenDigest: digestToken("t"), requireToken: true,
    requireRemoteToken: true, harnesses: ["claude"], outcomes: [],
  };
  const service = new ChatService(ctx);
  cleanup.push(() => service.dispose());
  return { service, home, spawns: () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { cwd?: string }).filter((l) => l.cwd !== undefined).map((l) => l.cwd as string) };
}

function projectWith(service: ChatService, path: string | null): string {
  const project = service.store.createProject({ name: "p" });
  if (path !== null) {
    service.setProjectFolder(project.id, path);
  }
  return project.id;
}

describe("normaliseSubfolder", () => {
  test("valid values are normalised", () => {
    expect(normaliseSubfolder("a")).toBe("a");
    expect(normaliseSubfolder("  a//b///c/ ")).toBe("a/b/c");
    expect(normaliseSubfolder("a/b/")).toBe("a/b");
    expect(normaliseSubfolder("")).toBeNull();
    expect(normaliseSubfolder("   ")).toBeNull();
    expect(normaliseSubfolder(null)).toBeNull();
    expect(normaliseSubfolder("a/b/c/d/e/f")).toBe("a/b/c/d/e/f");
    expect(normaliseSubfolder("x".repeat(200))).toBe("x".repeat(200));
  });

  test("bad values are refused with a sentence", () => {
    const bad = ["/abs", "../x", "a/../b", "a/./b", ".", "..", "~", "~/x", "a\\b", "a\0b", "x".repeat(201), "a/b/c/d/e/f/g", "/"];
    for (const value of bad) {
      expect(() => normaliseSubfolder(value)).toThrow(SubfolderError);
    }
    expect(() => normaliseSubfolder("/abs")).toThrow(/^subfolder: .*absolute/);
    expect(() => normaliseSubfolder("a/b/c/d/e/f/g")).toThrow(/6 levels/);
  });
});

describe("ensureSubfolder", () => {
  test("creates levels, recreates a deleted folder, refuses a symlink escape before creating anything through it", () => {
    const project = join(root, "proj");
    expect(ensureSubfolder(project, "docs/api")).toBe(join(project, "docs/api"));
    expect(existsSync(join(project, "docs/api"))).toBe(true);
    rmSync(join(project, "docs"), { recursive: true });
    expect(ensureSubfolder(project, "docs/api")).toBe(join(project, "docs/api"));
    expect(() => ensureSubfolder(project, "escape")).toThrow(/outside the project folder/);
    expect(() => ensureSubfolder(project, "escape/inner")).toThrow(/outside/);
    expect(existsSync(join(base, "out/inner"))).toBe(false);
    expect(() => ensureSubfolder(join(root, "missing"), "a")).toThrow(/does not exist/);
  });
});

describe("migration", () => {
  test("adds a nullable subfolder column and keeps old chats", () => {
    const file = join(base, "mig.db");
    const first = new ChatStore(file);
    const chat = first.createChat({ title: "old", harness: "claude", profile: "main" });
    first.close();
    const second = new ChatStore(file);
    const columns = second.handle.query("PRAGMA table_info(chats)").all() as Array<{ name: string; notnull: number }>;
    expect(columns.find((c) => c.name === "subfolder")?.notnull).toBe(0);
    expect(second.getChat(chat.id)?.subfolder).toBeNull();
    second.close();
  });
});

describe("validation in the service", () => {
  test("create and update: valid, absolute, .., symlink escape, too long, too deep, no project", () => {
    const { service } = setup();
    const project = projectWith(service, join(root, "proj"));
    const chat = service.createChat({ harness: "claude", profile: "main", project_id: project, subfolder: " work//one/ " });
    expect(chat.subfolder).toBe("work/one");
    expect(existsSync(join(root, "proj/work/one"))).toBe(true);
    for (const bad of ["/etc", "../x", "a/../../b", "escape", "x".repeat(201), "1/2/3/4/5/6/7", "~/x", "a\\..\\b"]) {
      expect(() => service.setChatSubfolder(chat.id, bad)).toThrow(HttpError);
    }
    expect(service.chat(chat.id).subfolder).toBe("work/one");
    expect(service.setChatSubfolder(chat.id, "").subfolder).toBeNull();
    expect(service.setChatSubfolder(chat.id, "b").subfolder).toBe("b");
    expect(service.setChatSubfolder(chat.id, null).subfolder).toBeNull();

    const noProject = service.createChat({ harness: "claude", profile: "main" });
    expect(() => service.setChatSubfolder(noProject.id, "a")).toThrow("subfolder needs a project with a folder");
    expect(() => service.createChat({ harness: "claude", profile: "main", subfolder: "a" })).toThrow("subfolder needs a project with a folder");
    const noPath = projectWith(service, null);
    expect(() => service.createChat({ harness: "claude", profile: "main", project_id: noPath, subfolder: "a" })).toThrow(/needs a project with a folder/);
    expect(service.createChat({ harness: "claude", profile: "main", project_id: noPath, subfolder: "" }).subfolder).toBeNull();
  });
});

describe("effective folder", () => {
  test("order: chat folder, project/subfolder, project, scratch; a new project path keeps the subfolder", () => {
    const { service } = setup();
    const none = projectWith(service, null);
    const proj = projectWith(service, join(root, "proj"));
    const make = (project: string | null, subfolder: string | null, cwd: string | null) => {
      const chat = service.createChat({ harness: "claude", profile: "main", project_id: project, subfolder, cwd });
      return service.effectiveCwd(chat);
    };
    const own = join(root, "proj2");
    expect(make(null, null, null)).toBeNull();
    expect(make(none, null, null)).toBeNull();
    expect(make(proj, null, null)).toBe(join(root, "proj"));
    expect(make(proj, "s", null)).toBe(join(root, "proj/s"));
    expect(make(proj, null, own)).toBe(own);
    expect(make(proj, "s", own)).toBe(own);
    expect(make(null, null, own)).toBe(own);

    const chat = service.createChat({ harness: "claude", profile: "main", project_id: proj, subfolder: "s" });
    service.setProjectFolder(proj, join(root, "proj2"));
    expect(service.effectiveCwd(service.chat(chat.id))).toBe(join(root, "proj2/s"));
    service.setProjectFolder(proj, join(root, "proj"));
  });

  test("usableCwd recreates a deleted subfolder and falls back to the project folder with a warning when it cannot", () => {
    const { service } = setup();
    const proj = projectWith(service, join(root, "proj"));
    const chat = service.createChat({ harness: "claude", profile: "main", project_id: proj, subfolder: "gone" });
    rmSync(join(root, "proj/gone"), { recursive: true });
    expect(service.usableCwd(chat)).toBe(join(root, "proj/gone"));
    expect(existsSync(join(root, "proj/gone"))).toBe(true);
    expect(service.warningFor(chat)).toBeNull();

    rmSync(join(root, "proj/gone"), { recursive: true });
    writeFileSync(join(root, "proj/gone"), "a file");
    expect(service.usableCwd(chat)).toBe(join(root, "proj"));
    expect(service.warningFor(chat)).toMatch(/could not be created.*project folder instead/);
    rmSync(join(root, "proj/gone"));
  });

  test("workspace area follows the subfolder", () => {
    const { service } = setup();
    const proj = projectWith(service, join(root, "proj"));
    const chat = service.createChat({ harness: "claude", profile: "main", project_id: proj, subfolder: "ws" });
    expect(service.workspace(chat, "chat").root).toBe(join(root, "proj/ws/.orch/chats", chat.id));
  });
});

describe("turns", () => {
  test("the agent process starts in the subfolder; a changed subfolder replaces the idle session", async () => {
    const { service, spawns } = setup();
    const proj = projectWith(service, join(root, "proj"));
    const chat = service.createChat({ harness: "claude", profile: "main", project_id: proj, subfolder: "turns" });
    service.sendMessage(chat.id, { content: "hi" });
    await service.settled(chat.id);
    expect(spawns().at(-1)).toBe(join(root, "proj/turns"));

    service.setChatSubfolder(chat.id, "other/deep");
    service.sendMessage(chat.id, { content: "again" });
    await service.settled(chat.id);
    expect(spawns().at(-1)).toBe(join(root, "proj/other/deep"));

    service.setChatSubfolder(chat.id, null);
    service.sendMessage(chat.id, { content: "plain" });
    await service.settled(chat.id);
    expect(spawns().at(-1)).toBe(join(root, "proj"));
  });
});
