// `run cover` / `run uncover`: mark a run whose unfinished work was copied into another run as `covered`,
// so it stays neither `error` nor `running`.
import { orchHome } from "../state/home.ts";
import { loadRun } from "../state/store.ts";
import { ev, OpError } from "../runs/node.ts";
import { errLine, mutateRun, resolveRun } from "./node.ts";

export const RUN_COVER_USAGE = 'dispatch.ts run cover <old-run> --by <new-run> [--note "T"] [--map oldNode=newNode ...]';
export const RUN_UNCOVER_USAGE = "dispatch.ts run uncover <run-id>";

/** Nodes of the old run that were not done: the work that was carried. */
export const carriedNodeIds = (nodes: { id?: unknown; status?: unknown }[]): string[] =>
  nodes.filter((n) => n.status !== "done").map((n) => String(n.id));

export async function runCover(args: string[]): Promise<number> {
  const runArg = args[0] ?? "";
  if (!runArg || runArg.startsWith("--")) return (errLine(`usage: ${RUN_COVER_USAGE}`), 2);
  let by = "";
  let note = "";
  const pairs: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === "--by") by = args[++i] ?? "";
    else if (a === "--note") note = args[++i] ?? "";
    else if (a === "--map") pairs.push(args[++i] ?? "");
    else return (errLine(`run cover: unknown argument ${a}\n  usage: ${RUN_COVER_USAGE}`), 2);
  }
  if (!by || by.startsWith("--")) return (errLine(`run cover: --by <new-run> is required\n  usage: ${RUN_COVER_USAGE}`), 2);
  const home = orchHome();
  const oldId = await resolveRun(home, runArg);
  if (oldId === null) return 1;
  const newId = await resolveRun(home, by);
  if (newId === null) return 1;
  if (oldId === newId) return (errLine("run cover: a run cannot be covered by itself"), 2);
  const target = await loadRun(home, newId);
  if (!target) return (errLine(`run ${newId}: unknown run`), 2);
  const map: Record<string, string> = {};
  for (const p of pairs) {
    const eq = p.indexOf("=");
    if (eq < 1 || eq === p.length - 1) return (errLine(`run cover: --map expects oldNode=newNode, got "${p}"`), 2);
    map[p.slice(0, eq)] = p.slice(eq + 1);
  }
  const rc = await mutateRun(home, oldId, (r, ctx) => {
    for (const [o, n] of Object.entries(map)) {
      if (!r.nodes.some((x) => x.id === o)) throw new OpError(`run cover: node ${o} is not in ${oldId}`);
      if (!target.nodes.some((x) => x.id === n)) throw new OpError(`run cover: node ${n} is not in ${newId}`);
    }
    if (r.status !== "covered") r.covered_prev_status = r.status;
    r.status = "covered";
    r.finished = r.finished ?? ctx.now;
    r.covered_by = newId;
    r.covered_at = ctx.now;
    r.covered_note = note;
    r.covered_nodes = carriedNodeIds(r.nodes);
    r.covered_map = map;
    ev(ctx, "run", "", "", "covered", `by ${newId}`);
  });
  if (rc === 0) process.stdout.write(`covered: ${oldId} by ${newId}\n`);
  return rc;
}

export async function runUncover(args: string[]): Promise<number> {
  const runArg = args[0] ?? "";
  if (!runArg || args.length !== 1) return (errLine(`usage: ${RUN_UNCOVER_USAGE}`), 2);
  const home = orchHome();
  const id = await resolveRun(home, runArg);
  if (id === null) return 1;
  let to = "";
  const rc = await mutateRun(home, id, (r, ctx) => {
    if (r.status !== "covered") throw new OpError(`run uncover: ${id} is not covered (status ${r.status})`);
    const prev = String(r.covered_prev_status ?? "");
    to = prev && prev !== "covered" ? prev : r.nodes.some((n) => n.status === "error") ? "error" : "done";
    r.status = to;
    if (to === "running") r.finished = null;
    for (const k of ["covered_by", "covered_at", "covered_note", "covered_nodes", "covered_map", "covered_prev_status"]) delete r[k];
    ev(ctx, "run", "", "covered", to, "uncovered");
  });
  if (rc === 0) process.stdout.write(`${to}: ${id}\n`);
  return rc;
}
