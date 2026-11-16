import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

import { chatRoots } from "./folders";
import { readProfiles } from "./options";

/**
 * Persistent Chromium profiles for the Playwright tools the agents use. A profile holds logins, so: folder mode 0700,
 * its files are never read here (only copied by name for seeding), never logged, and `.orch/browser` is skipped by the
 * workspace zip and the artifact scan. Chromium opens a profile in one browser at a time, hence the lock and the clone.
 */

export const NOTE_LIMIT = 400;
export const CLONE_MAX_AGE_MS: number = 24 * 60 * 60 * 1000;
const LOCK = ".orch-lock";
const SEED_ENTRIES = ["Default/Cookies", "Default/Cookies-journal", "Default/Network/Cookies", "Default/Network/Cookies-journal", "Default/Local Storage"];
const CACHE_NAMES = new Set(["Cache", "Code Cache", "GPUCache", "GrShaderCache", "ShaderCache", "DawnCache", "CacheStorage", "Crashpad", "component_crx_cache", "SingletonLock", "SingletonSocket", "SingletonCookie", LOCK]);

export interface ProfileRef {
  name: string;
  path: string;
}

export interface ProfileTargets {
  primary: ProfileRef;
  second: ProfileRef | null;
}

export interface BrowserChat {
  id: string;
  cwd: string | null;
  projectPath: string | null;
}

export function profileDir(folder: string, name: string): string {
  return join(folder, ".orch", "browser", name);
}

/** Same project folder: one profile. A chat folder that differs from the project's: its own plus the project's. No folder: `<home>/browser/chat-default`. */
export function profileTargets(home: string, cwd: string | null, projectPath: string | null): ProfileTargets {
  if (cwd === null && projectPath === null) {
    return { primary: { name: "chat-default", path: join(home, "browser", "chat-default") }, second: null };
  }
  const folder = cwd ?? (projectPath as string);
  const primary = { name: "default", path: profileDir(folder, "default") };
  if (cwd !== null && projectPath !== null && resolve(cwd) !== resolve(projectPath)) {
    return { primary, second: { name: "project", path: profileDir(projectPath, "default") } };
  }
  return { primary, second: null };
}

/** The `.orch` fence of a profile path under a folder (`<folder>/.orch/browser/<name>`), or null for the home profile. */
function folderOf(path: string): string | null {
  const parent = dirname(dirname(dirname(path)));
  return basename(dirname(dirname(path))) === ".orch" ? parent : null;
}

