// Stops the runner processes (loop __run, watch __run, job-run, serve, ...) that a test started in its temp home.
// A process belongs to a home when its environment has HARNESS_ORCH_HOME=<home>. macOS: `ps -axwwE` shows the
// environment; Linux: /proc/<pid>/environ. Bun built-ins only.
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";

export interface HomeProc { pid: number; home: string }

const ENV_RE = /HARNESS_ORCH_HOME=(\S+)/;

// Every live process that has HARNESS_ORCH_HOME in its environment, with the home it names.
export function listHomeProcs(): HomeProc[] {
  const out: HomeProc[] = [];
  if (process.platform === "linux") {
    for (const d of readdirSync("/proc")) {
      if (!/^\d+$/.test(d)) continue;
      let env = "";
      try { env = readFileSync(`/proc/${d}/environ`, "utf8"); } catch { continue; }
      const m = env.split("\0").find((kv) => kv.startsWith("HARNESS_ORCH_HOME="));
      if (m) out.push({ pid: Number(d), home: m.slice("HARNESS_ORCH_HOME=".length) });
    }
    return out;
  }
  const ps = Bun.spawnSync(["ps", "-axwwE", "-o", "pid=,command="], { stdout: "pipe", stderr: "ignore" });
  for (const line of ps.stdout.toString().split("\n")) {
    const pid = Number(line.trim().split(/\s+/, 1)[0]);
    const m = line.match(ENV_RE);
    if (pid && m) out.push({ pid, home: m[1]! });
  }
  return out;
}

// The home as written and as its real path, so /var/... and /private/var/... both match.
function sameHome(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\/+$/, "");
  if (norm(a) === norm(b)) return true;
  const real = (p: string) => { try { return realpathSync(p); } catch { return norm(p); } };
  return real(a) === real(b);
}

export const alive = (pid: number) => {
  try { process.kill(pid, 0); } catch { return false; }
  // A zombie (killed, not yet reaped by its parent) is dead: kill(pid, 0) still succeeds for it.
  const st = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" }).stdout.toString().trim();
  return st !== "" && !st.startsWith("Z");
};

// Stops every process whose HARNESS_ORCH_HOME is `home`: SIGTERM, then SIGKILL after 3 s for the ones still alive.
// Returns the pids that were signalled. Call it before the home is trashed.
export function reapUnder(home: string): number[] {
  const pids = [...new Set(listHomeProcs().filter((p) => p.pid !== process.pid && sameHome(p.home, home)).map((p) => p.pid))];
  for (const pid of pids) { try { process.kill(pid, "SIGTERM"); } catch {} }
  const until = Date.now() + 3000;
  while (Date.now() < until && pids.some(alive)) Bun.sleepSync(100);
  for (const pid of pids) if (alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch {} }
  return pids;
}

// Runners whose home is under the temp dir and looks like a test home. Used by the run.ts guard.
export const TEST_HOME_RE = /orch-t-|wdpill-|orch-test/;
export function leakedTestRunners(): HomeProc[] {
  const roots = [tmpdir(), "/tmp", "/private/tmp"].map((r) => r.replace(/\/+$/, ""));
  const real = roots.map((r) => { try { return realpathSync(r); } catch { return r; } });
  const all = [...roots, ...real];
  return listHomeProcs().filter((p) => p.pid !== process.pid && all.some((r) => p.home.startsWith(r + "/")) && TEST_HOME_RE.test(p.home));
}
