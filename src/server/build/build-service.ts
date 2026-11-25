import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import type { BuildCommit, BuildInfo, DeployInfo } from "../../shared/types/build-info";
import { lastFailure, readCurrent } from "./deploy-status";
import { EVERY_MS, FIRST_MS, Periodic, type Timers } from "./periodic";

export const TIMEOUT_MS: number = 20_000;
const MAX_COMMITS = 20;
const MAX_FILES = 8;
const SCAN_DIRS: readonly string[] = ["src", "skills/orch/scripts", "skills/orch/references"];
const SCAN_PATTERNS: readonly string[] = SCAN_DIRS.map((d) => `${d}/**/*`);
const FIELD = "\u001f";

export interface BuildServiceOptions {
  root: string;
  /** The orch home; when set, the refresh also reads deploy/current.json and counts the commits behind master. */
  home?: string;
  /** Hard cap for one refresh; the git children are killed when it passes. */
  timeoutMs?: number;
  gitBin?: string;
  firstMs?: number;
  everyMs?: number;
  timers?: Timers;
}

export type Core = Omit<BuildInfo, "busy">;

export function isTracked(path: string): boolean {
  return !path.split("/").includes("node_modules") && !/\.test\.[^/]*$/.test(path);
}

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

/**
 * Records what this process booted with, and answers "does the code on disk differ?". One background refresh runs
 * `firstMs` after `start()` and then every `everyMs` (git at nice 19, killed after `timeoutMs`, one at a time; a failed
 * refresh keeps the last value). `current()` only reads memory.
 */
export class BuildService {
  readonly bootAt: string;
  readonly bootHead: string | null;
  private readonly root: string;
  private readonly home: string | null;
  private readonly gitBin: string;
  private readonly periodic: Periodic<Core>;

  constructor(options: BuildServiceOptions) {
    this.root = options.root;
    this.home = options.home ?? null;
    this.gitBin = options.gitBin ?? "git";
    this.bootAt = new Date().toISOString();
    this.bootHead = readHeadSha(this.root);
    const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
    this.periodic = new Periodic<Core>((signal) => this.compute(signal), {
      timeoutMs,
      firstMs: options.firstMs ?? FIRST_MS,
      everyMs: options.everyMs ?? EVERY_MS,
      ...(options.timers === undefined ? {} : { timers: options.timers }),
      // Before any good result, a failure is reported with the HEAD from the files, so a deploy can see its sha.
      onFirstError: (err) => this.empty(err instanceof Error ? err.message : String(err), readHeadSha(this.root)),
    });
  }

  /** Starts the background refresh timers (unref'd). */
  start(): void {
    this.periodic.start();
  }

  stop(): void {
    this.periodic.stop();
  }

  /** The last refresh result; before the first one ends, the boot HEAD with no other detail. Never runs git or reads a file. */
  current(): Core {
    return this.periodic.get() ?? this.empty(null, this.bootHead);
  }

  /** Runs one refresh now (skipped when one is running) and answers the current value; never rejects. */
  async refresh(): Promise<Core> {
    await this.periodic.tick();
    return this.current();
  }

  private empty(error: string | null, head: string | null = null): Core {
    return {
      deploy: null,
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

  /** git at nice 19; the abort signal (the refresh timeout) kills it. */
  private async git(args: string[], signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const proc = Bun.spawn(["nice", "-n", "19", this.gitBin, "-C", this.root, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", signal, killSignal: "SIGKILL" });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    signal.throwIfAborted();
    if (code !== 0) {
      throw new Error(`git ${args[0] ?? ""} failed: ${err.trim().slice(0, 200)}`);
    }
    return out;
  }

  private async changedFiles(bootMs: number, signal: AbortSignal): Promise<{ count: number; newest: { path: string; mtime: string }[] }> {
    const changed: { path: string; ms: number }[] = [];
    for (const pattern of SCAN_PATTERNS) {
      for await (const file of new Bun.Glob(pattern).scan({ cwd: this.root, absolute: true, onlyFiles: true })) {
        signal.throwIfAborted();
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

  private async deployInfo(signal: AbortSignal): Promise<DeployInfo | null> {
    if (this.home === null) {
      return null;
    }
    const cur = readCurrent(this.home);
    const failed = lastFailure(this.home);
    if (cur === null && failed === null) {
      return null;
    }
    let behind: number | null = null;
    if (cur !== null) {
      const n = (await this.git(["rev-list", "--count", `${cur.sha}..master`], signal).catch(() => "")).trim();
      behind = /^\d+$/.test(n) ? Number(n) : null;
    }
    return { sha: cur?.sha ?? null, short: cur === null ? null : cur.sha.slice(0, 7), ref: cur?.ref ?? null, deployed_at: cur?.deployed_at ?? null, behind, failed };
  }

  private async compute(signal: AbortSignal): Promise<Core> {
    const sha = readHeadSha(this.root) ?? (await this.git(["rev-parse", "HEAD"], signal)).trim();
    const [branch, status, files, deploy] = await Promise.all([
      this.git(["rev-parse", "--abbrev-ref", "HEAD"], signal),
      this.git(["status", "--porcelain"], signal),
      this.changedFiles(Date.parse(this.bootAt), signal),
      this.deployInfo(signal),
    ]);
    let commits: BuildCommit[] = [];
    let total = 0;
    if (this.bootHead !== null && sha !== this.bootHead) {
      const range = `${this.bootHead}..${sha}`;
      const [log, count] = await Promise.all([
        this.git(["log", `--format=%H${FIELD}%s${FIELD}%cI`, "-n", String(MAX_COMMITS), range], signal),
        this.git(["rev-list", "--count", range], signal),
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
      deploy,
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
