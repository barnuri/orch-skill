import { herdrWatcherFor } from "../health/herdr-watcher";
import { pushHubFor } from "../push/hub";
import { clearRemoteWatchdogStatus, setRemoteWatchdogStatus, type MainMessage, type WorkerMessage } from "./bridge";

export const RESTART_MIN_MS: number = 1_000;
export const RESTART_MAX_MS: number = 30_000;

export interface Background {
  /** Stops the worker for good (shutdown). Resolves once it is terminated. */
  stop(): void;
}

/**
 * Runs the watchers off the API event loop in one Bun Worker and restarts it with a backoff when it dies.
 * The API process keeps serving requests; it receives the watchdog and herdr snapshots and push notifications
 * as messages. `stop()` must run before shutdown pauses runs, so the watchdog cannot resume them meanwhile.
 */
export function startBackground(home: string, log: (line: string) => void = (l) => process.stderr.write(`background: ${l}\n`)): Background {
  let worker: Worker | null = null;
  let stopped = false;
  let delay = RESTART_MIN_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const onMessage = (m: WorkerMessage): void => {
    switch (m.type) {
      case "watchdog":
        setRemoteWatchdogStatus(home, m.status);
        break;
      case "herdr":
        herdrWatcherFor(home).setRemote(m.health as never);
        break;
      case "notify":
        void pushHubFor(home).notify(m.category as never, m.input as never).catch(() => {});
        break;
      case "ready":
        delay = RESTART_MIN_MS;
        break;
    }
  };

  const spawn = (): void => {
    if (stopped) return;
    const w = new Worker(new URL("./worker.ts", import.meta.url).href);
    worker = w;
    const died = (why: string): void => {
      if (worker !== w) return;
      worker = null;
      clearRemoteWatchdogStatus(home);
      if (stopped) return;
      log(`worker ${why}; restart in ${delay} ms`);
      timer = setTimeout(spawn, delay);
      delay = Math.min(delay * 2, RESTART_MAX_MS);
    };
    w.onmessage = (event: MessageEvent<WorkerMessage>): void => onMessage(event.data);
    w.onerror = (event: ErrorEvent): void => died(`error: ${event.message}`);
    w.addEventListener("close", () => died("closed"));
    const start: MainMessage = { type: "start", home };
    w.postMessage(start);
  };
  spawn();

  return {
    stop: (): void => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      worker?.terminate();
      worker = null;
      clearRemoteWatchdogStatus(home);
    },
  };
}
