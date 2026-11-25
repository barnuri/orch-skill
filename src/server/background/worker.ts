// Background worker: every watcher that used to share the API event loop. It runs in a Bun Worker started by
// `startBackground` (supervisor.ts). Jobs are detached processes, so they never depend on this thread.
import { herdrWatcherFor, startHerdrWatcher } from "../health/herdr-watcher";
import { startBootResume } from "../runs/boot-resume";
import { startTicker } from "../schedules/ticker";
import { startRunWatcher } from "../push/run-watcher";
import { startWatchdog } from "../watchdog/watchdog-service";
import { startOrchestratorRotation } from "../watchdog/orchestrator-rotation";
import { startHubModelSync } from "../models/hub-sync";
import { isMainThread } from "node:worker_threads";
import type { MainMessage, WorkerMessage } from "./bridge";

export const SNAPSHOT_EVERY_MS: number = 3_000;

declare const self: Worker;
const post = (m: WorkerMessage): void => postMessage(m);

/** Starts every watcher and the snapshot loop; returns the stop function. */
export function startBackgroundWatchers(home: string, send: (m: WorkerMessage) => void): () => void {
  startTicker(home);
  startHerdrWatcher(home);
  const watchdog = startWatchdog(home);
  startOrchestratorRotation(home);
  const stopRunWatcher = startRunWatcher(home, (category, input) => send({ type: "notify", category, input }));
  startBootResume(home);
  startHubModelSync(home);
  const publish = (): void => {
    try {
      send({ type: "watchdog", status: watchdog.status() });
      send({ type: "herdr", health: herdrWatcherFor(home).latest() });
    } catch {
      // A failed snapshot is retried at the next tick.
    }
  };
  publish();
  const timer = setInterval(publish, SNAPSHOT_EVERY_MS);
  return () => {
    clearInterval(timer);
    stopRunWatcher();
    watchdog.stop();
  };
}

if (!isMainThread) {
  self.onmessage = (event: MessageEvent<MainMessage>): void => {
    if (event.data?.type === "start") {
      startBackgroundWatchers(event.data.home, post);
      post({ type: "ready" });
    }
  };
}
