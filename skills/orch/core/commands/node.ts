import { existsSync } from "node:fs";
// `node add | update | report` CLI handlers. Each call: one lock, one state read, one state write.
// Output and exit codes match lib/runs/runs.sh (success prints nothing).
import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { currentRunResolve } from "../state/current-run.ts";
import { acquireLock } from "../state/lock.ts";
import { orchHome } from "../state/home.ts";
import { appendEvents, loadRun, saveRun, type RunState } from "../state/store.ts";
import {
  applyAdd,
  applyReport,
  applyResult,
  parseResultArgs,
  RESULT_USAGE,
  resultText,
  applyUpdate,
  loadChain,
  loadHub,
  newCtx,
  OpError,
  parseAddArgs,
  parseReportArgs,
  parseUpdateArgs,
  USAGE,
  type Ctx,
} from "../runs/node.ts";

export const RUN_LOCK_TRIES = 600; // 30 s at 50 ms: run_lock in runs.sh
export const RUN_LOCK_SLEEP_MS = 50;

export function errLine(msg: string): void {
  process.stderr.write(msg.endsWith("\n") ? msg : msg + "\n");
}

// Writes the owner files a mutation queued (owner_registry_write).
export async function writeOwners(home: string, ctx: Ctx): Promise<void> {
  if (ctx.owners.length === 0) return;
  const dir = join(home, "owners");
  await mkdir(dir, { recursive: true });
  for (const o of ctx.owners) {
    const tmp = join(dir, `.${o.file}.tmp.${process.pid}`);
    await Bun.write(tmp, JSON.stringify(o.body) + "\n");
    await rename(tmp, join(dir, o.file));
  }
}

export function flushStderr(ctx: Ctx): void {
  for (const line of ctx.stderr) errLine(line);
  ctx.stderr.length = 0;
}

// Runs one mutation of a run under the run lock: load, apply, save state, append events, write owners.
// Returns the exit code. Failures print the op message and return 2 (or 75 when the lock times out).
export async function mutateRun(
  home: string,
  runId: string,
  mutate: (run: RunState, ctx: Ctx) => unknown,
): Promise<number> {
  const pre = await loadRun(home, runId);
  if (!pre) {
    errLine(`run ${runId}: unknown run`);
    return 2;
  }
  // Dry run on a copy before the lock: bash rejects a bad op before run_lock, so it creates no lock file.
  const dry = newCtx(home, runId, { hub: await loadHub(home), chain: await loadChain(home, pre) });
  try {
    mutate(structuredClone(pre), dry);
  } catch (e) {
    if (!(e instanceof OpError)) throw e;
    flushStderr(dry);
    errLine(e.message);
    return 2;
  }
  const lock = await acquireLock(home, `run-${runId}`, RUN_LOCK_TRIES, RUN_LOCK_SLEEP_MS);
  if (!lock) {
    errLine(`run ${runId}: state is locked by another writer`);
    return 75;
  }
  try {
    const run = await loadRun(home, runId);
    if (!run) {
      errLine(`run ${runId}: unknown run`);
      return 2;
    }
    const hub = await loadHub(home);
    const ctx = newCtx(home, runId, { hub, chain: await loadChain(home, run) });
    try {
      mutate(run, ctx);
    } catch (e) {
      flushStderr(ctx);
      if (e instanceof OpError) {
        errLine(e.message);
        return 2;
      }
      throw e;
    }
    await saveRun(home, runId, run);
    await appendEvents(home, runId, ctx.events);
    await writeOwners(home, ctx);
    flushStderr(ctx);
    return 0;
  } finally {
    await lock.release();
  }
}

// Resolves the run argument ("." is the saved current run). Prints the problem and returns null.
export async function resolveRun(home: string, arg: string): Promise<string | null> {
  try {
    return await currentRunResolve(home, arg);
  } catch (e) {
    errLine((e as Error).message);
    return null;
  }
}

