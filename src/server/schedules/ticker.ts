import { resolve } from "node:path";

const DISPATCH: string = resolve(import.meta.dir, "../../../skills/orch/scripts/dispatch.sh");
export const TICK_MS: number = 30_000;
const FIRST_TICK_MS: number = 5_000;

export interface Ticker {
  stop(): void;
}

// The server is the scheduler's clock: `dispatch.sh schedule tick` starts whatever is due. One tick
// at a time, so a slow tick is never stacked on top of itself.
export function startTicker(home: string): Ticker {
  let busy = false;
  const tick = async (): Promise<void> => {
    if (busy) {
      return;
    }
    busy = true;
    try {
      const proc = Bun.spawn(["bash", DISPATCH, "schedule", "tick"], {
        env: { ...process.env, HARNESS_ORCH_HOME: home },
        stdout: "ignore",
        stderr: "pipe",
      });
      const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      if (code !== 0) {
        process.stderr.write(`schedule tick failed (${code}): ${err.trim()}\n`);
      }
    } catch (err) {
      process.stderr.write(`schedule tick error: ${err instanceof Error ? err.message : String(err)}\n`);
    } finally {
      busy = false;
    }
  };
  const first = setTimeout(() => void tick(), FIRST_TICK_MS);
  const timer = setInterval(() => void tick(), TICK_MS);
  return {
    stop: (): void => {
      clearTimeout(first);
      clearInterval(timer);
    },
  };
}
