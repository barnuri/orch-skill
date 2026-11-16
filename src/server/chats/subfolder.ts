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
      const real = realpathSync(next);
      if (!inside(root, real)) {
        throw new SubfolderError("subfolder: resolves outside the project folder");
      }
      if (!statSync(real).isDirectory()) {
        throw new SubfolderError("subfolder: a level of the path is a file, not a folder");
      }
      current = real;
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
