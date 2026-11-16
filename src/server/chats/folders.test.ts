// test-tier: slow (detached fake-claude turn processes)
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { orchPaths } from "../files/paths";
import { digestToken } from "../http/auth";
import { TempHome } from "../test-support/temp-home";
import type { ServerContext } from "../types/server-context";
import { chatRoots, listFolders, validateFolder } from "./folders";
import { MIGRATIONS } from "./migrations";
import { ChatService, HttpError } from "./service";
import { ChatStore } from "./store";

const FAKE_CLAUDE = resolve(import.meta.dir, "testing/fake-claude.ts");
const base = realpathSync(mkdtempSync(join(tmpdir(), "chat-folders-")));
const root = join(base, "root");
const outside = join(base, "outside");
for (const d of ["root/alpha", "root/beta", "root/.hidden", "root/node_modules", "root/gamma/inner", "outside/secret"]) {
  mkdirSync(join(base, d), { recursive: true });
}
writeFileSync(join(root, "file.txt"), "x");
symlinkSync(join(outside, "secret"), join(root, "escape"));
symlinkSync(join(root, "beta"), join(root, "beta-link"));

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) {
    await fn();
  }
  delete process.env.ORCH_CHAT_CLAUDE_BIN;
  delete process.env.FAKE_AGENT_LOG;
});

