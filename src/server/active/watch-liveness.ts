import { readFileSync } from "node:fs";

// A confirmed match is trusted this long before the command line is read again. kill -0 still runs
// on every call, so a watch that dies is seen at once; only a pid reused within this window slips by.
const MATCH_TTL_MS: number = 5_000;
const confirmed: Map<string, number> = new Map();
// A pid whose command line did not name the watch: not alive, re-read after the same TTL. Stops a reused pid from running `ps` on every poll.
const rejected: Map<string, number> = new Map();

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

// Async `ps` results by pid. The sync caller reads the last result; a miss starts a refresh off the event loop.
const psCmd: Map<number, { cmd: string; at: number }> = new Map();
const psPending: Set<number> = new Set();

function refreshCommandLine(pid: number): void {
  if (psPending.has(pid)) return;
  psPending.add(pid);
  void (async () => {
    try {
      const proc = Bun.spawn(["ps", "-o", "command=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
      const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      if (psCmd.size > 256) psCmd.clear();
      psCmd.set(pid, { cmd: code === 0 ? text : "", at: Date.now() });
    } catch {
      // unreadable: leave unknown
    } finally {
      psPending.delete(pid);
    }
  })();
}

// The process's command line, or null when not known yet or unreadable. /proc on Linux, async `ps` elsewhere.
function commandLine(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ");
  } catch {
    // no /proc (macOS): fall through to ps
  }
  const hit = psCmd.get(pid);
  if (hit === undefined || Date.now() - hit.at > MATCH_TTL_MS) refreshCommandLine(pid);
  return hit === undefined ? null : hit.cmd;
}

/**
 * The same rule as `watch_pid_is` in core/commands/loops.ts: a watch is alive when its recorded pid answers
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
  if ((rejected.get(key) ?? 0) > now) {
    return false;
  }
  const cmd = commandLine(pid);
  // The command line is not known yet (first async ps still running): trust the pid for now, cache nothing,
  // so the next call decides from the ps result.
  if (cmd === null) {
    return true;
  }
  const alive = cmd.includes(`watch_run ${id}`) || cmd.includes(`watch __run ${id}`);
  if (alive) {
    if (confirmed.size > 256) {
      confirmed.clear();
    }
    confirmed.set(key, now + MATCH_TTL_MS);
  } else {
    confirmed.delete(key);
    if (rejected.size > 256) {
      rejected.clear();
    }
    rejected.set(key, now + MATCH_TTL_MS);
  }
  return alive;
}
