import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ChatStore } from "./store";
import { migrateSubprojectsCommand } from "./subproject-migrate";
import { migrateSubfoldersToSubprojects, parentProblem, subProjectFolder } from "./subprojects";
import { startTestServer } from "../test-support/test-server";
import type { TestServerHandle } from "../types/test-server-handle";

const base = realpathSync(mkdtempSync(join(tmpdir(), "chat-subprojects-")));
const servers: TestServerHandle[] = [];
const stores: ChatStore[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.stop();
  }
  for (const s of stores.splice(0)) {
    s.close();
  }
});

function folder(name: string): string {
  const dir = join(base, `${name}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function memStore(): ChatStore {
  const store = new ChatStore(":memory:");
  stores.push(store);
  return store;
}

const json = (srv: TestServerHandle, path: string, method: string, body?: unknown): Promise<Response> =>
  srv.api(path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

test("the schema adds parent_id; a plain project has none", () => {
  const store = memStore();
  const top = store.createProject({ name: "top" });
  expect(top.parent_id).toBeNull();
  expect(store.getProject(top.id)?.parent_id).toBeNull();
  const sub = store.createProject({ name: "sub", parent_id: top.id });
  expect(store.getProject(sub.id)?.parent_id).toBe(top.id);
  expect(store.subProjects(top.id).map((p) => p.id)).toEqual([sub.id]);
});

test("parentProblem refuses a sub project or an archived parent", () => {
  const store = memStore();
  const top = store.createProject({ name: "top" });
  const sub = store.createProject({ name: "sub", parent_id: top.id });
  expect(parentProblem(top)).toBeNull();
  expect(parentProblem(sub)).toMatch(/cannot have sub projects/);
  expect(parentProblem(store.setProjectArchived(top.id, true)!)).toMatch(/archived/);
});

test("subProjectFolder makes <parent>/<name>, refuses a path name, and is null without a parent folder", () => {
  const store = memStore();
  const root = folder("parent");
  const top = store.createProject({ name: "top", path: root });
  expect(subProjectFolder(top, "child")).toBe(join(root, "child"));
  expect(existsSync(join(root, "child"))).toBe(true);
  expect(() => subProjectFolder(top, "a/b")).toThrow(/one folder name/);
  expect(() => subProjectFolder(top, "..")).toThrow();
  expect(subProjectFolder(store.createProject({ name: "bare" }), "child")).toBeNull();
});

test("POST /api/projects with parent_id: folder under the parent, nesting and archived parents refused, 404 for no parent", async () => {
  const srv = startTestServer();
  servers.push(srv);
  const root = folder("api");
  const top = (await (await json(srv, "/api/projects", "POST", { name: "home", path: root })).json()) as { id: string; parent_id: string | null };
  expect(top.parent_id).toBeNull();

  const made = await json(srv, "/api/projects", "POST", { name: "kitchen", parent_id: top.id });
  expect(made.status).toBe(201);
  const sub = (await made.json()) as { id: string; parent_id: string; path: string };
  expect(sub).toMatchObject({ parent_id: top.id, path: join(root, "kitchen") });
  expect(existsSync(join(root, "kitchen"))).toBe(true);

  const own = folder("own");
  const explicit = (await (await json(srv, "/api/projects", "POST", { name: "elsewhere", parent_id: top.id, path: own })).json()) as { path: string };
  expect(explicit.path).toBe(own);

  const nested = await json(srv, "/api/projects", "POST", { name: "deeper", parent_id: sub.id });
  expect(nested.status).toBe(400);
  expect(((await nested.json()) as { error: string }).error).toMatch(/cannot have sub projects/);
  const slash = await json(srv, "/api/projects", "POST", { name: "a/b", parent_id: top.id });
  expect(slash.status).toBe(400);
  expect((await json(srv, "/api/projects", "POST", { name: "x", parent_id: "prj-none" })).status).toBe(404);

  await json(srv, `/api/projects/${top.id}/archive`, "POST");
  expect((await json(srv, "/api/projects", "POST", { name: "late", parent_id: top.id })).status).toBe(400);

  const list = (await (await srv.api("/api/projects?archived=1")).json()) as { items: Array<{ id: string; parent_id: string | null }> };
  expect(list.items.find((p) => p.id === sub.id)?.parent_id).toBe(top.id);
});

function seedSubfolderChats(store: ChatStore, root: string) {
  const top = store.createProject({ name: "home tasks", path: root });
  const a = store.createChat({ project_id: top.id, title: "fridge", harness: "claude", profile: "main", subfolder: "fridge" });
  const b = store.createChat({ project_id: top.id, title: "oven", harness: "claude", profile: "main", subfolder: "oven" });
  const c = store.createChat({ project_id: top.id, title: "oven again", harness: "claude", profile: "main", subfolder: "oven" });
  const plain = store.createChat({ project_id: top.id, title: "plain", harness: "claude", profile: "main" });
  const old = store.createChat({ project_id: top.id, title: "old", harness: "claude", profile: "main", subfolder: "old" });
  store.setChatArchived(old.id, true);
  const loose = store.createChat({ title: "loose", harness: "claude", profile: "main", subfolder: "x" });
  store.addMessage({ chat_id: a.id, role: "user", content: "hello", status: "done" });
  return { top, a, b, c, plain, old, loose };
}

test("migration: one sub project per project and subfolder, chat keeps id, history and updated_at; repeat is a no-op", () => {
  const store = memStore();
  const root = folder("migrate");
  const { top, a, b, c, plain, old, loose } = seedSubfolderChats(store, root);
  const before = store.getChat(a.id)!;

  const dry = migrateSubfoldersToSubprojects(store, { dryRun: true });
  expect(dry.migrated.map((m) => [m.chat_id, m.created])).toEqual([[a.id, true], [b.id, true], [c.id, false]]);
  expect(dry.skipped).toEqual([{ chat_id: loose.id, subfolder: "x", reason: "the chat has no project" }]);
  expect(store.subProjects(top.id)).toEqual([]);
  expect(store.getChat(a.id)?.subfolder).toBe("fridge");

  const run = migrateSubfoldersToSubprojects(store, { dryRun: false });
  expect(run.migrated).toHaveLength(3);
  const subs = store.subProjects(top.id);
  expect(subs.map((p) => [p.name, p.path])).toEqual([["fridge", join(root, "fridge")], ["oven", join(root, "oven")]]);
  const after = store.getChat(a.id)!;
  expect([after.id, after.project_id, after.subfolder, after.updated_at, after.title]).toEqual([before.id, subs[0]!.id, null, before.updated_at, "fridge"]);
  expect(store.chatMessageCount(a.id)).toBe(1);
  expect(store.getChat(b.id)?.project_id).toBe(subs[1]!.id);
  expect(store.getChat(c.id)?.project_id).toBe(subs[1]!.id);
  expect(store.getChat(plain.id)?.project_id).toBe(top.id);
  expect(store.getChat(old.id)).toMatchObject({ project_id: top.id, subfolder: "old" });
  expect(existsSync(join(root, "fridge"))).toBe(true);

  const again = migrateSubfoldersToSubprojects(store, { dryRun: false });
  expect(again.migrated).toEqual([]);
  expect(store.subProjects(top.id)).toHaveLength(2);
});

test("migration reuses an existing sub project, goes to the grandparent from a sub project, and skips an unusable subfolder", () => {
  const store = memStore();
  const root = folder("reuse");
  const top = store.createProject({ name: "top", path: root });
  const existing = store.createProject({ name: "fridge", path: join(root, "fridge"), parent_id: top.id });
  const a = store.createChat({ project_id: top.id, title: "a", harness: "claude", profile: "main", subfolder: "fridge" });
  const sub = store.createProject({ name: "sub", path: join(root, "sub"), parent_id: top.id });
  mkdirSync(join(root, "sub"));
  const b = store.createChat({ project_id: sub.id, title: "b", harness: "claude", profile: "main", subfolder: "deep" });
  writeFileSync(join(root, "afile"), "x");
  const c = store.createChat({ project_id: top.id, title: "c", harness: "claude", profile: "main", subfolder: "afile" });
  symlinkSync(tmpdir(), join(root, "out"));
  const d = store.createChat({ project_id: top.id, title: "d", harness: "claude", profile: "main", subfolder: "out" });
  const bare = store.createProject({ name: "bare" });
  const e = store.createChat({ project_id: bare.id, title: "e", harness: "claude", profile: "main", subfolder: "s" });

  const run = migrateSubfoldersToSubprojects(store, { dryRun: false });
  expect(store.getChat(a.id)?.project_id).toBe(existing.id);
  const deep = store.subProjects(top.id).find((p) => p.name === "deep");
  expect(deep?.path).toBe(join(root, "sub", "deep"));
  expect(store.getChat(b.id)?.project_id).toBe(deep!.id);
  expect(run.skipped.map((s) => s.chat_id).sort()).toEqual([c.id, d.id].sort());
  expect(store.getChat(c.id)?.subfolder).toBe("afile");
  const bareSub = store.subProjects(bare.id);
  expect(bareSub.map((p) => [p.name, p.path])).toEqual([["s", null]]);
  expect(store.getChat(e.id)?.project_id).toBe(bareSub[0]!.id);
  expect(migrateSubfoldersToSubprojects(store, { dryRun: false }).migrated).toEqual([]);
});

test("migrate-subprojects command: backup before writing, dry run writes nothing, json output, usage and missing db", () => {
  const home = folder("home");
  const root = folder("cmd");
  const seed = new ChatStore(join(home, "chats.db"));
  seedSubfolderChats(seed, root);
  seed.close();

  const dry = migrateSubprojectsCommand(["--home", home, "--dry-run"], {}, "s0");
  expect(dry.code).toBe(0);
  expect(dry.backup).toBeNull();
  expect(dry.lines[0]).toMatch(/^dry run: would move 3 chat/);
  expect(existsSync(join(home, "chats.db.bak-subprojects-s0"))).toBe(false);

  const real = migrateSubprojectsCommand(["--home", home], {}, "s1");
  expect(real.code).toBe(0);
  expect(real.backup).toBe(join(home, "chats.db.bak-subprojects-s1"));
  expect(real.lines.join("\n")).toMatch(/skipped .* the chat has no project/);
  const backup = new ChatStore(real.backup!);
  expect(backup.chatsWithSubfolder()).toHaveLength(4);
  backup.close();

  const again = migrateSubprojectsCommand(["--json"], { HARNESS_ORCH_HOME: home }, "s2");
  expect(again.backup).toBeNull();
  expect(JSON.parse(again.lines[0]!)).toMatchObject({ dry_run: false, migrated: [], backup: null });
  expect(existsSync(join(home, "chats.db.bak-subprojects-s2"))).toBe(false);

  expect(migrateSubprojectsCommand(["--bogus"], {}).code).toBe(2);
  const empty = folder("empty");
  expect(migrateSubprojectsCommand(["--home", empty], {}).code).toBe(1);
  rmSync(empty, { recursive: true });
});