function setup(roots: string[] = [root]): { service: ChatService; home: TempHome; spawns: () => Array<{ cwd: string }> } {
  const home = TempHome.create();
  home.write("profiles.json", JSON.stringify({
    settings: { chat_roots: roots },
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
  return { service, home, spawns: () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { cwd: string }).filter((l) => l.cwd !== undefined) };
}

async function turn(service: ChatService, id: string, text: string): Promise<void> {
  service.sendMessage(id, { content: text });
  await service.settled(id);
}

describe("store migration", () => {
  test("a database from before the folder column keeps its chats and gains a null cwd", () => {
    const path = join(base, "old.db");
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
    const db = new Database(path, { create: true });
    db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    MIGRATIONS.slice(0, 3).forEach((sql, i) => {
      db.exec(sql);
      db.query("INSERT INTO schema_migrations VALUES (?, 'x')").run(i + 1);
    });
    db.query("INSERT INTO chats (id, title, harness, profile, created_at, updated_at) VALUES ('chat-old', 'old', 'claude', 'p', 'a', 'b')").run();
    db.close();
    const store = new ChatStore(path);
    expect(store.schemaVersion()).toBe(MIGRATIONS.length);
    expect(store.getChat("chat-old")?.cwd).toBeNull();
    expect(store.setChatCwd("chat-old", "/x")?.cwd).toBe("/x");
    store.touchFolder("/x");
    expect(store.folderUse().has("/x")).toBe(true);
    store.close();
  });
});

describe("validateFolder", () => {
  const roots = [root];
  test("accepts a folder inside a root, the root itself and a symlink that stays inside", () => {
    expect(validateFolder(join(root, "alpha"), roots)).toBe(join(root, "alpha"));
    expect(validateFolder(root, roots)).toBe(root);
    expect(validateFolder(join(root, "beta-link"), roots)).toBe(join(root, "beta"));
  });
  test("rejects relative paths, traversal, missing paths, files and paths outside the roots", () => {
    expect(() => validateFolder("alpha", roots)).toThrow(/absolute/);
    expect(() => validateFolder(`${root}/alpha/../../outside`, roots)).toThrow(/\.\./);
    expect(() => validateFolder(join(root, "nope"), roots)).toThrow(/does not exist/);
    expect(() => validateFolder(join(root, "file.txt"), roots)).toThrow(/not a directory/);
    expect(() => validateFolder(outside, roots)).toThrow(/outside the allowed roots/);
    expect(() => validateFolder(base, roots)).toThrow(/outside/);
  });
  test("rejects a symlink inside the root that points outside", () => {
    expect(() => validateFolder(join(root, "escape"), roots)).toThrow(/outside the allowed roots/);
  });
  test("a root that is a prefix of another name is not a match", () => {
    mkdirSync(join(base, "root-evil"), { recursive: true });
    expect(() => validateFolder(join(base, "root-evil"), roots)).toThrow(/outside/);
  });
});

describe("listFolders", () => {
  test("hides dot folders, node_modules, files and symlink escapes; sorts recent first then by name", () => {
    const use = new Map([[join(root, "gamma"), "2026-01-02T00:00:00Z"], [join(root, "beta"), "2026-01-01T00:00:00Z"]]);
    const list = listFolders([root], undefined, use);
    expect(list.root).toBe(root);
    expect(list.items.map((i) => i.name)).toEqual(["gamma", "beta", "alpha"]);
    expect(list.items[0]?.last_used_at).toBe("2026-01-02T00:00:00Z");
  });
  test("lists a folder inside a root and refuses one outside", () => {
    expect(listFolders([root], join(root, "gamma"), new Map()).items.map((i) => i.name)).toEqual(["inner"]);
    expect(() => listFolders([root], outside, new Map())).toThrow(/outside/);
  });
  test("is cut at 200", () => {
    const big = join(base, "big");
    for (let i = 0; i < 230; i++) {
      mkdirSync(join(big, `d${String(i).padStart(3, "0")}`), { recursive: true });
    }
    const list = listFolders([big], undefined, new Map());
    expect([list.items.length, list.truncated]).toEqual([200, true]);
  });
  test("the default root is ~/sandbox/private and the setting replaces it", () => {
    const { home } = setup([root, join(base, "missing")]);
    expect(chatRoots(home.path)).toEqual([root]);
    home.write("profiles.json", "{}");
    expect(chatRoots(home.path).every((r) => r.endsWith("/sandbox/private"))).toBe(true);
  });
});

describe("chat folders reach the process", () => {
  test("a chat folder is the cwd of every turn; moving it applies from the next turn; clearing falls back to the project", async () => {
    const { service, spawns } = setup();
    const chat = service.createChat({ harness: "claude", profile: "main", cwd: join(root, "alpha") });
    await turn(service, chat.id, "one");
    service.setChatFolder(chat.id, join(root, "beta"));
    await turn(service, chat.id, "two");
    const project = service.store.createProject({ name: "p" });
    service.setChatProject(chat.id, project.id);
    service.setProjectFolder(project.id, join(root, "gamma"));
    service.setChatFolder(chat.id, null);
    await turn(service, chat.id, "three");
    expect(spawns().map((s) => s.cwd)).toEqual([join(root, "alpha"), join(root, "beta"), join(root, "gamma")]);
  });

  test("a chat folder overrides its project folder; a new chat of the project inherits the project folder", async () => {
    const { service, spawns } = setup();
    const project = service.store.createProject({ name: "p" });
    service.setProjectFolder(project.id, join(root, "gamma"));
    const inherit = service.createChat({ harness: "claude", profile: "main", project_id: project.id });
    const own = service.createChat({ harness: "claude", profile: "main", project_id: project.id, cwd: join(root, "alpha") });
    expect(service.effectiveCwd(inherit)).toBe(join(root, "gamma"));
    await turn(service, inherit.id, "a");
    await turn(service, own.id, "b");
    expect(spawns().map((s) => s.cwd)).toEqual([join(root, "gamma"), join(root, "alpha")]);
  });

  test("a running turn keeps its cwd and the change applies to the next one", async () => {
    const { service, spawns } = setup();
    const chat = service.createChat({ harness: "claude", profile: "main", cwd: join(root, "alpha") });
    const r = service.sendMessage(chat.id, { content: "SLOW" });
    while (service.store.getMessage(r.assistant_message_id)?.content.includes("tick") !== true) {
      await Bun.sleep(25);
    }
    service.setChatFolder(chat.id, join(root, "beta"));
    await service.stop(chat.id);
    await service.settled(chat.id);
    await turn(service, chat.id, "next");
    expect(spawns().map((s) => s.cwd)).toEqual([join(root, "alpha"), join(root, "beta")]);
  });

  test("a folder swapped for a symlink that escapes the roots is not used: the turn runs in the scratch folder", async () => {
    const { service, home, spawns } = setup();
    const swap = join(root, "swap");
    mkdirSync(swap, { recursive: true });
    const chat = service.createChat({ harness: "claude", profile: "main", cwd: swap });
    Bun.spawnSync(["trash", swap]);
    symlinkSync(outside, swap);
    expect(service.warningFor(chat)).toMatch(/no longer inside an allowed root/);
    await turn(service, chat.id, "x");
    expect(spawns()[0]?.cwd).toBe(realpathSync(join(home.path, "chats", "workspace")));
    Bun.spawnSync(["trash", swap]);
  });

  test("a bad folder is a 400 with the reason, for a chat, a project and a new chat", () => {
    const { service } = setup();
    const chat = service.createChat({ harness: "claude", profile: "main" });
    const project = service.store.createProject({ name: "p" });
    for (const bad of [outside, join(root, "escape"), "relative", join(root, "nope"), join(root, "file.txt")]) {
      expect(() => service.setChatFolder(chat.id, bad)).toThrow(expect.objectContaining({ status: 400, message: expect.stringContaining("folder:") }));
      expect(() => service.setProjectFolder(project.id, bad)).toThrow(HttpError);
      expect(() => service.createChat({ harness: "claude", profile: "main", cwd: bad })).toThrow(HttpError);
    }
    expect(service.chat(chat.id).cwd).toBeNull();
  });
});
