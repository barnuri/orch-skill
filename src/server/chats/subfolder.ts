import { lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";

import { SubfolderError } from "../../shared/subfolder";

export { MAX_SUBFOLDER_DEPTH, MAX_SUBFOLDER_NAME, normaliseSubfolder, SubfolderError } from "../../shared/subfolder";

function inside(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Creates the folder (mkdir -p) one level at a time and returns its real path. Every existing level is resolved first, so a
 * symlink that leaves the project folder is refused before anything is created through it.
 */
export function ensureSubfolder(projectPath: string, subfolder: string): string {
  return walk(projectPath, subfolder, true);
}

/** The reason without its `subfolder: ` prefix, for a sentence. */
export function reasonOf(err: SubfolderError): string {
  return err.message.replace(/^subfolder: /, "");
}

/**
 * Why the subfolder cannot be used now, or null: the real path of every level that exists is checked again (a symlink swapped in
 * after the subfolder was set, a level that became a file). Creates nothing, so reads can call it. A project folder that is gone
 * is not a subfolder problem (the caller reports it); a level that does not exist yet is fine (it is created at the next turn).
 */
export function subfolderProblem(projectPath: string, subfolder: string): string | null {
  try {
    realpathSync(projectPath);
  } catch {
    return null;
  }
  try {
    walk(projectPath, subfolder, false);
    return null;
  } catch (err) {
    if (err instanceof SubfolderError) {
      return reasonOf(err);
    }
    throw err;
  }
}

function walk(projectPath: string, subfolder: string, create: boolean): string {
  let root: string;
  try {
    root = realpathSync(projectPath);
  } catch {
    throw new SubfolderError("subfolder: the project folder does not exist");
  }
  let current = root;
  for (const part of subfolder.split("/")) {
    const next = join(current, part);
    let exists = true;
    try {
      lstatSync(next);
    } catch {
      exists = false;
    }
    if (exists) {
      let real: string;
      try {
        real = realpathSync(next);
      } catch {
        throw new SubfolderError("subfolder: a level of the path is a broken link");
      }
      if (!inside(root, real)) {
        throw new SubfolderError("subfolder: resolves outside the project folder");
      }
      if (!statSync(real).isDirectory()) {
        throw new SubfolderError("subfolder: a level of the path is a file, not a folder");
      }
      current = real;
    } else if (!create) {
      return current;
    } else {
      try {
        mkdirSync(next);
      } catch {
        throw new SubfolderError("subfolder: the folder could not be created");
      }
      current = next;
    }
  }
  return current;
}