export async function nodeAdd(args: string[]): Promise<number> {
  const [runArg = "", id = "", label = ""] = args;
  if (!runArg || !id || !label) {
    errLine(`usage: ${USAGE.add}`);
    return 2;
  }
  const runId = await resolveRun(orchHome(), runArg);
  if (runId === null) return 1;
  let a;
  try {
    a = parseAddArgs(args.slice(1));
  } catch (e) {
    errLine((e as Error).message);
    return 2;
  }
  return mutateRun(orchHome(), runId, (run, ctx) => applyAdd(run, a, ctx));
}

export async function nodeUpdate(args: string[]): Promise<number> {
  const [runArg = "", id = ""] = args;
  if (!runArg || !id) {
    errLine(`usage: ${USAGE.update}`);
    return 2;
  }
  const home = orchHome();
  const runId = await resolveRun(home, runArg);
  if (runId === null) return 1;
  let a;
  try {
    a = parseUpdateArgs(args.slice(1));
  } catch (e) {
    errLine((e as Error).message);
    return 2;
  }
  const rc = await mutateRun(home, runId, (run, ctx) => applyUpdate(run, a, ctx));
  if (rc === 0 && ["done", "error", "skipped"].includes(a.status)) await finalFill(home, runId);
  return rc;
}

// A session-bound node that just ended takes its final session totals now (owners_fill_index_run).
export async function finalFill(home: string, runId: string): Promise<void> {
  const o = await import("./owners.ts");
  if (process.env.ORCH_OWNER_FILL === "0" || !existsSync(o.opencodeDbPath())) return;
  await o.ownersFillIndexRun(home, runId).catch(() => undefined);
}

export async function nodeReport(args: string[]): Promise<number> {
  const [runArg = "", id = ""] = args;
  if (!runArg || !id) {
    errLine(`usage: ${USAGE.report}`);
    return 2;
  }
  const home = orchHome();
  const runId = await resolveRun(home, runArg);
  if (runId === null) return 1;
  let a;
  try {
    a = parseReportArgs(args.slice(1));
  } catch (e) {
    errLine((e as Error).message);
    return 2;
  }
  return mutateRun(home, runId, (run, ctx) => applyReport(run, a, ctx));
}

// `node result [<run> <node>] --verdict V --summary S [--follow-up F]`: run and node fall back to the node's env.
export async function nodeResult(args: string[]): Promise<number> {
  let a;
  try {
    a = parseResultArgs(args);
  } catch (e) {
    errLine((e as Error).message);
    return 2;
  }
  const runArg = a.pos[0] ?? process.env.ORCH_RUN_ID ?? "";
  a.id = a.pos[1] ?? process.env.ORCH_NODE_ID ?? "";
  if (!runArg || !a.id) {
    errLine(`usage: ${RESULT_USAGE}`);
    return 2;
  }
  const home = orchHome();
  const runId = await resolveRun(home, runArg);
  if (runId === null) return 1;
  return mutateRun(home, runId, (run, ctx) => applyResult(run, a, ctx));
}

// `node show <run> <node>`: the node's result in full, then the node as JSON.
export async function nodeShow(args: string[]): Promise<number> {
  const [runArg = "", id = ""] = args;
  if (!runArg || !id) {
    errLine("usage: dispatch.ts node show <run-id> <node-id>");
    return 2;
  }
  const home = orchHome();
  const runId = await resolveRun(home, runArg);
  if (runId === null) return 1;
  const run = await loadRun(home, runId);
  const n = run?.nodes.find((x: any) => x.id === id);
  if (!n) return (errLine(`node ${id}: not in this run`), 2);
  const r = resultText(n);
  if (r) process.stdout.write(`result: ${r}${(n as any).result?.at ? ` (at ${(n as any).result.at})` : ""}\n`);
  process.stdout.write(JSON.stringify(n, null, 2) + "\n");
  return 0;
}
