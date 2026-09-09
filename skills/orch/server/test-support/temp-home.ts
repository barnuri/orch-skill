import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";

// Same template the bash `ensure_home` and `server/files/ensure-home.ts` seed from.
// Resolved via import.meta.dir so the skill works when symlinked into other harnesses.
const TEMPLATES_DIR: string = resolvePath(import.meta.dir, "../../templates");
const PROFILES_TEMPLATE: string = join(TEMPLATES_DIR, "profiles.json");
const EMPTY_MEMORY: string = "[]\n";
const SERVE_DIR_MODE: number = 0o700;
const PERMISSION_MASK: number = 0o777;

/**
 * A throwaway ORCH_HOME for tests: a fresh temp directory seeded exactly like
 * `ensureHome` would seed a real one (profiles.json, memory.json, runs/, serve/).
 */
export class TempHome {
  readonly path: string;

  private constructor(path: string) {
    this.path = path;
  }

  static create(): TempHome {
    const home = new TempHome(mkdtempSync(join(tmpdir(), "orch-home-")));
    mkdirSync(home.resolve("runs"), { recursive: true });
    mkdirSync(home.resolve("serve"), { recursive: true, mode: SERVE_DIR_MODE });
    copyFileSync(PROFILES_TEMPLATE, home.resolve("profiles.json"));
    writeFileSync(home.resolve("memory.json"), EMPTY_MEMORY);
    return home;
  }

  resolve(rel: string): string {
    return resolvePath(this.path, rel);
  }

  /** Writes `text` at `rel`, creating parent directories (e.g. `runs/<id>/state.json`). */
  write(rel: string, text: string): void {
    const target = this.resolve(rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }

  read(rel: string): string {
    return readFileSync(this.resolve(rel), "utf8");
  }

  /** Permission bits only (e.g. `0o600`), without the file-type bits. */
  mode(rel: string): number {
    return statSync(this.resolve(rel)).mode & PERMISSION_MASK;
  }

  /**
   * Queues the directory for the Trash. One `trash` spawn costs ~120 ms, and a suite that
   * disposes per test spent most of its runtime there, so every queued path is trashed in a
   * single spawn at process exit instead. Never `rm`s — deletions must stay recoverable; when
   * `trash` is absent the directory is simply left in the OS temp dir.
   */
  dispose(): void {
    pending.push(this.path);
  }
}

const pending: string[] = [];

function trashPending(): void {
  const paths = pending.splice(0);
  const trashBin = Bun.which("trash");
  if (trashBin === null || paths.length === 0) {
    return;
  }
  Bun.spawnSync([trashBin, ...paths], { stdout: "ignore", stderr: "ignore" });
}

process.on("exit", trashPending);
