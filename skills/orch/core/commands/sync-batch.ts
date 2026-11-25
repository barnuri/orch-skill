// `orch run sync-batch <run-id>... [--no-retry] [--verify-owners] [--lock]` runs `run sync` for several runs in one
// process: the watchdog syncs every due running run with one start instead of one start per run.
import { out } from "../io.ts";
import { errLine } from "./node.ts";
import { runSync } from "./runs.ts";

export const RUN_SYNC_BATCH_USAGE = "dispatch.ts run sync-batch <run-id>... [--no-retry] [--verify-owners] [--lock]";

export async function runSyncBatch(args: string[]): Promise<number> {
  const ids = args.filter((a) => !a.startsWith("--"));
  const flags = args.filter((a) => a.startsWith("--"));
  if (ids.length === 0) return (errLine(`usage: ${RUN_SYNC_BATCH_USAGE}`), 2);
  let worst = 0;
  for (const id of ids) {
    let rc = 1;
    try {
      rc = await runSync([id, ...flags]);
    } catch (err) {
      errLine(`run sync-batch ${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (rc !== 0) {
      out(`run sync-batch: ${id} rc=${rc}\n`);
      worst = Math.max(worst, rc);
    }
  }
  return worst;
}
