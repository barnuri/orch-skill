import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dispatchPath } from "../dispatch-path";

/** Pauses one run (`dispatch.sh run pause <run>`); resolves with its exit code. */
export type PauseRun = (runId: string) => Promise<number>;

/** How long the SIGTERM handler waits for the pauses before it stops the server anyway. */
export const SHUTDOWN_PAUSE_TIMEOUT_MS: number = 5_000;

/**
 * Run ids under `<home>/runs` that are running: `status: "running"`, not paused and not stopped.
 * A run a user stopped (`dispatch.sh run stop`) is never paused here, so it never auto-resumes.
 */
export function runningRunIds(home: string): string[] {
  const runsDir = join(home, "runs");
  let names: string[];
  try {
    names = readdirSync(runsDir);
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const name of names.sort()) {
    try {
      const state: unknown = JSON.parse(readFileSync(join(runsDir, name, "state.json"), "utf8"));
      if (typeof state === "object" && state !== null) {
        const s = state as Record<string, unknown>;
        if (s["status"] === "running" && s["paused"] !== true && s["stopped"] !== true) {
          ids.push(name);
        }
      }
    } catch {
      // Not a run dir or an unreadable state.json: skip it.
    }
  }
  return ids;
}

function homePauseRun(home: string): PauseRun {
  return async (runId) => {
    const proc = Bun.spawn(["bash", dispatchPath(), "run", "pause", runId], {
      env: { ...process.env, HARNESS_ORCH_HOME: home, ORCH_EVENT_BY: "shutdown-pause" },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0 && stderr.trim() !== "") {
      process.stderr.write(`shutdown-pause: ${runId}: ${stderr.trim()}\n`);
    }
    return code;
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * On SIGTERM (PC restart or logout), pauses every running run with `dispatch.sh run pause`, which
 * sets `auto_resume` under the run lock, so boot-resume resumes it on the next start. Node jobs
 * are left alone. The pauses run in parallel; the promise settles after all of them or after
 * `timeoutMs`, whichever comes first. Never rejects: every failure is logged. Resolves with the
 * ids it started a pause for.
 */
export async function pauseRunsOnShutdown(
  home: string,
  pause: PauseRun = homePauseRun(home),
  log: (line: string) => void = (l) => process.stderr.write(l),
  timeoutMs: number = SHUTDOWN_PAUSE_TIMEOUT_MS,
): Promise<string[]> {
  let ids: string[];
  try {
    ids = runningRunIds(home);
  } catch (err) {
    log(`shutdown-pause: cannot list runs: ${errorText(err)}\n`);
    return [];
  }
  const pending = ids.map(async (id) => {
    log(`shutdown-pause: pausing ${id}\n`);
    try {
      const code = await pause(id);
      if (code !== 0) {
        log(`shutdown-pause: ${id}: run pause exited ${code}\n`);
      }
    } catch (err) {
      log(`shutdown-pause: ${id}: ${errorText(err)}\n`);
    }
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((done) => {
    timer = setTimeout(() => done("timeout"), timeoutMs);
  });
  const outcome = await Promise.race([Promise.all(pending).then(() => "done" as const), timeout]);
  clearTimeout(timer);
  if (outcome === "timeout") {
    log(`shutdown-pause: gave up waiting after ${timeoutMs} ms\n`);
  }
  return ids;
}
