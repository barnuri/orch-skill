import { readFileSync } from "node:fs";

// A confirmed match is trusted this long before the command line is read again. kill -0 still runs
// on every call, so a watch that dies is seen at once; only a pid reused within this window slips by.
const MATCH_TTL_MS: number = 5_000;
const confirmed: Map<string, number> = new Map();

// `kill -0` equivalent: signal 0 only checks that the process exists. EPERM means it exists but
// belongs to another user, which the command-line check below then rules out for a watch.
function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err instanceof Error && "code" in err && err.code === "EPERM";
  }
}

// The process's command line, or null when it cannot be read. /proc on Linux, `ps` elsewhere.
function commandLine(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ");
  } catch {
    // no /proc (macOS): fall through to ps
  }
  try {
    const proc = Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
    return proc.exitCode === 0 ? proc.stdout.toString() : "";
  } catch {
    return null;
  }
}

/**
 * The same rule as `watch_pid_is` in lib/loops.sh: a watch is alive when its recorded pid answers
 * and that process's command line names the watch id (`watch_run <id>`). A missing pid is not
 * alive, and neither is a pid the OS has since given to another process.
 */
export function watchProcessAlive(pid: unknown, id: string): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || !pidExists(pid)) {
    return false;
  }
  const key = `${pid}:${id}`;
  const now = Date.now();
  if ((confirmed.get(key) ?? 0) > now) {
    return true;
  }
  const cmd = commandLine(pid);
  // Without a way to read the command line, fall back to the pid check alone.
  const alive = cmd === null || cmd.includes(`watch_run ${id}`);
  if (alive) {
    if (confirmed.size > 256) {
      confirmed.clear();
    }
    confirmed.set(key, now + MATCH_TTL_MS);
  } else {
    confirmed.delete(key);
  }
  return alive;
}
