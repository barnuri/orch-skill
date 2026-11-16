import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dispatchPath } from "../dispatch-path";

/** Runs `dispatch.sh <args>` in the background; resolves with its exit code. */
export type ResumeSpawner = (args: readonly string[]) => Promise<number>;

/**
 * Run ids under `<home>/runs` whose state.json has `paused: true` and `auto_resume: true`.
 * A run a user stopped (`stopped: true`, `dispatch.sh run stop`) never resumes at boot.
 */
export function autoResumeRunIds(home: string): string[] {
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
        if (s["paused"] === true && s["auto_resume"] === true && s["stopped"] !== true) {
          ids.push(name);
        }
      }
    } catch {
      // Not a run dir or an unreadable state.json: skip it.
    }
  }
  return ids;
}

function homeResumeSpawner(home: string): ResumeSpawner {
  return async (args) => {
    const proc = Bun.spawn(["bash", dispatchPath(), ...args], {
      env: { ...process.env, HARNESS_ORCH_HOME: home, ORCH_EVENT_BY: "boot-resume" },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0 && stderr.trim() !== "") {
      process.stderr.write(`boot-resume: ${args.join(" ")}: ${stderr.trim()}\n`);
    }
    return code;
  };
}

/**
 * On server boot, runs `dispatch.sh run resume <run>` in the background for every run that
 * `run pause` marked `auto_resume`, so a paused run resumes by itself after a PC restart.
 * Never throws: every failure is logged. Returns the ids it started a resume for.
 */
export function startBootResume(
  home: string,
  spawn: ResumeSpawner = homeResumeSpawner(home),
  log: (line: string) => void = (l) => process.stderr.write(l),
): string[] {
  let ids: string[];
  try {
    ids = autoResumeRunIds(home);
  } catch (err) {
    log(`boot-resume: cannot list runs: ${err instanceof Error ? err.message : String(err)}\n`);
    return [];
  }
  for (const id of ids) {
    log(`boot-resume: resuming ${id}\n`);
    let pending: Promise<number>;
    try {
      pending = spawn(["run", "resume", id]);
    } catch (err) {
      log(`boot-resume: ${id}: ${err instanceof Error ? err.message : String(err)}\n`);
      continue;
    }
    pending.then(
      (code) => {
        if (code !== 0) {
          log(`boot-resume: ${id}: run resume exited ${code}\n`);
        }
      },
      (err: unknown) => log(`boot-resume: ${id}: ${err instanceof Error ? err.message : String(err)}\n`),
    );
  }
  return ids;
}
