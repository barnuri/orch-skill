import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { orchPaths } from "./paths";

const DEFAULT_MODE: number = 0o644;
const PERMISSION_MASK: number = 0o777;
const TMP_SUFFIX: string = ".tmp";

let tmpCounter: number = 0;

/**
 * Writes `payload` to `target` via a same-directory temp file (`wx`, target's
 * current mode or `defaultMode`), fsync, close, rename. A failed temp file is
 * moved under `<home>/.trash/<stamp>/` — never unlinked — before rethrowing.
 */
export function writeAtomic(
  home: string,
  target: string,
  payload: Uint8Array,
  defaultMode: number = DEFAULT_MODE,
): void {
  const mode = existsSync(target) ? statSync(target).mode & PERMISSION_MASK : defaultMode;
  const tmp = nextTmpPath(target);
  try {
    const fd = openSync(tmp, "wx", mode);
    try {
      writeAll(fd, payload);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, target);
  } catch (err) {
    discardSafely(home, tmp);
    throw err;
  }
}

/**
 * Moves `path` to `<home>/.trash/<YYYYMMDDTHHMMSSZ>/<basename>` — the same
 * fallback bash `recoverable_remove` uses. A missing path is a no-op.
 */
export function discardToTrash(home: string, path: string): void {
  if (!existsSync(path)) {
    return;
  }
  const destinationDir = join(orchPaths(home).trash, utcStamp());
  mkdirSync(destinationDir, { recursive: true });
  renameSync(path, join(destinationDir, basename(path)));
}

function nextTmpPath(target: string): string {
  tmpCounter += 1;
  return join(dirname(target), `.${basename(target)}.serve.${process.pid}.${tmpCounter}${TMP_SUFFIX}`);
}

function writeAll(fd: number, payload: Uint8Array): void {
  let offset = 0;
  while (offset < payload.byteLength) {
    offset += writeSync(fd, payload, offset, payload.byteLength - offset);
  }
}

// The original write error is the one worth surfacing; a failed discard must not mask it.
function discardSafely(home: string, tmp: string): void {
  try {
    discardToTrash(home, tmp);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`serve: could not move ${tmp} to .trash: ${reason}`);
  }
}

function utcStamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}
