import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startTestServer } from "../test-support/test-server";
import type { TestServerHandle } from "../types/test-server-handle";
import {
  acquireProfile, BrowserProfiles, browserEnv, browserNote, ensureProfile, forgetProfile, listProfiles, NOTE_LIMIT, primaryForCwd, profileTargets, recordUse, seedProfile, sweepClones,
} from "./browser-profile";
import { Workspace } from "./workspace";

const base = realpathSync(mkdtempSync(join(tmpdir(), "browser-profile-")));
const home = join(base, "home");
const proj = join(base, "root/proj");
const sub = join(base, "root/sub");
mkdirSync(home, { recursive: true });
mkdirSync(proj, { recursive: true });
mkdirSync(sub, { recursive: true });
writeFileSync(join(home, "profiles.json"), JSON.stringify({ settings: { chat_roots: [join(base, "root")] } }));
const alive = (pid: number): boolean => pid === process.pid;
const DEAD = 2147483000;

describe("path selection", () => {
  test("same folder, different folder, no folder", () => {
    expect(profileTargets(home, proj, proj)).toEqual({ primary: { name: "default", path: join(proj, ".orch/browser/default") }, second: null });
    expect(profileTargets(home, proj, null).second).toBeNull();
    expect(profileTargets(home, null, proj).primary.path).toBe(join(proj, ".orch/browser/default"));
    const t = profileTargets(home, sub, proj);
    expect([t.primary.path, t.second?.name, t.second?.path]).toEqual([join(sub, ".orch/browser/default"), "project", join(proj, ".orch/browser/default")]);
    expect(profileTargets(home, null, null).primary.path).toBe(join(home, "browser/chat-default"));
    expect(primaryForCwd(home, join(home, "chats/workspace"))).toBe(join(home, "browser/chat-default"));
    expect(primaryForCwd(home, sub)).toBe(join(sub, ".orch/browser/default"));
  });

  test("ensureProfile makes the folder 0700 and .orch/.gitignore with *", () => {
    const p = join(sub, ".orch/browser/default");
    ensureProfile(p);
    expect(readFileSync(join(sub, ".orch/.gitignore"), "utf8")).toBe("*\n");
    expect(statSync(p).mode & 0o777).toBe(0o700);
    writeFileSync(join(sub, ".orch/.gitignore"), "keep\n");
    ensureProfile(p);
    expect(readFileSync(join(sub, ".orch/.gitignore"), "utf8")).toBe("keep\n");
  });
});

describe("lock manager", () => {
  const p = join(base, "lock-folder/.orch/browser/default");

  test("free profile is locked, a live holder gives the other chat a clone without caches", () => {
    const a = acquireProfile(p, "chat-a", { alive });
    expect(a.clone).toBe(false);
    expect(JSON.parse(readFileSync(join(p, ".orch-lock"), "utf8"))).toEqual({ pid: process.pid, chat: "chat-a" });
    mkdirSync(join(p, "Default"), { recursive: true });
    mkdirSync(join(p, "Cache"), { recursive: true });
    writeFileSync(join(p, "Default/Cookies"), "x");
    writeFileSync(join(p, "Cache/big"), "y");
    expect(acquireProfile(p, "chat-a", { alive }).clone).toBe(false);
    const b = acquireProfile(p, "chat-b", { alive });
    expect(b.clone).toBe(true);
    expect(b.path).toBe(join(p, "../default-clone-chat-b"));
    expect(existsSync(join(b.path, "Default/Cookies"))).toBe(true);
    expect([existsSync(join(b.path, "Cache")), existsSync(join(b.path, ".orch-lock"))]).toEqual([false, false]);
    b.release();
    expect(existsSync(b.path)).toBe(false);
    expect(readdirSync(join(p, "../.trash")).length).toBe(1);
    a.release();
    expect(acquireProfile(p, "chat-b", { alive }).clone).toBe(false);
  });

  test("a stale lock of a dead pid is taken over", () => {
    const q = join(base, "stale/.orch/browser/default");
    ensureProfile(q);
    writeFileSync(join(q, ".orch-lock"), JSON.stringify({ pid: DEAD, chat: "chat-x" }));
    const lease = acquireProfile(q, "chat-y", { alive });
    expect([lease.clone, JSON.parse(readFileSync(join(q, ".orch-lock"), "utf8")).chat]).toEqual([false, "chat-y"]);
  });

  test("the sweep trashes clones older than 24 h only", () => {
    const dir = join(base, "sweep/.orch/browser");
    mkdirSync(join(dir, "default-clone-old"), { recursive: true });
    mkdirSync(join(dir, "default-clone-new"), { recursive: true });
    mkdirSync(join(dir, "default"), { recursive: true });
    const old = new Date(Date.now() - 25 * 3600_000);
    utimesSync(join(dir, "default-clone-old"), old, old);
    utimesSync(join(dir, "default"), old, old);
    expect(sweepClones(dir)).toBe(1);
    expect(readdirSync(dir).sort()).toEqual([".trash", "default", "default-clone-new"]);
  });

  test("seeding copies cookies and local storage only into an empty profile and only when the source is free", () => {
    const from = join(base, "seed/from");
    const to = join(base, "seed/to");
    mkdirSync(join(from, "Default/Local Storage"), { recursive: true });
    writeFileSync(join(from, "Default/Cookies"), "c");
    writeFileSync(join(from, "Default/History"), "h");
    writeFileSync(join(from, ".orch-lock"), JSON.stringify({ pid: process.pid, chat: "c" }));
    expect(seedProfile(from, to, alive)).toBe(false);
    writeFileSync(join(from, ".orch-lock"), JSON.stringify({ pid: DEAD, chat: "c" }));
    expect(seedProfile(from, to, alive)).toBe(true);
    expect(readdirSync(join(to, "Default")).sort()).toEqual(["Cookies", "Local Storage"]);
    expect(seedProfile(from, to, alive)).toBe(false);
  });
});

