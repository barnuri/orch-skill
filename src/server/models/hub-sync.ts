import { dispatchPath } from "../dispatch-path";

const SYNC_TIMEOUT_MS: number = 60_000;

// Runs `dispatch.ts model sync-hub` once in the background at server start. Never blocks boot and never
// throws: an unreachable hub or a failed sync is logged and the server keeps running.
export function startHubModelSync(
  home: string,
  log: (line: string) => void = (l) => process.stderr.write(l),
): void {
  void (async () => {
    try {
      const proc = Bun.spawn([process.execPath, dispatchPath(), "model", "sync-hub"], {
        env: { ...process.env, HARNESS_ORCH_HOME: home, ORCH_EVENT_BY: "boot", ORCH_NO_ANNOUNCE: "1" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: SYNC_TIMEOUT_MS,
        killSignal: "SIGKILL",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (code === 0) {
        log(stdout.trim() === "" ? "" : `hub-sync: ${stdout.trim()}\n`);
      } else {
        log(`hub-sync: failed (exit ${code}): ${stderr.trim()}\n`);
      }
    } catch (err) {
      log(`hub-sync: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  })();
}
