import { existsSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import type { BuildCommit, BuildInfo } from "../../shared/types/build-info";
import { SwrCache } from "./swr-cache";

export const CACHE_MS: number = 30_000;
export const TIMEOUT_MS: number = 5_000;
const MAX_COMMITS = 20;
const MAX_FILES = 8;
const SCAN_DIRS: readonly string[] = ["src", "skills/orch/scripts", "skills/orch/references"];
const SCAN_PATTERNS: readonly string[] = SCAN_DIRS.map((d) => `${d}/**/*`);
const FIELD = "\u001f";

export interface BuildServiceOptions {
  root: string;
  cacheMs?: number;
  timeoutMs?: number;
  gitBin?: string;
  /** Watch the scanned folders and revalidate on a change (default true). */
  watch?: boolean;
}

type Core = Omit<BuildInfo, "busy" | "deploy">;

export function isTracked(path: string): boolean {
  return !path.split("/").includes("node_modules") && !/\.test\.[^/]*$/.test(path);
}

class Timeout extends Error {}

const SHA = /^[0-9a-f]{40,64}$/;

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

/** The git dir (a worktree's own dir when .git is a pointer file) and the common dir holding refs. */
export function gitDirs(root: string): { gitDir: string; commonDir: string } {
  const dotGit = join(root, ".git");
  const pointer = readText(dotGit)?.match(/^gitdir:\s*(.+)$/)?.[1];
  const gitDir = pointer ? resolve(root, pointer.trim()) : dotGit;
  const common = readText(join(gitDir, "commondir"));
  return { gitDir, commonDir: common ? resolve(gitDir, common) : gitDir };
}

/** Reads HEAD from the .git files, so no git process can time out under load. Null when the root is not a repo. */
export function readHeadSha(root: string): string | null {
  const { gitDir, commonDir } = gitDirs(root);
  const head = readText(join(gitDir, "HEAD"));
  if (head === null) return null;
  if (!head.startsWith("ref: ")) return SHA.test(head) ? head : null;
  const ref = head.slice(5).trim();
  for (const dir of [gitDir, commonDir]) {
    const sha = readText(join(dir, ref));
    if (sha !== null && SHA.test(sha)) return sha;
  }
  const packed = readText(join(commonDir, "packed-refs")) ?? "";
  for (const line of packed.split("\n")) {
    const [sha, name] = line.split(" ");
    if (name === ref && sha !== undefined && SHA.test(sha)) return sha;
  }
  return null;
}

/** Records what this process booted with, and answers "does the code on disk differ?" without blocking the event loop. */
export class BuildService {
  readonly bootAt: string;
  readonly bootHead: string | null;
  private readonly root: string;
  private readonly cacheMs: number;
  private readonly timeoutMs: number;
  private readonly gitBin: string;
  private readonly cache: SwrCache<Core>;
  private readonly watchers: FSWatcher[] = [];
  private watching: boolean;

  constructor(options: BuildServiceOptions) {
    this.root = options.root;
    this.cacheMs = options.cacheMs ?? CACHE_MS;
    this.timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
    this.gitBin = options.gitBin ?? "git";
    this.bootAt = new Date().toISOString();
    this.bootHead = readHeadSha(this.root);
    // No cache key: reading .git on the request path costs up to 800 ms under load. The watchers on .git
    // (HEAD, refs, index) and the source folders invalidate instead; check() also compares HEAD.
    this.cache = new SwrCache<Core>(() => this.compute().catch((err: unknown) => this.failed(err)), this.cacheMs);
    // Watchers start with the first read, so a server that never asks does not watch or scan.
    this.watching = !(options.watch ?? true);
  }

  /**
   * Never waits on git, the file scan or a file read: the last result, served stale-while-revalidate (TTL cacheMs; a
   * change to .git HEAD, refs or index, or to a watched source file, revalidates in the background). Before the first
   * scan ends, the boot HEAD with no other detail.
   */
  current(): Core {
    if (!this.watching) {
      setImmediate(() => this.startWatchers());
    }
    return this.cache.get(() => this.quick());
  }

  /** Waits for a result no older than cacheMs and for the HEAD on disk; concurrent callers share one run; never rejects. */
  check(): Promise<Core> {
    this.startWatchers();
    const last = this.cache.peek();
    if (last !== null && last.head !== readHeadSha(this.root)) {
      this.cache.invalidate();
    }
    return this.cache.fresh();
  }

  /** Stops the file watchers. */
  close(): void {
    for (const w of this.watchers.splice(0)) {
      w.close();
    }
  }

  private watchGit(): void {
    const { gitDir, commonDir } = gitDirs(this.root);
    const relevant = (name: string): boolean => name === "HEAD" || name === "index" || name === "packed-refs" || name.startsWith("refs");
    const targets: [string, boolean][] = [[gitDir, false], [commonDir, false], [join(commonDir, "refs"), true]];
    for (const [abs, recursive] of new Map(targets)) {
      if (!existsSync(abs)) {
        continue;
      }
      try {
        const w = watch(abs, { recursive, persistent: false }, (_event, name) => {
          if (recursive || name === null || relevant(String(name))) {
            this.cache.invalidate();
          }
        });
        w.on("error", () => w.close());
        this.watchers.push(w);
      } catch {
        // No watcher: the TTL still revalidates.
      }
    }
  }

  private startWatchers(): void {
    if (this.watching) {
      return;
    }
    this.watching = true;
    this.watchGit();
    for (const dir of SCAN_DIRS) {
      const abs = join(this.root, dir);
      if (!existsSync(abs)) {
        continue;
      }
      try {
        const w = watch(abs, { recursive: true, persistent: false }, (_event, name) => {
          if (name === null || isTracked(join(dir, String(name)))) {
            this.cache.invalidate();
          }
        });
        w.on("error", () => w.close());
        this.watchers.push(w);
      } catch {
        // No watcher: the TTL still revalidates.
      }
    }
  }

  /** The answer before the first full check ends: the boot HEAD, not stale. */
  private quick(): Core {
    return this.empty(null, this.bootHead);
  }

  private empty(error: string | null, head: string | null = null): Core {
    return {
      boot_at: this.bootAt,
      boot_head: this.bootHead,
      head,
      branch: null,
      stale: false,
      reasons: [],
      missing_commits: [],
      missing_total: 0,
      changed_files: { count: 0, newest: [] },
      uncommitted: { count: 0 },
      error,
    };
  }

  /** A failed probe still reports the HEAD read from the files, so a deploy can see the sha it switched to. */
  private failed(err: unknown): Core {
    const text = err instanceof Timeout ? `timed out after ${this.timeoutMs} ms` : err instanceof Error ? err.message : String(err);
    return this.empty(text, readHeadSha(this.root));
  }

  private async git(args: string[], deadline: number): Promise<string> {
    const left = deadline - Date.now();
    if (left <= 0) {
      throw new Timeout();
    }
    const proc = Bun.spawn([this.gitBin, "-C", this.root, ...args], { stdout: "pipe", stderr: "pipe" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A grandchild can keep the pipes open after the kill, so the wait races the deadline instead of trusting EOF.
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        proc.kill();
        reject(new Timeout());
      }, left);
    });
    try {
      const [out, err, code] = await Promise.race([
        Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]),
        expired,
      ]);
      if (code !== 0) {
        throw new Error(`git ${args[0] ?? ""} failed: ${err.trim().slice(0, 200)}`);
      }
      return out;
    } finally {
      clearTimeout(timer);
    }
  }

  private async changedFiles(bootMs: number, deadline: number): Promise<{ count: number; newest: { path: string; mtime: string }[] }> {
    const changed: { path: string; ms: number }[] = [];
    for (const pattern of SCAN_PATTERNS) {
      for await (const file of new Bun.Glob(pattern).scan({ cwd: this.root, absolute: true, onlyFiles: true })) {
        if (Date.now() >= deadline) {
          throw new Timeout();
        }
        const path = relative(this.root, file);
        if (!isTracked(path)) {
          continue;
        }
        const info = await stat(file).catch(() => null);
        if (info !== null && info.mtimeMs > bootMs) {
          changed.push({ path, ms: info.mtimeMs });
        }
      }
    }
    changed.sort((a, b) => b.ms - a.ms);
    return { count: changed.length, newest: changed.slice(0, MAX_FILES).map((f) => ({ path: f.path, mtime: new Date(f.ms).toISOString() })) };
  }

  private async compute(): Promise<Core> {
    const deadline = Date.now() + this.timeoutMs;
    const sha = readHeadSha(this.root) ?? (await this.git(["rev-parse", "HEAD"], deadline)).trim();
    const [branch, status, files] = await Promise.all([
      this.git(["rev-parse", "--abbrev-ref", "HEAD"], deadline),
      this.git(["status", "--porcelain"], deadline),
      this.changedFiles(Date.parse(this.bootAt), deadline),
    ]);
    let commits: BuildCommit[] = [];
    let total = 0;
    if (this.bootHead !== null && sha !== this.bootHead) {
      const range = `${this.bootHead}..${sha}`;
      const [log, count] = await Promise.all([
        this.git(["log", `--format=%H${FIELD}%s${FIELD}%cI`, "-n", String(MAX_COMMITS), range], deadline),
        this.git(["rev-list", "--count", range], deadline),
      ]);
      commits = log
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => {
          const [s = "", subject = "", date = ""] = line.split(FIELD);
          return { sha: s, subject, date };
        });
      total = Number.parseInt(count.trim(), 10) || commits.length;
    }
    const reasons: ("commits" | "files")[] = [];
    if (this.bootHead !== null && sha !== this.bootHead) {
      reasons.push("commits");
    }
    if (files.count > 0) {
      reasons.push("files");
    }
    return {
      ...this.empty(null),
      head: sha,
      branch: branch.trim(),
      stale: reasons.length > 0,
      reasons,
      missing_commits: commits,
      missing_total: total,
      changed_files: files,
      uncommitted: { count: status.split("\n").filter((l) => l !== "").length },
    };
  }
}
