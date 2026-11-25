import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import type { BuildCommit, BuildInfo } from "../../shared/types/build-info";

export const CACHE_MS: number = 10_000;
export const TIMEOUT_MS: number = 5_000;
const MAX_COMMITS = 20;
const MAX_FILES = 8;
const SCAN_PATTERNS: readonly string[] = ["src/**/*", "skills/orch/scripts/**/*", "skills/orch/references/**/*"];
const FIELD = "\u001f";

export interface BuildServiceOptions {
  root: string;
  cacheMs?: number;
  timeoutMs?: number;
  gitBin?: string;
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

/** Reads HEAD from the .git files, so no git process can time out under load. Null when the root is not a repo. */
export function readHeadSha(root: string): string | null {
  const dotGit = join(root, ".git");
  const pointer = readText(dotGit)?.match(/^gitdir:\s*(.+)$/)?.[1];
  const gitDir = pointer ? resolve(root, pointer.trim()) : dotGit;
  const head = readText(join(gitDir, "HEAD"));
  if (head === null) return null;
  if (!head.startsWith("ref: ")) return SHA.test(head) ? head : null;
  const ref = head.slice(5).trim();
  const common = readText(join(gitDir, "commondir"));
  const commonDir = common ? resolve(gitDir, common) : gitDir;
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
  private cached: { at: number; value: Promise<Core> } | null = null;

  constructor(options: BuildServiceOptions) {
    this.root = options.root;
    this.cacheMs = options.cacheMs ?? CACHE_MS;
    this.timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
    this.gitBin = options.gitBin ?? "git";
    this.bootAt = new Date().toISOString();
    this.bootHead = readHeadSha(this.root) ?? this.headSync();
  }

  private headSync(): string | null {
    try {
      const out = Bun.spawnSync([this.gitBin, "-C", this.root, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "ignore", timeout: this.timeoutMs });
      const sha = out.stdout.toString().trim();
      return out.exitCode === 0 && sha !== "" ? sha : null;
    } catch {
      return null;
    }
  }

  /** Cached for 10 s and shared by concurrent callers; never rejects. */
  check(): Promise<Core> {
    const now = Date.now();
    if (this.cached !== null && now - this.cached.at < this.cacheMs) {
      return this.cached.value;
    }
    const value = this.compute().catch((err: unknown) => this.failed(err));
    this.cached = { at: now, value };
    return value;
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