/** Creates the profile folder (0700) and `.orch/.gitignore` containing `*`. Idempotent. */
export function ensureProfile(path: string): void {
  const folder = folderOf(path);
  if (folder !== null) {
    const orch = join(folder, ".orch");
    mkdirSync(orch, { recursive: true });
    const ignore = join(orch, ".gitignore");
    if (!existsSync(ignore)) {
      writeFileSync(ignore, "*\n");
    }
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try {
    chmodSync(path, 0o700);
  } catch {
    // best effort on filesystems without modes
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface LockInfo {
  pid: number;
  chat: string;
}

export function readLock(path: string): LockInfo | null {
  try {
    const v = JSON.parse(readFileSync(join(path, LOCK), "utf8")) as Partial<LockInfo>;
    return typeof v.pid === "number" && typeof v.chat === "string" ? { pid: v.pid, chat: v.chat } : null;
  } catch {
    return null;
  }
}

/** The live holder of a profile (a dead pid is stale and does not count), or null. */
export function lockHolder(path: string, alive: (pid: number) => boolean = pidAlive): LockInfo | null {
  const lock = readLock(path);
  return lock !== null && alive(lock.pid) ? lock : null;
}

export interface Lease {
  /** The profile the agent must use for this run. */
  path: string;
  /** True when the original was busy and `path` is a copy whose logins are not kept. */
  clone: boolean;
  release(): void;
}

/** Moves a folder to a `.trash` sibling of its `browser` folder; never deletes. */
export function trashFolder(path: string): string {
  const trash = join(dirname(path), ".trash");
  mkdirSync(trash, { recursive: true, mode: 0o700 });
  const target = join(trash, `${basename(path)}-${Date.now()}`);
  renameSync(path, target);
  return target;
}

function copyWithoutCaches(from: string, to: string): void {
  mkdirSync(to, { recursive: true, mode: 0o700 });
  cpSync(from, to, { recursive: true, filter: (src) => !CACHE_NAMES.has(basename(src)) });
}

/**
 * Takes the profile for a chat's run. A stale lock (dead pid) or the chat's own lock is taken over; a live lock of
 * another chat gives the chat a clone `<name>-clone-<chat id>` next to it.
 */
export function acquireProfile(path: string, chatId: string, opts: { pid?: number; alive?: (pid: number) => boolean } = {}): Lease {
  const pid = opts.pid ?? process.pid;
  ensureProfile(path);
  const holder = lockHolder(path, opts.alive);
  if (holder === null || holder.chat === chatId) {
    writeFileSync(join(path, LOCK), JSON.stringify({ pid, chat: chatId }), { mode: 0o600 });
    return {
      path,
      clone: false,
      release: () => {
        if (readLock(path)?.chat === chatId) {
          try {
            writeFileSync(join(path, LOCK), "");
          } catch {
            // the profile was forgotten meanwhile
          }
        }
      },
    };
  }
  const clone = join(dirname(path), `${basename(path)}-clone-${chatId.replace(/[^A-Za-z0-9_-]/g, "_")}`);
  if (existsSync(clone)) {
    trashFolder(clone);
  }
  copyWithoutCaches(path, clone);
  return { path: clone, clone: true, release: () => (existsSync(clone) ? void trashFolder(clone) : undefined) };
}

/** Moves clones older than 24 h to the trash. Returns how many. */
export function sweepClones(browserDir: string, now: number = Date.now()): number {
  let n = 0;
  if (!existsSync(browserDir)) {
    return 0;
  }
  for (const entry of readdirSync(browserDir)) {
    const full = join(browserDir, entry);
    if (entry.includes("-clone-") && now - statSync(full).mtimeMs > CLONE_MAX_AGE_MS) {
      trashFolder(full);
      n++;
    }
  }
  return n;
}

/** Copies the cookie and local-storage entries of a project profile into an empty one. Only when the source is not in use. */
export function seedProfile(from: string, to: string, alive: (pid: number) => boolean = pidAlive): boolean {
  if (!existsSync(from) || lockHolder(from, alive) !== null || existsSync(join(to, "Default"))) {
    return false;
  }
  let copied = false;
  for (const rel of SEED_ENTRIES) {
    const src = join(from, rel);
    if (existsSync(src)) {
      mkdirSync(dirname(join(to, rel)), { recursive: true, mode: 0o700 });
      cpSync(src, join(to, rel), { recursive: true });
      copied = true;
    }
  }
  return copied;
}

/** `browser_profile_seed` in settings of profiles.json (default off). */
export function seedEnabled(home: string): boolean {
  return (readProfiles(home).settings as { browser_profile_seed?: unknown } | undefined)?.browser_profile_seed === true;
}

/** The variables Playwright MCP reads. `PLAYWRIGHT_BROWSERS_PATH` is passed on only when one is already configured. */
export function browserEnv(path: string, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = { PLAYWRIGHT_MCP_USER_DATA_DIR: path };
  if (base.PLAYWRIGHT_BROWSERS_PATH !== undefined && base.PLAYWRIGHT_BROWSERS_PATH !== "") {
    env.PLAYWRIGHT_BROWSERS_PATH = base.PLAYWRIGHT_BROWSERS_PATH;
  }
  return env;
}

export interface NoteInput {
  path: string;
  clone?: boolean;
  second?: ProfileRef | null;
}

/** The general note for the agent's instructions; under NOTE_LIMIT characters (the extras are dropped first). */
export function browserNote({ path, clone = false, second = null }: NoteInput): string {
  const login = "If a login is needed, ask the user to log in once in the opened browser window, then continue.";
  const cloneText = clone ? " It is a copy: logins made in it are not kept." : "";
  const more = second === null ? "" : ` Second profile "${second.name}": ${second.path}.`;
  const build = (cli: boolean, extra: string): string =>
    `Browser: when you use Playwright, use the persistent profile at ${path} (it keeps logins; never log out, never clear cookies, never commit it${cli ? "; playwright-cli: open --persistent --profile <path>" : ""}).${cloneText}${extra} ${login}`;
  for (const note of [build(true, more), build(false, more), build(true, ""), build(false, "")]) {
    if (note.length < NOTE_LIMIT) {
      return note;
    }
  }
  const tight = `Browser: use the Playwright profile at ${path}${clone ? " (a copy: logins made in it are not kept)" : ""}. Never log out, clear cookies or commit it. ${login}`;
  return tight.length < NOTE_LIMIT ? tight : `Browser: Playwright profile ${path}; never log out or clear cookies.`.slice(0, NOTE_LIMIT - 1);
}

/** Registry of known profiles in `<home>/browser/registry.json`: path, chats that used it, last use. Written by the server only. */
interface Entry {
  chats: string[];
  last_used: string;
}

function registryFile(home: string): string {
  return join(home, "browser", "registry.json");
}

function readRegistry(home: string): Record<string, Entry> {
  try {
    return JSON.parse(readFileSync(registryFile(home), "utf8")) as Record<string, Entry>;
  } catch {
    return {};
  }
}

export function recordUse(home: string, path: string, chatId: string, now: Date = new Date()): void {
  const reg = readRegistry(home);
  const entry = reg[path] ?? { chats: [], last_used: "" };
  if (!entry.chats.includes(chatId)) {
    entry.chats.push(chatId);
  }
  entry.last_used = now.toISOString();
  reg[path] = entry;
  mkdirSync(join(home, "browser"), { recursive: true, mode: 0o700 });
  writeFileSync(registryFile(home), JSON.stringify(reg, null, 2));
}

export interface ProfileInfo {
  path: string;
  size_bytes: number;
  last_used: string | null;
  chats: string[];
  in_use: boolean;
}

function sizeOf(dir: string): number {
  let total = 0;
  try {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = lstatSync(full);
      total += st.isDirectory() ? sizeOf(full) : st.size;
    }
  } catch {
    // vanished while counting
  }
  return total;
}

export function listProfiles(home: string, alive: (pid: number) => boolean = pidAlive): ProfileInfo[] {
  return Object.entries(readRegistry(home))
    .filter(([path]) => existsSync(path))
    .map(([path, e]) => ({ path, size_bytes: sizeOf(path), last_used: e.last_used === "" ? null : e.last_used, chats: e.chats, in_use: lockHolder(path, alive) !== null }))
    .sort((a, b) => (b.last_used ?? "").localeCompare(a.last_used ?? ""));
}

export class BrowserProfileError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** A profile path may be forgotten when it is known, lies under `<root>/.orch/browser/` of an allowed root (or `<home>/browser/`), and is not in use. */
export function forgetProfile(home: string, path: string, alive: (pid: number) => boolean = pidAlive): string {
  const reg = readRegistry(home);
  if (reg[path] === undefined) {
    throw new BrowserProfileError(404, "unknown browser profile");
  }
  if (!existsSync(path)) {
    throw new BrowserProfileError(404, "the profile folder is gone");
  }
  const real = realpathSync(path);
  const homeBrowser = join(realpathSync(home), "browser");
  const underHome = real.startsWith(homeBrowser + sep);
  const underRoot = chatRoots(home).some((root) => {
    const r = realpathSync(root);
    return real.startsWith(r + sep) && real.includes(`${sep}.orch${sep}browser${sep}`);
  });
  if (!underHome && !underRoot) {
    throw new BrowserProfileError(400, "path: outside the known browser profile folders");
  }
  if (lockHolder(path, alive) !== null) {
    throw new BrowserProfileError(409, "the profile is in use by a running chat");
  }
  const target = trashFolder(path);
  delete reg[path];
  writeFileSync(registryFile(home), JSON.stringify(reg, null, 2));
  return target;
}

/** True for a path the workspace zip and the artifact scan must skip. */
export function isBrowserPath(path: string): boolean {
  return path.includes(`${sep}.orch${sep}browser${sep}`) || path.endsWith(`${sep}.orch${sep}browser`);
}

/** The profile Playwright MCP gets through the environment of a claude session: the primary one of the session's folder. */
export function primaryForCwd(home: string, cwd: string | undefined): string {
  if (cwd === undefined || cwd === join(home, "chats", "workspace")) {
    return profileTargets(home, null, null).primary.path;
  }
  return profileTargets(home, cwd, null).primary.path;
}

/** Per-service state: the lease of a running turn and the path the agent last heard about, per chat. */
export class BrowserProfiles {
  private get home(): string {
    return typeof this.homeOf === "string" ? this.homeOf : this.homeOf();
  }

  private readonly leases = new Map<string, Lease>();
  private readonly told = new Map<string, string>();

  constructor(private readonly homeOf: string | (() => string), private readonly alive: (pid: number) => boolean = pidAlive) {}

  /** Takes the profile for a turn and returns the note, or "" when this session already has it. Never throws. */
  startTurn(chat: BrowserChat, repeatEveryTurn: boolean): string {
    try {
      this.endTurn(chat.id);
      const { primary, second } = profileTargets(this.home, chat.cwd, chat.projectPath);
      ensureProfile(primary.path);
      if (second !== null && seedEnabled(this.home)) {
        seedProfile(second.path, primary.path, this.alive);
      }
      const lease = acquireProfile(primary.path, chat.id, { alive: this.alive });
      this.leases.set(chat.id, lease);
      recordUse(this.home, primary.path, chat.id);
      if (second !== null && existsSync(second.path)) {
        recordUse(this.home, second.path, chat.id);
      }
      const key = `${lease.path}|${second?.path ?? ""}`;
      if (!repeatEveryTurn && this.told.get(chat.id) === key) {
        return "";
      }
      this.told.set(chat.id, key);
      return browserNote({ path: lease.path, clone: lease.clone, second });
    } catch {
      return "";
    }
  }

  endTurn(chatId: string): void {
    const lease = this.leases.get(chatId);
    if (lease !== undefined) {
      this.leases.delete(chatId);
      lease.release();
    }
  }

  /** A new session of the chat (restart, harness change) hears the note again. */
  forgetSession(chatId: string): void {
    this.told.delete(chatId);
  }
}
