import { readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import { readProfiles } from "./options";

export const MAX_FOLDERS = 200;
const HIDDEN = new Set(["node_modules"]);

export interface FolderItem { path: string; name: string; last_used_at: string | null }
export interface FolderList { root: string; roots: string[]; items: FolderItem[]; truncated: boolean }

export class FolderError extends Error {}

function expand(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function real(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** `settings.chat_roots` of profiles.json (absolute paths, `~` allowed), default `~/sandbox/private`. Roots that do not exist are dropped. */
export function chatRoots(home: string): string[] {
  const set = readProfiles(home).settings?.chat_roots;
  const wanted = Array.isArray(set) && set.length > 0 ? set.filter((r): r is string => typeof r === "string") : ["~/sandbox/private"];
  const out: string[] = [];
  for (const r of wanted) {
    const abs = expand(r);
    const resolved = isAbsolute(abs) ? real(abs) : null;
    if (resolved !== null && isDir(resolved) && !out.includes(resolved)) {
      out.push(resolved);
    }
  }
  return out;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * The real path of a folder a chat may run in. Rejects a relative path, a `..` segment, a missing path, a file,
 * and anything whose real path (symlinks resolved) is outside every allowed root.
 */
export function validateFolder(input: string, roots: readonly string[]): string {
  const raw = expand(input.trim());
  if (raw === "" || !isAbsolute(raw)) {
    throw new FolderError("folder: must be an absolute path");
  }
  if (raw.split("/").includes("..")) {
    throw new FolderError("folder: must not contain '..'");
  }
  const resolved = real(resolve(raw));
  if (resolved === null) {
    throw new FolderError(`folder: ${raw} does not exist`);
  }
  if (!isDir(resolved)) {
    throw new FolderError(`folder: ${raw} is not a directory`);
  }
  if (!roots.some((root) => inside(root, resolved))) {
    throw new FolderError(`folder: ${raw} is outside the allowed roots (${roots.join(", ") || "none"}); see settings.chat_roots`);
  }
  return resolved;
}

/** True when the folder still exists and still resolves inside an allowed root. */
export function folderUsable(path: string, roots: readonly string[]): boolean {
  try {
    validateFolder(path, roots);
    return true;
  } catch {
    return false;
  }
}

/** Child directories of `root` (itself an allowed root or a folder inside one): recent use first, then by name, at most 200. */
export function listFolders(roots: readonly string[], rootParam: string | undefined, use: ReadonlyMap<string, string>): FolderList {
  const root = rootParam === undefined || rootParam === "" ? roots[0] : validateFolder(rootParam, roots);
  if (root === undefined) {
    return { root: "", roots: [...roots], items: [], truncated: false };
  }
  const items: FolderItem[] = [];
  const seen = new Set<string>();
  for (const name of readdirSync(root).sort()) {
    if (name.startsWith(".") || HIDDEN.has(name)) {
      continue;
    }
    const path = real(join(root, name));
    if (path === null || !isDir(path) || !roots.some((r) => inside(r, path))) {
      continue;
    }
    if (seen.has(path)) {
      continue;
    }
    seen.add(path);
    items.push({ path, name, last_used_at: use.get(path) ?? null });
  }
  items.sort((a, b) => {
    if (a.last_used_at !== b.last_used_at) {
      return a.last_used_at === null ? 1 : b.last_used_at === null ? -1 : a.last_used_at < b.last_used_at ? 1 : -1;
    }
    return a.name.localeCompare(b.name);
  });
  return { root, roots: [...roots], items: items.slice(0, MAX_FOLDERS), truncated: items.length > MAX_FOLDERS };
}
