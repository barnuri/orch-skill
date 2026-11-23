// Runs the blocking process scan off the server's event loop. The watchdog starts one worker per scan
// and terminates it after the reply.
import { judgeAll, scanRunners } from "../../../skills/orch/core/ghosts.ts";

self.onmessage = (): void => {
  let count = 0;
  try {
    count = judgeAll(scanRunners()).filter((j) => j.ghost).length;
  } catch {
    count = 0;
  }
  postMessage(count);
};
