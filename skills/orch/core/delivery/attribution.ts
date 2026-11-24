// Working-tree attribution for delivery. At dispatch a job records start_status.json: every dirty path of the repo
// with a hash of its content (null when missing). Later, the files a node changed are the dirty paths whose content
// differs from that snapshot. Reads git and files only; never stages, stashes or commits.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type StatusSnapshot = Record<string, string | null>;

function gitSync(repo: string, args: string[]): { code: number; out: string } {
  const p = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "ignore" });
  return { code: p.exitCode ?? 1, out: p.stdout.toString() };
}

/** Hash of a file's bytes, or null when it is missing or not a file. */
export function fileHash(path: string): string | null {
  try {
    if (!statSync(path).isFile()) return null;
    return Bun.hash(readFileSync(path)).toString(16);
  } catch {
    return null;
  }
}

/** Dirty paths of the repo (modified, added, deleted, untracked), repo-relative. Renames report the new path. */
// Inside withDirtyCache, each repo's git status is read once (a scan over many nodes of one repo).
let dirtyCache: Map<string, string[]> | null = null;
export async function withDirtyCache<T>(fn: () => Promise<T>): Promise<T> {
  if (dirtyCache) return fn();
  dirtyCache = new Map();
  try {
    return await fn();
  } finally {
    dirtyCache = null;
  }
}

export function dirtyPaths(repo: string): string[] {
  if (!dirtyCache) return readDirty(repo);
  const hit = dirtyCache.get(repo);
  if (hit) return hit;
  const paths = readDirty(repo);
  dirtyCache.set(repo, paths);
  return paths;
}

function readDirty(repo: string): string[] {
  const r = gitSync(repo, ["status", "--porcelain=v1", "-z", "-uall"]);
  if (r.code !== 0) return [];
  const parts = r.out.split("\0");
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (p.length < 4) continue;
    const xy = p.slice(0, 2);
    out.push(p.slice(3));
    if (xy.includes("R") || xy.includes("C")) i++; // the next field is the rename source
  }
  return [...new Set(out)];
}

/** The snapshot a job writes at dispatch: each dirty path and its content hash. */
export function statusSnapshot(repo: string): StatusSnapshot {
  const snap: StatusSnapshot = {};
  for (const f of dirtyPaths(repo)) snap[f] = fileHash(join(repo, f));
  return snap;
}

export function writeStatusSnapshot(jobDir: string, repo: string): void {
  try {
    writeFileSync(join(jobDir, "start_status.json"), JSON.stringify(statusSnapshot(repo)) + "\n");
  } catch {
    // Attribution is best effort: a job without a snapshot falls back to file times.
  }
}

export function readStatusSnapshot(jobDir: string): StatusSnapshot | null {
  const f = join(jobDir, "start_status.json");
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, "utf8")) as StatusSnapshot;
  } catch {
    return null;
  }
}

/**
 * Dirty paths that changed since the snapshot: not dirty at dispatch, or dirty with other content.
 * Without a snapshot, the dirty paths modified after `sinceIso` (conservative: may include other writers).
 */
export function changedSinceStart(repo: string, snap: StatusSnapshot | null, sinceIso: string | null): string[] {
  const since = sinceIso ? Date.parse(sinceIso) : NaN;
  return dirtyPaths(repo).filter((f) => {
    const now = fileHash(join(repo, f));
    if (snap) return !(f in snap) || snap[f] !== now;
    if (Number.isNaN(since)) return true;
    return mtimeMs(join(repo, f)) >= since;
  });
}

/** Files committed between start and HEAD. */
export function committedSince(repo: string, startCommit: string): string[] {
  if (!startCommit) return [];
  const r = gitSync(repo, ["diff", "--name-only", `${startCommit}..HEAD`]);
  return r.code === 0 ? r.out.split("\n").map((s) => s.trim()).filter(Boolean) : [];
}

export function mtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0; // a deleted file has no time; deletion is judged by attribution only
  }
}

/** True when the file holds a git conflict marker line. */
export function hasConflictMarkers(path: string): boolean {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return false;
  }
  return /^(<{7} |>{7} |<{7}$|>{7}$)/m.test(text) || (/^<{7}/m.test(text) && /^={7}$/m.test(text));
}

/**
 * The candidate files a handoff names. A candidate counts when its repo-relative path appears in the text, or when
 * its base name appears and no other candidate has that base name.
 */
export function namedInHandoff(handoff: string, candidates: string[]): string[] {
  const base = (f: string) => f.split("/").pop() ?? f;
  const count = new Map<string, number>();
  for (const f of candidates) count.set(base(f), (count.get(base(f)) ?? 0) + 1);
  return candidates.filter((f) => handoff.includes(f) || (count.get(base(f)) === 1 && new RegExp(`(^|[^\\w.-])${base(f).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\w-])`).test(handoff)));
}
