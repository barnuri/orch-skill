// `run watch <run-id> [--json] [--stall-min N]`: restarts `run wait` until the run ends. Each wait batch prints
// its events as they come. The end is read from the run's state, not from wait's exit code: exit 3 means the run
// is settled (nothing running or ready), not ended. Exits 0 when the run ends, 2 on a bad run or argument.
import { loadRun } from "../state/store.ts";
import { orchHome } from "../state/home.ts";
import { BIN_ORCH } from "../state/proc.ts";

export const RUN_WATCH_USAGE = "dispatch.ts run watch <run-id> [--json] [--stall-min N]";
const MAX_CRASHES = 5;

export async function runWatch(args: string[]): Promise<number> {
  const home = orchHome();
  let runId = "";
  const pass: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--json") pass.push(a);
    else if (a === "--stall-min") pass.push(a, args[++i] ?? "");
    else if (a.startsWith("-")) return (process.stderr.write(`run watch: unknown argument ${a}\n  usage: ${RUN_WATCH_USAGE}\n`), 2);
    else if (runId) return (process.stderr.write(`usage: ${RUN_WATCH_USAGE}\n`), 2);
    else runId = a;
  }
  if (!runId) return (process.stderr.write(`usage: ${RUN_WATCH_USAGE}\n`), 2);

  let crashes = 0;
  for (;;) {
    const before = await loadRun(home, runId);
    if (!before) return (process.stderr.write(`run ${runId}: unknown run\n`), 2);
    if (before.status !== "running") return 0;

    const proc = Bun.spawn([process.execPath, BIN_ORCH, "run", "wait", runId, ...pass], { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
    const code = await proc.exited;
    if (code === 2) return 2;

    const after = await loadRun(home, runId);
    if (!after) return (process.stderr.write(`run ${runId}: unknown run\n`), 2);
    if (after.status !== "running") return 0;

    // Exit 0 (events) and 3 (settled) restart at once: wait blocks on its own cursor until the next change.
    // Any other exit is a crash; give up after MAX_CRASHES in a row, with a pause between tries.
    if (code === 0 || code === 3) {
      crashes = 0;
      continue;
    }
    crashes++;
    if (crashes >= MAX_CRASHES) return (process.stderr.write(`run watch: run wait exited ${code} ${MAX_CRASHES} times in a row\n`), 1);
    await Bun.sleep(1000);
  }
}
