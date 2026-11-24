// `run carry`: move the unfinished part of a run into a new run. Port of lib/runs/carry.sh.
// The new run is created by `dispatch.ts run start` (still bash); the state edits are done here.
import { existsSync, readdirSync, statSync } from "node:fs";
import { orchHome, paths } from "../state/home.ts";
import { loadRun } from "../state/store.ts";
import { dispatchSh } from "../state/proc.ts";
import { mutateRun } from "./node.ts";
import { closureProblems } from "../runs/closure.ts";

export const RUN_CARRY_USAGE = "dispatch.ts run carry <run-id> [--title T] [--id NEW-ID] [--keep-skipped] [--keep-open]";

export async function runCarry(args: string[]): Promise<number> {
  const home = orchHome();
  const runId = args[0] ?? "";
  if (!runId) { process.stderr.write(`usage: ${RUN_CARRY_USAGE}\n`); return 2; }
  let title = "", newId = "", keepSkipped = false, keepOpen = false;
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === "--title") title = args[++i] ?? "";
    else if (a === "--id") newId = args[++i] ?? "";
    else if (a === "--keep-skipped") keepSkipped = true;
    else if (a === "--keep-open") keepOpen = true;
    else { process.stderr.write(`run carry: unknown argument ${a}\n  usage: ${RUN_CARRY_USAGE}\n`); return 2; }
  }
  const old = await loadRun(home, runId);
  if (!old) { process.stderr.write(`run ${runId}: unknown run\n`); return 2; }
  const moves = (n: any) => n.status !== "done" && (n.status !== "skipped" || keepSkipped);
  const total = old.nodes.length;
  const moved = old.nodes.filter(moves).length;
  if (moved === 0) {
    process.stdout.write(`nothing to carry: all ${total} node(s) of ${runId} are finished\n`);
    return 0;
  }
  if (!title) title = `${old.title} (continued)`;
  const r = await dispatchSh(["run", "start", title, ...(newId ? ["--id", newId] : [])]);
  if (r.code !== 0) { process.stderr.write(r.err); return r.code; }
  const newRun = r.out.split("\n")[0]!.trim();
  process.stderr.write(r.err);

  const outRoot = `${home}/runs/${runId}/out`;
  const existing = existsSync(outRoot) ? readdirSync(outRoot).filter((d) => statSync(`${outRoot}/${d}`).isDirectory()) : [];
  const keep = old.nodes.filter(moves).map((n) => {
    if ((n.out_dir ?? null) != null || existing.includes(n.id)) return { ...n, out_dir: n.out_dir ?? `${paths.runs(home)}/${runId}/out/${n.id}` };
    return n;
  });
  const ids = new Set(keep.map((n) => n.id));
  let code = await mutateRun(home, newRun, (run) => {
    run.nodes = structuredClone(keep);
    run.edges = (old.edges ?? []).filter((e: string[]) => ids.has(e[0]) && ids.has(e[1]));
    run.continued_from = runId;
  });
  if (code !== 0) return code;
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  code = await mutateRun(home, runId, (run) => {
    for (const n of run.nodes) {
      if (!moves(n)) continue;
      n.status = "skipped";
      n.error = `moved to run ${newRun}`;
      n.skip_reason = `moved to run ${newRun}`;
      n.finished = n.finished ?? ts;
    }
    run.continued_to = newRun;
    if (!keepOpen) {
      const open = closureProblems(run);
      if (open.length === 0) { run.status = "done"; run.finished = run.finished ?? ts; }
      else process.stderr.write(`run ${runId} stays ${run.status}: ${open.join("; ")}\n`);
    }
  });
  if (code !== 0) return code;
  process.stdout.write(`${newRun}\n`);
  process.stderr.write(`carried ${moved} node(s) from ${runId}; ${total - moved} finished node(s) stay there\n`);
  return 0;
}