describe("env and note", () => {
  test("env sets the MCP data dir; the browsers path only when configured", () => {
    expect(browserEnv("/p", {})).toEqual({ PLAYWRIGHT_MCP_USER_DATA_DIR: "/p" });
    expect(browserEnv("/p", { PLAYWRIGHT_BROWSERS_PATH: "/b" })).toEqual({ PLAYWRIGHT_MCP_USER_DATA_DIR: "/p", PLAYWRIGHT_BROWSERS_PATH: "/b" });
  });

  test("note text, second profile, clone text, and under 400 characters even for long paths", () => {
    const n = browserNote({ path: "/a/.orch/browser/default", second: { name: "project", path: "/b/.orch/browser/default" } });
    expect(n).toStartWith("Browser: when you use Playwright, use the persistent profile at /a/.orch/browser/default (it keeps logins; never log out, never clear cookies, never commit it");
    expect(n).toContain("ask the user to log in once in the opened browser window, then continue.");
    expect(n).toContain('Second profile "project": /b/.orch/browser/default');
    expect(browserNote({ path: "/a", clone: true })).toContain("logins made in it are not kept");
    const long = `/${"x".repeat(120)}/.orch/browser/default`;
    for (const input of [{ path: long, second: { name: "project", path: long } }, { path: long, clone: true, second: { name: "project", path: long } }]) {
      expect(browserNote(input).length).toBeLessThan(NOTE_LIMIT);
    }
  });

  test("the note is sent on the first turn and when the path changes, not on every turn (local-llm: every turn)", () => {
    const bp = new BrowserProfiles(home, alive);
    const chat = { id: "chat-1", cwd: proj, projectPath: proj };
    expect(bp.startTurn(chat, false)).toContain(join(proj, ".orch/browser/default"));
    expect(bp.startTurn(chat, false)).toBe("");
    expect(bp.startTurn(chat, true)).not.toBe("");
    const moved = bp.startTurn({ ...chat, cwd: sub }, false);
    expect(moved).toContain(join(sub, ".orch/browser/default"));
    bp.endTurn("chat-1");
    expect(bp.startTurn({ id: "chat-2", cwd: null, projectPath: null }, false)).toContain(join(home, "browser/chat-default"));
  });

  test("two chats in one folder: the second gets a clone and the note says so", () => {
    const bp = new BrowserProfiles(home, alive);
    const folder = { cwd: proj, projectPath: null };
    expect(bp.startTurn({ id: "c-one", ...folder }, false)).not.toContain("not kept");
    const second = bp.startTurn({ id: "c-two", ...folder }, false);
    expect(second).toContain("default-clone-c-two");
    expect(second).toContain("not kept");
    bp.endTurn("c-two");
    bp.endTurn("c-one");
  });
});

describe("workspace zip", () => {
  test("skips .orch/browser", () => {
    const dir = join(base, "zipfolder");
    mkdirSync(join(dir, ".orch/browser/default"), { recursive: true });
    writeFileSync(join(dir, ".orch/browser/default/Cookies"), "SECRETCOOKIE");
    writeFileSync(join(dir, ".orch/notes.txt"), "ok");
    const zip = Buffer.from(new Workspace("folder", join(dir, ".orch"), dir).zip()).toString("latin1");
    expect(zip).toContain("notes.txt");
    expect(zip).not.toContain("Cookies");
    expect(zip).not.toContain("SECRETCOOKIE");
  });
});

describe("API", () => {
  const servers: TestServerHandle[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.stop();
  });

  test("list shows metadata only; forget moves to .trash; unknown and outside paths are refused", async () => {
    const srv = startTestServer();
    servers.push(srv);
    const h = realpathSync(srv.home.resolve("."));
    const folder = join(base, "root/api");
    srv.home.write("profiles.json", JSON.stringify({ settings: { chat_roots: [join(base, "root")] } }));
    const p = join(folder, ".orch/browser/default");
    ensureProfile(p);
    writeFileSync(join(p, "Cookies"), "SECRET");
    recordUse(h, p, "chat-1");
    const listed = (await (await srv.api("/api/browser-profiles")).json()) as { profiles: Array<{ path: string; size_bytes: number; chats: string[]; in_use: boolean }> };
    expect(listed.profiles).toHaveLength(1);
    expect(listed.profiles[0]).toMatchObject({ path: p, size_bytes: 6, chats: ["chat-1"], in_use: false });
    expect(JSON.stringify(listed)).not.toContain("SECRET");
    const post = (path: string): Promise<Response> => srv.api("/api/browser-profiles/forget", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) });
    expect((await post(join(base, "root"))).status).toBe(404);
    expect((await post("/etc")).status).toBe(404);
    writeFileSync(join(p, ".orch-lock"), JSON.stringify({ pid: process.pid, chat: "chat-1" }));
    expect((await post(p)).status).toBe(409);
    writeFileSync(join(p, ".orch-lock"), "");
    const done = await post(p);
    expect(done.status).toBe(200);
    expect(existsSync(p)).toBe(false);
    expect(existsSync(((await done.json()) as { trashed_to: string }).trashed_to)).toBe(true);
    expect(listProfiles(h)).toEqual([]);
  });

  test("a recorded path outside the allowed folders is refused (400)", () => {
    const stray = join(base, "stray");
    mkdirSync(stray, { recursive: true });
    recordUse(home, stray, "c");
    expect(() => forgetProfile(home, stray, alive)).toThrow("outside the known browser profile folders");
    expect(existsSync(stray)).toBe(true);
  });
});
